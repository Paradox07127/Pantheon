import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { holdModifier } from '@/lib/held-keys';
import { KeyHint } from '@/components/Shortcuts';
import { resetShortcuts, setShortcut } from '@/lib/shortcuts';

type Listener = (e: Partial<KeyboardEvent>) => void;

let listeners: Record<string, Listener[]> = {};
const body = { dataset: {} as Record<string, string | undefined> };
const fire = (type: string, e: Partial<KeyboardEvent> = {}) => {
  for (const listener of [...(listeners[type] ?? [])]) listener(e);
};

beforeEach(() => {
  vi.useFakeTimers();
  listeners = {};
  body.dataset = {};
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
    },
  });
  vi.stubGlobal('document', { body });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetShortcuts();
});

describe('held modifier', () => {
  it.each([
    [
      'marks the body once ⌘ alone has been held for 400ms, and clears it on release',
      () => fire('keyup', { key: 'Meta' }),
    ],
    ['clears the mark when the window loses focus', () => fire('blur')],
  ])('%s', (_name, release) => {
    const stop = holdModifier();
    fire('keydown', { key: 'Meta' });
    vi.advanceTimersByTime(399);
    expect(body.dataset.cmd).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(body.dataset.cmd).toBe('held');
    fire('keydown', { key: 'Meta', repeat: true });
    release();
    expect(body.dataset.cmd).toBeUndefined();
    stop();
  });

  it('shows nothing when another key goes down within the hold, as ⌘K does', () => {
    const stop = holdModifier();
    fire('keydown', { key: 'Meta' });
    vi.advanceTimersByTime(200);
    fire('keydown', { key: 'k', metaKey: true });
    vi.advanceTimersByTime(400);
    expect(body.dataset.cmd).toBeUndefined();
    stop();
  });

  it('holds Control off macOS, and not ⌘', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows NT 10.0' });
    const stop = holdModifier();
    fire('keydown', { key: 'Meta' });
    vi.advanceTimersByTime(400);
    expect(body.dataset.cmd).toBeUndefined();
    fire('keydown', { key: 'Control' });
    vi.advanceTimersByTime(400);
    expect(body.dataset.cmd).toBe('held');
    fire('keyup', { key: 'Control' });
    expect(body.dataset.cmd).toBeUndefined();
    stop();
  });

  it('stops listening once stopped', () => {
    holdModifier()();
    fire('keydown', { key: 'Meta' });
    vi.advanceTimersByTime(400);
    expect(body.dataset.cmd).toBeUndefined();
  });
});

describe('key hint', () => {
  it('writes the current keys of the entry, hidden from assistive technology', () => {
    expect(renderToStaticMarkup(createElement(KeyHint, { id: 'palette' }))).toBe(
      '<span class="kbd hk" aria-hidden="true">⌘K</span>',
    );
    expect(setShortcut('palette', 'Meta+P')).toBeNull();
    expect(renderToStaticMarkup(createElement(KeyHint, { id: 'palette' }))).toContain('>⌘P<');
  });

  it('writes one digit of the session numbers and nothing for an entry without keys', () => {
    expect(renderToStaticMarkup(createElement(KeyHint, { id: 'session-number', digit: 3 }))).toBe(
      '<span class="kbd hk" aria-hidden="true">⌘3</span>',
    );
    expect(renderToStaticMarkup(createElement(KeyHint, { id: 'session-pin' }))).toBe('');
  });
});
