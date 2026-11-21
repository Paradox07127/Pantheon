import { expect, it } from 'vitest';
import {
  quiet,
  stalled,
  turnLoop,
  type TurnActivity,
} from '../../packages/control/src/progress.js';

const MINUTE = 60_000;

const activity = (fields: Partial<TurnActivity> = {}): TurnActivity => ({
  started_at: 0,
  acted_at: 0,
  completed: [],
  ...fields,
});

const failed = (input: unknown) => ({ ok: false, call: { name: 'Bash', input } });

it('calls a running turn quiet after two minutes without progress or a tool call under way', () => {
  expect(quiet(activity(), 2 * MINUTE)).toBe(false);
  expect(quiet(activity(), 2 * MINUTE + 1)).toBe(true);
  expect(quiet(activity({ acted_at: MINUTE }), 2 * MINUTE + 1)).toBe(false);
  expect(quiet(activity({ open_call: { at: 0, name: 'Bash' } }), 30 * MINUTE)).toBe(false);
});

it('calls a running turn stalled after ten minutes without progress or a tool call under way', () => {
  expect(stalled(activity(), 9 * MINUTE)).toBe(false);
  expect(stalled(activity(), 10 * MINUTE)).toBe(false);
  expect(stalled(activity(), 10 * MINUTE + 1)).toBe(true);
  expect(stalled(activity({ open_call: { at: 0, name: 'Bash' } }), 30 * MINUTE)).toBe(false);
});

it('calls a running turn looping when the same tool call failed three times in a row', () => {
  const test = { command: 'pnpm test' };
  expect(turnLoop(activity({ completed: [failed(test), failed(test)] }))).toBeUndefined();
  expect(
    turnLoop(
      activity({ completed: [failed(test), failed({ command: 'pnpm build' }), failed(test)] }),
    ),
  ).toBeUndefined();
  expect(
    turnLoop(
      activity({
        completed: [failed(test), failed(test), { ok: true, call: { name: 'Bash', input: test } }],
      }),
    ),
  ).toBeUndefined();
  expect(
    turnLoop(activity({ completed: [failed(test), failed(test), failed(test)] }))?.call,
  ).toEqual({
    name: 'Bash',
    input: test,
  });
});
