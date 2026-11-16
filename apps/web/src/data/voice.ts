import { useEffect, useRef, useState } from 'react';
import type { BridgeResult, DesktopBridge } from '@pantheon/protocol';
import { currentLocale } from '../i18n';
import { useDelayed } from '../lib/use-delayed';
import { failureText } from './needs-you';

/** One event of the voice engine the shell runs. */
export type VoiceEvent = Parameters<Parameters<DesktopBridge['voiceStart']>[1]>[0];

/** How many level bars the recording row draws. */
export const VOICE_BARS = 28;
/** A level under this counts as no sound. */
export const VOICE_SILENCE_LEVEL = 0.01;
/** How long the levels stay under the threshold before the row says no sound was heard. */
export const VOICE_SILENCE_MS = 2000;
/** A recording that has given no new text for this long finishes as if stopped. */
export const VOICE_NO_TEXT_MS = 60_000;
/** The engine says preparing even with its model in place; the row names it only after this. */
export const VOICE_PREPARING_DELAY_MS = 400;
/** An engine level at or above this fills a bar. */
const VOICE_LEVEL_FULL = 0.2;

export type VoicePhase =
  | 'idle'
  | 'preparing'
  | 'listening'
  | 'silent'
  | 'transcribing'
  | 'denied'
  | 'failed'
  | 'unavailable';

export interface VoiceState {
  phase: VoicePhase;
  /** The permission the system refused, while denied. */
  denied: 'microphone' | 'speech' | null;
  progress: number | null;
  /** The newest engine levels, oldest first. */
  levels: readonly number[];
  /** When the engine was ready to record. */
  startedAt: number | null;
  /** When the recording ended. */
  endedAt: number | null;
  /** When the last level at or above the silence threshold came. */
  quietSince: number | null;
  partial: string;
  /** Why the system settings did not open. */
  settingsError: string | null;
}

export type VoiceAction =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'settings_failed'; message: string };

export type VoiceInput = (VoiceEvent | VoiceAction) & { at: number };

export const VOICE_IDLE: VoiceState = {
  phase: 'idle',
  denied: null,
  progress: null,
  levels: [],
  startedAt: null,
  endedAt: null,
  quietSince: null,
  partial: '',
  settingsError: null,
};

const recording = (state: VoiceState) => state.phase === 'listening' || state.phase === 'silent';

export function voiceReducer(state: VoiceState, input: VoiceInput): VoiceState {
  switch (input.type) {
    case 'start':
      return { ...VOICE_IDLE, phase: 'preparing' };
    case 'cancel':
      return VOICE_IDLE;
    case 'preparing':
      return state.phase === 'preparing' ? { ...state, progress: input.progress ?? null } : state;
    case 'ready':
      return state.phase === 'preparing'
        ? { ...state, phase: 'listening', startedAt: input.at, quietSince: input.at }
        : state;
    case 'level': {
      if (!recording(state)) return state;
      const quietSince =
        input.value >= VOICE_SILENCE_LEVEL ? input.at : (state.quietSince ?? input.at);
      return {
        ...state,
        levels: [...state.levels, input.value].slice(-VOICE_BARS),
        quietSince,
        phase: input.at - quietSince >= VOICE_SILENCE_MS ? 'silent' : 'listening',
      };
    }
    case 'partial':
      return recording(state) || state.phase === 'transcribing'
        ? { ...state, partial: input.text }
        : state;
    case 'stop':
      return recording(state) ? { ...state, phase: 'transcribing', endedAt: input.at } : state;
    case 'final':
      return VOICE_IDLE;
    case 'error': {
      if (state.phase === 'idle') return state;
      const ended = {
        ...state,
        endedAt: state.endedAt ?? (state.startedAt === null ? null : input.at),
      };
      if (input.code === 'microphone_denied')
        return { ...ended, phase: 'denied', denied: 'microphone' };
      if (input.code === 'speech_denied') return { ...ended, phase: 'denied', denied: 'speech' };
      return { ...ended, phase: input.code };
    }
    case 'retry':
      return state.phase === 'failed' ? { ...state, phase: 'transcribing' } : state;
    case 'settings_failed':
      return state.phase === 'denied' ? { ...state, settingsError: input.message } : state;
  }
}

/** An engine level, which runs small, raised to the 0 to 1 a bar is drawn with. */
export function voiceLevel(value: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, value) / VOICE_LEVEL_FULL));
}

