import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Approval, Project, ProjectRead, Session, Workspace } from '@pantheon/domain';
import { workbenchFixture, git } from './workbench-fixture.js';
import { eventually, registerWorkspace, user } from '../helpers.js';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { requestApproval } from '../../packages/control/dist/approvals.js';

it('answers later approvals in another session of the project, names the rule, lists and removes it', () => {
  const f = workbenchFixture();
  const first = f.create('First session');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const request = (session: Session, request_id: string) => {
    f.store.transaction(() =>
      requestApproval(ctx, session, {
        key: request_id,
        provider_sequence: 1,
        kind: 'permission.requested',
        request_id,
        tool: 'Bash',
        rule: 'Bash(pnpm test)',
        project_rule_supported: true,
        detail: { input: { command: 'pnpm test --filter control' } },
      }),
    );
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  const approval = request(first, 'first-request');
  expect(approval.project_rule_supported).toBe(true);
  expect(
    f.control.needsYou(user).items.find((item) => item.source.id === approval.id)?.binding,
  ).toMatchObject({ project_rule_supported: true });
  f.call(
    'approval.respond',
    { approval_id: approval.id, decision: 'approve_project' },
    approval.revision,
  );
  const second = f.create('Second session');
  const automatic = request(second, 'later-request');
  expect(automatic).toMatchObject({ state: 'approved', answered_by_rule: 'Bash(pnpm test)' });
  expect(f.store.kindEvents(f.project.id, ['approval.approved']).at(-1)?.payload).toMatchObject({
    answered_by_rule: 'Bash(pnpm test)',
  });
  expect(
    f.store
      .pending()
      .filter((job) => job.kind === 'permission.answer')
      .map((job) => JSON.parse(job.payload)),
  ).toContainEqual(expect.objectContaining({ approval_id: automatic.id, decision: 'allow' }));
  f.store.insert<Project>('projects', { ...f.project, id: 'other-project' });
  const other = f.store.insert<Session>('sessions', {
    ...second,
    id: 'other-session',
    project_id: 'other-project',
  });
  expect(request(other, 'other-project-request').state).toBe('pending');
  expect(f.control.permissionRules(user, f.project.id)).toEqual([
    {
      rule: 'Bash(pnpm test)',
      session_id: first.id,
      session_title: first.title,
      added_at: expect.any(Number),
    },
  ]);
  f.store.db.prepare('DELETE FROM sessions WHERE id=?').run(first.id);
  expect(f.control.permissionRules(user, f.project.id)[0]).not.toHaveProperty('session_title');
  f.call('permission.rule.remove', { project_id: f.project.id, rule: 'Bash(pnpm test)' });
  expect(f.control.permissionRules(user, f.project.id)).toEqual([]);
  expect(request(second, 'after-removal').state).toBe('pending');
});

it('lists project rules newest first, including rules added during the same clock tick', () => {
  const f = workbenchFixture();
  const session = f.create();
  const entries = [
    { rule: 'WebFetch', session_id: session.id, added_at: 1 },
    { rule: 'Bash(pnpm test)', session_id: session.id, added_at: 2 },
    { rule: 'Bash(git status)', session_id: session.id, added_at: 2 },
  ];
  f.store.update<Project>(
    'projects',
    { ...f.project, permission_rules: entries },
    f.project.revision,
  );
  expect(f.control.permissionRules(user, f.project.id).map((entry) => entry.rule)).toEqual([
    'Bash(git status)',
    'Bash(pnpm test)',
    'WebFetch',
  ]);
});

it('does not offer project rules for requests without reusable rules or in plan mode', () => {
  const f = workbenchFixture();
  const session = f.create();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  for (const patch of [
    { project_rule_supported: false },
    { project_rule_supported: true, tool: 'AskUserQuestion' },
  ]) {
    f.store.transaction(() =>
      requestApproval(ctx, session, {
        key: String(f.store.cursor()),
        provider_sequence: 1,
        kind: 'permission.requested',
        request_id: String(f.store.cursor()),
        tool: 'tool.read',
        rule: 'tool.read',
        ...patch,
      }),
    );
    const approval = f.store.list<Approval>('approvals').at(-1)!;
    expect(approval.project_rule_supported).toBe(false);
    expect(() =>
      f.call(
        'approval.respond',
        { approval_id: approval.id, decision: 'approve_project' },
        approval.revision,
      ),
    ).toThrow();
  }
  f.store.transaction(() =>
    requestApproval(
      ctx,
      { ...session, permission_mode: 'plan' },
      {
        key: 'plan-request',
        provider_sequence: 1,
        kind: 'permission.requested',
        request_id: 'plan-request',
        tool: 'Bash',
        rule: 'Bash(pnpm test)',
        project_rule_supported: true,
      },
    ),
  );
  expect(f.store.list<Approval>('approvals').at(-1)?.project_rule_supported).toBe(false);
});

it('lists local branches by commit time with a checked-out mark and a cap of 200', async () => {
  const f = workbenchFixture();
  const older = git(f.source, 'rev-parse', 'HEAD');
  const tree = git(f.source, 'rev-parse', 'HEAD^{tree}');
  const newer = execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', older, '-m', 'New branch commit'],
    {
      cwd: f.source,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: '2037-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2037-01-01T00:00:00Z',
      },
    },
  ).trim();
  for (let i = 0; i < 205; i++)
    git(f.source, 'branch', `recent-${String(i).padStart(3, '0')}`, newer);
  git(f.source, 'switch', '--quiet', 'recent-000');
  const branches = await f.control.projectBranches(user, f.project.id);
  expect(branches).toHaveLength(200);
  expect(branches[0]).toMatchObject({
    name: 'recent-000',
    sha: newer,
    checked_out: true,
    commit_time: Date.parse('2037-01-01T00:00:00Z'),
  });
  expect(branches.every((branch) => branch.sha === newer)).toBe(true);
  expect(branches.filter((branch) => branch.checked_out)).toHaveLength(1);
  await expect(f.control.projectBranches(user, f.project.id, f.root)).rejects.toThrow();
});

