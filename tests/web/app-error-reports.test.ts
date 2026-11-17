import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Command } from '@pantheon/protocol';
import { captureAppErrors } from '@/data/app-errors';

const listeners = new Map<string, (event: unknown) => void>();
const command = vi.fn(async (_command: Command) => ({ ok: true, value: null }));
const reports = () =>
  command.mock.calls.map(([sent]) => sent).filter((sent) => sent.type === 'signal.app_error');
const original = console.error;

beforeAll(() => {
  vi.useFakeTimers({ now: new Date('2026-11-17T09:00:00.000Z') });
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    pantheon: { command, debugTarget: async () => null },
  });
  console.error = () => {};
  captureAppErrors();
});
afterAll(() => {
  console.error = original;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  // Each case starts after the previous one's minute has passed.
  vi.advanceTimersByTime(2 * 60_000);
  command.mockClear();
});

it('sends one report for a hundred identical console errors within a second', () => {
  for (let index = 0; index < 100; index++) {
    console.error('Warning: each child in a list needs a key');
    vi.advanceTimersByTime(10);
  }
  expect(reports()).toHaveLength(1);
  expect(reports()[0]).toMatchObject({
    type: 'signal.app_error',
    input: { kind: 'console', message: 'Warning: each child in a list needs a key' },
  });
});

it('sends at most thirty reports a minute for distinct errors', () => {
  const name = (index: number) =>
    String.fromCharCode(97 + (index % 26)) + String.fromCharCode(97 + Math.floor(index / 26));
  for (let index = 0; index < 40; index++) {
    const error = new TypeError(`Panel ${name(index)} failed to render`);
    listeners.get('error')!({ error, message: error.message });
    vi.advanceTimersByTime(1000);
  }
  expect(reports()).toHaveLength(30);
  expect(reports()[0]!.input).toMatchObject({
    kind: 'error',
    message: 'TypeError: Panel aa failed to render',
  });
});
