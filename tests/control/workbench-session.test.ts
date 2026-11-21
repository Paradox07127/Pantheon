import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ClaudeAdapter, CodexAdapter, FixtureAdapter } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST } from '@pantheon/domain';
import type {
  Approval,
  BoardPlan,
  HarnessAdapter,
  Principal,
  Project,
  Session,
  SessionSpec,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { MEMORY_INSTRUCTIONS } from '../../packages/control/dist/memory.js';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

it('creates a worktree session whose first turn starts as a writer once the worktree is ready', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  expect(session).toMatchObject({ state: 'running', permission_mode: 'ask', turn_count: 1 });
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(workspace).toMatchObject({ kind: 'linked_worktree', source: f.source });
  expect(f.turns(session.id)).toMatchObject([{ state: 'queued', delivery: 'pending' }]);
  await f.control.tick();
  expect(f.start).not.toHaveBeenCalled();
  const ready = await awaitWorkspaceReady(f.control, workspace);
  await eventually(
    () => f.start.mock.calls.length > 0,
    () => f.control.tick(),
  );
  const spec = f.start.mock.calls[0]![0] as SessionSpec;
  const { worktreeSandbox } = await import('../../packages/control/dist/protection.js');
  const { writerTempDirectory } = await import('../../packages/control/dist/workspace-removal.js');
  const tempDir = writerTempDirectory(ready.id);
  f.temporaryDirectories.push(tempDir);
  const expected = worktreeSandbox({
    ...f.protectionPaths,
    otherWorkspaces: [],
    sourceRepo: f.source,
    workspacePath: ready.path,
    worktreeId: path.basename(ready.path),
    tempDir,
  });
  expect(spec).toMatchObject({
    role: 'writer',
    cwd: ready.path,
    workspace: { id: ready.id, path: ready.path },
    env: { TMPDIR: tempDir },
    extensions: { mode: 'inherit' },
  });
  expect(spec.control_instructions ?? '').toBe('');
  expect(spec.pantheon_mcp).toBeUndefined();
  expect(spec.sandbox!.writable_roots).toEqual(expected.writable_roots);
  expect(spec.sandbox!.protected_entries).toEqual(
    expect.arrayContaining(expected.protected_entries.map(({ path, deny }) => ({ path, deny }))),
  );
  await eventually(
    () => f.turns(session.id)[0]!.state === 'completed',
    () => f.control.tick(),
  );
});

it('keeps a turn within the timer range', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await awaitWorkspaceReady(
    f.control,
    f.store.must<Workspace>('workspaces', session.workspace_id!),
  );
  await eventually(
    () => f.start.mock.calls.length > 0,
    () => f.control.tick(),
  );
  const spec = f.start.mock.calls[0]![0] as SessionSpec;
  // setTimeout fires at once for delays above 2^31 - 1 ms.
  expect(spec.budget.wall_time_ms).toBeLessThanOrEqual(2 ** 31 - 1);
});
it('runs a second message after the first turn ends', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'completed',
    () => f.control.tick(),
  );
  await eventually(() => f.store.must<Session>('sessions', session.id).state === 'open');
  const current = f.store.must<Session>('sessions', session.id);
  const next = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Now add a test' },
    current.revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', next.id).state === 'completed',
    () => f.control.tick(),
  );
});

it('lists workbench sessions with their state, title and unanswered permission requests', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const input = '  Make the answer file say hello and commit the change with a clear message  ';
  const session = await f.create(input);
  expect(f.list()).toMatchObject([
    {
      id: session.id,
      title: `${input.trim().slice(0, 39)}…`,
      runtime: f.adapter.name,
      model: null,
      permission_mode: 'ask',
      workspace_id: session.workspace_id,
      state: 'starting',
      waiting: 0,
    },
  ]);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  expect(f.list()[0]!.state).toBe('running');
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  expect(f.list()[0]!.state).toBe('idle');
  const approval: Approval = {
    id: 'pending-permission',
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: session.id,
    request_id: 'request-1',
    tool: 'Bash',
    input_hash: 'a'.repeat(64),
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
  };
  f.store.insert('approvals', approval);
  expect(f.list()[0]).toMatchObject({ state: 'waiting', waiting: 1 });
});

