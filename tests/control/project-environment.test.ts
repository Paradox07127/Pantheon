import {
  insideSandbox,
  awaitWorkspaceReady,
  eventually,
  fixture,
  registerWorkspace,
  user,
} from '../helpers.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Project, Session, SessionSpec, Workspace } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import {
  gitFolderAsync,
  rootOf,
  type ControlContext,
} from '../../packages/control/dist/context.js';
import { managedSessionSpec } from '../../packages/control/dist/native-session.js';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { workbenchFixture } from './workbench-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
  const f = await fixture({ managedWorkspaces: true });
  cleanups.push(() => f.close());
  const extra = path.join(f.root, 'shared-library'),
    other = path.join(f.root, 'second-project'),
    repository = path.join(f.root, 'repository');
  mkdirSync(extra);
  mkdirSync(other);
  mkdirSync(repository);
  git(repository, 'init', '--quiet', '--initial-branch=main');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const events = (kind: string) => f.store.events().filter((event) => event.kind === kind);
  return {
    ...f,
    ctx,
    projectRoot: realpathSync(f.projectRoot),
    extra: realpathSync(extra),
    other: realpathSync(other),
    repository: realpathSync(repository),
    events,
  };
}

/** A linked worktree of the project's folder, registered as session.create registers one. */
function worktree(f: Awaited<ReturnType<typeof setup>>) {
  return registerWorkspace(f.control, {
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.projectRoot,
    base_ref: 'HEAD',
  });
}

/** A conversation without a worktree, stored as the dispatcher reads it. */
function conversation(f: Awaited<ReturnType<typeof setup>>, state: Session['state'] = 'open') {
  return f.store.insert<Session>('sessions', {
    id: `conversation-${state}`,
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    device_id: 'local',
    state,
    turn_count: 0,
  });
}

it('opens a project with several roots and environment variables and keeps values out of events', async () => {
  const f = await setup();
  const project = await f.call<Project>('project.open', {
    name: 'With environment',
    roots: [f.other, f.extra],
    env: { PROJECT_MARKER: 'secret-value' },
  });
  expect(project).toMatchObject({
    roots: [f.other, f.extra],
    env: { PROJECT_MARKER: 'secret-value' },
  });
  expect(project).not.toHaveProperty('root');
  expect(f.store.must<Project>('projects', project.id)).toEqual(project);
  expect(f.project).toMatchObject({ roots: [f.projectRoot] });
  expect(f.project).not.toHaveProperty('env');
  expect(JSON.stringify(f.store.events())).not.toContain('secret-value');
  expect(
    inputSchemas['project.open'].safeParse({ name: 'n', roots: ['/r'], env: { '1BAD': 'x' } })
      .success,
  ).toBe(false);
  expect(inputSchemas['project.open'].safeParse({ name: 'n', roots: [] }).success).toBe(false);
  expect(inputSchemas['project.open'].safeParse({ name: 'n', root: '/r' }).success).toBe(false);
});

it('rejects nested, repeated or non-directory roots within one project', async () => {
  const f = await setup();
  const nested = path.join(f.other, 'nested'),
    file = path.join(f.root, 'plain-file');
  mkdirSync(nested);
  writeFileSync(file, 'not a directory');
  expect(() => f.call('project.open', { name: 'Nested', roots: [f.other, nested] })).toThrow(
    expect.objectContaining({ code: 'scope_violation' }),
  );
  expect(() => f.call('project.open', { name: 'Containing', roots: [nested, f.other] })).toThrow(
    expect.objectContaining({ code: 'scope_violation' }),
  );
  expect(() => f.call('project.open', { name: 'File', roots: [f.other, file] })).toThrow(
    expect.objectContaining({ code: 'invalid_project' }),
  );
  expect(() => f.call('project.open', { name: 'Twice', roots: [f.extra, f.extra] })).toThrow(
    expect.objectContaining({ code: 'invalid_project' }),
  );
  expect(f.store.list<Project>('projects')).toHaveLength(1);
});

it('returns the project with the same set of roots in any order', async () => {
  const f = await setup();
  const project = await f.call<Project>('project.open', {
    name: 'Pair',
    roots: [f.other, f.extra],
  });
  const again = await f.call<Project>('project.open', {
    name: 'Other name',
    roots: [f.extra, f.other],
  });
  expect(again).toEqual(project);
  expect(f.store.list<Project>('projects')).toHaveLength(2);
});