it('copies selected files and folders and finishes preparation before the first turn', async () => {
  const f = workbenchFixture();
  writeFileSync(path.join(f.source, '.env'), 'TOKEN=local\n');
  mkdirSync(path.join(f.source, 'local-config'));
  writeFileSync(path.join(f.source, 'local-config/settings'), 'local');
  const project = f.call<Project>(
    'project.worktree.set',
    {
      project_id: f.project.id,
      copy_paths: ['.env', 'local-config', 'absent'],
      command: {
        argv: [
          process.execPath,
          '-e',
          "const fs = require('node:fs'); fs.writeFileSync('prepared', fs.readFileSync('.env') + fs.readFileSync('local-config/settings'));",
        ],
        timeout_ms: 5000,
      },
    },
    f.project.revision,
  );
  expect((f.control.projectRead(user, f.project.id) as ProjectRead).project.worktree).toEqual(
    project.worktree,
  );
  const send = vi.spyOn(f.adapter, 'send').mockImplementation(async (handle, turn) => {
    const workspace = f.store.must<Workspace>(
      'workspaces',
      f.store.must<Session>('sessions', handle.platform_session_id).workspace_id!,
    );
    expect(readFileSync(path.join(workspace.path, 'prepared'), 'utf8')).toBe('TOKEN=local\nlocal');
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  const session = f.create();
  await eventually(
    () => send.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(
    f.control.sessionList(user, f.project.id).find((item) => item.id === session.id)?.state,
  ).toBe('running');
});

it('refuses escaping preparation paths when saved, including a symlink outside the root', () => {
  const f = workbenchFixture();
  symlinkSync(f.root, path.join(f.source, 'outside'));
  for (const entry of ['../outside', '/absolute', 'nested/../../outside', 'outside/state']) {
    expect(() =>
      f.call(
        'project.worktree.set',
        { project_id: f.project.id, copy_paths: [entry] },
        f.project.revision,
      ),
    ).toThrow();
  }
});

it('keeps a worktree and exposes preparation failure and its last output without starting the turn', async () => {
  const f = workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  f.call(
    'project.worktree.set',
    {
      project_id: f.project.id,
      copy_paths: [],
      command: {
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('x'.repeat(5000) + '\\npreparation failed\\n', () => process.exit(7));",
        ],
        timeout_ms: 5000,
      },
    },
    f.project.revision,
  );
  const session = f.create();
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'closed',
    () => f.control.tick(),
  );
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(existsSync(workspace.path)).toBe(true);
  expect(workspace.provisioning).toMatchObject({
    state: 'failed',
    output: expect.stringContaining('preparation failed'),
  });
  expect(workspace.provisioning?.output).toHaveLength(4000);
  expect(
    f.control.sessionList(user, f.project.id).find((item) => item.id === session.id)?.state,
  ).toBe('failed');
  expect(f.store.kindEvents(f.project.id, ['session.closed']).at(-1)?.payload).toMatchObject({
    reason: 'workspace_failed',
  });
  expect(f.turns(session.id)[0]).toMatchObject({
    state: 'failed',
    delivery_reason: expect.stringContaining('preparation failed'),
  });
  expect(send).not.toHaveBeenCalled();
});

it('times out preparation and keeps its output with the failed environment', async () => {
  const f = workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  f.call(
    'project.worktree.set',
    {
      project_id: f.project.id,
      copy_paths: [],
      command: {
        argv: [
          process.execPath,
          '-e',
          "process.stdout.write('waiting'); setInterval(() => {}, 10)",
        ],
        timeout_ms: 2000,
      },
    },
    f.project.revision,
  );
  const session = f.create();
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'closed',
    () => f.control.tick(),
    10000,
  );
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(workspace.provisioning).toMatchObject({
    state: 'failed',
    error: 'Workspace provisioning deadline exceeded',
    output: 'waiting',
  });
  expect(existsSync(workspace.path)).toBe(true);
  expect(send).not.toHaveBeenCalled();
});