it('renames a workbench session, trims its title and publishes the new title', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const renamed = f.call<Session>(
    'session.rename',
    { session_id: session.id, title: '  新的会话标题  ' },
    session.revision,
    { ...user, project_id: f.project.id },
  );
  expect(renamed).toEqual({
    ...session,
    title: '新的会话标题',
    title_source: 'user',
    revision: session.revision + 1,
  });
  expect(f.store.must<Session>('sessions', session.id)).toEqual(renamed);
  expect(f.list()[0]!.title).toBe('新的会话标题');
  expect(f.store.kindEvents(f.project.id, ['session.renamed'])).toMatchObject([
    {
      aggregate_id: session.id,
      aggregate_revision: renamed.revision,
      payload: { title: renamed.title },
    },
  ]);
});

it('titles a session from the first non-empty line of its first message', async () => {
  const f = await workbenchFixture();
  expect((await f.create('\n   \n  Fix the importer  \nIt drops the last row')).title).toBe(
    'Fix the importer',
  );
  expect((await f.create(`${'字'.repeat(50)}\nsecond line`)).title).toBe(`${'字'.repeat(39)}…`);
  expect((await f.create('字'.repeat(40))).title).toBe('字'.repeat(40));
  // The 39th and 40th units are one emoji, so the cut falls before it.
  expect((await f.create(`${'a'.repeat(38)}😀 and more`)).title).toBe(`${'a'.repeat(38)}…`);
});

it.each(['', ' \n\t '])('rejects an empty title after trimming: %j', async (title) => {
  const f = await workbenchFixture();
  const session = await f.create();
  // The daemon translates schema errors to invalid_input.
  expect(() =>
    f.call('session.rename', { session_id: session.id, title }, session.revision),
  ).toThrow(expect.objectContaining({ name: 'ZodError' }));
  expect(f.store.must<Session>('sessions', session.id)).toEqual(session);
  expect(f.store.kindEvents(f.project.id, ['session.renamed'])).toEqual([]);
});

it('accepts titles of one or eighty characters and rejects longer titles', async () => {
  const f = await workbenchFixture();
  let session = await f.create();
  for (const title of ['字', '字'.repeat(80)]) {
    session = f.call<Session>(
      'session.rename',
      { session_id: session.id, title: `  ${title}  ` },
      session.revision,
    );
    expect(session.title).toBe(title);
  }
  expect(() =>
    f.call('session.rename', { session_id: session.id, title: '字'.repeat(81) }, session.revision),
  ).toThrow(expect.objectContaining({ name: 'ZodError' }));
  expect(f.store.must<Session>('sessions', session.id)).toEqual(session);
});

