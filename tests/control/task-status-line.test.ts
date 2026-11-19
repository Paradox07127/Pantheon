import { afterEach, expect, it, vi } from 'vitest';
import type { Principal, Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

afterEach(() => {
  vi.restoreAllMocks();
});

const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;
/** A turn that stays running long enough to set status lines in it. */
const longTurn = script({ wait: 4000 });
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const principal = (f: Fixture, id: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${id}`,
  role,
  session_id: id,
  project_id: f.project.id,
  expires_at: Date.now() + 60000,
});
const setLine = (f: Fixture, id: string, role: 'lead' | 'worker', text: string) =>
  f.call<{ text: string; at: number; turn_id: string }>(
    'task.status_line',
    { text },
    null,
    principal(f, id, role),
  );
const lineEvents = (f: Fixture) =>
  f.store.events(0, undefined, 10_000).filter((event) => event.kind === 'session.status_line_set');

/** Waits until the session's newest turn runs. */
async function running(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id).at(-1)?.state === 'running',
    () => f.control.tick(),
    10000,
  );
  return f.turns(session.id).at(-1)!;
}

function writePlan(f: Fixture, lead: Session) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'export',
          title: 'Build exports',
          goal: 'Build exports',
          depends_on: [],
          lane: 'core',
          source: ['Plan the export feature'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    principal(f, lead.id, 'lead'),
  );
}

async function taskSession(input = longTurn) {
  const f = await workbenchFixture();
  let skew = 0;
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + skew);
  const lead = await f.create('Plan the export feature');
  writePlan(f, lead);
  const worker = await boundTaskSession(f, lead.id, 'export', input);
  const row = () =>
    f.control
      .boardView(user, f.project.id, 1)
      .tasks.find((task) => task.id === `${lead.id}:export`)!;
  return { f, lead, worker, row, advance: (ms: number) => (skew += ms) };
}

it('shows the line a task session sets in its running turn on its board row with its time', async () => {
  const { f, worker, row } = await taskSession();
  const turn = await running(f, worker);
  const set = setLine(f, worker.id, 'worker', '  Running the migration tests ');
  expect(set).toMatchObject({ text: 'Running the migration tests', turn_id: turn.id });
  expect(current(f, worker.id).status_line).toEqual(set);
  expect(row().status_line).toEqual({ text: 'Running the migration tests', at: set.at });
  expect(lineEvents(f).map((event) => event.payload)).toEqual([
    { text: 'Running the migration tests', turn_id: turn.id },
  ]);
});

it('refuses a line longer than 80 characters', async () => {
  const { f, worker } = await taskSession();
  await running(f, worker);
  expect(() => setLine(f, worker.id, 'worker', 'x'.repeat(81))).toThrow(
    expect.objectContaining({ name: 'ZodError' }),
  );
  expect(current(f, worker.id).status_line).toBeUndefined();
});

it('shows the line a lead sets on its row of the board leads', async () => {
  const f = await workbenchFixture();
  const lead = await f.create(`Plan the export feature\n${longTurn}`);
  const turn = await running(f, lead);
  writePlan(f, lead);
  const set = setLine(f, lead.id, 'lead', 'Splitting the export plan');
  expect(set).toMatchObject({ text: 'Splitting the export plan', turn_id: turn.id });
  expect(
    f.control.boardView(user, f.project.id, 1).leads?.find((row) => row.session_id === lead.id)
      ?.status_line,
  ).toEqual({ text: 'Splitting the export plan', at: set.at });
});

it('refuses a session that is neither a plan task nor a lead', async () => {
  const f = await workbenchFixture();
  const standalone = await f.create(longTurn);
  await running(f, standalone);
  expect(() => setLine(f, standalone.id, 'lead', 'Reading the parser')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(current(f, standalone.id).status_line).toBeUndefined();
  expect(lineEvents(f)).toEqual([]);
});

it('refuses a task session with no running turn', async () => {
  const { f, worker } = await taskSession('Build it');
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id)[0]?.state === 'completed' && current(f, worker.id).state === 'open',
    () => f.control.tick(),
  );
  expect(() => setLine(f, worker.id, 'worker', 'Running the migration tests')).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  expect(current(f, worker.id).status_line).toBeUndefined();
});

it('writes the same text of one turn once', async () => {
  const { f, worker, advance } = await taskSession();
  await running(f, worker);
  const first = setLine(f, worker.id, 'worker', 'Running the migration tests');
  advance(20_000);
  expect(setLine(f, worker.id, 'worker', 'Running the migration tests')).toEqual(first);
  expect(current(f, worker.id).status_line).toEqual(first);
  expect(lineEvents(f)).toHaveLength(1);
});

it('refuses a new text within 15 s of the last one and stores it after', async () => {
  const { f, worker, row, advance } = await taskSession();
  await running(f, worker);
  const first = setLine(f, worker.id, 'worker', 'Running the migration tests');
  advance(14_000);
  expect(() => setLine(f, worker.id, 'worker', 'Reading the schema')).toThrow(
    expect.objectContaining({
      code: 'invalid_state',
      message: expect.stringContaining(new Date(first.at + 15_000).toISOString()),
    }),
  );
  expect(current(f, worker.id).status_line).toEqual(first);
  advance(1_000);
  const next = setLine(f, worker.id, 'worker', 'Reading the schema');
  expect(next.at).toBeGreaterThanOrEqual(first.at + 15_000);
  expect(row().status_line).toEqual({ text: 'Reading the schema', at: next.at });
  expect(lineEvents(f)).toHaveLength(2);
});

it('drops the line from the board row once the next turn starts', async () => {
  const { f, worker, row } = await taskSession(script({ wait: 1500 }));
  await running(f, worker);
  setLine(f, worker.id, 'worker', 'Running the migration tests');
  await eventually(
    () => f.turns(worker.id)[0]?.state === 'completed' && current(f, worker.id).state === 'open',
    () => f.control.tick(),
    10000,
  );
  expect(row().status_line).toMatchObject({ text: 'Running the migration tests' });
  f.call(
    'session.send',
    { session_id: worker.id, input: longTurn },
    current(f, worker.id).revision,
  );
  await running(f, worker);
  expect(row()).not.toHaveProperty('status_line');
  expect(current(f, worker.id).status_line?.text).toBe('Running the migration tests');
});

it('keeps the line on the session when a recap is written after it', async () => {
  const { f, worker } = await taskSession();
  (
    f.control as unknown as { ctx: { -readonly [K in keyof ControlContext]: ControlContext[K] } }
  ).ctx.turnSummarizer = async () => ({
    text: JSON.stringify({ headline: 'Ran the tests', needs_you: '', happened: 'Tests ran' }),
  });
  await running(f, worker);
  const set = setLine(f, worker.id, 'worker', 'Running the migration tests');
  await eventually(
    () => current(f, worker.id).recap !== undefined,
    () => f.control.tick(),
    10000,
  );
  expect(current(f, worker.id).recap?.headline).toBe('Ran the tests');
  expect(current(f, worker.id).status_line).toEqual(set);
});
