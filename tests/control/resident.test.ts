import { expect, it, vi } from 'vitest';
import { credentialRole, type BoardPlan, type Principal, type Session } from '@pantheon/domain';
import { eventually, settle, user } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const task = (id: string, lane: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane,
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}.ts`],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't1' },
  ...fields,
});

const open = (f: Fixture, kind: 'assistant' | 'triage' = 'assistant') =>
  f.call<Session>('resident.open', { project_id: f.project.id, kind });

function writePlan(f: Fixture, leadId: string, tasks = [task('a', 'core')]) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [
        { id: 'core', title: 'Core' },
        { id: 'docs', title: 'Docs' },
      ],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, leadId, 'lead'),
  );
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const told = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker');

function patch(f: Fixture, sessionId: string, fields: Partial<Session>) {
  const session = current(f, sessionId);
  f.store.update<Session>('sessions', { ...session, ...fields }, session.revision);
}

const requirement = (f: Fixture, workerId: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'requirement', text },
    null,
    sessionOf(f, workerId, 'worker'),
  );

/** Waits until the session without a worktree takes input again with no turn left to run. */
const settleResident = (f: Fixture, sessionId: string) =>
  eventually(
    () =>
      current(f, sessionId).state === 'open' &&
      f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );

/** The assistant after the user's request, which plan sources quote, has run. */
async function requested(f: Fixture) {
  const assistant = open(f);
  f.call(
    'session.send',
    { session_id: assistant.id, input: 'Plan the export feature' },
    current(f, assistant.id).revision,
  );
  await settleResident(f, assistant.id);
  return assistant;
}

it('gives a resident session a lead credential and refuses its reports', async () => {
  const f = workbenchFixture();
  const assistant = await requested(f);
  expect(assistant.workspace_id).toBeUndefined();
  expect(credentialRole(assistant)).toBe('lead');
  writePlan(f, assistant.id);
  expect(planOf(f, assistant.id).tasks.map((each) => each.id)).toEqual(['a']);

  expect(() =>
    f.call(
      'task.report',
      { project_id: f.project.id, kind: 'done', text: 'The export works' },
      null,
      sessionOf(f, assistant.id, 'lead'),
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it('returns the open resident session of the kind instead of opening another', () => {
  const f = workbenchFixture();
  const assistant = open(f);
  expect(open(f).id).toBe(assistant.id);
  const triage = open(f, 'triage');
  expect(triage.id).not.toBe(assistant.id);
  expect(open(f, 'triage').id).toBe(triage.id);
  expect(current(f, assistant.id)).toMatchObject({
    title: 'Assistant',
    resident: { kind: 'assistant' },
  });
  expect(current(f, triage.id)).toMatchObject({ title: 'Triage', resident: { kind: 'triage' } });
});

it('opens a new resident that takes over the plan, the unread notes and the task sessions of a closed one', async () => {
  const f = workbenchFixture();
  const assistant = await requested(f);
  writePlan(f, assistant.id);
  const worker = boundTaskSession(f, assistant.id, 'a');
  await settle(f, worker);
  // The wake is queued, but the session closes before it is delivered.
  requirement(f, worker.id, 'The export needs a CSV header');
  expect(told(f, assistant.id)).toHaveLength(1);
  patch(f, assistant.id, { state: 'closed' });
  requirement(f, worker.id, 'The export needs a JSON option');
  expect(planOf(f, assistant.id).wake_failed).toBeUndefined();

  const successor = open(f);
  expect(successor.id).not.toBe(assistant.id);
  expect(f.store.get<BoardPlan>('board_plans', assistant.id)).toBeUndefined();
  const plan = planOf(f, successor.id);
  expect(plan.tasks.map((each) => each.id)).toEqual(['a']);
  expect(plan.inbox.map((note) => note.text)).toEqual([
    'The export needs a CSV header',
    'The export needs a JSON option',
  ]);
  expect(current(f, worker.id).task).toMatchObject({
    lead_session_id: successor.id,
    id: 'a',
  });
  expect(f.turns(successor.id)[0]!.input).toContain('take over');
  expect(open(f).id).toBe(successor.id);
});

it('dispatches the direct task of a resident to a task session', async () => {
  const f = workbenchFixture();
  const assistant = await requested(f);
  writePlan(f, assistant.id);

  expect(
    f.call(
      'task.start',
      { project_id: f.project.id, task_ids: ['a'] },
      null,
      sessionOf(f, assistant.id, 'lead'),
    ),
  ).toEqual({ requested: ['a'] });
  await f.control.tick();

  expect(current(f, assistant.id).direct_task).toBeUndefined();
  expect(
    f.store
      .list<Session>('sessions')
      .filter(
        (session) => session.task?.lead_session_id === assistant.id && session.task.id === 'a',
      ),
  ).toHaveLength(1);
});

it('gathers twelve worker notes into at most two wakes of a resident without a wake limit', async () => {
  const f = workbenchFixture();
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  const assistant = await requested(f);
  writePlan(f, assistant.id);
  const worker = boundTaskSession(f, assistant.id, 'a');
  await settle(f, worker);

  for (let index = 0; index < 12; index++) {
    requirement(f, worker.id, `Requirement ${index}`);
    await settleResident(f, assistant.id);
  }
  skew += 60_000;
  await eventually(
    () => planOf(f, assistant.id).inbox.length === 0,
    () => f.control.tick(),
  );
  await settleResident(f, assistant.id);

  expect(told(f, assistant.id).length).toBeLessThanOrEqual(2);
  const inputs = told(f, assistant.id)
    .map((turn) => turn.input)
    .join('\n');
  for (let index = 0; index < 12; index++) expect(inputs).toContain(`Requirement ${index}`);
  expect(planOf(f, assistant.id).wake_failed).toBeUndefined();
  expect(
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item) => item.reason === 'lead_wake_limited'),
  ).toEqual([]);
});

it('lists a resident with its kind and a task session with its plan task and lane', async () => {
  const f = workbenchFixture();
  const assistant = await requested(f);
  writePlan(f, assistant.id, [task('a', 'core'), task('b', 'docs')]);
  const worker = boundTaskSession(f, assistant.id, 'b');
  await settle(f, worker);

  const listed = f.list();
  expect(listed.find((each) => each.id === assistant.id)).toMatchObject({
    resident: { kind: 'assistant' },
    workspace_id: null,
  });
  expect(listed.find((each) => each.id === worker.id)).toMatchObject({
    lead: assistant.id,
    task: { id: 'b', title: 'Task b', lane: 'docs', lane_title: 'Docs' },
  });
});
