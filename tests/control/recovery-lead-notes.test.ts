import { expect, it, vi } from 'vitest';
import type { BoardPlan, Session, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { appendNote, takeInbox } from '../../packages/control/dist/lead-inbox.js';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

const contextOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;

/** Gives the session a lead plan with one note and queues an undelivered turn that took it. */
function undeliveredNoteTurn(f: Fixture, session: Session) {
  const ctx = contextOf(f);
  const plan = f.store.insert<BoardPlan>('board_plans', {
    id: session.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Plan the export feature',
    lanes: [],
    tasks: [],
    plan_version: 1,
    pending_edits: [],
    risks: [],
    assumptions: [],
    inbox: [],
    notified: {},
    updated_at: f.store.now(),
  });
  const digest = ctx.store.transaction(() => {
    appendNote(ctx, plan, {
      at: f.store.now(),
      session_id: 'worker-session',
      task_id: 'a',
      kind: 'risk',
      text: 'The export format may change',
    });
    return takeInbox(ctx, session.id)!;
  });
  return f.store.insert<SessionTurn>('session_turns', {
    id: `${session.id}-note-turn`,
    revision: 1,
    project_id: f.project.id,
    session_id: session.id,
    input: JSON.stringify(digest.text),
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
    lead_note_ids: digest.note_ids,
  });
}

const inbox = (f: Fixture, leadId: string) =>
  f.store.must<BoardPlan>('board_plans', leadId).inbox.map((note) => note.text);

it('gives the lead back the notes of a turn whose session never started before the restart', async () => {
  const f = workbenchFixture();
  const session = f.store.insert<Session>('sessions', {
    id: 'never-started-reviewer',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    device_id: 'local',
    review_id: 'a-review',
    state: 'reconciling',
    turn_count: 1,
  });
  const turn = undeliveredNoteTurn(f, session);
  expect(inbox(f, session.id)).toEqual([]);

  await f.restart();
  expect(f.store.must<SessionTurn>('session_turns', turn.id)).toMatchObject({
    state: 'failed',
    delivery: 'failed',
  });
  expect(inbox(f, session.id)).toEqual(['The export format may change']);
});

it('gives the lead back the notes of an undelivered turn when a restart finishes its discard', async () => {
  const f = workbenchFixture();
  vi.spyOn(f.adapter, 'send').mockImplementationOnce(async (handle, turn) => {
    handle.process_identity = { pid: 4000001, start_time_us: 1700000000123456 };
    return { turn_id: turn.turn_id, status: 'delivered' };
  });
  const created = f.create();
  await awaitWorkspaceReady(f.control, created.workspace_id!);
  await eventually(
    () => f.store.must<Session>('sessions', created.id).process_identity !== undefined,
    () => f.control.tick(),
  );
  const turn = undeliveredNoteTurn(f, created);
  const session = f.store.must<Session>('sessions', created.id);
  f.store.update(
    'sessions',
    { ...session, stop_requested: { reason: 'Discarded', by: 'user', at: f.store.now() } },
    session.revision,
  );

  await f.restart(() => undefined);
  expect(f.store.must<Session>('sessions', created.id).outcome).toBe('discarded');
  expect(f.store.must<SessionTurn>('session_turns', turn.id).delivery).toBe('failed');
  expect(inbox(f, created.id)).toEqual(['The export format may change']);
});

it('gives the lead back the notes of an undelivered turn when a restart interrupts its discard', async () => {
  const f = workbenchFixture();
  const created = f.create();
  await awaitWorkspaceReady(f.control, created.workspace_id!);
  await eventually(
    () =>
      f.store
        .list<SessionTurn>('session_turns')
        .some((turn) => turn.session_id === created.id && turn.state === 'completed'),
    () => f.control.tick(),
  );
  const turn = undeliveredNoteTurn(f, created);
  const session = f.store.must<Session>('sessions', created.id);
  // The old process was confirmed gone before the restart cut the discard short.
  f.store.update(
    'sessions',
    {
      ...session,
      process_identity: undefined,
      stop_requested: { reason: 'Discarded', by: 'user', at: f.store.now() },
    },
    session.revision,
  );

  await f.restart(() => undefined);
  expect(f.store.must<Session>('sessions', created.id).outcome).toBe('discarded');
  expect(f.store.must<SessionTurn>('session_turns', turn.id).delivery).toBe('failed');
  expect(inbox(f, created.id)).toEqual(['The export format may change']);
});
