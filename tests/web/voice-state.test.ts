import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import {
  insertVoiceText,
  useVoice,
  VOICE_BARS,
  VOICE_IDLE,
  VOICE_NO_TEXT_MS,
  VOICE_SILENCE_LEVEL,
  VOICE_SILENCE_MS,
  voiceClock,
  voiceLevel,
  voiceReducer,
  type VoiceEvent,
  type VoiceInput,
  type VoiceState,
} from '@/data/voice';

const run = (inputs: VoiceInput[], from: VoiceState = VOICE_IDLE) =>
  inputs.reduce(voiceReducer, from);
const listening = () =>
  run([
    { type: 'start', at: 0 },
    { type: 'preparing', at: 10 },
    { type: 'ready', at: 100 },
  ]);

describe('voice state', () => {
  it('prepares after a start and listens from the ready event, keeping the progress', () => {
    const preparing = run([
      { type: 'start', at: 0 },
      { type: 'preparing', progress: 0.4, at: 5 },
    ]);
    expect(preparing.phase).toBe('preparing');
    expect(preparing.progress).toBe(0.4);
    const ready = voiceReducer(preparing, { type: 'ready', at: 100 });
    expect(ready.phase).toBe('listening');
    expect(ready.startedAt).toBe(100);
  });

  it('keeps the newest levels up to the bar count and the partial text', () => {
    let state = listening();
    for (let i = 0; i < VOICE_BARS + 5; i++)
      state = voiceReducer(state, { type: 'level', value: i / 100, at: 200 + i });
    expect(state.levels).toHaveLength(VOICE_BARS);
    expect(state.levels.at(-1)).toBe((VOICE_BARS + 4) / 100);
    state = voiceReducer(state, { type: 'partial', text: 'fix the', at: 300 });
    expect(state.partial).toBe('fix the');
  });

  it('turns silent after levels stay under the threshold for the silence time, and back on a sound', () => {
    const quiet = VOICE_SILENCE_LEVEL / 2;
    let state = voiceReducer(listening(), { type: 'level', value: quiet, at: 1000 });
    state = voiceReducer(state, { type: 'level', value: quiet, at: 100 + VOICE_SILENCE_MS - 1 });
    expect(state.phase).toBe('listening');
    state = voiceReducer(state, { type: 'level', value: quiet, at: 100 + VOICE_SILENCE_MS });
    expect(state.phase).toBe('silent');
    state = voiceReducer(state, { type: 'level', value: 0.1, at: 5000 });
    expect(state.phase).toBe('listening');
    state = voiceReducer(state, { type: 'level', value: quiet, at: 5000 + VOICE_SILENCE_MS - 1 });
    expect(state.phase).toBe('listening');
  });

  it('transcribes after a stop with the recording length, and ends on the final text', () => {
    const stopped = voiceReducer(listening(), { type: 'stop', at: 7100 });
    expect(stopped.phase).toBe('transcribing');
    expect(voiceClock(stopped.endedAt! - stopped.startedAt!)).toBe('0:07');
    expect(voiceReducer(stopped, { type: 'final', text: 'done', at: 7200 })).toEqual(VOICE_IDLE);
  });

  it('names the missing permission, the failure and the missing engine from the error codes', () => {
    const error = (code: Extract<VoiceEvent, { type: 'error' }>['code']) =>
      voiceReducer(listening(), { type: 'error', code, message: 'engine text', at: 900 });
    expect([error('microphone_denied').phase, error('microphone_denied').denied]).toEqual([
      'denied',
      'microphone',
    ]);
    expect([error('speech_denied').phase, error('speech_denied').denied]).toEqual([
      'denied',
      'speech',
    ]);
    expect(error('unavailable').phase).toBe('unavailable');
    expect(error('failed').phase).toBe('failed');
    expect(error('failed').endedAt).toBe(900);
    expect(voiceReducer(error('failed'), { type: 'retry', at: 1000 }).phase).toBe('transcribing');
  });

  it('drops everything on cancel and ignores engine events while idle', () => {
    expect(voiceReducer(listening(), { type: 'cancel', at: 500 })).toEqual(VOICE_IDLE);
    expect(voiceReducer(VOICE_IDLE, { type: 'ready', at: 1 })).toBe(VOICE_IDLE);
    expect(voiceReducer(VOICE_IDLE, { type: 'level', value: 0.5, at: 1 })).toBe(VOICE_IDLE);
    expect(
      voiceReducer(VOICE_IDLE, { type: 'error', code: 'failed', message: 'late', at: 1 }),
    ).toBe(VOICE_IDLE);
  });

  it('raises the small engine levels with a square root and caps them at one', () => {
    expect(voiceLevel(0)).toBe(0);
    expect(voiceLevel(0.05)).toBeCloseTo(0.5);
    expect(voiceLevel(0.2)).toBe(1);
    expect(voiceLevel(0.8)).toBe(1);
    expect(voiceLevel(0.02)).toBeGreaterThan(0.3);
  });

  it('formats the clock as minutes and seconds', () => {
    expect(voiceClock(0)).toBe('0:00');
    expect(voiceClock(65_400)).toBe('1:05');
  });
});