it('rejects roots that equal, contain or lie inside a root of another project and names it', async () => {
  const f = await setup();
  const named = expect.objectContaining({
    code: 'scope_violation',
    message: expect.stringContaining('"fixture"'),
  });
  expect(() =>
    f.call('project.open', { name: 'Superset', roots: [f.projectRoot, f.extra] }),
  ).toThrow(named);
  const inside = path.join(f.projectRoot, 'inside');
  mkdirSync(inside);
  expect(() => f.call('project.open', { name: 'Inside', roots: [inside] })).toThrow(named);
  const inner = path.join(f.extra, 'inner');
  mkdirSync(inner);
  await f.call('project.open', { name: 'Inner', roots: [inner] });
  expect(() => f.call('project.open', { name: 'Containing', roots: [f.extra] })).toThrow(
    expect.objectContaining({
      code: 'scope_violation',
      message: expect.stringContaining('"Inner"'),
    }),
  );
  f.call('project.remove', { project_id: f.project.id }, f.project.revision);
  expect(() => f.call('project.open', { name: 'Inside', roots: [inside] })).toThrow(
    expect.objectContaining({
      code: 'scope_violation',
      message: expect.stringContaining('overlap removed project "fixture"'),
    }),
  );
  const second = await f.call<Project>('project.open', { name: 'Second', roots: [f.other] });
  expect(() =>
    f.call(
      'project.environment.set',
      { project_id: second.id, name: 'Second', roots: [f.other, f.projectRoot], env: {} },
      second.revision,
    ),
  ).toThrow(named);
  expect(f.store.list<Project>('projects')).toHaveLength(3);
});

