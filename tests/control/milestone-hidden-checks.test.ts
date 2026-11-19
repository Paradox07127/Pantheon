import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { Principal, Session, SessionSpec, Workspace } from '@pantheon/domain';
import { projectFolder, type ControlContext } from '../../packages/control/dist/context.js';
import { inPlaceSessionSpec } from '../../packages/control/dist/in-place-session.js';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { boundTaskSession, git, workbenchFixture } from './workbench-fixture.js';

const checks = [{ name: 'Export survives a restart', command: 'node scripts/restart-export.mjs' }];

/** A session without a task and a task session of it, each in its own ready worktree. */
async function leadAndTask() {
  const f = await workbenchFixture();
  const lead = await f.create('Plan the export feature');
  const worker = await boundTaskSession(f, lead.id, 'export');
  const workspaces = await Promise.all(
    [lead, worker].map((session) => awaitWorkspaceReady(f.control, session.workspace_id!)),
  );
  const spec = (sessionId: string) =>
    f.start.mock.calls
      .map(([started]) => started as SessionSpec)
      .find((started) => started.platform_session_id === sessionId);
  await eventually(
    () => spec(lead.id) !== undefined && spec(worker.id) !== undefined,
    () => f.control.tick(),
  );
  const unreadable = (sessionId: string) =>
    spec(sessionId)!
      .sandbox!.protected_entries.filter((entry) => entry.deny === 'read_write')
      .map((entry) => entry.path);
  return { f, lead, worker, workspaces: workspaces as Workspace[], unreadable };
}

it('keeps hidden checks in the project folder outside every worktree and project root', async () => {
  const { f, workspaces } = await leadAndTask();
  const set = f.call('milestone.checks.set', { project_id: f.project.id, checks });
  expect(set).toEqual({ project_id: f.project.id, checks });
  const file = path.join(path.dirname(workspaces[0]!.path), 'checks', 'hidden.json');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ checks });
  for (const workspace of workspaces) expect(file.startsWith(`${workspace.path}/`)).toBe(false);
  expect(file.startsWith(`${f.source}/`)).toBe(false);
  expect(f.call('milestone.checks.get', { project_id: f.project.id })).toEqual({
    project_id: f.project.id,
    checks,
  });
});

it('reads no hidden checks for a project that has none', async () => {
  const f = await workbenchFixture();
  expect(f.call('milestone.checks.get', { project_id: f.project.id })).toEqual({
    project_id: f.project.id,
    checks: [],
  });
});

it('lets only the user read or change the hidden checks', async () => {
  const { f, lead } = await leadAndTask();
  const principal: Principal = {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60_000,
  };
  expect(() =>
    f.call('milestone.checks.get', { project_id: f.project.id }, null, principal),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(() =>
    f.call('milestone.checks.set', { project_id: f.project.id, checks }, null, principal),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
  expect(existsSync(path.join(f.root, 'managed', 'checks'))).toBe(false);
});

it('refuses two hidden checks with the same name', async () => {
  const f = await workbenchFixture();
  expect(() =>
    f.call('milestone.checks.set', { project_id: f.project.id, checks: [...checks, ...checks] }),
  ).toThrow();
});

it('denies a task session and a session without a task reading the hidden checks folder', async () => {
  const { lead, worker, workspaces, unreadable } = await leadAndTask();
  const folder = path.join(path.dirname(workspaces[0]!.path), 'checks');
  expect(unreadable(worker.id)).toContain(folder);
  expect(unreadable(lead.id)).toContain(folder);
});

it('denies a reviewer session reading the hidden checks folder', async () => {
  const f = await workbenchFixture();
  const reviewer = new FixtureAdapter();
  reviewer.name = 'checks-reviewer';
  const start = vi.spyOn(reviewer, 'start');
  f.control.adapters.set(reviewer.name, reviewer);
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'reviewed answer\n');
  git(workspace.path, 'commit', '--quiet', '-am', 'Update the answer');
  f.call('milestone.checks.set', { project_id: f.project.id, checks });
  await f.call('review.request', { session_id: session.id, runtimes: [reviewer.name] });
  await eventually(
    () => start.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(start.mock.calls[0]![0].sandbox?.protected_entries).toContainEqual({
    path: realpathSync(path.join(path.dirname(workspace.path), 'checks')),
    deny: 'read_write',
  });
});

it('denies a session in the user folder reading the hidden checks folder', async () => {
  const f = await workbenchFixture({ adoptable: true });
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  Object.assign(ctx, {
    issueSessionCredential: () => ({
      token_file: path.join(f.root, 'token'),
      daemon_url: 'http://127.0.0.1:1',
    }),
  });
  f.call('milestone.checks.set', { project_id: f.project.id, checks });
  const spec = await inPlaceSessionSpec(ctx, await f.adopt());
  expect(spec.sandbox?.protected_entries).toContainEqual(
    expect.objectContaining({
      path: realpathSync(path.join(projectFolder(ctx, f.project.id), 'checks')),
      deny: 'read_write',
    }),
  );
});