it('refuses to rename a session in another project', async () => {
  const f = await workbenchFixture();
  const otherRoot = path.join(f.root, 'other-project');
  mkdirSync(otherRoot);
  const other = await f.call<Project>('project.open', {
    name: 'Other project',
    roots: [otherRoot],
  });
  const session = await f.call<Session>('session.create', {
    project_id: other.id,
    runtime: f.adapter.name,
    input: 'Work in the other project',
  });
  expect(() =>
    f.call('session.rename', { session_id: session.id, title: 'New title' }, session.revision, {
      ...user,
      project_id: f.project.id,
    }),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(f.store.must<Session>('sessions', session.id)).toEqual(session);
});

it.each(['merged', 'discarded'] as const)('renames a %s workbench session', async (outcome) => {
  const f = await workbenchFixture();
  const created = await f.create();
  const ended = f.store.update<Session>(
    'sessions',
    { ...created, state: 'closed', outcome },
    created.revision,
  );
  const renamed = f.call<Session>(
    'session.rename',
    { session_id: ended.id, title: 'Archived conversation' },
    ended.revision,
  );
  expect(renamed).toMatchObject({ state: 'closed', outcome, title: 'Archived conversation' });
  expect(f.list()[0]).toMatchObject({ state: outcome, title: 'Archived conversation' });
});

it('refuses session renames by non-users and renames of baseline sessions', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const planner: Principal = { id: 'planner', role: 'planner', project_id: f.project.id };
  expect(() =>
    f.call(
      'session.rename',
      { session_id: session.id, title: 'New title' },
      session.revision,
      planner,
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  const baseline = f.store.insert<Session>('sessions', {
    ...session,
    id: 'baseline-without-worktree',
    workspace_id: undefined,
    baseline: { baseline_id: 'baseline-a' },
  });
  expect(() =>
    f.call('session.rename', { session_id: baseline.id, title: 'New title' }, baseline.revision),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(f.store.must<Session>('sessions', baseline.id)).toEqual(baseline);
});

it('refuses a stale revision when renaming a session', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  expect(() =>
    f.call('session.rename', { session_id: session.id, title: 'New title' }, session.revision - 1),
  ).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
  expect(f.store.must<Session>('sessions', session.id)).toEqual(session);
});

it('fails the session without starting the runtime when the worktree cannot be prepared', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  renameSync(f.source, `${f.source}-moved`);
  await eventually(
    () =>
      ['failed', 'cancelled'].includes(
        f.store.must<Workspace>('workspaces', session.workspace_id!).provisioning!.state,
      ),
    () => f.control.tick(),
  );
  await f.control.tick();
  expect(f.list()[0]!.state).toBe('failed');
  expect(f.store.must<Session>('sessions', session.id).state).toBe('closed');
  expect(f.turns(session.id)).toMatchObject([{ state: 'failed', delivery: 'failed' }]);
  expect(f.start).not.toHaveBeenCalled();
});

it('starts the native session in the permission mode the session was created with', async () => {
  const f = await workbenchFixture();
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    permission_mode: 'plan',
    input: 'Plan the rename',
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.start.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect((f.start.mock.calls[0]![0] as SessionSpec).permission_mode).toBe('plan');
});

it('gives the native session of an unset permission mode the ask mode', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.start.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect((f.start.mock.calls[0]![0] as SessionSpec).permission_mode).toBe('ask');
});

it('changes the permission mode of a session and of its live native session', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const setPermissionMode = vi.fn(async () => ({ ok: true }));
  Object.assign(f.adapter, { setPermissionMode });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  const current = f.store.must<Session>('sessions', session.id);
  const changed = f.call<Session>(
    'session.setPermissionMode',
    { session_id: session.id, permission_mode: 'auto_edit' },
    current.revision,
  );
  expect(changed.permission_mode).toBe('auto_edit');
  expect(f.store.must<Session>('sessions', session.id).permission_mode).toBe('auto_edit');
  expect(f.list()[0]!.permission_mode).toBe('auto_edit');
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.kind === 'session.permission_mode_changed')
      .map((event) => [event.aggregate_id, event.payload]),
  ).toEqual([[session.id, { permission_mode: 'auto_edit' }]]);
  await eventually(() => setPermissionMode.mock.calls.length > 0);
  expect(setPermissionMode).toHaveBeenCalledWith(
    expect.objectContaining({ platform_session_id: session.id }),
    'auto_edit',
  );
});

