import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Principal, Session, SessionComment, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

async function idleSession(f: Fixture) {
  const session = f.create();
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id)[0]!.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  return f.store.must<Session>('sessions', session.id);
}

function add(f: Fixture, sessionId: string, extra = {}) {
  return f.call<SessionComment>('session.comment.add', {
    session_id: sessionId,
    path: 'src/answer.ts',
    line: 12,
    side: 'new',
    text: 'Explain this change',
    ...extra,
  });
}

it('stores all comment fields and lists by path, line and creation time within one session', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const other = await idleSession(f);
  vi.spyOn(f.store, 'now').mockReturnValue(100);
  const laterPath = add(f, session.id, { path: 'src/z.ts', side: 'old' });
  const laterLine = add(f, session.id, { line: 20 });
  const earlier = add(f, session.id);
  vi.mocked(f.store.now).mockReturnValue(200);
  const later = add(f, session.id);
  add(f, other.id);
  expect(earlier).toEqual({
    id: expect.any(String),
    revision: 1,
    session_id: session.id,
    path: 'src/answer.ts',
    line: 12,
    side: 'new',
    text: 'Explain this change',
    created_at: 100,
    state: 'open',
  });
  expect(f.control.sessionComments(user, session.id)).toEqual([
    earlier,
    later,
    laterLine,
    laterPath,
  ]);
  for (const text of ['', 'x'.repeat(10_001)]) expect(() => add(f, session.id, { text })).toThrow();
  expect(f.control.sessionComments(user, session.id)).toHaveLength(4);
  expect(f.control.sessionPreflight(user, other.id).open_comments).toBe(1);
});

it("keeps the commented line's text and the turn whose diff it was made on", async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const turnId = f.turns(session.id)[0]!.id;
  const onTurn = add(f, session.id, { line_text: '  return readToken();', turn_id: turnId });
  const onBranch = add(f, session.id, { line: 20, line_text: '' });
  expect(onTurn).toMatchObject({ line_text: '  return readToken();', turn_id: turnId });
  expect(onBranch).toMatchObject({ line_text: '' });
  expect(onBranch).not.toHaveProperty('turn_id');
  expect(f.control.sessionComments(user, session.id)).toEqual([onTurn, onBranch]);
});

it('resolves open comments to sent and kept and omits the count once none remain open', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const workspace = f.store.must<Workspace>('workspaces', session.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'changed\n');
  git(workspace.path, 'add', '.');
  git(workspace.path, 'commit', '--quiet', '-m', 'Change the answer');
  const before = f.control.sessionPreflight(user, session.id);
  expect(before.can_merge).toBe(true);
  expect(before).not.toHaveProperty('open_comments');
  const sent = add(f, session.id);
  const kept = add(f, session.id);
  expect(f.control.sessionPreflight(user, session.id)).toEqual({ ...before, open_comments: 2 });
  f.call('session.comment.resolve', { comment_id: sent.id, state: 'sent' }, sent.revision);
  expect(f.control.sessionPreflight(user, session.id).open_comments).toBe(1);
  f.call('session.comment.resolve', { comment_id: kept.id, state: 'kept' }, kept.revision);
  expect(f.control.sessionPreflight(user, session.id)).toEqual(before);
  expect(f.control.sessionComments(user, session.id).map((comment) => comment.state)).toEqual([
    'sent',
    'kept',
  ]);
  expect(f.turns(session.id)).toHaveLength(1);
});

it('deletes a comment from storage and the open count, and refuses a stale revision', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const comment = add(f, session.id);
  expect(f.control.sessionPreflight(user, session.id).open_comments).toBe(1);
  for (const [type, input] of [
    ['session.comment.resolve', { comment_id: comment.id, state: 'kept' }],
    ['session.comment.delete', { comment_id: comment.id }],
  ] as const)
    expect(() => f.call(type, input, comment.revision + 1)).toThrow(
      expect.objectContaining({ code: 'revision_conflict' }),
    );
  expect(f.control.sessionComments(user, session.id)).toEqual([comment]);
  f.call('session.comment.delete', { comment_id: comment.id }, comment.revision);
  expect(f.control.sessionComments(user, session.id)).toEqual([]);
  expect(f.store.get('session_comments', comment.id)).toBeUndefined();
  expect(f.control.sessionPreflight(user, session.id)).not.toHaveProperty('open_comments');
});

it.each(['lead', 'worker'] as const)('refuses comment mutations by a %s session', async (role) => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  if (role === 'worker')
    f.store.update<Session>(
      'sessions',
      {
        ...session,
        task: { lead_session_id: 'lead-session', id: 'explain-change', generation: 1 },
      },
      session.revision,
    );
  const comment = add(f, session.id);
  const principal: Principal = {
    id: `${role}-credential`,
    role,
    session_id: session.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60_000,
  };
  expect(f.control.sessionPrincipal(principal).principal).toEqual(principal);
  for (const [type, input, revision] of [
    [
      'session.comment.add',
      { session_id: session.id, path: 'file.ts', line: 1, side: 'old', text: 'Change it' },
      null,
    ],
    ['session.comment.resolve', { comment_id: comment.id, state: 'sent' }, comment.revision],
    ['session.comment.delete', { comment_id: comment.id }, comment.revision],
  ] as const)
    expect(() => f.call(type, input, revision, principal)).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
  expect(f.control.sessionComments(user, session.id)).toEqual([comment]);
});

it.each(['merged', 'discarded', 'closed'] as const)(
  'refuses all comment mutations after the session is %s',
  async (outcome) => {
    const f = workbenchFixture();
    const session = await idleSession(f);
    const comment = add(f, session.id);
    f.store.update<Session>(
      'sessions',
      { ...session, state: 'closed', ...(outcome === 'closed' ? {} : { outcome }) },
      session.revision,
    );
    expect(() => add(f, session.id)).toThrow(expect.objectContaining({ code: 'invalid_state' }));
    expect(() =>
      f.call(
        'session.comment.resolve',
        { comment_id: comment.id, state: 'sent' },
        comment.revision,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
    expect(() =>
      f.call('session.comment.delete', { comment_id: comment.id }, comment.revision),
    ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
    expect(f.control.sessionComments(user, session.id)).toEqual([comment]);
  },
);

it('records exactly one session event for each comment addition, resolution and deletion', async () => {
  const f = workbenchFixture();
  const session = await idleSession(f);
  const before = f.store.cursor();
  const comment = add(f, session.id);
  const resolved = f.call<SessionComment>(
    'session.comment.resolve',
    { comment_id: comment.id, state: 'kept' },
    comment.revision,
  );
  f.call('session.comment.delete', { comment_id: comment.id }, resolved.revision);
  expect(
    f.store.events(before).map((event) => ({
      kind: event.kind,
      session: event.aggregate_id,
      project: event.project_id,
      payload: event.payload,
    })),
  ).toEqual([
    { kind: 'session.comment_added', session: session.id, project: f.project.id, payload: comment },
    {
      kind: 'session.comment_resolved',
      session: session.id,
      project: f.project.id,
      payload: resolved,
    },
    {
      kind: 'session.comment_deleted',
      session: session.id,
      project: f.project.id,
      payload: resolved,
    },
  ]);
});
