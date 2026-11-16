import { expect, it } from 'vitest';
import type { Project, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, insideSandbox, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

async function idleSession(f: Fixture) {
  const session = f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return session;
}

function setGate(f: Fixture, commands: { name: string; argv: string[] }[]) {
  f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands,
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

function recordGateRun(
  f: Fixture,
  sessionId: string,
  commit: string,
  results: {
    name: string;
    argv: string[];
    exit_code: number | null;
    duration_ms: number;
    timed_out: boolean;
    output?: string;
  }[],
) {
  const session = current(f, sessionId);
  return f.store.event('session.gate_checked', session, session.project_id, {
    workspace_id: session.workspace_id,
    commit,
    check_spec_hash: 'spec',
    results: results.map((r) => ({ output: '', ...r })),
  });
}

it('returns three gate runs newest first with the right commits and durations', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f, [{ name: 'Verify', argv: ['node', '-e', '0'] }]);

  const e1 = recordGateRun(f, session.id, '1'.repeat(40), [
    { name: 'Verify', argv: ['node', '-e', '0'], exit_code: 0, duration_ms: 100, timed_out: false },
  ]);
  const e2 = recordGateRun(f, session.id, '2'.repeat(40), [
    { name: 'Verify', argv: ['node', '-e', '0'], exit_code: 0, duration_ms: 200, timed_out: false },
  ]);
  const e3 = recordGateRun(f, session.id, '3'.repeat(40), [
    { name: 'Verify', argv: ['node', '-e', '0'], exit_code: 0, duration_ms: 300, timed_out: false },
  ]);

  const history = f.control.sessionGatesHistory(user, session.id);
  expect(history.runs).toHaveLength(3);
  expect(history.runs.map((r) => r.run_id)).toEqual([e3.event_id, e2.event_id, e1.event_id]);
  expect(history.runs.map((r) => r.commit)).toEqual([
    '3'.repeat(40),
    '2'.repeat(40),
    '1'.repeat(40),
  ]);
  expect(history.runs.map((r) => r.results[0]!.duration_ms)).toEqual([300, 200, 100]);
  expect(history.runs[0]!.finished_at).toBe(new Date(e3.created_at).toISOString());
  expect(Date.parse(history.runs[0]!.started_at)).toBeLessThanOrEqual(e3.created_at);
  expect(history.runs[0]!.results[0]!.command).toEqual(['node', '-e', '0']);
});

const pnpm = (name: string) => ({ name, argv: ['pnpm', name] });

it.each([
  {
    name: 'lists commands after a failing command as skipped',
    gate: ['build', 'test', 'lint'],
    ran: [
      { ...pnpm('build'), exit_code: 0, duration_ms: 120, timed_out: false },
      { ...pnpm('test'), exit_code: 1, duration_ms: 250, timed_out: false },
    ],
    results: [
      {
        name: 'build',
        command: ['pnpm', 'build'],
        exit_code: 0,
        timed_out: false,
        duration_ms: 120,
      },
      { name: 'test', command: ['pnpm', 'test'], exit_code: 1, timed_out: false, duration_ms: 250 },
      { name: 'lint', command: ['pnpm', 'lint'], skipped: true },
    ],
  },
  {
    name: 'counts a command without an exit code as failed and lists the commands after it as skipped',
    gate: ['build', 'test'],
    ran: [{ ...pnpm('build'), exit_code: null, duration_ms: 90, timed_out: false }],
    results: [
      {
        name: 'build',
        command: ['pnpm', 'build'],
        exit_code: null,
        timed_out: false,
        duration_ms: 90,
      },
      { name: 'test', command: ['pnpm', 'test'], skipped: true },
    ],
  },
])('$name', async ({ gate, ran, results }) => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f, gate.map(pnpm));

  recordGateRun(f, session.id, 'a'.repeat(40), ran);

  const history = f.control.sessionGatesHistory(user, session.id);
  expect(history.runs).toHaveLength(1);
  expect(history.runs[0]!.results).toEqual(results);
});