it('refuses a permission mode the runtime cannot apply to a running turn', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const adapter: HarnessAdapter = f.adapter;
  expect(adapter.setPermissionMode).toBeUndefined();
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  expect(() =>
    f.call(
      'session.setPermissionMode',
      { session_id: session.id, permission_mode: 'plan' },
      f.store.must<Session>('sessions', session.id).revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
  expect(f.store.must<Session>('sessions', session.id).permission_mode).toBe('ask');
});

it('reopens an idle native session without a mode setter in the new permission mode', async () => {
  const f = await workbenchFixture();
  const resume = vi.spyOn(f.adapter, 'resume');
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  f.call(
    'session.setPermissionMode',
    { session_id: session.id, permission_mode: 'plan' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () =>
      ![...f.control.handles.values()].some((handle) => handle.platform_session_id === session.id),
  );
  const next = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Now plan the edit' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', next.id).state === 'completed',
    () => f.control.tick(),
  );
  // The fixture's start goes through resume, so the second resume reopens the session.
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledTimes(2);
  expect((resume.mock.calls[1]![0] as SessionSpec).permission_mode).toBe('plan');
});

it('applies a permission mode changed while the native session starts', async () => {
  const f = await workbenchFixture();
  const setPermissionMode = vi.fn(async () => ({ ok: true }));
  Object.assign(f.adapter, { setPermissionMode });
  const launch = Promise.withResolvers<void>();
  f.start.mockImplementation(async (spec, sink) => {
    await launch.promise;
    return FixtureAdapter.prototype.start.call(f.adapter, spec, sink);
  });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const ticking = f.control.tick();
  await eventually(() => f.start.mock.calls.length > 0);
  f.call(
    'session.setPermissionMode',
    { session_id: session.id, permission_mode: 'plan' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  launch.resolve();
  await ticking;
  await eventually(() => setPermissionMode.mock.calls.length > 0);
  expect((f.start.mock.calls[0]![0] as SessionSpec).permission_mode).toBe('ask');
  expect(setPermissionMode).toHaveBeenCalledWith(
    expect.objectContaining({ platform_session_id: session.id }),
    'plan',
  );
});

it('restores the previous permission mode when the runtime refuses the new one', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const setPermissionMode = vi.fn(async () => ({ ok: false, reason: 'native refused' }));
  Object.assign(f.adapter, { setPermissionMode });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  f.call(
    'session.setPermissionMode',
    { session_id: session.id, permission_mode: 'plan' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(() => f.store.must<Session>('sessions', session.id).permission_mode === 'ask');
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.kind.startsWith('session.permission_mode_'))
      .map((event) => [event.kind, event.payload]),
  ).toEqual([
    ['session.permission_mode_changed', { permission_mode: 'plan' }],
    ['session.permission_mode_failed', { error: 'native refused' }],
    ['session.permission_mode_changed', { permission_mode: 'ask' }],
  ]);
});

it('leaves the native mode alone when the permission mode command rolls back', async () => {
  const f = await workbenchFixture({ delay: 400 });
  const setPermissionMode = vi.fn(async () => ({ ok: true }));
  Object.assign(f.adapter, { setPermissionMode });
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'running',
    () => f.control.tick(),
  );
  Object.assign(f.control, {
    failpoint: (name: string) => {
      if (name === 'before_transaction_commit') throw new Error('commit failed');
    },
  });
  expect(() =>
    f.call(
      'session.setPermissionMode',
      { session_id: session.id, permission_mode: 'plan' },
      f.store.must<Session>('sessions', session.id).revision,
    ),
  ).toThrow('commit failed');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.store.must<Session>('sessions', session.id).permission_mode).toBe('ask');
  expect(setPermissionMode).not.toHaveBeenCalled();
});

it('runs no gate of a gate command that rolls back', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  await f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [
        { name: 'Prints ok', argv: [process.execPath, '-e', "process.stdout.write('ok')"] },
      ],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  Object.assign(f.control, {
    failpoint: (name: string) => {
      if (name === 'before_transaction_commit') throw new Error('commit failed');
    },
  });
  await expect(
    f.call(
      'session.gates.run',
      { session_id: session.id },
      f.store.must<Session>('sessions', session.id).revision,
    ),
  ).rejects.toThrow('commit failed');
  await eventually(() => !f.control.sessionGates(user, session.id).running, undefined, 10000);
  expect(
    f.store
      .events(0, undefined, 10000)
      .filter((event) => event.aggregate_id === session.id && event.kind.includes('gate')),
  ).toEqual([]);
});

