import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { NeedsYouItem } from '@pantheon/domain';
import { NEEDS_YOU_DECISIONS, type AppSettings } from '@pantheon/protocol';
import { deliveryFor } from '../../packages/control/dist/app-settings.js';
import { fixture } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function setup() {
  const userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-app-settings-'));
  const f = await fixture({ controlOptions: { userConfigDir } });
  cleanups.push(async () => {
    await f.close();
    rmSync(userConfigDir, { recursive: true, force: true });
  });
  return f;
}

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    // The daemon answers a schema refusal with invalid_input.
    return (error as Error).name === 'ZodError'
      ? 'invalid_input'
      : (error as { code?: string }).code;
  }
  return 'accepted';
};

it('delivers every decision kind now and sets no quiet hours by default', async () => {
  const f = await setup();
  const settings = f.call<AppSettings>('app.settings.set', {});
  expect(settings.attention_delivery).toEqual(
    Object.fromEntries(NEEDS_YOU_DECISIONS.map((kind) => [kind, 'now'])),
  );
  expect(settings.quiet_hours).toBeUndefined();
});

it('keeps delivery rules and quiet hours across reads, leaving the other kinds as they were', async () => {
  const f = await setup();
  f.call('app.settings.set', {
    attention_delivery: { question: 'brief', budget: 'never' },
    quiet_hours: { from: '22:00', to: '07:30' },
  });
  const settings = f.call<AppSettings>('app.settings.set', {});
  expect(settings.attention_delivery).toMatchObject({
    question: 'brief',
    budget: 'never',
    permission: 'now',
  });
  expect(settings.quiet_hours).toEqual({ from: '22:00', to: '07:30' });
});

it.each([
  ['an unknown decision kind', { attention_delivery: { lunch: 'now' } }],
  ['an unknown delivery', { attention_delivery: { question: 'later' } }],
  ['quiet hours that are not HH:MM', { quiet_hours: { from: '7pm', to: '07:00' } }],
])('refuses %s', async (_name, input) => {
  const f = await setup();
  expect(refusal(() => f.call('app.settings.set', input))).toBe('invalid_input');
});

const HOUR = 3_600_000;
const noon = new Date(2026, 10, 17, 12, 0).getTime();
const item = (decision: NeedsYouItem['decision'], waited: number) =>
  ({ decision, created_at: noon - waited }) as NeedsYouItem;
const settings = (
  delivery: Partial<AppSettings['attention_delivery']>,
  quiet_hours?: AppSettings['quiet_hours'],
) =>
  ({
    attention_delivery: {
      ...Object.fromEntries(NEEDS_YOU_DECISIONS.map((kind) => [kind, 'now'])),
      ...delivery,
    },
    quiet_hours,
  }) as AppSettings;

it.each([
  [
    'a new question set to brief',
    settings({ question: 'brief' }),
    item('question', 60_000),
    'brief',
  ],
  [
    'a question set to never that has waited over four hours',
    settings({ question: 'never' }),
    item('question', 4 * HOUR + 1),
    'now',
  ],
  [
    'a permission set to now inside quiet hours',
    settings({}, { from: '11:00', to: '13:00' }),
    item('permission', 0),
    'brief',
  ],
  [
    'a permission set to now inside quiet hours that cross midnight',
    settings({}, { from: '22:00', to: '13:00' }),
    item('permission', 0),
    'brief',
  ],
  [
    'a permission set to now outside quiet hours',
    settings({}, { from: '22:00', to: '07:00' }),
    item('permission', 0),
    'now',
  ],
  [
    'an old question inside quiet hours',
    settings({ question: 'brief' }, { from: '11:00', to: '13:00' }),
    item('question', 5 * HOUR),
    'now',
  ],
  ['a budget set to never', settings({ budget: 'never' }), item('budget', 5 * HOUR), 'never'],
])('delivers %s', (_name, rules, need, expected) => {
  expect(deliveryFor(rules, need, noon)).toBe(expected);
});
