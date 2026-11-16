import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Principal, Project, Session, Workspace } from '@pantheon/domain';
import { sessionPrincipal, type ControlContext } from '../../packages/control/dist/context.js';
import { inPlaceSessionSpec } from '../../packages/control/dist/in-place-session.js';
import {
  assertNativeSessionFree,
  nativeSessionHolder,
} from '../../packages/control/dist/native-liveness.js';
import { readProcess } from '../../packages/control/dist/process.js';
import { inPlaceSandbox } from '../../packages/control/dist/protection.js';
import { writerTempDirectory } from '../../packages/control/dist/workspace-removal.js';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const contextOf = (f: ReturnType<typeof workbenchFixture>) =>
  (f.control as unknown as { ctx: ControlContext }).ctx;

/** Everything a write to the folder or its repository would change. */
const folderState = (folder: string) => ({
  entries: readdirSync(folder, { recursive: true }).map(String).sort(),
  refs: git(folder, 'for-each-ref'),
  worktrees: git(folder, 'worktree', 'list', '--porcelain'),
});

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error('Expected a refusal');
};

it('adopts a native session in its own folder without provisioning or writing to it', async () => {
  const f = workbenchFixture({ adoptable: true });
  const nativeId = randomUUID(),
    folder = realpathSync(f.source);
  f.nativeRecord(nativeId);
  await f.control.traceScan(5000);
  const before = folderState(f.source);
  const session = f.call<Session>('session.adopt', {
    project_id: f.project.id,
    runtime: 'claude',
    native_session_id: nativeId,
  });
  expect(session).toMatchObject({
    state: 'open',
    turn_count: 0,
    native_id: nativeId,
    permission_mode: 'ask',
    title: 'Fix the parser',
  });
  expect(session).not.toHaveProperty('native_state_dir');
  expect(session).not.toHaveProperty('native_title');
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(workspace).toMatchObject({ kind: 'in_place', path: folder, source: folder });
  expect(workspace).not.toHaveProperty('provisioning');
  expect(f.store.pending().filter((job) => job.kind === 'workspace.provision')).toEqual([]);
  expect(f.turns(session.id)).toEqual([]);
  expect(f.store.events().find((event) => event.kind === 'session.adopted')?.payload).toEqual({
    runtime: 'claude',
    native_id: nativeId,
    cwd: folder,
  });
  expect(folderState(f.source)).toEqual(before);
});