it('changes only the stored mode of a session without a native session', async () => {
  const f = await workbenchFixture();
  const setPermissionMode = vi.fn(async () => ({ ok: true }));
  Object.assign(f.adapter, { setPermissionMode });
  const session = await f.create();
  f.call('session.setPermissionMode', { session_id: session.id, permission_mode: 'plan' }, 1);
  expect(f.store.must<Session>('sessions', session.id).permission_mode).toBe('plan');
  expect(setPermissionMode).not.toHaveBeenCalled();
});

it('refuses to change the permission mode of an ended session', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const discarded = f.call<Session>(
    'session.discard',
    { session_id: session.id },
    session.revision,
  );
  expect(discarded.outcome).toBe('discarded');
  expect(() =>
    f.call(
      'session.setPermissionMode',
      { session_id: session.id, permission_mode: 'plan' },
      discarded.revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(f.store.must<Session>('sessions', session.id).permission_mode).toBe('ask');
});

it('refuses a non-user principal and a daemon without a managed workspace root', async () => {
  const f = await workbenchFixture();
  const planner: Principal = {
    id: 'planner',
    role: 'planner',
    project_id: f.project.id,
  };
  expect(() => f.create('Do work', planner)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  const unmanaged = await workbenchFixture({ managedWorkspaces: false });
  expect(() => unmanaged.create()).toThrow(
    expect.objectContaining({
      code: 'invalid_workspace',
      message: expect.stringContaining('workspace root'),
    }),
  );
  expect(unmanaged.store.list<Session>('sessions')).toEqual([]);
  expect(unmanaged.store.list<Workspace>('workspaces')).toEqual([]);
});

const closings: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closings.splice(0)) await close();
  vi.unstubAllEnvs();
});

/** Daemon variables a session the user opened must not inherit. */
const deniedVariables = ['ANTHROPIC_API_KEY', 'PANTHEON_X', 'CLAUDE_CONFIG_DIR'];

/** Sets a plain daemon variable and one of each kind a session must not inherit. */
function stubDaemonEnvironment() {
  vi.stubEnv('PLAIN_DAEMON_VARIABLE', 'kept');
  for (const name of deniedVariables) vi.stubEnv(name, 'denied');
}

it.each([
  ['claude', 'AskUserQuestion', 'request_user_input'],
  ['codex', 'request_user_input', 'AskUserQuestion'],
])('tells a %s session to ask the user with its question tool', async (runtime, tool, other) => {
  const f = await workbenchFixture();
  f.control.adapters.delete(f.adapter.name);
  f.adapter.name = runtime;
  const real = runtime === 'claude' ? new ClaudeAdapter() : new CodexAdapter();
  Object.assign(f.adapter, { questionTool: real.questionTool });
  f.control.adapters.set(runtime, f.adapter);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const session = await setupSession(f);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const instructions = workbenchSessionSpec(
    ctx,
    f.store.must<Session>('sessions', session.id),
  ).control_instructions!;
  expect(instructions).toContain(tool);
  expect(instructions).not.toContain(other);
});

/** A project setup session, which asks the user with the runtime's question tool. */
const setupSession = (f: Awaited<ReturnType<typeof workbenchFixture>>) =>
  f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Set up the project',
    purpose: 'project_setup',
  });

/** A workbench fixture whose adapter is registered under the runtime name with the given declarations. */
async function declaredRuntime(runtime: string, declared: Partial<HarnessAdapter>) {
  const f = await workbenchFixture();
  f.control.adapters.delete(f.adapter.name);
  f.adapter.name = runtime;
  Object.assign(f.adapter, declared);
  f.control.adapters.set(runtime, f.adapter);
  return { ...f, ctx: (f.control as unknown as { ctx: ControlContext }).ctx };
}