it('limits the returned gate run history', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f, [{ name: 'check', argv: ['true'] }]);

  recordGateRun(f, session.id, '1'.repeat(40), [
    { name: 'check', argv: ['true'], exit_code: 0, duration_ms: 50, timed_out: false },
  ]);
  const e2 = recordGateRun(f, session.id, '2'.repeat(40), [
    { name: 'check', argv: ['true'], exit_code: 0, duration_ms: 60, timed_out: false },
  ]);
  const e3 = recordGateRun(f, session.id, '3'.repeat(40), [
    { name: 'check', argv: ['true'], exit_code: 0, duration_ms: 70, timed_out: false },
  ]);

  const limited = f.control.sessionGatesHistory(user, session.id, 2);
  expect(limited.runs).toHaveLength(2);
  expect(limited.runs.map((r) => r.run_id)).toEqual([e3.event_id, e2.event_id]);
});

it('refuses access to another project principal', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f, [{ name: 'check', argv: ['true'] }]);

  const otherPrincipal = {
    id: 'other-agent',
    role: 'worker' as const,
    project_id: 'other-project',
  };
  expect(() => f.control.sessionGatesHistory(otherPrincipal, session.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('reads started_at from the gate_started event when recorded', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  setGate(f, [{ name: 'check', argv: ['true'] }]);

  const startEvent = f.store.event('session.gate_started', session, session.project_id, {
    workspace_id: session.workspace_id,
    candidate_path: '/tmp/cand',
    commit: 'c'.repeat(40),
    check_spec_hash: 'spec',
  });
  const checkEvent = f.store.event('session.gate_checked', session, session.project_id, {
    workspace_id: session.workspace_id,
    commit: 'c'.repeat(40),
    check_spec_hash: 'spec',
    results: [
      {
        name: 'check',
        argv: ['true'],
        exit_code: 0,
        duration_ms: 45,
        timed_out: false,
        output: '',
      },
    ],
  });

  const history = f.control.sessionGatesHistory(user, session.id);
  expect(history.runs[0]!.started_at).toBe(new Date(startEvent.created_at).toISOString());
  expect(history.runs[0]!.finished_at).toBe(new Date(checkEvent.created_at).toISOString());
});

it('reads skipped commands from the current configuration when configuration changed', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  // Run recorded with build (ok) and test (fail)
  recordGateRun(f, session.id, 'd'.repeat(40), [
    { name: 'build', argv: ['pnpm', 'build'], exit_code: 0, duration_ms: 50, timed_out: false },
    { name: 'test', argv: ['pnpm', 'test'], exit_code: 1, duration_ms: 80, timed_out: false },
  ]);

  // Gate configuration is updated after the run with an added lint command
  setGate(f, [
    { name: 'build', argv: ['pnpm', 'build'] },
    { name: 'test', argv: ['pnpm', 'test'] },
    { name: 'lint', argv: ['pnpm', 'lint'] },
  ]);

  const history = f.control.sessionGatesHistory(user, session.id);
  expect(history.runs[0]!.results).toHaveLength(3);
  expect(history.runs[0]!.results[2]).toEqual({
    name: 'lint',
    command: ['pnpm', 'lint'],
    skipped: true,
  });
});

it.skipIf(insideSandbox)(
  'lists the skipped commands the run had after its gate commands change',
  async () => {
    const f = workbenchFixture();
    const session = await idleSession(f);
    setGate(f, [
      { name: 'Fails', argv: [process.execPath, '-e', 'process.exit(1)'] },
      { name: 'Never ran', argv: [process.execPath, '-e', 'process.exit(0)'] },
    ]);
    f.call('session.gates.run', { session_id: session.id }, current(f, session.id).revision);
    await eventually(
      () => f.control.sessionGatesHistory(user, session.id).runs.length === 1,
      () => f.control.tick(),
      10000,
    );
    setGate(f, [
      { name: 'Fails', argv: [process.execPath, '-e', 'process.exit(1)'] },
      { name: 'Added later', argv: ['pnpm', 'lint'] },
      { name: 'Also added later', argv: ['pnpm', 'test'] },
    ]);

    const results = f.control.sessionGatesHistory(user, session.id).runs[0]!.results;
    expect(results.map(({ name, skipped }) => ({ name, skipped }))).toEqual([
      { name: 'Fails', skipped: undefined },
      { name: 'Never ran', skipped: true },
    ]);
    expect(results[1]!.command).toEqual([process.execPath, '-e', 'process.exit(0)']);
    expect(f.control.projectGatesHistory(user, f.project.id).runs[0]!.results).toEqual(results);
  },
);