/** A duration as m:ss. */
export function voiceClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const LATIN_END = /[\p{Script=Latin}0-9.,;:!?]$/u;
const LATIN_START = /^[\p{Script=Latin}0-9]/u;

/** value with text put in at the caret, or after the end without one, and where the caret goes after it. */
export function insertVoiceText(
  value: string,
  text: string,
  caret: { start: number; end: number } | null,
): { value: string; caret: number } {
  const before = value.slice(0, caret?.start ?? value.length);
  const after = value.slice(caret?.end ?? value.length);
  // Latin words need a space between them; Chinese text does not.
  const lead = LATIN_END.test(before) && LATIN_START.test(text) ? ' ' : '';
  const trail = LATIN_START.test(after) && LATIN_END.test(text) ? ' ' : '';
  const put = `${lead}${text}${trail}`;
  return { value: before + put + after, caret: before.length + lead.length + text.length };
}

const voiceSettingsListeners = new Set<() => void>();

/** The composer whose recognition the shell runs; the shell runs one at a time. */
let voiceOwner: { reset: () => void } | null = null;

/** Has each open composer ask the shell again whether voice input is available. */
export function voiceSettingsChanged() {
  voiceSettingsListeners.forEach((listener) => listener());
}

/** Voice input through the desktop shell; onText gets each final text, the partial text stays in the state. */
export function useVoice(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>(VOICE_IDLE);
  const [available, setAvailable] = useState(false);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [, setTick] = useState(0);
  // Events of a recognition started before the newest start or cancel are dropped.
  const run = useRef(0);
  const current = useRef(state);
  current.current = state;
  const handText = useRef(onText);
  handText.current = onText;
  const dispatch = (input: VoiceInput) => setState((s) => voiceReducer(s, input));
  const owner = useRef({
    reset: () => {
      run.current++;
      dispatch({ type: 'cancel', at: Date.now() });
    },
  }).current;
  const owns = () => voiceOwner === owner;
  const active = state.phase !== 'idle';
  const ticking = recording(state);
  const slow = useDelayed(state.phase === 'preparing', VOICE_PREPARING_DELAY_MS);

  useEffect(() => {
    const listener = () => setSettingsRevision((n) => n + 1);
    voiceSettingsListeners.add(listener);
    return () => {
      voiceSettingsListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let shown = true;
    void window.pantheon?.voiceAvailable?.().then(
      (yes) => {
        if (shown) setAvailable(yes);
      },
      () => {},
    );
    return () => {
      shown = false;
    };
  }, [settingsRevision]);

  // A hidden screen keeps its state, so leaving the page also resets the voice bar.
  useEffect(
    () => () => {
      if (current.current.phase === 'idle') return;
      cancel();
    },
    [],
  );

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  useEffect(() => {
    if (!ticking) return;
    const timer = setTimeout(stop, VOICE_NO_TEXT_MS);
    return () => clearTimeout(timer);
  }, [ticking, state.partial]);

  function start() {
    const bridge = window.pantheon;
    if (!bridge) return;
    if (voiceOwner && !owns()) voiceOwner.reset();
    voiceOwner = owner;
    const id = ++run.current;
    dispatch({ type: 'start', at: Date.now() });
    bridge.voiceStart(currentLocale(), (event) => {
      if (run.current !== id) return;
      if (event.type === 'final' && event.text.trim() !== '') handText.current(event.text.trim());
      dispatch({ ...event, at: Date.now() });
    });
  }

  function stop() {
    dispatch({ type: 'stop', at: Date.now() });
    if (owns()) window.pantheon?.voiceStop();
  }

  function cancel() {
    owner.reset();
    if (!owns()) return;
    voiceOwner = null;
    window.pantheon?.voiceCancel();
  }

  function retry() {
    // Without a recording there is nothing to recognize again.
    if (current.current.startedAt === null) return start();
    dispatch({ type: 'retry', at: Date.now() });
    if (owns()) window.pantheon?.voiceRetry();
  }

  async function openSettings() {
    const bridge = window.pantheon;
    const pane = current.current.denied;
    if (!bridge || pane === null) return;
    const result: BridgeResult<null> = await bridge
      .openPrivacySettings(pane)
      .catch((reason: unknown) => ({
        ok: false as const,
        error: { code: 'ipc_failed', message: String(reason) },
      }));
    if (!result.ok)
      dispatch({ type: 'settings_failed', message: failureText(result.error), at: Date.now() });
  }

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);

  return { state, available, slow, start, stop, cancel, retry, openSettings };
}