it('asks with the question tool and lets the runtime title the session as its adapter declares', async () => {
  const f = await declaredRuntime('agy', { questionTool: 'ask_human', generatesTitles: true });
  const session = await setupSession(f);
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const spec = workbenchSessionSpec(f.ctx, f.store.must<Session>('sessions', session.id));
  expect(spec.control_instructions).toContain('ask with the ask_human tool');
  expect(spec.auto_title).toBe(true);
});

it('gives a runtime whose adapter declares neither no question tool and no title of its own', async () => {
  const f = await declaredRuntime('claude', {});
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const spec = workbenchSessionSpec(f.ctx, f.store.must<Session>('sessions', session.id));
  expect(spec.control_instructions).not.toContain('When the user must decide or answer something');
  expect(spec).not.toHaveProperty('auto_title');
});

/** A runtime with a question tool whose sessions can hold a credential, in a project with a memory decision. */
async function credentialedRuntime(runtime = 'agy') {
  const f = await declaredRuntime(runtime, { questionTool: 'ask_human' });
  Object.assign(f.ctx, {
    issueSessionCredential: () => ({
      token_file: path.join(f.root, 'token'),
      daemon_url: 'http://127.0.0.1:1',
    }),
  });
  const draft = f.call<{ id: string; revision: number }>('memory.propose', {
    project_id: f.project.id,
    key: 'language',
    kind: 'decision',
    text: 'Use precise terminology',
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const send = vi.spyOn(f.adapter, 'send');
  /** Starts the session and returns its spec and its first runtime input. */
  const started = async (session: Session) => {
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () => send.mock.calls.length > 0,
      () => f.control.tick(),
    );
    return {
      spec: f.start.mock.calls.find(([each]) => each.platform_session_id === session.id)![0],
      input: send.mock.calls[0]![1].input,
    };
  };
  return { ...f, started };
}

it.each(['claude', 'codex'])(
  'runs a %s worktree session the user opened without Pantheon tools, text or memory',
  async (runtime) => {
    const f = await credentialedRuntime(runtime);
    const session = await f.create();
    const { spec, input } = await f.started(session);
    expect(spec.pantheon_mcp).toBeUndefined();
    expect(spec.control_instructions ?? '').toBe('');
    expect(input).not.toContain('[Pantheon current project memory]');
  },
);

it("runs a worktree session the user opened on the user's native home, extensions and daemon environment", async () => {
  stubDaemonEnvironment();
  const f = await credentialedRuntime();
  const session = await f.create();
  const { spec } = await f.started(session);
  expect(spec.native_state_dir).toBeUndefined();
  expect(f.store.must<Session>('sessions', session.id).native_state_dir).toBeUndefined();
  expect(spec.env_allowlist).toContain('PLAIN_DAEMON_VARIABLE');
  for (const name of deniedVariables) expect(spec.env_allowlist).not.toContain(name);
  expect(spec.extensions).toEqual({
    mode: 'inherit',
    overrides: {
      disabled_mcp_servers: [],
      disabled_plugins: [],
      disabled_skills: [],
      disable_hooks: false,
      disable_apps: false,
    },
  });
});

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

/** Marks the session's newest turn running from now, as when the runtime started it. */
function runLatestTurn(f: Fixture, sessionId: string) {
  const session = f.store.must<Session>('sessions', sessionId);
  f.store.update<Session>('sessions', { ...session, state: 'running' }, session.revision);
  const turn = f.turns(sessionId).at(-1)!;
  const running = f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, state: 'running' },
    turn.revision,
  );
  f.store.event('turn.running', running, f.project.id, {});
  return running;
}

const agentEvent = (f: Fixture, sessionId: string, kind: string, fields: Record<string, unknown>) =>
  f.store.event(`agent.${kind}`, f.store.must<Session>('sessions', sessionId), f.project.id, {
    kind,
    ...fields,
  });

