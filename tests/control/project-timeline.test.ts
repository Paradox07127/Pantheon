import { expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '@pantheon/daemon';
import { command } from '@pantheon/protocol';
import type { Approval, Entity, Project, Session, SessionTurn, Workspace } from '@pantheon/domain';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const base = Date.parse('2026-01-01T12:00:00Z');
const iso = (seconds: number) => new Date(base + seconds * 1000).toISOString();

async function timelineFixture() {
  const f = await workbenchFixture();
  const now = vi.spyOn(f.store, 'now').mockReturnValue(base);
  const record = (
    seconds: number,
    kind: string,
    entity: Entity & { project_id: string },
    payload: unknown = {},
  ) => {
    now.mockReturnValue(base + seconds * 1000);
    return f.store.event(kind, entity, entity.project_id, payload);
  };
  const session = (id: string, seconds = 0, projectId = f.project.id) => {
    const workspace = f.store.insert<Workspace>('workspaces', {
      id: `${id}-workspace`,
      revision: 1,
      project_id: projectId,
      kind: 'linked_worktree',
      path: `${f.root}/${id}`,
      owner: 'none',
      ownership_epoch: 0,
      provisioning: { state: 'queued', base_ref: 'HEAD' },
    });
    const session = f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: projectId,
      workspace_id: workspace.id,
      runtime: f.adapter.name,
      title: `Session ${id}`,
      state: 'open',
      turn_count: 0,
    });
    record(seconds, 'workspace.registered', workspace, workspace);
    record(seconds, 'session.opened', session, session);
    return { session, workspace };
  };
  const turn = (session: Session, id: string) =>
    f.store.insert<SessionTurn>('session_turns', {
      id,
      revision: 1,
      project_id: session.project_id,
      session_id: session.id,
      input: 'Check the project',
      kind: 'send',
      delivery: 'delivered',
      state: 'completed',
    });
  const approval = (session: Session, id: string): Approval => ({
    id,
    revision: 1,
    project_id: session.project_id,
    session_id: session.id,
    kind: 'permission',
    input_hash: id,
    decider: 'user',
    state: 'pending',
    created_at: base,
  });
  return { ...f, now, record, session, turn, approval };
}

it('ends a merging interval when cancellation is confirmed', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('cancelled-work');
  f.record(1, 'workspace.ready', workspace);
  f.record(2, 'session.merge_started', session);
  f.record(3, 'session.merge_cancel_requested', session);
  f.record(4, 'session.merge_cancelled', session);
  f.now.mockReturnValue(base + 5000);
  const lane = f.control.projectTimeline(user, f.project.id, iso(0)).sessions[0]!;
  expect(lane.intervals.slice(-2)).toEqual([
    { state: 'merging', from: iso(2), to: iso(4) },
    { state: 'idle', from: iso(4), to: null },
  ]);
});

it('replays provisioning, two turns, a permission wait, idle time and a merge', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('first');
  const first = f.turn(session, 'first-turn'),
    second = f.turn(session, 'second-turn'),
    permission = f.approval(session, 'permission');
  f.record(1, 'workspace.provisioning', workspace, { state: 'running' });
  f.record(2, 'workspace.ready', workspace);
  f.record(3, 'turn.running', first);
  f.record(5, 'turn.completed', first);
  f.record(8, 'turn.running', second);
  f.record(9, 'approval.requested', permission, permission);
  f.record(10, 'approval.approved', permission, { ...permission, state: 'approved' });
  f.record(11, 'approval.resolved', permission, { ...permission, state: 'approved' });
  f.record(12, 'turn.completed', second);
  f.record(15, 'session.merge_started', session);
  f.record(16, 'session.gate_started', session);
  f.record(20, 'session.merged', session);
  f.record(21, 'workspace.removed', workspace);
  f.record(22, 'session.archived', session);
  f.now.mockReturnValue(base + 30_000);
  const cursor = f.store.cursor();

  expect(f.control.projectTimeline(user, f.project.id, iso(0))).toEqual({
    from: iso(0),
    to: iso(30),
    sessions: [
      {
        session_id: session.id,
        title: session.title,
        runtime: session.runtime,
        intervals: [
          { state: 'starting', from: iso(0), to: iso(2) },
          { state: 'idle', from: iso(2), to: iso(3) },
          { state: 'running', from: iso(3), to: iso(5) },
          { state: 'ready', from: iso(5), to: iso(8) },
          { state: 'running', from: iso(8), to: iso(9) },
          { state: 'waiting', from: iso(9), to: iso(10) },
          { state: 'running', from: iso(10), to: iso(12) },
          { state: 'ready', from: iso(12), to: iso(15) },
          { state: 'merging', from: iso(15), to: iso(20) },
          { state: 'merged', from: iso(20), to: iso(20) },
        ],
      },
    ],
  });
  expect(f.store.cursor()).toBe(cursor);
});

