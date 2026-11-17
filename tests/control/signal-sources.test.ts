import { expect, it, vi } from 'vitest';
import { id, type LandingItem, type Session, type SignalIssue, type Timer } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { normalizeErrorLine, recordGateRun } from '../../packages/control/dist/signal-sources.js';
import { workbenchFixture } from './workbench-fixture.js';

type GateResult = NonNullable<LandingItem['gate_results']>[number];

const MINUTE = 60_000,
  HOUR = 60 * MINUTE;

const failure = 'FAIL tests/totals.test.ts > adds\nAssertionError: expected 3 to be 4';

const check = (name: string, passed: boolean, extra: Partial<GateResult> = {}): GateResult => ({
  name,
  argv: ['pnpm', name],
  exit_code: passed ? 0 : 1,
  duration_ms: 10,
  timed_out: false,
  output: passed ? 'All checks passed' : failure,
  ...(passed ? {} : { state: 'failed' as const, failure_class: 'code' as const }),
  ...extra,
});

const environmentCheck = (name: string) =>
  check(name, false, {
    exit_code: null,
    timed_out: true,
    failure_class: 'environment',
    output: `${name} timed out after 1200000 ms`,
  });

/** A project on a clock that moves only by advance, with sessions and gate runs written as their owners write them. */
async function sourceFixture() {
  const f = await workbenchFixture();
  let now = Date.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const session = (fields: Partial<Session> = {}) =>
    f.store.insert<Session>('sessions', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      requested_model: 'fixture-large',
      state: 'open',
      turn_count: 0,
      ...fields,
    });
  const taskSession = (taskId: string) =>
    session({ task: { lead_session_id: 'lead-session', id: taskId } });
  const gateRun = (owner: Session, commit: string, results: GateResult[]) =>
    f.store.transaction(() => {
      f.store.event('session.gate_checked', owner, f.project.id, { commit, results });
      recordGateRun(ctx, { project_id: f.project.id, session_id: owner.id, commit, results });
    });
  const turnEnd = (
    owner: Session,
    status: 'completed' | 'failed',
    fields: { error?: string; error_code?: string } = {},
  ) =>
    agentEvent(ctx, owner.id, {
      key: id(),
      provider_sequence: 1,
      kind: 'turn.completed',
      status,
      ...fields,
    });
  const issues = (source: SignalIssue['source']) =>
    f.store
      .list<SignalIssue>('signal_issues')
      .filter((issue) => issue.project_id === f.project.id && issue.source === source);
  return {
    f,
    session,
    taskSession,
    gateRun,
    turnEnd,
    issues,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it('normalizes numbers, hashes, paths and quoted strings out of an error line and keeps different errors apart', () => {
  expect(normalizeErrorLine('AssertionError: expected 3 to be 4')).toBe(
    normalizeErrorLine('AssertionError: expected 17 to be 250'),
  );
  expect(normalizeErrorLine('Object 3f9a2c1d8e is missing')).toBe(
    normalizeErrorLine('Object b07e44a19c2f is missing'),
  );
  expect(normalizeErrorLine('Cannot open /Users/ada/project/src/totals.ts')).toBe(
    normalizeErrorLine('Cannot open /home/runner/work/app/src/other.ts'),
  );
  expect(normalizeErrorLine(`Cannot find module 'left-pad'`)).toBe(
    normalizeErrorLine(`Cannot find module 'right-pad'`),
  );
  expect(normalizeErrorLine('AssertionError: expected 3 to be 4')).not.toBe(
    normalizeErrorLine('TypeError: totals is not a function'),
  );
});

it('records no issue for one task retrying its failing check, and one when a second task fails it the same way within a day', async () => {
  const { taskSession, gateRun, issues, advance } = await sourceFixture();
  const first = taskSession('task-first'),
    second = taskSession('task-second');
  for (const commit of ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']) {
    gateRun(first, commit, [check('typecheck', true), check('test', false)]);
    advance(10 * MINUTE);
  }
  expect(issues('gate_failures')).toEqual([]);

  advance(20 * HOUR);
  gateRun(second, 'd4e5f6a7', [check('typecheck', true), check('test', false)]);
  expect(issues('gate_failures')).toHaveLength(1);
  expect(issues('gate_failures')[0]).toMatchObject({ state: 'new', priority: 'interrupt' });

  gateRun(second, 'e5f6a7b8', [check('typecheck', true), check('test', true)]);
  expect(issues('gate_failures')[0]!.state).toBe('new');
  gateRun(first, 'f6a7b8c9', [check('typecheck', true), check('test', true)]);
  expect(issues('gate_failures')[0]!.state).toBe('resolved');
});

it('records a check that failed because of its environment at once', async () => {
  const { taskSession, gateRun, issues } = await sourceFixture();
  gateRun(taskSession('task-first'), 'a1b2c3d4', [
    check('install', true),
    environmentCheck('test'),
  ]);
  expect(issues('gate_failures')).toHaveLength(1);
  expect(issues('gate_failures')[0]).toMatchObject({ state: 'new' });
  expect(issues('gate_failures')[0]!.fingerprint.startsWith('test:')).toBe(true);
});

it('records one environment issue for a run whose checks nearly all failed and mutes the checks of that run', async () => {
  const { taskSession, gateRun, issues } = await sourceFixture();
  const names = Array.from({ length: 12 }, (_, index) => `check-${index}`);
  gateRun(
    taskSession('task-first'),
    'a1b2c3d4',
    names.map((name, index) => (index === 0 ? check(name, true) : environmentCheck(name))),
  );
  const environment = issues('gate_failures').filter((issue) =>
    issue.fingerprint.startsWith('environment:'),
  );
  expect(environment).toHaveLength(1);
  expect(environment[0]).toMatchObject({ state: 'new', priority: 'interrupt' });
  const checks = issues('gate_failures').filter((issue) => issue.id !== environment[0]!.id);
  expect(checks).toHaveLength(11);
  expect(
    checks.every((issue) => issue.state === 'muted' && issue.muted_by === environment[0]!.id),
  ).toBe(true);
});

it('records one flaky issue when a check passes and then fails on the same commit', async () => {
  const { taskSession, gateRun, issues, advance } = await sourceFixture();
  const owner = taskSession('task-first');
  gateRun(owner, 'a1b2c3d4e5f6', [check('test', true)]);
  expect(issues('flaky_tests')).toEqual([]);
  advance(MINUTE);
  gateRun(owner, 'a1b2c3d4e5f6', [check('test', false)]);
  expect(issues('flaky_tests')).toHaveLength(1);
  expect(issues('flaky_tests')[0]).toMatchObject({
    fingerprint: 'test',
    title: 'test passed and failed on a1b2c3d',
    priority: 'record',
  });
});

it('makes one outage of three sessions failing alike within five minutes, mutes their issue, and resolves both on a completed turn', async () => {
  const { session, turnEnd, issues, advance } = await sourceFixture();
  const sessions = [session(), session(), session()];
  const outages = () =>
    issues('session_failures').filter((issue) => issue.fingerprint.startsWith('outage:'));
  turnEnd(sessions[0]!, 'failed', { error: 'Overloaded', error_code: 'overloaded' });
  advance(MINUTE);
  turnEnd(sessions[1]!, 'failed', { error: 'Overloaded', error_code: 'overloaded' });
  expect(outages()).toEqual([]);
  expect(issues('session_failures')).toHaveLength(1);

  advance(MINUTE);
  turnEnd(sessions[2]!, 'failed', { error: 'Overloaded', error_code: 'overloaded' });
  expect(outages()).toHaveLength(1);
  const outage = outages()[0]!;
  expect(outage).toMatchObject({ state: 'new', priority: 'interrupt' });
  const single = issues('session_failures').find((issue) => issue.id !== outage.id)!;
  expect(single).toMatchObject({
    fingerprint: `overloaded:${sessions[0]!.runtime}:fixture-large`,
    state: 'muted',
    muted_by: outage.id,
  });

  advance(MINUTE);
  turnEnd(sessions[0]!, 'completed');
  expect(issues('session_failures').map((issue) => issue.state)).toEqual(['resolved', 'resolved']);
});

it('records nothing for a turn that waits for a used-up usage limit', async () => {
  const { f, session, turnEnd, issues } = await sourceFixture();
  turnEnd(session(), 'failed', { error: 'Usage limit reached', error_code: 'usage_limit' });
  expect(issues('session_failures')).toEqual([]);
  expect(f.store.list<Timer>('timers').filter((timer) => timer.kind === 'signal-hold')).toEqual([]);
});
