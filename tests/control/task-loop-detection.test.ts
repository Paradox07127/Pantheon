import { expect, it } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
  ...extra,
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** The notes the tracker left the lead, of one kind, oldest first. */
const notes = (f: Fixture, leadId: string, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === leadId)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);

const itemsOf = (f: Fixture, sessionId: string) =>
  f.control
    .needsYou(user, f.project.id)
    .items.filter((item) => item.source.table === 'sessions' && item.source.id === sessionId);

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = f.create('Plan the export feature');
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
    sessionOf(f, lead.id, 'lead'),
  );
  return lead;
}

const openTask = (f: Fixture, leadId: string, taskId: string, input = 'Build it') =>
  f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input,
    task_id: `${leadId}:${taskId}`,
  });

const script = (steps: unknown[]) => `fixture-script\n${JSON.stringify(steps)}`;
const failing = (input: Record<string, unknown>) => ({
  try: { tool: 'Bash', input, error: 'exit 1' },
});
const hang = { hang: true };

/** Runs a scripted worker for task a and waits for the lead's first looping note. */
async function loopingWorker(f: Fixture, leadId: string, steps: unknown[]) {
  const worker = openTask(f, leadId, 'a', script([...steps, hang]));
  await eventually(
    () => notes(f, leadId, 'looping').length > 0,
    () => f.control.tick(),
    10000,
  );
  expect(f.turns(worker.id)[0]!.state).toBe('running');
  return notes(f, leadId, 'looping');
}

const test = failing({ command: 'pnpm test' }),
  build = failing({ command: 'pnpm build' }),
  read = { trace: { tool: 'Read', input: { file_path: 'src/a/export.ts' } } };

it.each([
  [
    'tells the lead when a scripted worker repeats the same failing tool call three times in one turn',
    [test, test, test],
    'The running turn of the session repeats a failing tool call. Its last 3 calls of Bash failed, each with the input {"command":"pnpm test"}.',
  ],
  [
    'tells the lead when a worker repeats the same successful call with no other progress',
    [read, read, read, read, read],
    'The running turn of the session repeats a tool call with no other progress. Its last 5 calls of Read succeeded, each with the input {"file_path":"src/a/export.ts"}.',
  ],
  [
    'tells the lead when two failing calls alternate',
    [test, build, test, build, test, build],
    'The running turn of the session alternates between two failing tool calls. Its last 6 calls took turns between Bash with the input {"command":"pnpm build"} and Bash with the input {"command":"pnpm test"}, each failing.',
  ],
])('%s', async (_, steps, text) => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const [note] = await loopingWorker(f, lead.id, steps);
  expect(note!.text).toBe(text);
});

it('compares repeated calls without their free-text fields', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);

  const [note] = await loopingWorker(f, lead.id, [
    failing({ command: 'pnpm test', description: 'Run the tests' }),
    failing({ command: 'pnpm test', description: 'Run the tests again', timeout: 120000 }),
    failing({ command: 'pnpm test', description: 'Check the tests once more', timeout: 60000 }),
  ]);
  expect(note!.text).toContain('Its last 3 calls of Bash failed');
});

/** A task session whose first turn runs for longer than the test. */
async function runningWorker(f: Fixture, leadId: string) {
  (f.adapter as { delay: number }).delay = 60000;
  const worker = openTask(f, leadId, 'a');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id)[0]?.state === 'running',
    () => f.control.tick(),
  );
  return { worker, turn: f.turns(worker.id)[0]! };
}

function failedCall(f: Fixture, worker: Session, turn: SessionTurn, id: string) {
  const event = (kind: string, fields: Record<string, unknown>) =>
    f.store.event(kind, current(f, worker.id), f.project.id, { turn_id: turn.id, ...fields });
  event('agent.tool.started', { tool_call_id: id, name: 'Bash', input: { command: 'pnpm test' } });
  event('agent.tool.completed', { tool_call_id: id, ok: false, output: 'exit 1' });
}

