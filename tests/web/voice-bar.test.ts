import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { draftKey, useDrafts } from '@/data/drafts';
import {
  VOICE_BARS,
  VOICE_IDLE,
  voiceReducer,
  type VoiceEvent,
  type VoiceInput,
  type VoiceState,
} from '@/data/voice';
import { useQueued, usePrefill } from '@/screens/sessions/parts';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';
import { VoiceBar } from '@/screens/sessions/VoiceBar';
import { zh } from './i18n-setup.js';

const state = (inputs: readonly object[], at = 0) =>
  inputs.reduce<VoiceState>(
    (s, input, i) => voiceReducer(s, { ...input, at: at + i * 1000 } as VoiceInput),
    VOICE_IDLE,
  );
const START = [{ type: 'start' }, { type: 'preparing' }, { type: 'ready' }] as const;
const callbacks = () => ({
  onStop: vi.fn(),
  onCancel: vi.fn(),
  onRetry: vi.fn(),
  onOpenSettings: vi.fn(),
});
const bar = (s = state([...START]), extra: { slow?: boolean; now?: number } = {}) => {
  const on = callbacks();
  const tree = VoiceBar({ state: s, slow: extra.slow ?? false, now: extra.now ?? 0, ...on })!;
  return { tree, on };
};
const buttons = (tree: ReactElement) =>
  nodes(tree)
    .filter((n) => n.type === 'button')
    .map((n) => n.props['aria-label'] ?? text(n));
const press = (tree: ReactElement, label: string | undefined) =>
  find(
    tree,
    (n) => n.type === 'button' && (n.props['aria-label'] ?? text(n)) === label,
  ).props.onClick();

describe('voice bar', () => {
  it('draws the level bars, newest on the right, the clock, and cancel and finish while listening', () => {
    const s = [0.2, 0].reduce(
      (s, value, i) => voiceReducer(s, { type: 'level', value, at: 2100 + i }),
      state([...START]),
    );
    const { tree, on } = bar(s, { now: 2000 + 3500 });
    const vu = find(tree, (n) => n.props.role === 'img');
    expect(vu.props['aria-label']).toBe(zh('sessions.voice.level'));
    expect(vu.props['data-flat']).toBe(false);
    const heights = nodes(vu.props.children).map((n) => n.props.style.height);
    expect(heights).toHaveLength(VOICE_BARS);
    expect(heights.slice(-2)).toEqual(['20px', '4px']);
    expect(text(find(tree, (n) => n.props.className === 'vc-clk'))).toBe('0:03');
    expect(buttons(tree)).toEqual([
      zh('sessions.voice.cancelRecording'),
      zh('sessions.voice.finish'),
    ]);
    press(tree, zh('sessions.voice.finish'));
    expect(on.onStop).toHaveBeenCalled();
    press(tree, zh('sessions.voice.cancelRecording'));
    expect(on.onCancel).toHaveBeenCalled();
  });

  it('flattens the bars and says no sound was heard while silent', () => {
    const s = state([
      ...START,
      { type: 'level', value: 0 },
      { type: 'level', value: 0 },
      {
        type: 'level',
        value: 0,
      },
      { type: 'level', value: 0 },
    ]);
    expect(s.phase).toBe('silent');
    const { tree } = bar(s, { now: 7000 });
    const vu = find(tree, (n) => n.props.role === 'img');
    expect(vu.props['data-flat']).toBe(true);
    expect(vu.props['aria-label']).toBe(zh('sessions.voice.silent'));
    expect(text(tree)).toContain(zh('sessions.voice.silent'));
    expect(buttons(tree)).toEqual([
      zh('sessions.voice.cancelRecording'),
      zh('sessions.voice.finish'),
    ]);
  });

  it('shows transcribing with the recording length and only a cancel', () => {
    const { tree, on } = bar(state([...START, { type: 'stop' }]), { now: 99_000 });
    expect(text(tree)).toContain(zh('sessions.voice.transcribing'));
    expect(text(find(tree, (n) => n.props.className === 'vc-clk'))).toBe('0:01');
    expect(buttons(tree)).toEqual([zh('sessions.voice.cancelTranscribing')]);
    press(tree, zh('sessions.voice.cancelTranscribing'));
    expect(on.onCancel).toHaveBeenCalled();
  });

  it('offers the system settings for a missing microphone or speech permission', () => {
    for (const [code, sentence] of [
      ['microphone_denied', zh('sessions.voice.microphoneDenied')],
      ['speech_denied', zh('sessions.voice.speechDenied')],
    ] as const) {
      const { tree, on } = bar(state([{ type: 'start' }, { type: 'error', code, message: 'x' }]));
      expect(text(tree)).toContain(sentence);
      expect(buttons(tree)).toEqual([
        zh('sessions.voice.close'),
        zh('sessions.voice.openSettings'),
      ]);
      press(tree, zh('sessions.voice.openSettings'));
      expect(on.onOpenSettings).toHaveBeenCalled();
    }
  });

  it('shows why the system settings did not open in place of the sentence', () => {
    const s = voiceReducer(
      state([{ type: 'start' }, { type: 'error', code: 'microphone_denied', message: 'x' }]),
      { type: 'settings_failed', message: 'Only on macOS', at: 0 },
    );
    const { tree } = bar(s);
    expect(text(find(tree, (n) => n.props.role === 'alert'))).toBe('Only on macOS');
  });

  it('keeps the recording after a failed transcription and offers a retry', () => {
    const { tree, on } = bar(
      state([...START, { type: 'stop' }, { type: 'error', code: 'failed', message: 'x' }]),
    );
    expect(text(tree)).toContain(zh('sessions.voice.failed'));
    expect(text(find(tree, (n) => n.props.className === 'vc-clk'))).toBe('0:01');
    expect(buttons(tree)).toEqual([zh('sessions.voice.discard'), zh('sessions.voice.retry')]);
    press(tree, zh('sessions.voice.retry'));
    expect(on.onRetry).toHaveBeenCalled();
    press(tree, zh('sessions.voice.discard'));
    expect(on.onCancel).toHaveBeenCalled();
  });

  it('says the engine is unavailable with no action besides closing', () => {
    const { tree } = bar(
      state([{ type: 'start' }, { type: 'error', code: 'unavailable', message: 'x' }]),
    );
    expect(text(tree)).toContain(zh('sessions.voice.unavailable'));
    expect(buttons(tree)).toEqual([zh('sessions.voice.close')]);
  });

  it('names the model preparation only once preparing is slow', () => {
    const s = state([{ type: 'start' }, { type: 'preparing' }]);
    expect(text(bar(s).tree)).not.toContain(zh('sessions.voice.preparing'));
    const slow = bar(s, { slow: true }).tree;
    expect(text(slow)).toContain(zh('sessions.voice.preparing'));
    expect(buttons(slow)).toEqual([zh('sessions.voice.cancelPreparing')]);
  });
});