function pendingRequest(f: Fixture, sessionId: string, fields: Partial<Approval>) {
  return f.store.insert<Approval>('approvals', {
    id: `approval-${sessionId}-${fields.tool}`,
    revision: 1,
    project_id: f.project.id,
    kind: 'permission',
    session_id: sessionId,
    request_id: `request-${fields.tool}`,
    input_hash: 'hash',
    decider: 'user',
    state: 'pending',
    created_at: f.store.now(),
    ...fields,
  });
}

it.each<{
  name: string;
  setup: (f: Fixture, sessionId: string) => { run: Record<string, unknown>; kind?: string };
}>([
  {
    name: 'compacting while its compaction has not ended',
    setup: (f, id) => {
      const turn = runLatestTurn(f, id);
      const at = agentEvent(f, id, 'context.compacting', { turn_id: turn.id, trigger: 'auto' });
      return { run: { phase: 'compacting', since: at.created_at } };
    },
  },
  {
    name: 'thinking once its compaction ended',
    setup: (f, id) => {
      const turn = runLatestTurn(f, id);
      agentEvent(f, id, 'context.compacting', { turn_id: turn.id, trigger: 'auto' });
      agentEvent(f, id, 'context.compacted', { turn_id: turn.id, trigger: 'auto' });
      return { run: { phase: 'thinking' } };
    },
  },
  {
    name: 'retrying while nothing followed the retry',
    setup: (f, id) => {
      const turn = runLatestTurn(f, id);
      const at = agentEvent(f, id, 'turn.retrying', {
        turn_id: turn.id,
        attempt: 1,
        reason: 'overloaded',
      });
      return { run: { phase: 'retrying', since: at.created_at } };
    },
  },
  {
    name: 'thinking once text followed the retry',
    setup: (f, id) => {
      const turn = runLatestTurn(f, id);
      agentEvent(f, id, 'turn.retrying', { turn_id: turn.id, attempt: 1, reason: 'network' });
      agentEvent(f, id, 'message.delta', { turn_id: turn.id, text: 'Reading' });
      return { run: { phase: 'thinking' } };
    },
  },
  {
    name: 'waiting on a question',
    setup: (f, id) => {
      runLatestTurn(f, id);
      const ask = pendingRequest(f, id, {
        tool: 'AskUserQuestion',
        questions: [
          { question: 'Which format?', header: 'Format', options: [], multiSelect: false },
        ],
      });
      return {
        run: {
          phase: 'waiting_input',
          since: ask.created_at,
          wait: { reason: 'question', since: ask.created_at },
        },
        kind: 'question',
      };
    },
  },
  {
    name: 'waiting on an approval',
    setup: (f, id) => {
      runLatestTurn(f, id);
      const bash = pendingRequest(f, id, { tool: 'Bash', input_summary: 'command=ls' });
      return {
        run: { phase: 'waiting_approval', wait: { reason: 'approval', since: bash.created_at } },
        kind: 'approval',
      };
    },
  },
  {
    name: 'waiting on a long background task',
    setup: (f, id) => {
      const startedAt = f.store.now() - 30 * 60_000;
      agentEvent(f, id, 'background.changed', {
        tasks: [{ id: 'server', kind: 'shell', description: 'Serve', started_at: startedAt }],
      });
      return { run: { phase: 'idle', wait: { reason: 'long_background', since: startedAt } } };
    },
  },
])('lists a session $name, with waiting_kind matching its wait', async ({ setup }) => {
  const f = await workbenchFixture();
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const { run, kind } = setup(f, session.id);
  const listed = f.control.sessionList(user, f.project.id).find((row) => row.id === session.id)!;
  expect(listed.run).toMatchObject(run);
  if (!('wait' in run)) expect(listed.run).not.toHaveProperty('wait');
  expect(listed.waiting_kind).toBe(kind);
});
