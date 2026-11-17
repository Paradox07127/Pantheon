import { expect, it } from 'vitest';
import type {
  Approval,
  BoardPlan,
  Principal,
  Retrospective,
  Session,
  WorkflowPolicy,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const leadPrincipal = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

/** A goal or message the fixture runtime runs as a script. */
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

const task = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
  ...fields,
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const board = (f: Fixture) => f.control.boardView(user, f.project.id, 1);
const leadRow = (f: Fixture, leadId: string) =>
  board(f).leads!.find((lead) => lead.session_id === leadId)!;

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  dispatchEveryTier(f);
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadPrincipal(f, lead.id),
  );
  return lead;
}

const send = (f: Fixture, sessionId: string, input: string) =>
  f.call('session.send', { session_id: sessionId, input }, current(f, sessionId).revision);

it('shows an idle lead, then one whose turn runs, as its activity', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  expect(leadRow(f, lead.id).activity).toMatchObject({
    phase: 'idle',
    health: 'fresh',
    attempt: 1,
  });
  send(f, lead.id, script({ hang: true }));
  await eventually(
    () => f.turns(lead.id).some((turn) => turn.state === 'running'),
    () => f.control.tick(),
  );
  expect(leadRow(f, lead.id).activity).toMatchObject({ phase: 'thinking', health: 'fresh' });
});

it('shows a lead whose turn waits for an approval as waiting for it', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  send(f, lead.id, script({ ask: { tool: 'Bash', input: { command: 'pnpm test' } } }));
  await eventually(
    () =>
      f.store
        .list<Approval>('approvals')
        .some((approval) => approval.session_id === lead.id && approval.state === 'pending'),
    () => f.control.tick(),
  );
  const approval = f.store
    .list<Approval>('approvals')
    .find((row) => row.session_id === lead.id && row.state === 'pending')!;
  expect(leadRow(f, lead.id).activity).toMatchObject({
    phase: 'waiting_approval',
    since: approval.created_at,
    waiting: { kind: 'approval', approval_id: approval.id },
  });
});

it('gives a task retrospective its record id', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const row = f.store.insert<Retrospective>('retrospectives', {
    id: 'retrospective-a',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'a',
    session_ids: [],
    outcome: 'failed',
    recorded_at: f.store.now(),
  });
  expect(board(f).tasks.find((each) => each.id === `${lead.id}:a`)?.retrospective).toEqual({
    id: row.id,
    outcome: 'failed',
    recorded_at: row.recorded_at,
    handbacks: 0,
  });
});

it('counts the task places in use against the limit dispatch uses', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('a', { goal: script({ hang: true }) }),
    task('b', { goal: script({ hang: true }) }),
  ]);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, max_parallel: 2 },
    f.store.must<WorkflowPolicy>('workflow_policies', f.project.id).revision,
  );
  expect(board(f).task_places).toEqual({ used: 0, limit: 2 });
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['a', 'b'] },
    null,
    leadPrincipal(f, lead.id),
  );
  await f.control.tick();
  expect(board(f).task_places).toEqual({ used: 2, limit: 2 });
  const first = f.store
    .list<Session>('sessions')
    .find((session) => session.task?.lead_session_id === lead.id && session.task.id === 'a')!;
  await awaitWorkspaceReady(f.control, first.workspace_id!);
  f.call('session.discard', { session_id: first.id }, current(f, first.id).revision);
  await eventually(
    () => current(f, first.id).outcome === 'discarded',
    () => f.control.tick(),
  );
  expect(board(f).task_places).toEqual({ used: 1, limit: 2 });
});