it('tells the lead again and lists needs-you when a turn keeps looping after the first alert', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const { worker, turn } = await runningWorker(f, lead.id);
  let calls = 0;
  const fail = async (times: number) => {
    for (let index = 0; index < times; index++) failedCall(f, worker, turn, `call-${++calls}`);
    await f.control.tick();
  };

  await fail(3);
  expect(notes(f, lead.id, 'looping')).toHaveLength(1);
  expect(itemsOf(f, worker.id)).toEqual([]);
  await fail(2);
  expect(notes(f, lead.id, 'looping')).toHaveLength(1);

  await fail(1);
  const loops = notes(f, lead.id, 'looping');
  expect(loops).toHaveLength(2);
  expect(loops[1]!.text).toContain(
    'The running turn of the session still repeats a failing tool call after you were told: 3 more calls of the loop since.',
  );
  expect(itemsOf(f, worker.id)).toEqual([
    expect.objectContaining({
      kind: 'session.failed',
      reason: 'task_turn_looping',
      next_step: expect.any(String),
    }),
  ]);

  await fail(3);
  expect(notes(f, lead.id, 'looping')).toHaveLength(2);
});

it('tells the user when a lead turn repeats a failing tool call', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const test = failing({ command: 'pnpm test' });
  f.call(
    'session.send',
    { session_id: lead.id, input: script([test, test, test, hang]) },
    current(f, lead.id).revision,
  );

  await eventually(
    () => itemsOf(f, lead.id).length > 0,
    () => f.control.tick(),
    10000,
  );
  expect(itemsOf(f, lead.id)).toEqual([
    expect.objectContaining({
      kind: 'session.failed',
      reason: 'lead_turn_looping',
      next_step: expect.any(String),
    }),
  ]);
});

/** Runs each script as one turn of the session of a report task a, one turn after another. */
async function turnsOfWorker(f: Fixture, leadId: string, turns: unknown[][]) {
  const worker = openTask(f, leadId, 'a', script(turns[0]!));
  await settle(f, worker);
  for (const steps of turns.slice(1)) {
    f.call(
      'session.send',
      { session_id: worker.id, input: script(steps) },
      current(f, worker.id).revision,
    );
    await settle(f, worker);
  }
  await f.control.tick();
  return worker;
}

const healthOf = (f: Fixture, leadId: string) =>
  f.control.boardView(user, f.project.id, 1).tasks.find((each) => each.id === `${leadId}:a`)
    ?.activity?.health;

it('tells the lead once when a task session fails the same call in three turns in a row', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { done_when: 'report' })]);
  const read = { trace: { tool: 'Read', input: { file_path: 'src/a/export.ts' } } },
    test = failing({ command: 'pnpm test', description: 'Run the tests' });

  const worker = await turnsOfWorker(f, lead.id, [[test], [read, test], [test, read]]);
  expect(notes(f, lead.id, 'looping')).toEqual([
    expect.objectContaining({
      session_id: worker.id,
      text: 'The session repeats a failing tool call across turns. In each of its last 3 turns, Bash failed with the input {"command":"pnpm test","description":"Run the tests"}.',
    }),
  ]);
  expect(healthOf(f, lead.id)).toBe('looping');

  f.call(
    'session.send',
    { session_id: worker.id, input: script([test]) },
    current(f, worker.id).revision,
  );
  await settle(f, worker);
  await f.control.tick();
  expect(notes(f, lead.id, 'looping')).toHaveLength(1);
});

it('does not tell the lead when consecutive turns of a task session fail different calls', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { done_when: 'report' })]);

  await turnsOfWorker(f, lead.id, [
    [failing({ command: 'pnpm test' })],
    [failing({ command: 'pnpm build' })],
    [failing({ command: 'pnpm lint' })],
  ]);
  expect(notes(f, lead.id, 'looping')).toEqual([]);
  expect(healthOf(f, lead.id)).not.toBe('looping');
});

it('does not tell the lead when consecutive turns of a task session repeat a successful call', async () => {
  const f = workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { done_when: 'report' })]);
  const test = { trace: { tool: 'Bash', input: { command: 'pnpm test' } } };

  await turnsOfWorker(f, lead.id, [[test], [test], [test]]);
  expect(notes(f, lead.id, 'looping')).toEqual([]);
  expect(healthOf(f, lead.id)).not.toBe('looping');
});
