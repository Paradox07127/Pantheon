import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as validation from '../../packages/control/dist/validation-executor.js';
import type { Project, Session } from '@pantheon/domain';
import { insideSandbox, awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

async function idleSession(f: Fixture) {
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session, workspace };
}

function commit(repository: string, name: string, contents: string) {
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

const runGates = (f: Fixture, sessionId: string) =>
  f.call<Session>('session.gates.run', { session_id: sessionId }, current(f, sessionId).revision);

const payloads = (f: Fixture, sessionId: string, kind: string) =>
  (
    f.store.db
      .prepare('SELECT payload FROM events WHERE aggregate_id=? AND kind=? ORDER BY sequence')
      .all(sessionId, kind) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);

function setGate(f: Fixture, commands: { name: string; argv: string[] }[]) {
  f.call<Project>(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    f.store.must<Project>('projects', f.project.id).revision,
  );
}

it.skipIf(insideSandbox)(
  'runs the project gate on the worktree head without merging and reports the result',
  async () => {
    const f = workbenchFixture();
    const { session, workspace } = await idleSession(f);
    const sourceHead = git(f.source, 'rev-parse', 'HEAD');
    setGate(f, [
      { name: 'Prints ok', argv: [process.execPath, '-e', "process.stdout.write('ok')"] },
    ]);
    const head = commit(workspace.path, 'answer.txt', 'checked\n');
    expect(f.control.sessionGates(user, session.id)).toEqual({
      configured: true,
      commands: ['Prints ok'],
      running: false,
      last: null,
    });
    runGates(f, session.id);
    expect(f.control.sessionGates(user, session.id).running).toBe(true);
    expect(() => runGates(f, session.id)).toThrow(
      expect.objectContaining({ code: 'resource_busy' }),
    );
    expect(() =>
      f.call('session.merge', { session_id: session.id }, current(f, session.id).revision),
    ).toThrow(expect.objectContaining({ code: 'resource_busy' }));
    await eventually(
      () => payloads(f, session.id, 'session.gate_checked').length === 1,
      () => f.control.tick(),
      10000,
    );
    expect(payloads(f, session.id, 'session.gate_checked')[0]).toMatchObject({
      workspace_id: workspace.id,
      commit: head,
      results: [{ name: 'Prints ok', exit_code: 0, timed_out: false }],
    });
    await eventually(
      () => !f.control.sessionGates(user, session.id).running,
      () => f.control.tick(),
    );
    const gates = f.control.sessionGates(user, session.id);
    expect(gates).toMatchObject({
      configured: true,
      running: false,
      last: {
        commit: head,
        results: [{ name: 'Prints ok', exit_code: 0, timed_out: false, output_tail: 'ok' }],
      },
    });
    expect(typeof gates.last?.checked_at).toBe('number');
    expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
    expect(current(f, session.id).merge).toBeUndefined();
    expect(current(f, session.id).outcome).toBeUndefined();
  },
);

it.skipIf(insideSandbox)('keeps the output tail of a failing gate command', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  setGate(f, [
    {
      name: 'Always fails',
      argv: [process.execPath, '-e', "process.stderr.write('gate broke'); process.exit(3)"],
    },
  ]);
  const head = git(workspace.path, 'rev-parse', 'HEAD');
  runGates(f, session.id);
  await eventually(
    () => f.control.sessionGates(user, session.id).last !== null,
    () => f.control.tick(),
    10000,
  );
  const [result] = f.control.sessionGates(user, session.id).last!.results;
  expect(f.control.sessionGates(user, session.id).last!.commit).toBe(head);
  expect(result).toMatchObject({ name: 'Always fails', exit_code: 3, timed_out: false });
  expect(result!.output_tail).toContain('gate broke');
});

it('refuses to run gates when no gate or acceptance commands are configured', async () => {
  const f = workbenchFixture();
  const { session } = await idleSession(f);
  expect(f.control.sessionGates(user, session.id)).toEqual({
    configured: false,
    running: false,
    last: null,
  });
  expect(() => runGates(f, session.id)).toThrow(
    expect.objectContaining({
      code: 'invalid_state',
      message: 'No gate or acceptance commands are configured',
    }),
  );
  expect(payloads(f, session.id, 'session.gate_started')).toHaveLength(0);
});