it('replaces the project roots and environment and records only variable names', async () => {
  const f = await setup();
  const next = await f.call<Project>(
    'project.environment.set',
    {
      project_id: f.project.id,
      name: 'Renamed',
      roots: [f.projectRoot, f.extra],
      env: { API_URL: 'https://internal.example', SECOND: 'hidden-value' },
    },
    f.project.revision,
  );
  expect(next).toMatchObject({
    name: 'Renamed',
    roots: [f.projectRoot, f.extra],
    env: { API_URL: 'https://internal.example', SECOND: 'hidden-value' },
    revision: f.project.revision + 1,
  });
  expect(f.events('project.environment_set')).toMatchObject([
    {
      aggregate_id: f.project.id,
      payload: {
        name: 'Renamed',
        roots: [f.projectRoot, f.extra],
        env_keys: ['API_URL', 'SECOND'],
      },
    },
  ]);
  expect(JSON.stringify(f.store.events())).not.toContain('hidden-value');
  const cleared = await f.call<Project>(
    'project.environment.set',
    { project_id: f.project.id, name: 'Renamed', roots: [f.projectRoot], env: {} },
    next.revision,
  );
  expect(cleared).toMatchObject({ roots: [f.projectRoot], env: {} });
  expect(() =>
    f.call(
      'project.environment.set',
      { project_id: f.project.id, name: 'Agent', roots: [f.projectRoot], env: {} },
      cleared.revision,
      { id: 'agent', role: 'planner' },
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it('sets a gate per git root, refuses other roots and drops the gate of a removed root', async () => {
  const f = await setup();
  const project = await f.call<Project>('project.open', {
    name: 'Mixed',
    roots: [f.repository, f.extra],
  });
  // Stands for a plain folder opened before project.open made every root a git repository.
  rmSync(path.join(f.extra, '.git'), { recursive: true });
  const commands = [{ name: 'test', argv: ['pnpm', 'test'] }];
  const gated = await f.call<Project>(
    'project.gate.set',
    { project_id: project.id, root: f.repository, commands },
    project.revision,
  );
  expect(gated.gates).toEqual({ [f.repository]: commands });
  expect(f.events('project.gate_set')).toMatchObject([
    { payload: { root: f.repository, commands } },
  ]);
  await expect(
    f.call('project.gate.set', { project_id: project.id, root: f.extra, commands }, gated.revision),
  ).rejects.toThrow(expect.objectContaining({ code: 'invalid_input' }));
  expect(() =>
    f.call('project.gate.set', { project_id: project.id, root: f.other, commands }, gated.revision),
  ).toThrow(expect.objectContaining({ code: 'scope_violation' }));
  const cleared = await f.call<Project>(
    'project.gate.set',
    { project_id: project.id, root: f.repository, commands: [] },
    gated.revision,
  );
  expect(cleared).not.toHaveProperty('gates');
  const again = await f.call<Project>(
    'project.gate.set',
    { project_id: project.id, root: f.repository, commands },
    cleared.revision,
  );
  const moved = await f.call<Project>(
    'project.environment.set',
    { project_id: project.id, name: 'Mixed', roots: [f.extra], env: {} },
    again.revision,
  );
  expect(moved).not.toHaveProperty('gates');
});

it('refuses to drop a folder that a session still holds unmerged work from', async () => {
  const f = await setup();
  const session = f.store.insert<Session>('sessions', {
    id: 'unmerged-work',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    device_id: 'local',
    state: 'open',
    turn_count: 1,
    workspace_id: worktree(f).id,
  });
  const drop = () =>
    f.call<Project>(
      'project.environment.set',
      { project_id: f.project.id, name: f.project.name, roots: [f.extra], env: {} },
      f.store.must<Project>('projects', f.project.id).revision,
    );
  expect(drop).toThrow(
    expect.objectContaining({ code: 'root_in_use', message: expect.stringContaining(session.id) }),
  );
  expect(f.store.must<Project>('projects', f.project.id).roots).toEqual([f.projectRoot]);
  f.store.update<Session>(
    'sessions',
    { ...session, state: 'closed', outcome: 'discarded' },
    session.revision,
  );
  expect((await drop()).roots).toEqual([f.extra]);
});

it('reads every root configuration: the gate of each root and merged extensions', async () => {
  const f = await setup();
  const write = (root: string, name: string, value: unknown) => {
    mkdirSync(path.join(root, '.pantheon'), { recursive: true });
    writeFileSync(path.join(root, '.pantheon', name), JSON.stringify(value));
  };
  const overrides = (server: string, apps: boolean) => ({
    disabled_mcp_servers: [server],
    disabled_plugins: [],
    disabled_skills: [],
    disable_apps: apps,
    disable_hooks: false,
  });
  const gate = (name: string) => [{ name, argv: ['true'] }];
  write(f.extra, 'config.json', {
    version: 1,
    gate: gate('library'),
    extensions: { claude: overrides('alpha', true) },
  });
  write(f.repository, 'config.json', {
    version: 1,
    gate: gate('repository'),
    extensions: { claude: overrides('beta', false) },
  });
  const project = await f.call<Project>('project.open', {
    name: 'Configured',
    roots: [f.extra, f.repository],
  });
  expect(project.gates).toEqual({
    [f.extra]: gate('library'),
    [f.repository]: gate('repository'),
  });
  expect(project.extension_overrides).toEqual({
    claude: { ...overrides('alpha', true), disabled_mcp_servers: ['alpha', 'beta'] },
  });
});

it('opens a user-level item for the project when any root opens it', async () => {
  const f = await setup();
  const write = (root: string, extensions: unknown) => {
    mkdirSync(path.join(root, '.pantheon'), { recursive: true });
    writeFileSync(
      path.join(root, '.pantheon', 'config.json'),
      JSON.stringify({ version: 1, extensions }),
    );
  };
  const closed = {
    disabled_mcp_servers: [],
    disabled_plugins: [],
    disabled_skills: [],
    disable_apps: false,
    disable_hooks: false,
  };
  write(f.extra, { claude: { ...closed, enabled_user_mcp_servers: ['alpha'] } });
  write(f.repository, {
    claude: { ...closed, enabled_user_mcp_servers: ['beta'], enabled_user_skills: ['review'] },
  });
  const project = await f.call<Project>('project.open', {
    name: 'Opened',
    roots: [f.extra, f.repository],
  });
  expect(project.extension_overrides).toEqual({
    claude: {
      ...closed,
      enabled_user_mcp_servers: ['alpha', 'beta'],
      enabled_user_skills: ['review'],
    },
  });
});

it('finds the one root holding all paths and tells git roots from other folders', async () => {
  const f = await setup();
  const project = { roots: [f.repository, f.extra] } as Project;
  const inner = path.join(f.repository, 'inner');
  mkdirSync(inner);
  expect(rootOf(project, [inner, f.repository])).toBe(f.repository);
  expect(rootOf(project, [f.extra])).toBe(f.extra);
  expect(rootOf(project, [inner, f.extra])).toBeUndefined();
  expect(rootOf(project, [f.other])).toBeUndefined();
  expect(rootOf(project, [])).toBeUndefined();
  expect(await gitFolderAsync(f.repository)).toBe(true);
  expect(await gitFolderAsync(inner)).toBe(false);
  expect(await gitFolderAsync(f.extra)).toBe(false);
});

it('refuses to remove a project while one of its sessions is running', async () => {
  const f = await setup();
  conversation(f, 'running');
  expect(() => f.call('project.remove', { project_id: f.project.id }, f.project.revision)).toThrow(
    expect.objectContaining({ code: 'resource_busy' }),
  );
  expect(f.store.must<Project>('projects', f.project.id)).not.toHaveProperty('removed_at');
});

it('removes a project and restores the same project with its history when the folder is opened again', async () => {
  const f = await setup();
  const workspace = worktree(f);
  const removed = f.call<Project>(
    'project.remove',
    { project_id: f.project.id },
    f.project.revision,
  );
  expect(removed.removed_at).toEqual(expect.any(Number));
  expect(f.events('project.removed')).toMatchObject([{ aggregate_id: f.project.id }]);
  const restored = await f.call<Project>('project.open', { name: 'Again', roots: [f.projectRoot] });
  expect(restored.id).toBe(f.project.id);
  expect(restored).not.toHaveProperty('removed_at');
  expect(restored.name).toBe(f.project.name);
  expect(f.events('project.restored')).toMatchObject([{ aggregate_id: f.project.id }]);
  expect(f.store.must<Workspace>('workspaces', workspace.id).project_id).toBe(f.project.id);
});

it('keeps writers to their workspace and gives every session the project variables', async () => {
  const f = await setup();
  await f.call(
    'project.environment.set',
    {
      project_id: f.project.id,
      name: f.project.name,
      roots: [f.projectRoot, f.extra],
      env: { PROJECT_MARKER: 'from-project' },
    },
    f.project.revision,
  );
  const session = conversation(f),
    workspace = worktree(f);
  const base: SessionSpec = {
    platform_session_id: session.id,
    project_id: f.project.id,
    runtime: f.adapter.name,
    role: 'writer',
    device_id: 'local',
    cwd: workspace.path,
    env_allowlist: [],
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 10000 },
  };
  const writer = managedSessionSpec(f.ctx, {
    ...base,
    sandbox: { writable_roots: [workspace.path], protected_entries: [] },
  });
  expect(writer.sandbox?.writable_roots).toEqual([workspace.path]);
  expect(writer.env).toEqual({ PROJECT_MARKER: 'from-project' });
  const planner = managedSessionSpec(f.ctx, {
    ...base,
    role: 'planner',
    sandbox: { writable_roots: [], protected_entries: [] },
  });
  expect(planner.sandbox?.writable_roots).toEqual([]);
  expect(planner.env).toEqual({ PROJECT_MARKER: 'from-project' });
});

it('keeps the session temporary directory over the project one while adding project variables', async () => {
  const f = await setup();
  await f.call(
    'project.environment.set',
    {
      project_id: f.project.id,
      name: f.project.name,
      roots: [f.projectRoot],
      env: { PROJECT_MARKER: 'from-project', TMPDIR: '/project-temp' },
    },
    f.project.revision,
  );
  const session = conversation(f);
  const writer = managedSessionSpec(f.ctx, {
    platform_session_id: session.id,
    project_id: f.project.id,
    runtime: f.adapter.name,
    role: 'writer',
    device_id: 'local',
    cwd: worktree(f).path,
    env_allowlist: [],
    env: { TMPDIR: '/writer-temp' },
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 10000 },
  });
  expect(writer.env).toEqual({ PROJECT_MARKER: 'from-project', TMPDIR: '/writer-temp' });
});

it('passes project variables to the native process while Pantheon variables win', async () => {
  const seen: NodeJS.ProcessEnv[] = [];
  const query = ({ options }: { options: { env?: NodeJS.ProcessEnv } }) => {
    seen.push(options.env!);
    return {
      initializationResult: async () => ({
        account: { apiProvider: 'firstParty', subscriptionType: 'max' },
      }),
      close: () => {},
      async *[Symbol.asyncIterator]() {},
    };
  };
  const adapter = new ClaudeAdapter('claude', 'test', query as never);
  const handle = await adapter.start(
    {
      platform_session_id: 'environment-session',
      project_id: 'environment-project',
      runtime: 'claude',
      device_id: 'local',
      role: 'writer',
      cwd: process.cwd(),
      env_allowlist: ['PATH'],
      env: { PATH: '/project-only/bin', PROJECT_MARKER: 'from-project' },
      skills: [],
      mcp_servers: [],
      budget: { max_turns: 1, wall_time_ms: 1000 },
    },
    () => {},
  );
  await adapter.close(handle, Date.now() + 1000);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ PROJECT_MARKER: 'from-project', PATH: process.env.PATH });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Environment Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Environment Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

it.skipIf(insideSandbox)('runs gate commands with the project variables', async () => {
  const f = await workbenchFixture();
  const project = await f.call<Project>(
    'project.environment.set',
    {
      project_id: f.project.id,
      name: f.project.name,
      roots: f.project.roots,
      env: { PROJECT_MARKER: 'from-project' },
    },
    f.project.revision,
  );
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const gate = [
    {
      name: 'Read project variable',
      argv: [
        process.execPath,
        '-e',
        "process.stdout.write(process.env.PROJECT_MARKER ?? 'missing')",
      ],
    },
  ];
  await f.call<Project>(
    'project.gate.set',
    { project_id: project.id, root: f.source, commands: gate },
    project.revision,
  );
  await f.call<Session>(
    'session.gates.run',
    { session_id: session.id },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => !f.control.sessionGates(user, session.id).running,
    () => f.control.tick(),
    10000,
  );
  const checked = f.store.events().filter((event) => event.kind === 'session.gate_checked');
  expect(checked).toMatchObject([
    { payload: { results: [{ exit_code: 0, output: 'from-project' }] } },
  ]);
});