it('resumes the adopted native session in the original folder on its first turn', async () => {
  const f = workbenchFixture({ adoptable: true });
  const nativeId = randomUUID();
  const session = await f.adopt({ native_id: nativeId });
  f.call('session.send', { session_id: session.id, input: 'Continue' }, session.revision);
  await eventually(
    () => f.resume.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(f.start).not.toHaveBeenCalled();
  const [spec, resumedId] = f.resume.mock.calls[0]!;
  expect(resumedId).toBe(nativeId);
  expect(spec.cwd).toBe(realpathSync(f.source));
  expect(spec.native_state_dir).toBeUndefined();
  expect(spec.env ?? {}).not.toHaveProperty('CLAUDE_CONFIG_DIR');
});

it('builds a spec for the user folder that holds a planner credential, never a lead one', async () => {
  const f = workbenchFixture({ adoptable: true });
  Object.assign(f.adapter, { generatesTitles: true });
  const roles: string[] = [];
  const ctx = contextOf(f);
  Object.assign(ctx, {
    issueSessionCredential: (_session: string, role: string) => {
      roles.push(role);
      return { token_file: path.join(f.root, 'token'), daemon_url: 'http://127.0.0.1:1' };
    },
  });
  const session = await f.adopt({ title: 'Terminal work', permission_mode: 'auto_edit' });
  expect(session).toMatchObject({ title: 'Terminal work', permission_mode: 'auto_edit' });
  const spec = inPlaceSessionSpec(ctx, session);
  const folder = realpathSync(f.source);
  expect(spec).toMatchObject({ cwd: folder, role: 'writer', permission_mode: 'auto_edit' });
  expect(spec).not.toHaveProperty('auto_title');
  expect(spec.native_state_dir).toBeUndefined();
  expect(spec.native_title).toBeUndefined();
  expect(spec.control_instructions).toContain('own folder');
  // The fixture folder's own path may contain "worktrees".
  expect(spec.control_instructions).not.toMatch(/\bworktree\b/);
  expect(spec.sandbox?.writable_roots).toContain(folder);
  expect(roles).toEqual(['planner']);
  const principal = (role: Principal['role']): Principal => ({
    id: `session:${session.id}`,
    role,
    session_id: session.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60_000,
  });
  expect(sessionPrincipal(ctx, principal('planner')).id).toBe(session.id);
  expect(refusal(() => sessionPrincipal(ctx, principal('lead'))).code).toBe('permission_denied');
});

it('shares one workspace between sessions adopted from the same folder', async () => {
  const f = workbenchFixture({ adoptable: true });
  const first = await f.adopt(),
    second = await f.adopt();
  expect(second.workspace_id).toBe(first.workspace_id);
  expect(
    f.store.list<Workspace>('workspaces').filter((workspace) => workspace.kind === 'in_place'),
  ).toHaveLength(1);
});

it('refuses an adopted native id, a folder outside the project, a moved native home and an unknown record', async () => {
  const f = workbenchFixture({ adoptable: true });
  const adopt = (nativeId: string) => () =>
    f.call('session.adopt', {
      project_id: f.project.id,
      runtime: 'claude',
      native_session_id: nativeId,
    });
  const taken = await f.adopt();
  expect(refusal(adopt(taken.native_id!)).code).toBe('resource_busy');

  // A linked worktree of the project's repository is indexed with the project but lies outside it.
  const elsewhere = path.join(f.root, 'elsewhere'),
    outside = randomUUID();
  git(f.source, 'worktree', 'add', '--quiet', elsewhere);
  f.nativeRecord(outside, elsewhere);
  await f.control.traceScan(5000);
  expect(refusal(adopt(outside)).code).toBe('scope_violation');

  expect(refusal(adopt(randomUUID())).code).toBe('not_found');

  const project = f.store.must<Project>('projects', f.project.id);
  f.call(
    'project.environment.set',
    {
      project_id: project.id,
      name: project.name,
      roots: project.roots,
      env: { CODEX_HOME: path.join(f.root, 'other-codex') },
    },
    project.revision,
  );
  const moved = randomUUID();
  f.nativeRecord(moved);
  await f.control.traceScan(5000);
  expect(refusal(adopt(moved)).code).toBe('invalid_state');
});

it('finds a running Claude process that holds the native session', () => {
  const f = workbenchFixture();
  const claudeHome = path.join(f.root, 'claude-home'),
    sessions = path.join(claudeHome, 'sessions'),
    nativeId = randomUUID();
  mkdirSync(sessions, { recursive: true });
  writeFileSync(path.join(sessions, 'broken.json'), '{not json');
  const register = (pid: number, procStart: number) =>
    writeFileSync(
      path.join(sessions, `${pid}.json`),
      JSON.stringify({ pid, procStart, sessionId: nativeId, cwd: f.source, status: 'busy' }),
    );
  const input = { runtime: 'claude', native_id: nativeId, claudeHome, readProcess };

  const gone = spawnSync('true').pid!;
  register(gone, Date.now());
  expect(nativeSessionHolder(input)).toEqual({ state: 'free' });
  expect(() => assertNativeSessionFree(input)).not.toThrow();

  register(process.pid, Math.floor(readProcess(process.pid)!.start_time_us! / 1000));
  expect(nativeSessionHolder(input)).toEqual({ state: 'held', pid: process.pid });
  const busy = refusal(() => assertNativeSessionFree(input));
  expect(busy.code).toBe('native_session_busy');
  expect(busy.message).toContain(String(process.pid));

  expect(nativeSessionHolder({ ...input, runtime: 'codex' })).toEqual({ state: 'unknown' });

  // Claude writes procStart as a ctime-style string in UTC without a zone, e.g. "Wed Nov 11 15:25:05 2026".
  const start = new Date(Math.floor(readProcess(process.pid)!.start_time_us! / 1000));
  const [weekday, day, month, year, time] = start.toUTCString().replace(',', '').split(' ');
  writeFileSync(
    path.join(sessions, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      procStart: `${weekday} ${month} ${day!.padStart(2, ' ')} ${time} ${year}`,
      sessionId: nativeId,
    }),
  );
  expect(nativeSessionHolder(input)).toEqual({ state: 'held', pid: process.pid });
});

