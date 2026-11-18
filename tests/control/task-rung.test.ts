import { expect, it } from 'vitest';
import { taskRung, type TaskRungFacts } from '@pantheon/control';

const facts = (fields: Partial<TaskRungFacts> = {}): TaskRungFacts => ({
  user: [],
  switches: [],
  ...fields,
});

const gateFailed = (used: number, fields: Partial<NonNullable<TaskRungFacts['problem']>> = {}) => ({
  reason: 'gate_failed',
  at: 1_000,
  allowed: used < 3,
  used,
  limit: 3,
  ...fields,
});

it('has Pantheon retry a failed gate it may still hand back, with the tries used', () => {
  expect(taskRung(facts({ problem: gateFailed(1) }))).toEqual({
    rung: 'retry',
    by: 'pantheon',
    reason: 'gate_failed',
    used: 1,
    limit: 3,
    since: 1_000,
    switches: [],
  });
});

it('holds the retry while the session waits for its usage limit to reset', () => {
  expect(
    taskRung(
      facts({
        problem: gateFailed(1, { held: 'usage_limit' }),
        user: [{ reason: 'usage_limit_waiting', at: 900 }],
      }),
    ),
  ).toMatchObject({ rung: 'retry', by: 'pantheon', held: 'usage_limit', used: 1, limit: 3 });
});

it('shows the review round of the findings turn the session is on', () => {
  expect(
    taskRung(facts({ retry_turn: { reason: 'review_findings', at: 2_000, used: 2, limit: 3 } })),
  ).toEqual({
    rung: 'retry',
    by: 'pantheon',
    reason: 'review_findings',
    used: 2,
    limit: 3,
    since: 2_000,
    switches: [],
  });
});

it('gives the task to the lead once the hand-backs are used up and the lead was told', () => {
  expect(
    taskRung(
      facts({
        problem: gateFailed(3),
        told: { state: 'blocked', at: 3_000 },
        retry_turn: { reason: 'gate_failed', at: 2_000, used: 3, limit: 3 },
      }),
    ),
  ).toEqual({
    rung: 'lead',
    by: 'lead',
    reason: 'gate_failed',
    used: 3,
    limit: 3,
    since: 3_000,
    switches: [],
  });
});

it('waits for the user when a stall the lead was told of went unanswered', () => {
  expect(
    taskRung(
      facts({
        alert: { kind: 'stalled', at: 4_000 },
        user: [{ reason: 'task_turn_stalled', at: 3_500 }],
      }),
    ),
  ).toEqual({
    rung: 'user',
    by: 'user',
    reason: 'task_turn_stalled',
    since: 3_500,
    switches: [],
  });
});

it('shows a runtime change of the lead as a switch, from and to', () => {
  const switches = [{ from: 'claude', to: 'codex', at: 5_000, by: 'lead' as const }];
  expect(taskRung(facts({ switches }))).toEqual({
    rung: 'switch',
    by: 'lead',
    reason: 'runtime_changed',
    since: 5_000,
    switches,
  });
});

it('keeps the switches on a later rung', () => {
  const switches = [{ from: 'claude', to: 'codex', at: 5_000, by: 'lead' as const }];
  expect(taskRung(facts({ problem: gateFailed(0), switches }))).toMatchObject({
    rung: 'retry',
    switches,
  });
});

it('has Pantheon retry a session that could not open', () => {
  expect(taskRung(facts({ dispatch_error: { attempts: 2, at: 6_000 } }))).toEqual({
    rung: 'retry',
    by: 'pantheon',
    reason: 'dispatch_failed',
    used: 2,
    since: 6_000,
    switches: [],
  });
});

it('has no rung for a task without a problem', () => {
  expect(taskRung(facts())).toBeUndefined();
});