it('refuses to run the gates while the session merges', async () => {
  const f = workbenchFixture();
  const { session } = await idleSession(f);
  setGate(f, [{ name: 'Prints ok', argv: [process.execPath, '-e', "process.stdout.write('ok')"] }]);
  f.store.transaction(() => {
    const open = current(f, session.id);
    f.store.update('sessions', { ...open, merge: { state: 'running' as const } }, open.revision);
  });
  expect(() => runGates(f, session.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
});

it('refuses to run the gates of an ended session', async () => {
  const f = workbenchFixture();
  const { session } = await idleSession(f);
  setGate(f, [{ name: 'Prints ok', argv: [process.execPath, '-e', "process.stdout.write('ok')"] }]);
  f.call<Session>('session.discard', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(() => runGates(f, session.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
});

function validationResult(): validation.ValidationResult {
  return {
    exit_code: 0,
    signal: null,
    duration_ms: 5,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: 'new output',
    timedOut: false,
    stdout_sha256: '',
    stderr_sha256: '',
    output_truncated: false,
    tests: { passed: 41, failed: 0, skipped: 2 },
    boundary: {
      kind: 'macos-seatbelt',
      network: 'loopback',
      supported: true,
      stop_scope: 'process-group',
    },
  };
}

it('repeats failed and skipped steps while carrying passed results and their test counts', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  const commands = ['Passed', 'Failed', 'Skipped'].map((name) => ({ name, argv: ['check', name] }));
  setGate(f, commands);
  f.call('workflow.policy.set', { project_id: f.project.id, gate_runner: 'session' });
  const head = commit(workspace.path, 'answer.txt', 'checked\n');
  const tests = { passed: 41, failed: 0, skipped: 2 };
  f.store.event('session.gate_started', session, session.project_id, { commands });
  f.store.event('session.gate_checked', session, session.project_id, {
    commit: head,
    results: [
      { ...commands[0]!, exit_code: 0, timed_out: false, duration_ms: 7, output: 'earlier', tests },
      { ...commands[1]!, exit_code: 1, timed_out: false, duration_ms: 8, output: 'failed' },
    ],
  });
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult());
  f.call(
    'session.gates.run',
    { session_id: session.id, only_failed: true },
    current(f, session.id).revision,
  );
  await eventually(
    () => !f.control.sessionGates(user, session.id).running,
    () => f.control.tick(),
    10000,
  );
  expect(execute.mock.calls.map(([input]) => input.argv)).toEqual([
    commands[1]!.argv,
    commands[2]!.argv,
  ]);
  expect(payloads(f, session.id, 'session.gate_checked').at(-1)).toMatchObject({
    commit: head,
    results: [
      { name: 'Passed', carried: true, output: 'earlier', duration_ms: 7, tests },
      { name: 'Failed', exit_code: 0, tests },
      { name: 'Skipped', exit_code: 0, tests },
    ],
  });
  expect(f.control.sessionGates(user, session.id).last!.results).toMatchObject([
    { name: 'Passed', carried: true, tests },
    { name: 'Failed', tests },
    { name: 'Skipped', tests },
  ]);
  const history = f.control.sessionGatesHistory(user, session.id).runs[0]!;
  expect(history.results).toMatchObject([
    { name: 'Passed', carried: true, tests },
    { name: 'Failed', tests },
    { name: 'Skipped', tests },
  ]);
  expect(history.results.slice(1).every((result) => !result.carried)).toBe(true);
  expect(f.control.projectGatesHistory(user, f.project.id).runs[0]!.results).toEqual(
    history.results,
  );
  expect((await f.control.sessionPreflight(user, session.id)).gate.last).toBe('passed');
});

it('reruns the passed steps before a failed one as setup in a fresh candidate clone', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  const commands = ['Build', 'Test'].map((name) => ({ name, argv: ['check', name] }));
  setGate(f, commands);
  const head = commit(workspace.path, 'answer.txt', 'checked\n');
  f.store.event('session.gate_started', session, session.project_id, { commands });
  f.store.event('session.gate_checked', session, session.project_id, {
    commit: head,
    results: [
      { ...commands[0]!, exit_code: 0, timed_out: false, duration_ms: 7, output: 'earlier' },
      { ...commands[1]!, exit_code: 1, timed_out: false, duration_ms: 8, output: 'failed' },
    ],
  });
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult());
  f.call(
    'session.gates.run',
    { session_id: session.id, only_failed: true },
    current(f, session.id).revision,
  );
  await eventually(
    () => !f.control.sessionGates(user, session.id).running,
    () => f.control.tick(),
    10000,
  );
  expect(execute.mock.calls.map(([input]) => input.argv)).toEqual([
    commands[0]!.argv,
    commands[1]!.argv,
  ]);
  const results = payloads(f, session.id, 'session.gate_checked').at(-1)!.results as {
    carried?: boolean;
  }[];
  expect(results).toMatchObject([
    { name: 'Build', exit_code: 0, output: 'new output' },
    { name: 'Test', exit_code: 0 },
  ]);
  expect(results.some((result) => result.carried)).toBe(false);
});

it.each(['no previous run', 'no failures', 'head moved', 'dirty worktree'])(
  'refuses only_failed with %s',
  async (reason) => {
    const f = workbenchFixture();
    const { session, workspace } = await idleSession(f);
    const commands = [{ name: 'Check', argv: ['check'] }];
    setGate(f, commands);
    if (reason !== 'no previous run') {
      f.store.event('session.gate_checked', session, session.project_id, {
        commit: git(workspace.path, 'rev-parse', 'HEAD'),
        results: [
          {
            ...commands[0]!,
            exit_code: reason === 'no failures' ? 0 : 1,
            timed_out: false,
            duration_ms: 5,
            output: '',
          },
        ],
      });
    }
    if (reason === 'head moved') commit(workspace.path, 'answer.txt', 'moved\n');
    if (reason === 'dirty worktree')
      writeFileSync(path.join(workspace.path, 'untracked.txt'), 'dirty');
    expect(() =>
      f.call(
        'session.gates.run',
        { session_id: session.id, only_failed: true },
        current(f, session.id).revision,
      ),
    ).toThrow(expect.objectContaining({ code: 'gate_retry_unavailable' }));
    expect(payloads(f, session.id, 'session.gate_run_requested')).toHaveLength(0);
  },
);

it('keeps test counts on the gate failure returned with a blocked merge', async () => {
  const f = workbenchFixture();
  const { session, workspace } = await idleSession(f);
  setGate(f, [{ name: 'Tests', argv: ['check'] }]);
  commit(workspace.path, 'answer.txt', 'checked\n');
  const tests = { passed: 41, failed: 3, skipped: 2 };
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue({
    ...validationResult(),
    exit_code: 1,
    tests,
  });
  f.call('session.merge', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );
  expect(current(f, session.id).merge!.gate).toMatchObject({ name: 'Tests', tests });
  expect(f.list().find((listed) => listed.id === session.id)!.merge!.gate).toMatchObject({
    name: 'Tests',
    tests,
  });
});