it.runIf(process.platform === 'linux')(
  'reads the clock ticks since boot that Claude writes as procStart on Linux',
  () => {
    const f = workbenchFixture();
    const claudeHome = path.join(f.root, 'claude-home'),
      nativeId = randomUUID();
    mkdirSync(path.join(claudeHome, 'sessions'), { recursive: true });
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
    writeFileSync(
      path.join(claudeHome, 'sessions', `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, procStart: ticks, sessionId: nativeId }),
    );
    expect(
      nativeSessionHolder({ runtime: 'claude', native_id: nativeId, claudeHome, readProcess }),
    ).toEqual({ state: 'held', pid: process.pid });
  },
);

it('lets an in-place session write its project root but not repository settings, Claude state or worktrees', async () => {
  const f = workbenchFixture();
  const worktree = f.store.must<Workspace>('workspaces', f.create().workspace_id!);
  await awaitWorkspaceReady(f.control, worktree.id);
  const tempDir = path.join(realpathSync(f.root), 'temp'),
    folder = realpathSync(f.source);
  mkdirSync(tempDir);
  const sandbox = inPlaceSandbox({
    ...f.protectionPaths,
    projectRoot: folder,
    tempDir,
    otherWorkspaces: [worktree.path],
  });
  expect(sandbox.writable_roots).toEqual([folder, tempDir]);
  const denied = (target: string) =>
    sandbox.protected_entries.find((entry) => entry.path === target)?.deny;
  expect(denied(path.join(folder, '.git/config'))).toBe('write');
  expect(denied(path.join(folder, '.git/worktrees'))).toBe('write');
  expect(denied(path.join(f.protectionPaths.home, '.claude'))).toBe('write');
  expect(denied(worktree.path)).toBe('write');
  expect(denied(folder)).toBeUndefined();
});

it('refuses an in-place turn after the session replaced its temporary folder or project root with a symlink', async () => {
  const f = workbenchFixture({ adoptable: true });
  const ctx = contextOf(f);
  Object.assign(ctx, {
    issueSessionCredential: () => ({
      token_file: path.join(f.root, 'token'),
      daemon_url: 'http://127.0.0.1:1',
    }),
  });
  const session = await f.adopt();
  const elsewhere = path.join(realpathSync(f.root), 'elsewhere');
  mkdirSync(elsewhere);
  const temporary = writerTempDirectory(session.workspace_id!);
  rmSync(temporary, { recursive: true, force: true });
  symlinkSync(elsewhere, temporary);
  try {
    expect(refusal(() => inPlaceSessionSpec(ctx, session)).code).toBe('sandbox_path_replaced');
  } finally {
    rmSync(temporary, { force: true });
  }

  const folder = realpathSync(f.source),
    tempDir = path.join(realpathSync(f.root), 'temp'),
    linkedParent = path.join(realpathSync(f.root), 'linked-parent');
  mkdirSync(tempDir);
  symlinkSync(path.dirname(folder), linkedParent);
  const sandbox = (projectRoot: string) => () =>
    inPlaceSandbox({ ...f.protectionPaths, projectRoot, tempDir, otherWorkspaces: [] });
  expect(refusal(sandbox(path.join(linkedParent, path.basename(folder)))).code).toBe(
    'sandbox_path_replaced',
  );
  const linkedRoot = path.join(realpathSync(f.root), 'linked-root');
  symlinkSync(folder, linkedRoot);
  expect(refusal(sandbox(linkedRoot)).code).toBe('sandbox_path_replaced');
});