it('keeps the failed environment when a selected folder cannot replace a tracked file', async () => {
  const f = workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  writeFileSync(path.join(f.source, 'local-config'), 'tracked file');
  git(f.source, 'add', 'local-config');
  git(f.source, 'commit', '--quiet', '-m', 'Track configuration placeholder');
  rmSync(path.join(f.source, 'local-config'));
  mkdirSync(path.join(f.source, 'local-config'));
  writeFileSync(path.join(f.source, 'local-config/settings'), 'local settings');
  f.call(
    'project.worktree.set',
    { project_id: f.project.id, copy_paths: ['local-config'] },
    f.project.revision,
  );
  const session = f.create();
  await eventually(
    () => f.store.must<Session>('sessions', session.id).state === 'closed',
    () => f.control.tick(),
  );
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(workspace.provisioning).toMatchObject({ state: 'failed', phase: 'copy' });
  expect(existsSync(workspace.path)).toBe(true);
  expect(f.turns(session.id)[0]).toMatchObject({ state: 'failed' });
  expect(send).not.toHaveBeenCalled();
});

it('counts only archived session worktrees on disk, caches their size, and prunes without deleting branches', async () => {
  const f = workbenchFixture();
  const archived = f.create('Archived session');
  const active = f.create('Keep this session');
  const missing = f.create('Missing worktree');
  const { startWorkspaceProvisioning } =
    await import('../../packages/control/dist/provisioning.js');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  for (const session of [archived, active, missing]) {
    startWorkspaceProvisioning(ctx, session.workspace_id!);
    await eventually(
      () =>
        f.store.must<Workspace>('workspaces', session.workspace_id!).provisioning?.state ===
        'ready',
    );
  }
  const archivedWorkspace = f.store.must<Workspace>('workspaces', archived.workspace_id!);
  git(archivedWorkspace.path, 'switch', '--quiet', '-c', 'retained-work');
  for (const session of [archived, missing]) {
    const current = f.store.must<Session>('sessions', session.id);
    f.store.update(
      'sessions',
      { ...current, state: 'closed', archived_at: '2026-11-13T00:00:00Z' },
      current.revision,
    );
  }
  rmSync(f.store.must<Workspace>('workspaces', missing.workspace_id!).path, { recursive: true });
  const unowned = registerWorkspace(f.control, {
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.source,
    base_ref: 'HEAD',
  });
  startWorkspaceProvisioning(ctx, unowned.id);
  await eventually(
    () => f.store.must<Workspace>('workspaces', unowned.id).provisioning?.state === 'ready',
  );
  const first = f.control.workspaceStale(user, f.project.id);
  expect(first).toMatchObject({
    count: 1,
    worktree_root: path.dirname(path.dirname(archivedWorkspace.path)),
  });
  expect(first.size_bytes).toBeUndefined();
  await eventually(() => f.control.workspaceStale(user, f.project.id).size_bytes !== undefined);
  expect(f.control.workspaceStale(user, f.project.id).size_bytes).toBeGreaterThan(0);
  const branches = git(f.source, 'show-ref', '--heads');
  git(f.source, 'worktree', 'lock', archivedWorkspace.path);
  expect(await f.call('workspace.prune_stale', { project_id: f.project.id })).toEqual({
    removed: 0,
  });
  expect(f.store.must<Workspace>('workspaces', archivedWorkspace.id).removed_at).toBeUndefined();
  expect(f.control.workspaceStale(user, f.project.id).count).toBe(1);
  git(f.source, 'worktree', 'unlock', archivedWorkspace.path);
  expect(await f.call('workspace.prune_stale', { project_id: f.project.id })).toEqual({
    removed: 1,
  });
  expect(existsSync(archivedWorkspace.path)).toBe(false);
  expect(existsSync(f.store.must<Workspace>('workspaces', active.workspace_id!).path)).toBe(true);
  expect(existsSync(unowned.path)).toBe(true);
  expect(git(f.source, 'show-ref', '--heads')).toBe(branches);
  expect(f.control.workspaceStale(user, f.project.id).count).toBe(0);
});

it('keeps commits made on an archived detached worktree reachable after pruning it', async () => {
  const f = workbenchFixture();
  const session = f.create('Unmerged session');
  const { startWorkspaceProvisioning } =
    await import('../../packages/control/dist/provisioning.js');
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  startWorkspaceProvisioning(ctx, session.workspace_id!);
  await eventually(
    () =>
      f.store.must<Workspace>('workspaces', session.workspace_id!).provisioning?.state === 'ready',
  );
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  writeFileSync(path.join(workspace.path, 'unmerged.txt'), 'unmerged work\n');
  git(workspace.path, 'add', 'unmerged.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Unmerged work');
  const commit = git(workspace.path, 'rev-parse', 'HEAD');
  const current = f.store.must<Session>('sessions', session.id);
  f.store.update(
    'sessions',
    { ...current, state: 'closed', archived_at: '2026-11-13T00:00:00Z' },
    current.revision,
  );
  expect(await f.call('workspace.prune_stale', { project_id: f.project.id })).toEqual({
    removed: 1,
  });
  expect(existsSync(workspace.path)).toBe(false);
  expect(git(f.source, 'for-each-ref', '--contains', commit)).not.toBe('');
});