describe('composer microphone', () => {
  let session: Session;
  let listed: WorkbenchSession;
  let listener: ((event: VoiceEvent) => void) | null;
  let bridge: Record<string, any>;
  let project = 0;
  const compose = async () => {
    const h = mount(() => SessionCompose({ session, listed, title: 'Voice work' }));
    await h.flush();
    return h;
  };
  const mic = (tree: ReactElement) =>
    nodes(tree).find(
      (n) => n.type === 'button' && n.props['aria-label'] === zh('sessions.voice.start'),
    );

  beforeEach(() => {
    const id = `project-voice-${++project}`;
    listener = null;
    session = {
      id: 'session-voice',
      revision: 1,
      project_id: id,
      runtime: 'claude',
      state: 'open',
      turn_count: 1,
    };
    listed = {
      id: 'session-voice',
      created_at: '2026-01-01T00:00:00.000Z',
      title: 'Voice work',
      runtime: 'claude',
      model: null,
      effort: null,
      permission_mode: 'ask',
      workspace_id: 'workspace-voice',
      workspace_kind: 'linked_worktree',
      state: 'idle',
      waiting: 0,
      reconciling: false,
      stopping: false,
      last_activity_at: '2026-01-01T00:00:00.000Z',
      changes: null,
      merge: null,
    };
    useQueued.setState({ queued: {}, failures: {} });
    usePrefill.setState({ prefill: {} });
    useDrafts.setState({ drafts: {}, answers: {} });
    mock.board = {
      board: { cursor: 1, projects: [] },
      events: [],
      resync: 0,
      status: { state: 'live' },
      refresh() {},
    };
    bridge = {
      command: vi.fn(async () => ({ ok: true, value: {} })),
      query: vi.fn(async () => ({ ok: true, value: [] })),
      voiceAvailable: vi.fn(async () => true),
      voiceStart: vi.fn((_locale: string, next: (event: VoiceEvent) => void) => {
        listener = next;
      }),
      voiceStop: vi.fn(),
      voiceCancel: vi.fn(),
    };
    vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('has no microphone when voice input is unavailable', async () => {
    bridge.voiceAvailable = vi.fn(async () => false);
    const h = await compose();
    expect(mic(h.value)).toBeUndefined();
  });

  it('puts the microphone before the send key and swaps the row for the voice bar while recording', async () => {
    const h = await compose();
    const row = find(h.value, (n) => n.props.className === 'cp-row');
    const kids = [row.props.children].flat().filter(Boolean) as ReactElement<any>[];
    const at = kids.findIndex((n) => n.props['aria-label'] === zh('sessions.voice.start'));
    expect(at).toBeGreaterThan(-1);
    expect(kids[at + 1]!.type).toBe(named(h.value, 'SendButton').type);
    mic(h.value)!.props.onClick();
    h.render();
    expect(nodes(h.value).some((n) => n.props.className === 'cp-row')).toBe(false);
    expect(named(h.value, 'VoiceBar').props.state.phase).toBe('preparing');
  });

  it('inserts the final text at the caret and never the partial text', async () => {
    const key = draftKey(session.project_id, session.id);
    useDrafts.getState().update(key, () => ({ text: 'fix  bug' }));
    const h = await compose();
    const box = { selectionStart: 4, selectionEnd: 4, focus: vi.fn(), setSelectionRange: vi.fn() };
    find(h.value, (n) => n.type === 'textarea').props.ref.current = box;
    mic(h.value)!.props.onClick();
    h.render();
    listener!({ type: 'ready' });
    listener!({ type: 'partial', text: 'the' });
    h.render();
    expect(useDrafts.getState().drafts[key]?.text).toBe('fix  bug');
    listener!({ type: 'final', text: 'the' });
    h.render();
    expect(useDrafts.getState().drafts[key]?.text).toBe('fix the bug');
  });
});