it('leaves a running lane open and defaults the window to the last seven days', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('running');
  const turn = f.turn(session, 'running-turn');
  f.record(2, 'workspace.ready', workspace);
  f.record(3, 'turn.running', turn);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id)).toEqual({
    from: new Date(base + 10_000 - 7 * 24 * 60 * 60 * 1000).toISOString(),
    to: iso(10),
    sessions: [
      {
        session_id: session.id,
        title: session.title,
        runtime: session.runtime,
        intervals: [
          { state: 'starting', from: iso(0), to: iso(2) },
          { state: 'idle', from: iso(2), to: iso(3) },
          { state: 'running', from: iso(3), to: null },
        ],
      },
    ],
  });
});

it('replays events before since to clip a pending wait and resume the running turn', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('clipped');
  const turn = f.turn(session, 'clipped-turn'),
    permission = f.approval(session, 'clipped-permission');
  f.record(1, 'workspace.ready', workspace);
  f.record(2, 'turn.running', turn);
  f.record(3, 'approval.requested', permission, permission);
  f.record(6, 'approval.resolved', permission, { ...permission, state: 'approved' });
  f.now.mockReturnValue(base + 10_000);

  const timeline = f.control.projectTimeline(user, f.project.id, iso(5));
  expect(timeline.from).toBe(iso(5));
  expect(timeline.sessions[0]!.intervals).toEqual([
    { state: 'waiting', from: iso(5), to: iso(6) },
    { state: 'running', from: iso(6), to: null },
  ]);
});

it('separates queue time from running time and readiness for review', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('queued');
  const first = f.turn(session, 'active-turn'),
    second = f.turn(session, 'queued-turn');
  f.record(0, 'turn.queued', first, { ...first, state: 'queued' });
  f.record(2, 'workspace.ready', workspace);
  f.record(3, 'turn.running', first);
  f.record(4, 'turn.queued', second, { ...second, state: 'queued' });
  f.record(5, 'turn.cancelled', second);
  f.record(6, 'turn.completed', first);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id, iso(0)).sessions[0]!.intervals).toEqual([
    { state: 'starting', from: iso(0), to: iso(0) },
    { state: 'queued', from: iso(0), to: iso(3) },
    { state: 'running', from: iso(3), to: iso(6) },
    { state: 'ready', from: iso(6), to: null },
  ]);
});

it('keeps a lane that waits through the whole window without new events', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('still-waiting');
  const turn = f.turn(session, 'still-waiting-turn'),
    permission = f.approval(session, 'still-waiting-permission');
  f.record(1, 'workspace.ready', workspace);
  f.record(2, 'turn.running', turn);
  f.record(3, 'approval.requested', permission, permission);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id, iso(5)).sessions).toEqual([
    {
      session_id: session.id,
      title: session.title,
      runtime: session.runtime,
      intervals: [{ state: 'waiting', from: iso(5), to: null }],
    },
  ]);
});

it('ends a steer that was delivered into the running turn with that turn', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('steered');
  const main = f.turn(session, 'main-turn'),
    steer = { ...f.turn(session, 'steer-turn'), kind: 'steer' as const };
  f.record(1, 'workspace.ready', workspace);
  f.record(2, 'turn.queued', main, { ...main, state: 'queued' });
  f.record(2, 'session.turn.delivery', main, { delivery: 'pending' });
  f.record(3, 'turn.running', main);
  f.record(3, 'session.turn.delivery', main, { delivery: 'delivered' });
  f.record(4, 'turn.queued', steer, { ...steer, state: 'queued' });
  f.record(4, 'session.turn.delivery', steer, { delivery: 'pending' });
  f.record(5, 'session.turn.delivery', steer, { delivery: 'delivered' });
  f.record(6, 'turn.completed', main);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id, iso(1)).sessions[0]!.intervals).toEqual([
    { state: 'idle', from: iso(1), to: iso(2) },
    { state: 'queued', from: iso(2), to: iso(3) },
    { state: 'running', from: iso(3), to: iso(6) },
    { state: 'ready', from: iso(6), to: null },
  ]);
});

