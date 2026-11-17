import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { Project, Session, SessionComment, SessionTurn, Workspace } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { releaseIdleConversation } from '../../packages/control/dist/session.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

async function idleSession(f: Fixture): Promise<Session> {
  const session = await f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return current(f, session.id);
}

it('refuses to copy attachments through a temporary directory the session replaced with a link', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const { writerTempDirectory } = await import('../../packages/control/dist/workspace-removal.js');
  const temporary = writerTempDirectory(session.workspace_id!);
  f.temporaryDirectories.push(temporary);
  const victim = path.join(f.root, 'victim');
  mkdirSync(victim);
  writeFileSync(path.join(victim, 'attachments'), 'precious user file\n');
  rmSync(temporary, { recursive: true, force: true });
  symlinkSync(victim, temporary);
  const upload = f.control.addAttachment(
    user,
    f.project.id,
    'note.txt',
    'text/plain',
    new TextEncoder().encode('attached\n'),
  );
  expect(() =>
    f.call(
      'session.send',
      { session_id: session.id, input: 'Read the note', attachments: [upload.id] },
      session.revision,
    ),
  ).toThrow(expect.objectContaining({ code: 'sandbox_path_replaced' }));
  expect(lstatSync(path.join(victim, 'attachments')).isFile()).toBe(true);
  expect(readFileSync(path.join(victim, 'attachments'), 'utf8')).toBe('precious user file\n');
});

it('refuses a setting the runtime cannot apply live while an input waits for its idle process', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  expect(
    [...f.control.handles.values()].some((handle) => handle.platform_session_id === session.id),
  ).toBe(true);
  f.call('session.send', { session_id: session.id, input: 'Continue the work' }, session.revision);
  expect(current(f, session.id).state).toBe('running');
  const changes: [string, Record<string, unknown>, string][] = [
    ['session.setPermissionMode', { permission_mode: 'auto_edit' }, 'unsupported_capability'],
    ['session.setModel', { model: 'fixture', effort: 'high' }, 'unsupported_capability'],
    ['session.setBackend', { backend: null }, 'invalid_state'],
  ];
  for (const [type, input, code] of changes)
    expect(
      () =>
        f.call(
          type as Parameters<Fixture['call']>[0],
          { session_id: session.id, ...input },
          current(f, session.id).revision,
        ),
      type,
    ).toThrow(expect.objectContaining({ code }));
  expect(current(f, session.id)).toMatchObject({ permission_mode: 'ask' });
  expect(current(f, session.id).requested_effort).toBe(session.requested_effort);
});

it('fails the queued input of a session discarded before its released process starts again', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  releaseIdleConversation(ctx, session);
  await eventually(
    () =>
      ![...f.control.handles.values()].some((handle) => handle.platform_session_id === session.id),
    () => f.control.tick(),
  );
  f.call(
    'session.send',
    { session_id: session.id, input: 'Continue the work' },
    current(f, session.id).revision,
  );
  const queued = f.turns(session.id).at(-1)!;
  expect(queued.state).toBe('queued');
  f.call('session.discard', { session_id: session.id }, current(f, session.id).revision);
  expect(current(f, session.id).outcome).toBe('discarded');
  expect(f.store.must<SessionTurn>('session_turns', queued.id)).toMatchObject({
    state: 'failed',
    delivery: 'failed',
  });
});

it('shows a session in the user folder ready after its turn instead of starting', async () => {
  const f = await workbenchFixture();
  const folder = realpathSync(f.source);
  const workspace = f.store.insert<Workspace>('workspaces', {
    id: randomUUID(),
    revision: 1,
    project_id: f.project.id,
    kind: 'in_place',
    path: folder,
    source: folder,
    owner: 'none',
    ownership_epoch: 0,
  });
  f.store.event('workspace.registered', workspace, f.project.id, workspace);
  const session = f.store.insert<Session>('sessions', {
    id: randomUUID(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    device_id: 'local',
    native_id: randomUUID(),
    state: 'open',
    turn_count: 0,
    workspace_id: workspace.id,
    permission_mode: 'ask',
  });
  f.call('session.send', { session_id: session.id, input: 'Continue' }, session.revision);
  await eventually(
    () =>
      current(f, session.id).state === 'open' &&
      f.turns(session.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  const lane = f.control
    .projectTimeline(user, f.project.id)
    .sessions.find((each) => each.session_id === session.id)!;
  expect(lane.intervals.map((interval) => interval.state)).not.toContain('starting');
  expect(lane.intervals.at(-1)).toMatchObject({ state: 'ready', to: null });
});

it('deletes the diff comments of a deleted session', async () => {
  const f = await workbenchFixture();
  const session = await idleSession(f);
  f.call<SessionComment>('session.comment.add', {
    session_id: session.id,
    path: 'answer.txt',
    line: 1,
    side: 'new',
    text: 'Explain this change',
  });
  f.call('session.discard', { session_id: session.id }, current(f, session.id).revision);
  await eventually(
    () => current(f, session.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  f.call('session.delete', { session_id: session.id }, current(f, session.id).revision);
  expect(
    f.store
      .list<SessionComment>('session_comments')
      .filter((comment) => comment.session_id === session.id),
  ).toEqual([]);
});

it('refuses a worktree session in a project folder that is a linked worktree of another checkout', async () => {
  const f = await workbenchFixture();
  const linked = path.join(f.root, 'project/linked');
  git(f.source, 'worktree', 'add', '--quiet', '-b', 'linked-branch', linked);
  const project = await f.call<Project>('project.open', {
    name: 'Linked project',
    roots: [linked],
  });
  await expect(
    f.call('session.create', {
      project_id: project.id,
      runtime: f.adapter.name,
      input: 'Change the answer',
    }),
  ).rejects.toThrow(expect.objectContaining({ code: 'source_metadata_unsupported' }));
  expect(
    f.store.list<Workspace>('workspaces').filter((each) => each.project_id === project.id),
  ).toEqual([]);
});
