import { expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  HarnessAdapter,
  Principal,
  Session,
  SessionTurn,
  UserTurn,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const task = (id: string): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** Sends one more turn to the session and returns the turn the adapter received. */
async function delivered(f: Fixture, send: { mock: { calls: unknown[][] } }, session: Session) {
  const turn = f.call<SessionTurn>(
    'session.send',
    { session_id: session.id, input: 'Add a CSV export button' },
    current(f, session.id).revision,
  );
  await settle(f, session);
  const call = send.mock.calls.find(([, sent]) => (sent as UserTurn).turn_id === turn.id);
  expect(call).toBeDefined();
  return call![1] as UserTurn;
}

it('makes lead turns read-only while the plan has an unfinished task', async () => {
  const f = await workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task('a')],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );

  expect((await delivered(f, send, lead)).read_only).toBe(true);

  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  f.store.update<BoardPlan>(
    'board_plans',
    { ...plan, accepted: { a: { at: f.store.now(), evidence: 'Merged by hand' } } },
    plan.revision,
  );
  expect((await delivered(f, send, lead)).read_only ?? false).toBe(false);
});

it('makes the running lead turn read-only once its plan update leaves an unfinished task', async () => {
  const f = await workbenchFixture({ delay: 5000 });
  const setTurnReadOnly = vi.fn();
  (f.adapter as HarnessAdapter).setTurnReadOnly = setTurnReadOnly;
  const send = vi.spyOn(f.adapter, 'send');
  const lead = await f.create('Plan the export feature');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => send.mock.calls.length === 1,
    () => f.control.tick(),
  );
  const update = (tasks: PlanTask[]) =>
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: f.store.get<BoardPlan>('board_plans', lead.id)?.plan_version ?? 0,
        headline: 'Export ships this week',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks,
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      leadOf(f, lead.id),
    );
  update([]);
  await Promise.resolve();
  expect(setTurnReadOnly).not.toHaveBeenCalled();
  update([task('a')]);
  await Promise.resolve();
  expect(setTurnReadOnly).toHaveBeenCalledExactlyOnceWith(send.mock.calls[0]![0], true);
});

it('never makes turns of a session without a plan read-only', async () => {
  const f = await workbenchFixture();
  const send = vi.spyOn(f.adapter, 'send');
  const session = await f.create('Rename the answer file');
  await settle(f, session);
  expect(send.mock.calls.map(([, sent]) => (sent as UserTurn).read_only ?? false)).toEqual([false]);
  expect((await delivered(f, send, session)).read_only ?? false).toBe(false);
});