it('ends a steer whose delivery failed without a turn end', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('refused-steer');
  const main = f.turn(session, 'refused-main-turn'),
    steer = { ...f.turn(session, 'refused-steer-turn'), kind: 'steer' as const };
  f.record(1, 'workspace.ready', workspace);
  f.record(2, 'turn.running', main);
  f.record(3, 'turn.queued', steer, { ...steer, state: 'queued' });
  f.record(4, 'session.turn.delivery', steer, { delivery: 'failed', reason: 'refused' });
  f.record(5, 'turn.completed', main);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id, iso(1)).sessions[0]!.intervals).toEqual([
    { state: 'idle', from: iso(1), to: iso(2) },
    { state: 'running', from: iso(2), to: iso(5) },
    { state: 'ready', from: iso(5), to: null },
  ]);
});

it('ends a session discarded after its provisioning failed as discarded', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('failed-then-discarded');
  f.record(2, 'workspace.provisioning', workspace, { state: 'failed' });
  f.record(2, 'session.closed', session, { reason: 'workspace_failed' });
  f.record(5, 'session.discarded', session);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id, iso(0)).sessions[0]!.intervals).toEqual([
    { state: 'starting', from: iso(0), to: iso(2) },
    { state: 'failed', from: iso(2), to: iso(5) },
    { state: 'discarded', from: iso(5), to: iso(5) },
  ]);
});

it('leaves out a deleted session whose events remain', async () => {
  const f = await timelineFixture();
  const kept = f.session('kept'),
    deleted = f.session('deleted');
  const keptTurn = f.turn(kept.session, 'kept-turn'),
    deletedTurn = f.turn(deleted.session, 'deleted-turn'),
    permission = f.approval(deleted.session, 'deleted-permission');
  f.record(1, 'workspace.ready', kept.workspace);
  f.record(1, 'workspace.ready', deleted.workspace);
  f.record(2, 'turn.running', deletedTurn);
  f.record(3, 'approval.requested', permission, permission);
  f.record(4, 'turn.running', keptTurn);
  f.record(5, 'session.discarded', deleted.session);
  f.record(5, 'session.deleted', deleted.session, { title: deleted.session.title });
  f.store.remove('session_turns', deletedTurn.id, deletedTurn.revision);
  f.store.remove('sessions', deleted.session.id, deleted.session.revision);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id, iso(0)).sessions).toEqual([
    {
      session_id: kept.session.id,
      title: kept.session.title,
      runtime: kept.session.runtime,
      intervals: [
        { state: 'starting', from: iso(0), to: iso(1) },
        { state: 'idle', from: iso(1), to: iso(4) },
        { state: 'running', from: iso(4), to: null },
      ],
    },
  ]);
});

it('lists only recently active worktree sessions of the project in first event order', async () => {
  const f = await timelineFixture();
  const later = f.session('later', 4),
    earlier = f.session('earlier', 0),
    quiet = f.session('quiet', 0);
  const other = f.store.insert<Project>('projects', { ...f.project, id: 'other-project' });
  f.session('foreign', 7, other.id);
  const readOnly = f.store.insert<Session>('sessions', {
    ...earlier.session,
    id: 'read-only',
    workspace_id: undefined,
  });
  f.record(8, 'session.opened', readOnly, readOnly);
  f.record(5, 'session.renamed', earlier.session, { title: 'Earlier' });
  f.record(6, 'workspace.ready', later.workspace);
  f.record(3, 'workspace.ready', quiet.workspace);
  f.now.mockReturnValue(base + 10_000);

  expect(
    f.control.projectTimeline(user, f.project.id, iso(5)).sessions.map((lane) => lane.session_id),
  ).toEqual([earlier.session.id, later.session.id]);
});