describe('inserting the text', () => {
  it('puts the text at the caret, replacing a selection, and moves the caret after it', () => {
    expect(insertVoiceText('修复这个', '解析器的', { start: 2, end: 2 })).toEqual({
      value: '修复解析器的这个',
      caret: 6,
    });
    expect(insertVoiceText('fix the bug', 'crash', { start: 8, end: 11 })).toEqual({
      value: 'fix the crash',
      caret: 13,
    });
  });

  it('appends without a caret and spaces Latin words apart', () => {
    expect(insertVoiceText('fix the bug', 'in the parser', null)).toEqual({
      value: 'fix the bug in the parser',
      caret: 25,
    });
    expect(insertVoiceText('', 'hello', null)).toEqual({ value: 'hello', caret: 5 });
  });

  it('spaces accented Latin words apart', () => {
    expect(insertVoiceText('café', 'please', null).value).toBe('café please');
    expect(insertVoiceText('fix', 'École', null).value).toBe('fix École');
  });
});

describe('voice hook', () => {
  let listener: ((event: VoiceEvent) => void) | null;
  let bridge: Record<string, any>;
  let keys: ((e: unknown) => void)[];
  const voice = (onText = vi.fn()) => mount(() => useVoice(onText));

  beforeEach(() => {
    listener = null;
    keys = [];
    bridge = {
      voiceAvailable: vi.fn(async () => true),
      voiceStart: vi.fn((_locale, next) => {
        listener = next;
      }),
      voiceStop: vi.fn(),
      voiceCancel: vi.fn(),
      voiceRetry: vi.fn(),
      openPrivacySettings: vi.fn(async () => ({ ok: true, value: null })),
    };
    vi.stubGlobal('window', {
      pantheon: bridge,
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === 'keydown') keys.push(fn);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === 'keydown') keys = keys.filter((k) => k !== fn);
      },
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('is unavailable without the desktop bridge and available when the bridge says so', async () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    expect((await voice().flush()).available).toBe(false);
    vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
    expect((await voice().flush()).available).toBe(true);
  });

  it('starts in the interface language and hands only the final text on', () => {
    const onText = vi.fn();
    const h = voice(onText);
    h.value.start();
    h.render();
    expect(bridge.voiceStart.mock.calls[0]![0]).toBe('zh-CN');
    listener!({ type: 'ready' });
    listener!({ type: 'partial', text: 'fix' });
    h.render();
    expect(h.value.state.partial).toBe('fix');
    expect(onText).not.toHaveBeenCalled();
    h.value.stop();
    h.render();
    expect(bridge.voiceStop).toHaveBeenCalled();
    listener!({ type: 'final', text: 'fix the parser' });
    h.render();
    expect(onText).toHaveBeenCalledWith('fix the parser');
    expect(h.value.state.phase).toBe('idle');
  });

  it('hands the recognition to the composer started last, and lets only it stop or cancel it', () => {
    const a = voice();
    const b = voice();
    a.value.start();
    a.render();
    listener!({ type: 'ready' });
    a.render();
    b.value.start();
    b.render();
    listener!({ type: 'ready' });
    a.render();
    b.render();
    expect(a.value.state.phase).toBe('idle');
    expect(b.value.state.phase).toBe('listening');
    a.unmount();
    expect(bridge.voiceCancel).not.toHaveBeenCalled();
    b.value.stop();
    b.render();
    expect(bridge.voiceStop).toHaveBeenCalledTimes(1);
    expect(b.value.state.phase).toBe('transcribing');
  });

  it('ignores the events of a recognition after it was cancelled', () => {
    const onText = vi.fn();
    const h = voice(onText);
    h.value.start();
    h.render();
    const old = listener!;
    h.value.cancel();
    h.render();
    expect(bridge.voiceCancel).toHaveBeenCalled();
    old({ type: 'final', text: 'late' });
    h.render();
    expect(onText).not.toHaveBeenCalled();
    expect(h.value.state.phase).toBe('idle');
  });

  it('cancels on Esc while recording and when the composer goes away', () => {
    const h = voice();
    h.value.start();
    h.render();
    listener!({ type: 'ready' });
    h.render();
    const esc = {
      key: 'Escape',
      isComposing: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    keys.forEach((k) => k(esc));
    h.render();
    expect(bridge.voiceCancel).toHaveBeenCalledTimes(1);
    expect(esc.stopPropagation).toHaveBeenCalled();
    expect(h.value.state.phase).toBe('idle');
    expect(keys).toEqual([]);
    h.value.start();
    h.render();
    h.unmount();
    expect(bridge.voiceCancel).toHaveBeenCalledTimes(2);
  });

  it('ends voice input when its page is hidden and shows no voice bar when the page comes back', () => {
    const onText = vi.fn();
    const h = voice(onText);
    h.value.start();
    h.render();
    const old = listener!;
    old({ type: 'ready' });
    old({ type: 'partial', text: 'fix' });
    h.render();
    // A hidden screen keeps its state and runs its effect cleanups.
    h.unmount();
    expect(bridge.voiceCancel).toHaveBeenCalledTimes(1);
    old({ type: 'final', text: 'fix the parser' });
    h.render();
    expect(onText).not.toHaveBeenCalled();
    expect(h.value.state).toEqual(VOICE_IDLE);
  });

  it('finishes a recording that has given no new text for a minute and hands its text on', () => {
    vi.useFakeTimers();
    const onText = vi.fn();
    const h = voice(onText);
    h.value.start();
    h.render();
    listener!({ type: 'ready' });
    h.render();
    vi.advanceTimersByTime(VOICE_NO_TEXT_MS - 1000);
    listener!({ type: 'partial', text: 'fix' });
    h.render();
    vi.advanceTimersByTime(VOICE_NO_TEXT_MS - 1);
    h.render();
    expect(bridge.voiceStop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    h.render();
    expect(bridge.voiceStop).toHaveBeenCalledTimes(1);
    expect(h.value.state.phase).toBe('transcribing');
    listener!({ type: 'final', text: 'fix the parser' });
    h.render();
    expect(onText).toHaveBeenCalledWith('fix the parser');
    expect(h.value.state.phase).toBe('idle');
  });

  it('shows preparing only once it has lasted past the delay', () => {
    vi.useFakeTimers();
    const h = voice();
    h.value.start();
    h.render();
    listener!({ type: 'preparing' });
    h.render();
    expect(h.value.slow).toBe(false);
    vi.advanceTimersByTime(399);
    h.render();
    expect(h.value.slow).toBe(false);
    vi.advanceTimersByTime(1);
    h.render();
    expect(h.value.slow).toBe(true);
    listener!({ type: 'ready' });
    h.render();
    expect(h.value.slow).toBe(false);
  });

  it('opens the settings pane of the missing permission and shows why it did not open', async () => {
    const h = voice();
    h.value.start();
    h.render();
    listener!({ type: 'error', code: 'speech_denied', message: 'denied' });
    h.render();
    bridge.openPrivacySettings.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unsupported', message: 'Only on macOS' },
    });
    await h.value.openSettings();
    await h.flush();
    expect(bridge.openPrivacySettings).toHaveBeenCalledWith('speech');
    expect(h.value.state.settingsError).toContain('Only on macOS');
  });

  it('retries the kept recording, or starts again when the failure came before any recording', () => {
    const h = voice();
    h.value.start();
    h.render();
    listener!({ type: 'error', code: 'failed', message: 'no engine' });
    h.render();
    h.value.retry();
    h.render();
    expect(bridge.voiceRetry).not.toHaveBeenCalled();
    expect(bridge.voiceStart).toHaveBeenCalledTimes(2);
    listener!({ type: 'ready' });
    h.value.stop();
    h.render();
    listener!({ type: 'error', code: 'failed', message: 'crashed' });
    h.render();
    h.value.retry();
    h.render();
    expect(bridge.voiceRetry).toHaveBeenCalledTimes(1);
    expect(h.value.state.phase).toBe('transcribing');
  });
});
