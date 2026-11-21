import { afterEach, describe, expect, it } from 'vitest';
import { setLocaleSync } from '@/i18n';
import { eventSummary } from '@/data/logs';
import { listedTitle, nextStepText } from '../../apps/web/src/lib/daemon-text.js';
import { zh, zhCatalog } from './i18n-setup.js';

afterEach(() => setLocaleSync('zh-CN', zhCatalog()));

const STUCK = 'The user checks the stuck merge and cancels it if needed.';

describe('next steps the daemon writes', () => {
  it('words a known reason in the interface language', () => {
    expect(nextStepText({ reason: 'merge_stuck', next_step: STUCK })).toBe(
      zh('daemon.nextStep.mergeStuck'),
    );
    setLocaleSync('en', {});
    expect(nextStepText({ reason: 'merge_stuck', next_step: STUCK })).toBe(STUCK);
  });

  it.each([
    [
      'usage_limit_reached',
      'Continue the session after the limit resets, or fork it to another runtime.',
      'usageLimitReached',
    ],
    ['session_turn_stalled', 'Open the session to see where it stopped.', 'sessionTurnStalled'],
  ] as const)('words the next step of %s in the interface language', (reason, next_step, id) => {
    expect(nextStepText({ reason, next_step })).toBe(zh(`daemon.nextStep.${id}`));
    setLocaleSync('en', {});
    expect(nextStepText({ reason, next_step })).toBe(next_step);
  });

  it("shows the daemon's text for a reason the interface does not know, and none without one", () => {
    expect(nextStepText({ reason: 'gate_failed', next_step: 'Fix the gate' })).toBe('Fix the gate');
    expect(nextStepText({ reason: 'merge_stuck' })).toBeUndefined();
  });
});

describe('listed session titles', () => {
  const at = new Date(2026, 10, 2, 9, 18).getTime();

  it('names a baseline session without a title by its start time', () => {
    expect(listedTitle({ title: '', baseline_started_at: at })).toMatch(/^摸底 11.02.* 09:18$/);
    setLocaleSync('en', {});
    expect(listedTitle({ title: '', baseline_started_at: at })).toMatch(/^Baseline 11.02.* 09:18$/);
    expect(listedTitle({ title: 'Own title', baseline_started_at: at })).toBe('Own title');
  });
});

describe('deleted session titles', () => {
  const deleted = (payload: unknown) =>
    eventSummary({
      sequence: 1,
      event_id: 'event-1',
      kind: 'session.deleted',
      aggregate_id: 'a',
      aggregate_revision: 1,
      project_id: 'project-a',
      causation_id: '',
      created_at: 1,
      payload,
    });

  it('names an untitled deleted session by its baseline start, else without a title', () => {
    const at = new Date(2026, 10, 2, 9, 18).getTime();
    expect(deleted({ title: '', baseline_started_at: at })).toMatch(
      /^删除会话 摸底 11.02.* 09:18$/,
    );
    expect(deleted({ title: '' })).toBe(zh('data.logs.sessionDeletedUntitled'));
    setLocaleSync('en', {});
    expect(deleted({ title: '' })).toBe('Deleted session');
  });
});