it.each(['approval.rejected', 'approval.void'])(
  'keeps waiting for the remaining permission after %s',
  async (kind) => {
    const f = await timelineFixture();
    const { session, workspace } = f.session('waiting');
    const turn = f.turn(session, 'waiting-turn'),
      first = f.approval(session, 'first-permission'),
      second = f.approval(session, 'second-permission');
    f.record(1, 'workspace.ready', workspace);
    f.record(2, 'turn.running', turn);
    f.record(3, 'approval.requested', first, first);
    f.record(4, 'approval.requested', second, second);
    f.record(5, kind, first, { ...first, state: kind === 'approval.void' ? 'void' : 'rejected' });
    f.record(6, 'approval.resolved', second, { ...second, state: 'approved' });
    f.now.mockReturnValue(base + 10_000);

    expect(f.control.projectTimeline(user, f.project.id, iso(2)).sessions[0]!.intervals).toEqual([
      { state: 'running', from: iso(2), to: iso(3) },
      { state: 'waiting', from: iso(3), to: iso(6) },
      { state: 'running', from: iso(6), to: null },
    ]);
  },
);

it.each([
  ['session.discarded', {}, 'discarded', iso(2)],
  ['session.closed', {}, 'failed', null],
  ['workspace.provisioning', { state: 'failed' }, 'failed', null],
  ['workspace.provisioning', { state: 'cancelled' }, 'failed', null],
] as const)('ends the lane on %s with %j', async (kind, payload, state, to) => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('ended');
  f.record(2, kind, kind.startsWith('workspace.') ? workspace : session, payload);
  f.record(3, 'session.closed', session);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id, iso(0)).sessions[0]!.intervals).toEqual([
    { state: 'starting', from: iso(0), to: iso(2) },
    { state, from: iso(2), to },
  ]);
});

it('returns to idle after a blocked merge and after failed or cancelled turns', async () => {
  const f = await timelineFixture();
  const { session, workspace } = f.session('retry');
  const first = f.turn(session, 'failed-turn'),
    second = f.turn(session, 'cancelled-turn');
  f.record(1, 'workspace.ready', workspace);
  f.record(2, 'turn.running', first);
  f.record(3, 'turn.failed', first);
  f.record(4, 'turn.running', second);
  f.record(5, 'turn.cancelled', second);
  f.record(6, 'session.merge_started', session);
  f.record(7, 'session.merge_blocked', session);
  f.now.mockReturnValue(base + 10_000);

  expect(f.control.projectTimeline(user, f.project.id, iso(1)).sessions[0]!.intervals).toEqual([
    { state: 'idle', from: iso(1), to: iso(2) },
    { state: 'running', from: iso(2), to: iso(3) },
    { state: 'idle', from: iso(3), to: iso(4) },
    { state: 'running', from: iso(4), to: iso(5) },
    { state: 'idle', from: iso(5), to: iso(6) },
    { state: 'merging', from: iso(6), to: iso(7) },
    { state: 'idle', from: iso(7), to: null },
  ]);
});

it('refuses access from another project principal', async () => {
  const f = await timelineFixture();
  expect(() =>
    f.control.projectTimeline(
      { id: 'other', role: 'planner', session_id: 'other', project_id: 'other-project' },
      f.project.id,
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it('serves the timeline at GET /v1/project.timeline and validates since', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'project-timeline-')),
    work = path.join(root, 'project');
  mkdirSync(work);
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    intervalMs: 60000,
    now: () => base,
  });
  try {
    const project = (await daemon.control.execute(
      user,
      command(user.id, 'project.open', { name: 'Timeline project', roots: [work] }),
    )) as Project;
    const workspace = daemon.store.insert<Workspace>('workspaces', {
      id: 'timeline-workspace',
      revision: 1,
      project_id: project.id,
      kind: 'linked_worktree',
      path: work,
      owner: 'none',
      ownership_epoch: 0,
      provisioning: { state: 'queued', base_ref: 'HEAD' },
    });
    const session = daemon.store.insert<Session>('sessions', {
      id: 'timeline-session',
      revision: 1,
      project_id: project.id,
      workspace_id: workspace.id,
      runtime: 'fixture',
      title: 'Timeline session',
      state: 'open',
      turn_count: 0,
    });
    daemon.store.event('session.opened', session, project.id, session);
    const url = new URL('/v1/project.timeline', daemon.url);
    url.searchParams.set('project_id', project.id);
    url.searchParams.set('since', iso(-1));
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      from: iso(-1),
      to: iso(0),
      sessions: [
        {
          session_id: session.id,
          title: session.title,
          runtime: session.runtime,
          intervals: [{ state: 'starting', from: iso(0), to: null }],
        },
      ],
    });
    url.searchParams.set('since', 'yesterday');
    const invalid = await fetch(url, { headers });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_input' });
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
