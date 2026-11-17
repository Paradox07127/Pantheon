import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Approval, Entity, Session, Workspace } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

async function timeline(change = true) {
  const f = await workbenchFixture();
  const session = await f.create('Measure session time');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  if (change) {
    const worktree = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
    writeFileSync(path.join(worktree, 'notes.txt'), 'notes\n');
    git(worktree, 'add', '--', 'notes.txt');
    git(worktree, 'commit', '--quiet', '-m', 'Add notes');
  }
  await eventually(
    () =>
      f.turns(session.id)[0]?.state === 'completed' &&
      f.store.must<Session>('sessions', session.id).state === 'open',
    () => f.control.tick(),
  );
  const turn = f.turns(session.id)[0]!;
  const start = new Date(2027, 2, 16, 12).getTime();
  f.store.db
    .prepare('UPDATE events SET created_at=? WHERE aggregate_id IN (?, ?)')
    .run(start, session.id, turn.id);
  for (const [kind, offset] of [
    ['turn.running', 1000],
    ['turn.completed', 5000],
  ] as const)
    f.store.db
      .prepare('UPDATE events SET created_at=? WHERE aggregate_id=? AND kind=?')
      .run(start + offset, turn.id, kind);
  await f.control.prefetchWorktreeReads(user, f.project.id);
  const clock = vi.spyOn(f.store, 'now').mockReturnValue(start + 10000);
  const event = (offset: number, kind: string, owner: Entity, payload: unknown = {}) => {
    clock.mockReturnValue(start + offset);
    f.store.event(kind, owner, f.project.id, payload);
  };
  const approval = (id: string, tool = 'Bash'): Approval => ({
    id,
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    kind: 'permission',
    input_hash: id,
    decider: 'user',
    state: 'pending',
    created_at: start + 2000,
    tool,
  });
  const board = () => f.control.boardView(user, f.project.id, 1);
  return { f, session, turn, start, clock, event, approval, board };
}

it('partitions a merged session into working, user wait, gate and queue time', async () => {
  const t = await timeline();
  const request = t.approval('command-approval');
  t.event(2000, 'approval.requested', request, request);
  t.event(4000, 'approval.approved', request, { ...request, state: 'approved' });
  t.event(7000, 'session.gate_started', t.session);
  t.event(9000, 'session.gate_checked', t.session, { results: [] });
  t.event(9000, 'session.merge_started', t.session);
  t.event(10000, 'session.merged', t.session, { to_sha: 'merged-head' });
  const counts = t.board().counts;
  expect(counts.session_time).toEqual({
    sessions: 1,
    working_ms: 2000,
    waiting_ms: 4000,
    gate_ms: 3000,
    queue_ms: 1000,
  });
  const { sessions, ...parts } = counts.session_time!;
  expect(sessions).toBe(1);
  expect(Object.values(parts).reduce((sum, value) => sum + value, 0)).toBe(counts.median_ms);
  expect(counts.previous).not.toHaveProperty('session_time');
  expect(counts.wait_by_reason_ms).toEqual({ approval: 2000, review: 2000 });
});

it('counts a merged session only in the previous range and omits empty time objects', async () => {
  const t = await timeline();
  expect(t.board().counts).not.toHaveProperty('session_time');
  t.event(10000, 'session.merged', t.session, { to_sha: 'merged-head' });
  t.event(10000, 'session.closed', t.session);
  t.clock.mockReturnValue(new Date(2027, 2, 17, 12).getTime());
  const counts = t.board().counts;
  expect(counts).not.toHaveProperty('session_time');
  expect(counts.merged).toBe(0);
  expect(counts.previous?.merged).toBe(1);
  expect(counts).not.toHaveProperty('wait_by_reason_ms');
  expect(counts.previous?.session_time).toEqual({
    sessions: 1,
    working_ms: 4000,
    waiting_ms: 5000,
    gate_ms: 0,
    queue_ms: 1000,
  });
});

it('clips approval waits to the range and separates questions from review waits', async () => {
  const t = await timeline();
  const midnight = new Date(2027, 2, 17).getTime();
  const offset = midnight - t.start;
  const approval = t.approval('overnight-approval');
  t.event(offset - 1000, 'approval.requested', approval, approval);
  t.event(offset + 2000, 'approval.rejected', approval, { ...approval, state: 'rejected' });
  const question = t.approval('format-question', 'AskUserQuestion');
  t.event(offset + 3000, 'approval.requested', question, question);
  t.event(offset + 6000, 'approval.approved', question, { ...question, state: 'approved' });
  const leadQuestion = { id: 'destination-question' };
  t.event(offset + 7000, 'lead.question_asked', t.session, leadQuestion);
  t.event(offset + 9000, 'lead.question_answered', t.session, leadQuestion);
  t.clock.mockReturnValue(midnight + 10000);
  expect(t.board().counts.wait_by_reason_ms).toEqual({
    approval: 2000,
    review: 3000,
    question: 5000,
  });
});

it('gives open approvals precedence over questions and a gate precedence over review', async () => {
  const t = await timeline();
  const approval = t.approval('overlapping-approval');
  const question = t.approval('overlapping-question', 'AskUserQuestion');
  t.event(2000, 'approval.requested', approval, approval);
  t.event(3000, 'approval.requested', question, question);
  t.event(4000, 'approval.approved', approval, { ...approval, state: 'approved' });
  t.event(6000, 'approval.resolved', question, { ...question, state: 'approved' });
  t.event(6000, 'session.gate_started', t.session);
  t.event(8000, 'session.gate_run_failed', t.session);
  t.clock.mockReturnValue(t.start + 9000);
  expect(t.board().counts.wait_by_reason_ms).toEqual({
    approval: 2000,
    question: 2000,
    review: 1000,
  });
});

it('clips an ongoing review wait at the midnight ending a past range', async () => {
  const t = await timeline();
  t.clock.mockReturnValue(new Date(2027, 2, 17, 12).getTime());
  const counts = t.f.control.boardView(user, t.f.project.id, 1, '2027-03-16').counts;
  expect(counts.wait_by_reason_ms).toEqual({ review: 12 * 60 * 60 * 1000 - 5000 });
});

it.each([
  ['omits user wait totals when a turn is still working', true, 1500],
  ['leaves a session without a change out of the review wait', false, 9000],
])('%s', async (_name, change, at) => {
  const t = await timeline(change);
  t.clock.mockReturnValue(t.start + at);
  expect(t.board().counts).not.toHaveProperty('wait_by_reason_ms');
});
