import { afterEach, expect, it } from 'vitest';
import type { Retrospective, ImprovementSignal, WorkflowPolicy } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { improvementSignals } from '../../packages/control/dist/improvement-signals.js';
import { DEFAULT_WORKFLOW_POLICY } from '../../packages/control/dist/workflow-policy.js';
import { fixture } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

const backend = { domain: 'backend-logic', tier: 't2' } as const;
const docs = { domain: 'docs-chore', tier: 't1' } as const;

async function setup() {
  const f = await fixture();
  fixtures.push(f);
  let rows = 0;
  /** Inserts a merged retrospective of a new task, newer than every earlier one; returns its id. */
  const retro = (fields: Partial<Retrospective> = {}) => {
    rows++;
    const id = `retrospective-${rows}`;
    f.store.insert<Retrospective>('retrospectives', {
      id,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: `task-${rows}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: rows,
      ...fields,
    });
    return id;
  };
  const policy = (fields: Partial<WorkflowPolicy>) =>
    f.store.insert<WorkflowPolicy>('workflow_policies', {
      ...structuredClone(DEFAULT_WORKFLOW_POLICY),
      id: f.project.id,
      revision: 1,
      project_id: f.project.id,
      policy_version: 1,
      ...fields,
    });
  const signals = (signal: ImprovementSignal) =>
    improvementSignals((f.control as unknown as { ctx: ControlContext }).ctx, f.project.id).filter(
      (finding) => finding.signal === signal,
    );
  return { f, retro, policy, signals };
}

const times = <T>(count: number, make: (index: number) => T) =>
  Array.from({ length: count }, (_, index) => make(index));

const dispatched = (leadInput: number, taskInput: number, fields: Partial<Retrospective> = {}) => ({
  measured_kind: backend,
  path: 'dispatch' as const,
  gate_passed_on_attempt: 1,
  lead_usage: { input_tokens: leadInput, output_tokens: 10 },
  task_usage: { input_tokens: taskInput, output_tokens: 10 },
  ...fields,
});

it('finds dispatch overhead when the lead takes most input tokens of five first-pass dispatched tasks of a cell', async () => {
  const { retro, signals } = await setup();
  retro(dispatched(100, 900));
  const ids = times(5, () => retro(dispatched(700, 300)));

  expect(signals('dispatch_overhead')).toEqual([
    {
      signal: 'dispatch_overhead',
      cell: backend,
      retrospective_ids: ids.reverse(),
      suggestion: { type: 'policy_change', param: 'path', tier: 't2', to: 'direct' },
    },
  ]);
});

it('finds no dispatch overhead at a lead share of exactly 60 percent or with a gate that failed first', async () => {
  const { retro, signals } = await setup();
  times(5, () => retro(dispatched(600, 400)));
  expect(signals('dispatch_overhead')).toEqual([]);

  const other = await setup();
  times(4, () => other.retro(dispatched(700, 300)));
  other.retro(dispatched(700, 300, { gate_passed_on_attempt: 2, gate_failures: ['code'] }));
  expect(other.signals('dispatch_overhead')).toEqual([]);
});

it('withholds the suggestion of a signal whose parameter the user pinned', async () => {
  const { retro, policy, signals } = await setup();
  policy({ pinned: ['path'] });
  times(5, () => retro(dispatched(700, 300)));

  expect(signals('dispatch_overhead')).toMatchObject([
    { suggestion: { param: 'path', to: 'direct' }, withheld: 'pinned' },
  ]);
});

const direct = (firstPass: boolean) => ({
  planned_kind: docs,
  path: 'direct' as const,
  ...(firstPass
    ? { gate_passed_on_attempt: 1 }
    : { gate_passed_on_attempt: 2, gate_failures: ['code' as const] }),
});

it('finds direct rework when two of the five latest direct tasks of a cell failed their first gate run', async () => {
  const { retro, signals } = await setup();
  const ids = [true, false, true, false, true].map((firstPass) => retro(direct(firstPass)));

  expect(signals('direct_rework')).toEqual([
    {
      signal: 'direct_rework',
      cell: docs,
      retrospective_ids: ids.reverse(),
      suggestion: { type: 'policy_change', param: 'path', tier: 't1', to: 'dispatch' },
    },
  ]);
});

it('finds no direct rework when one of the five latest direct tasks failed its first gate run', async () => {
  const { retro, signals } = await setup();
  retro(direct(false));
  [true, false, true, true, true].forEach((firstPass) => retro(direct(firstPass)));

  expect(signals('direct_rework')).toEqual([]);
});

it('finds idle wakeups when most of the latest ten lead wakes ended without a decision', async () => {
  const { retro, signals } = await setup();
  retro({ lead_wakes: 6, lead_wakes_without_decision: 0 });
  const ids = [
    retro({ lead_wakes: 4, lead_wakes_without_decision: 3 }),
    retro({ lead_wakes: 4, lead_wakes_without_decision: 2 }),
    retro({ lead_wakes: 4, lead_wakes_without_decision: 2 }),
  ];

  expect(signals('idle_wakeups')).toEqual([
    {
      signal: 'idle_wakeups',
      retrospective_ids: ids.reverse(),
      suggestion: { type: 'policy_change', param: 'acceptance_wake', to: 'milestone' },
    },
  ]);
});

it('finds no idle wakeups when exactly half of the latest ten lead wakes ended without a decision', async () => {
  const { retro, signals } = await setup();
  retro({ lead_wakes: 10, lead_wakes_without_decision: 10 });
  retro({ lead_wakes: 5, lead_wakes_without_decision: 2 });
  retro({ lead_wakes: 5, lead_wakes_without_decision: 3 });

  expect(signals('idle_wakeups')).toEqual([]);
});

it('finds no idle wakeups in direct tasks, whose wakes milestone acceptance does not hold back', async () => {
  const { retro, signals } = await setup();
  times(10, () => retro({ path: 'direct', lead_wakes: 1, lead_wakes_without_decision: 1 }));

  expect(signals('idle_wakeups')).toEqual([]);
});

it('finds idle wakeups in dispatched tasks and leaves a newer direct task out of them', async () => {
  const { retro, signals } = await setup();
  const ids = [
    retro(dispatched(100, 900, { lead_wakes: 4, lead_wakes_without_decision: 3 })),
    retro(dispatched(100, 900, { lead_wakes: 4, lead_wakes_without_decision: 2 })),
    retro(dispatched(100, 900, { lead_wakes: 4, lead_wakes_without_decision: 2 })),
  ];
  retro({ path: 'direct', lead_wakes: 1, lead_wakes_without_decision: 1 });

  expect(signals('idle_wakeups')).toEqual([
    {
      signal: 'idle_wakeups',
      retrospective_ids: ids.reverse(),
      suggestion: { type: 'policy_change', param: 'acceptance_wake', to: 'milestone' },
    },
  ]);
});

const waited = (dispatchWait: number, fields: Partial<Retrospective> = {}) => ({
  stage_ms: { dispatch_wait: dispatchWait, execution: 1000 },
  ...fields,
});

it('finds a queue wait when the latest five tasks waited for dispatch over half as long as they ran', async () => {
  const { retro, policy, signals } = await setup();
  policy({ max_parallel: 2, max_parallel_limit: 4 });
  const ids = times(5, () => retro(waited(600)));

  expect(signals('queue_wait')).toEqual([
    {
      signal: 'queue_wait',
      retrospective_ids: ids.reverse(),
      suggestion: { type: 'policy_change', param: 'max_parallel', to: 3 },
    },
  ]);
});

it('finds no queue wait after a rebase conflict among the latest five tasks', async () => {
  const { retro, policy, signals } = await setup();
  policy({ max_parallel: 2, max_parallel_limit: 4 });
  times(4, () => retro(waited(600)));
  retro(waited(600, { handbacks: [{ reason: 'rebase_conflict' }] }));

  expect(signals('queue_wait')).toEqual([]);
});

it('finds no queue wait while max_parallel is at the user limit', async () => {
  const { retro, signals } = await setup();
  times(5, () => retro(waited(600)));

  expect(signals('queue_wait')).toEqual([]);
});

const conflicted = (conflict: boolean) => ({
  handbacks: conflict ? [{ reason: 'rebase_conflict' }] : [],
});

it('finds merge conflicts when two of the latest five tasks were handed back a rebase conflict', async () => {
  const { retro, signals } = await setup();
  const ids = [true, false, false, true, false].map((conflict) => retro(conflicted(conflict)));

  expect(signals('merge_conflicts')).toEqual([
    {
      signal: 'merge_conflicts',
      retrospective_ids: ids.reverse(),
      suggestion: { type: 'policy_change', param: 'max_parallel', to: 2 },
    },
  ]);
});

it('finds no merge conflicts when one of the latest five tasks was handed back a rebase conflict', async () => {
  const { retro, signals } = await setup();
  retro(conflicted(true));
  [true, false, false, false, false].forEach((conflict) => retro(conflicted(conflict)));

  expect(signals('merge_conflicts')).toEqual([]);
});

it('finds a cell over budget when three of its five latest tasks spent more than their budget', async () => {
  const { retro, signals } = await setup();
  const ids = [1.2, 0.8, 1.5, 0.9, 1.1].map((ratio) =>
    retro({ measured_kind: backend, budget_ratio: ratio }),
  );

  expect(signals('over_budget')).toEqual([
    { signal: 'over_budget', cell: backend, retrospective_ids: ids.reverse() },
  ]);
});

it('finds no cell over budget when one of three tasks spent exactly its budget', async () => {
  const { retro, signals } = await setup();
  [1.2, 0.8, 1.5, 0.9, 1].forEach((ratio) =>
    retro({ measured_kind: backend, budget_ratio: ratio }),
  );

  expect(signals('over_budget')).toEqual([]);
});

it('finds a repeated gate failure when one check failed in two different tasks', async () => {
  const { retro, signals } = await setup();
  const first = retro({ gate_failures: ['code'], gate_failed_checks: ['Typecheck'] });
  retro({ gate_failures: ['code'], gate_failed_checks: ['Lint'] });
  const second = retro({ gate_failures: ['code'], gate_failed_checks: ['Typecheck'] });

  expect(signals('repeat_gate_failure')).toEqual([
    { signal: 'repeat_gate_failure', retrospective_ids: [second, first] },
  ]);
});

it("finds no repeated gate failure in the user's own sessions that landed", async () => {
  const { retro, signals } = await setup();
  for (const session of ['session-1', 'session-2'])
    retro({
      origin: 'session',
      lead_session_id: session,
      task_id: 'session',
      gate_failures: ['code'],
      gate_failed_checks: ['Typecheck'],
    });

  expect(signals('repeat_gate_failure')).toEqual([]);
});

it('finds no repeated gate failure when one check failed in two generations of the same task', async () => {
  const { retro, signals } = await setup();
  retro({ task_id: 'export', gate_failures: ['code'], gate_failed_checks: ['Typecheck'] });
  retro({ task_id: 'export', gate_failures: ['code'], gate_failed_checks: ['Typecheck'] });

  expect(signals('repeat_gate_failure')).toEqual([]);
});

it('finds a repeated turn failure when one error code failed turns of two different tasks', async () => {
  const { retro, signals } = await setup();
  const first = retro({ turn_failure_codes: ['modelNotFound'] });
  const second = retro({ turn_failure_codes: ['modelNotFound', 'rateLimited'] });

  expect(signals('repeat_turn_failure')).toEqual([
    { signal: 'repeat_turn_failure', retrospective_ids: [second, first] },
  ]);
});

it('finds no repeated turn failure in a task that failed twice or in a task that was removed', async () => {
  const { retro, signals } = await setup();
  retro({ turn_failure_codes: ['modelNotFound', 'modelNotFound'] });
  retro({ outcome: 'removed', turn_failure_codes: ['modelNotFound'] });

  expect(signals('repeat_turn_failure')).toEqual([]);
});

it('finds a repeated turn failure in failed tasks the user did not stop', async () => {
  const { retro, signals } = await setup();
  const first = retro({ outcome: 'failed', turn_failure_codes: ['modelNotFound'] });
  const second = retro({
    outcome: 'failed',
    stopped_by: 'lead',
    turn_failure_codes: ['modelNotFound'],
  });

  expect(signals('repeat_turn_failure')).toEqual([
    { signal: 'repeat_turn_failure', retrospective_ids: [second, first] },
  ]);
});

it('finds no repeated turn failure in failed tasks the user stopped', async () => {
  const { retro, signals } = await setup();
  for (let i = 0; i < 2; i++)
    retro({ outcome: 'failed', stopped_by: 'user', turn_failure_codes: ['modelNotFound'] });

  expect(signals('repeat_turn_failure')).toEqual([]);
});

it('finds a hand-back loop when one reason was handed back as often as the hand-back limit', async () => {
  const { retro, signals } = await setup();
  const id = retro({ handbacks: times(3, () => ({ reason: 'gate_failed' })) });

  expect(signals('handback_loop')).toEqual([{ signal: 'handback_loop', retrospective_ids: [id] }]);
});

it('finds no hand-back loop when no single reason reached the hand-back limit', async () => {
  const { retro, signals } = await setup();
  retro({
    handbacks: [{ reason: 'gate_failed' }, { reason: 'out_of_scope' }, { reason: 'gate_failed' }],
  });

  expect(signals('handback_loop')).toEqual([]);
});

function commandDecision(
  f: Fixture,
  index: number,
  state: 'approved' | 'rejected' = 'approved',
  at = f.store.now(),
  command = 'pnpm test --run',
  answeredByRule = false,
  projectRuleSupported = false,
  sessionId = 'command-session',
  decider: 'user' | 'lead' = 'user',
) {
  const owner = { id: `approval-${index}`, revision: 1 };
  f.store.event('agent.permission.requested', { id: sessionId, revision: 1 }, f.project.id, {
    kind: 'permission.requested',
    request_id: owner.id,
    tool: 'Bash',
    detail: { input: { command } },
  });
  const event = f.store.event(`approval.${state}`, owner, f.project.id, {
    session_id: sessionId,
    project_rule_supported: projectRuleSupported,
    request_id: owner.id,
    tool: 'Bash',
    rule: 'Bash(pnpm test)',
    state,
    ...(answeredByRule
      ? { answered_by_rule: 'Bash(pnpm test)' }
      : decider === 'lead'
        ? { decider, decided_by: 'session:lead-session' }
        : { decided_by: 'local-user' }),
  });
  f.store.db.prepare('UPDATE events SET created_at=? WHERE event_id=?').run(at, event.event_id);
}

it('finds an always-approved command at five user approvals with its complete command text', async () => {
  const { f, signals } = await setup();
  times(4, (index) => commandDecision(f, index));
  expect(signals('always_approved_command')).toEqual([]);
  commandDecision(f, 4);
  expect(signals('always_approved_command')).toEqual([
    {
      signal: 'always_approved_command',
      retrospective_ids: [],
      evidence: { kind: 'always_approved_command', command: 'pnpm test --run', approvals: 5 },
    },
  ]);
});

it('excludes always-approved commands with a refusal, an existing project rule, an answer by a rule or old approvals', async () => {
  const refused = await setup();
  times(5, (index) => commandDecision(refused.f, index));
  commandDecision(refused.f, 5, 'rejected');
  expect(refused.signals('always_approved_command')).toEqual([]);

  const covered = await setup();
  times(5, (index) => commandDecision(covered.f, index));
  covered.f.store.update(
    'projects',
    {
      ...covered.f.project,
      permission_rules: [
        {
          rule: 'Bash(pnpm test)',
          session_id: 'command-session',
          added_at: covered.f.store.now(),
        },
      ],
    },
    covered.f.project.revision,
  );
  expect(covered.signals('always_approved_command')).toEqual([]);

  const byRule = await setup();
  times(4, (index) => commandDecision(byRule.f, index));
  commandDecision(byRule.f, 4, 'approved', undefined, undefined, true);
  expect(byRule.signals('always_approved_command')).toEqual([]);

  const old = await setup();
  times(4, (index) => commandDecision(old.f, index));
  commandDecision(old.f, 4, 'approved', old.f.store.now() - 7 * 24 * 60 * 60 * 1000 - 1);
  expect(old.signals('always_approved_command')).toEqual([]);
});

it('does not count a prompt the lead approved under the charter as an approval by the user', async () => {
  const { f, signals } = await setup();
  times(4, (index) => commandDecision(f, index));
  commandDecision(f, 4, 'approved', undefined, undefined, false, false, undefined, 'lead');
  expect(signals('always_approved_command')).toEqual([]);
});

function gateFailure(
  f: Fixture,
  index: number,
  durations: number[],
  failedAt = durations.length - 1,
  carried = false,
  at = f.store.now(),
) {
  const event = f.store.event(
    'session.gate_checked',
    { id: `gate-session-${index}`, revision: 1 },
    f.project.id,
    {
      results: durations.map((duration_ms, commandIndex) => ({
        name: ['Build', 'Lint', 'Test'][commandIndex],
        argv: ['fixture-check'],
        exit_code: commandIndex === failedAt || commandIndex === durations.length - 1 ? 1 : 0,
        duration_ms,
        timed_out: false,
        output: '',
        carried: carried && commandIndex === 0,
      })),
    },
  );
  f.store.db.prepare('UPDATE events SET created_at=? WHERE event_id=?').run(at, event.event_id);
}

it('finds a late gate failure at three runs with the median time spent on passing predecessors', async () => {
  const { f, signals } = await setup();
  gateFailure(f, 0, [10, 20, 5]);
  gateFailure(f, 1, [20, 30, 5]);
  expect(signals('late_gate_failure')).toEqual([]);
  gateFailure(f, 2, [30, 40, 5]);
  expect(signals('late_gate_failure')).toEqual([
    {
      signal: 'late_gate_failure',
      retrospective_ids: [],
      evidence: { kind: 'late_gate_failure', name: 'Test', runs: 3, median_prior_ms: 50 },
    },
  ]);
});

it('excludes first-command gate failures, failed or carried predecessors and old gate runs', async () => {
  const first = await setup();
  times(3, (index) => gateFailure(first.f, index, [10]));
  expect(first.signals('late_gate_failure')).toEqual([]);
  const earlier = await setup();
  times(3, (index) => gateFailure(earlier.f, index, [10, 20, 5], 0));
  expect(earlier.signals('late_gate_failure')).toEqual([]);
  const carried = await setup();
  times(3, (index) => gateFailure(carried.f, index, [10, 20, 5], 2, true));
  expect(carried.signals('late_gate_failure')).toEqual([]);
  const old = await setup();
  times(2, (index) => gateFailure(old.f, index, [10, 20, 5]));
  gateFailure(old.f, 2, [10, 20, 5], 2, false, old.f.store.now() - 7 * 24 * 60 * 60 * 1000 - 1);
  expect(old.signals('late_gate_failure')).toEqual([]);
});

it('offers the rule and source session only when the newest approval supports a project rule', async () => {
  const { f, signals } = await setup();
  const now = f.store.now();
  times(4, (index) => commandDecision(f, index, 'approved', now - 2000, undefined, false, true));
  commandDecision(f, 4, 'approved', now - 1000, undefined, false, true, 'newest-session');
  // A later inserted event can carry an older decision timestamp.
  commandDecision(f, 5, 'approved', now - 1500);
  expect(signals('always_approved_command')[0]!.evidence).toEqual({
    kind: 'always_approved_command',
    command: 'pnpm test --run',
    approvals: 6,
    rule: 'Bash(pnpm test)',
    session_id: 'newest-session',
  });
  commandDecision(f, 6, 'approved', now);
  expect(signals('always_approved_command')[0]!.evidence).toEqual({
    kind: 'always_approved_command',
    command: 'pnpm test --run',
    approvals: 7,
  });
});

it('finds no hand-back loop while disabled and preserves the limit of earlier policy versions', async () => {
  const { f, retro, policy, signals } = await setup();
  const current = policy({ handback_limit: 0, policy_version: 2 });
  f.store.event('workflow.policy_changed', current, f.project.id, {
    param: 'handback_limit',
    from: 3,
    to: 0,
    policy_version: 2,
  });
  retro({ handbacks: [{ reason: 'gate_failed' }] });
  retro({ policy_version: 2, handbacks: [] });
  const earlier = retro({
    policy_version: 1,
    handbacks: times(3, () => ({ reason: 'gate_failed' })),
  });
  expect(signals('handback_loop')).toEqual([
    { signal: 'handback_loop', retrospective_ids: [earlier] },
  ]);
});
