import { expect, it, vi } from 'vitest';
import type { Project, Session, Workspace } from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const result = (exit_code: number | null = 0, timedOut = false): validation.ValidationResult => ({
  exit_code,
  timedOut,
  signal: null,
  duration_ms: 1,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  log: Buffer.alloc(0),
  tail: exit_code ? 'check failed' : '',
  stdout_sha256: '',
  stderr_sha256: '',
  output_truncated: false,
  boundary: {
    kind: 'macos-seatbelt',
    network: 'loopback',
    supported: true,
    stop_scope: 'process-group',
  },
});
async function setup(commands: object[]) {
  const f = workbenchFixture({ delay: 1 });
  const session = f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id).every((t) => t.state === 'completed'),
    () => f.control.tick(),
  );
  f.call(
    'project.gate.set',
    { project_id: f.project.id, root: f.source, commands },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  return { f, session, workspace: f.store.must<Workspace>('workspaces', session.workspace_id!) };
}
const run = (f: ReturnType<typeof workbenchFixture>, session: Session) =>
  f.call(
    'session.gates.run',
    { session_id: session.id },
    f.store.must<Session>('sessions', session.id).revision,
  );

it('updates the live split after each step and never counts a skipped or disabled step as passed', async () => {
  const release = Promise.withResolvers<validation.ValidationResult>();
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockImplementation(async (input) =>
      input.argv[0] === 'wait' ? release.promise : result(input.argv[0] === 'optional' ? 3 : 0),
    );
  const { f, session } = await setup([
    { name: 'disabled', argv: ['disabled'], enabled: false },
    { name: 'pass', argv: ['pass'] },
    { name: 'optional', argv: ['optional'], skippable: true },
    { name: 'wait', argv: ['wait'] },
  ]);
  await run(f, session);
  await eventually(
    () => execute.mock.calls.some(([input]) => input.argv[0] === 'wait'),
    () => f.control.tick(),
  );
  expect(f.list().find((s) => s.id === session.id)?.gate).toMatchObject({
    passed: 1,
    failed: 0,
    skipped: 1,
    running: 1,
  });
  release.resolve(result());
  await eventually(
    () => !f.control.sessionGates(user, session.id).running,
    () => f.control.tick(),
  );
  expect(execute.mock.calls.map(([input]) => input.argv[0])).toEqual(['pass', 'optional', 'wait']);
  expect(f.control.sessionGates(user, session.id).last?.results).toContainEqual(
    expect.objectContaining({ name: 'optional', state: 'skipped', reason: 'check failed' }),
  );
});

it('retries only failed gates once and carries successes', async () => {
  let attempts = 0;
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockImplementation(async (input) =>
      result(input.argv[0] === 'flaky' && attempts++ === 0 ? 3 : 0),
    );
  const { f, session } = await setup([
    { name: 'pass', argv: ['pass'] },
    { name: 'flaky', argv: ['flaky'] },
    { name: 'last', argv: ['last'] },
  ]);
  f.call('workflow.policy.set', { project_id: f.project.id, gate_on_fail: 'retry' });
  await run(f, session);
  await eventually(
    () => !f.control.sessionGates(user, session.id).running,
    () => f.control.tick(),
  );
  expect(execute.mock.calls.map(([input]) => input.argv[0])).toEqual([
    'pass',
    'flaky',
    'flaky',
    'last',
  ]);
  expect(
    f.control.sessionGates(user, session.id).last?.results.every((r) => r.exit_code === 0),
  ).toBe(true);
});

it('runs local session gates in the session workspace with the configured timeout', async () => {
  const execute = vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(result());
  const { f, session, workspace } = await setup([
    { name: 'check', argv: ['check'], timeout_ms: 1234 },
  ]);
  f.call('workflow.policy.set', { project_id: f.project.id, gate_runner: 'session' });
  await run(f, session);
  await eventually(
    () => !f.control.sessionGates(user, session.id).running,
    () => f.control.tick(),
  );
  expect(execute.mock.calls[0]![0]).toMatchObject({ cwd: workspace.path, timeoutMs: 1234 });
});

it('marks only the fresh gate clone as a disposable root', async () => {
  const execute = vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(result());
  const { f, session, workspace } = await setup([{ name: 'check', argv: ['check'] }]);
  const idle = () =>
    eventually(
      () => !f.control.sessionGates(user, session.id).running,
      () => f.control.tick(),
    );
  await run(f, session);
  await idle();
  expect(execute.mock.calls[0]![0].cwd).not.toBe(workspace.path);
  expect(execute.mock.calls[0]![0].disposable).toBe(true);
  f.call('workflow.policy.set', { project_id: f.project.id, gate_runner: 'session' });
  await run(f, session);
  await idle();
  expect(execute.mock.calls[1]![0]).toMatchObject({ cwd: workspace.path });
  expect(execute.mock.calls[1]![0].disposable).toBeUndefined();
});

it('refuses session gates in the live worktree while input waits for a turn', async () => {
  const { f, session } = await setup([{ name: 'check', argv: ['check'] }]);
  f.call('workflow.policy.set', { project_id: f.project.id, gate_runner: 'session' });
  const idle = f.store.must<Session>('sessions', session.id);
  f.store.update('sessions', { ...idle, state: 'running' }, idle.revision);
  expect(() => run(f, session)).toThrowError(expect.objectContaining({ code: 'invalid_state' }));
  expect(f.store.must<Session>('sessions', session.id).gate_run).toBeUndefined();
});

it('refuses remote session gates with unsupported_capability before starting an operation', async () => {
  const { f, session } = await setup([{ name: 'check', argv: ['check'] }]);
  f.call('workflow.policy.set', { project_id: f.project.id, gate_runner: 'session' });
  const current = f.store.must<Session>('sessions', session.id);
  f.store.update('sessions', { ...current, device_id: 'remote-device' }, current.revision);
  expect(() => run(f, session)).toThrowError(
    expect.objectContaining({ code: 'unsupported_capability' }),
  );
});

it.each(['timeout', 'cannot_start'])(
  'records a skippable %s failure with its reason and continues',
  async (failure) => {
    const execute = vi
      .spyOn(validation, 'runValidationCommand')
      .mockImplementation(async (input) =>
        input.argv[0] === 'optional'
          ? { ...result(null, failure === 'timeout'), error: failure }
          : result(),
      );
    const { f, session } = await setup([
      { name: 'optional', argv: ['optional'], skippable: true },
      { name: 'last', argv: ['last'] },
    ]);
    await run(f, session);
    await eventually(
      () => !f.control.sessionGates(user, session.id).running,
      () => f.control.tick(),
    );
    expect(f.control.sessionGates(user, session.id).last?.results).toMatchObject([
      { name: 'optional', state: 'skipped', reason: failure },
      { name: 'last', state: 'passed' },
    ]);
    expect(execute.mock.calls.at(-1)![0].argv).toEqual(['last']);
  },
);

it('shows completed gate counts while a later command is still running', async () => {
  const release = Promise.withResolvers<validation.ValidationResult>();
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockImplementation(async (input) => (input.argv[0] === 'wait' ? release.promise : result()));
  const { f, session } = await setup([
    { name: 'pass', argv: ['pass'] },
    { name: 'wait', argv: ['wait'] },
  ]);
  await run(f, session);
  await eventually(
    () => execute.mock.calls.length === 2,
    () => f.control.tick(),
  );
  const gate = f.list().find((s) => s.id === session.id)?.gate;
  release.resolve(result());
  expect(gate).toMatchObject({ passed: 1, failed: 0, running: 1 });
});
