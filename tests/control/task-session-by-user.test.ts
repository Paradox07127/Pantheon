import { expect, it } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { dispatchEveryTier, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

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
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const userEdits = (f: Fixture, leadId: string): LeadNote[] =>
  planOf(f, leadId).inbox.filter((note) => note.kind === 'user_edit');

async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  dispatchEveryTier(f);
  const lead = await f.create('Plan the export feature');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () =>
      current(f, lead.id).state === 'open' &&
      f.turns(lead.id).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );
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
    leadOf(f, lead.id),
  );
  return lead;
}

/** The session the user opens from the board task. */
// A refusal the store makes is thrown at once; the opened session comes in a promise.
const openTask = (f: Fixture, leadId: string, taskId: string) =>
  f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: `Work on task ${taskId}`,
    task_id: `${leadId}:${taskId}`,
  });

function refusal(fn: () => unknown): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

it('refuses the user a second session for a task that has one', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const first = await openTask(f, lead.id, 'a');
  const error = refusal(() => openTask(f, lead.id, 'a'));
  expect(error.code).toBe('invalid_state');
  expect(error.message).toContain(first.id);
});

it('refuses the user a session for the direct task its lead works on', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [
    task('a', { path: 'direct', flow_reason: 'The lead changes one line itself' }),
  ]);
  f.call('task.start', { project_id: f.project.id, task_ids: ['a'] }, null, leadOf(f, lead.id));
  expect(current(f, lead.id).direct_task?.id).toBe('a');
  const error = refusal(() => openTask(f, lead.id, 'a'));
  expect(error.code).toBe('invalid_state');
  expect(error.message).toContain(lead.id);
});

it('opens a follow-up session for a task whose session merged', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  const first = await openTask(f, lead.id, 'a');
  f.store.update<Session>(
    'sessions',
    { ...current(f, first.id), state: 'closed', outcome: 'merged' },
    current(f, first.id).revision,
  );

  const second = await openTask(f, lead.id, 'a');

  expect(second.id).not.toBe(first.id);
  expect(current(f, second.id).task).toMatchObject({ lead_session_id: lead.id, id: 'a' });
});

it('opens a session from the board with the first message dispatch sends, then what the user wrote', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a', { brief: 'toCsv() reads rows too early.' })]);
  const opened = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Task a\n\nFinish task a',
    task_id: `${lead.id}:a`,
  });
  const first = f.turns(opened.id)[0]!.input;
  for (const text of [
    'Task a\n\nTask a of the plan "Export ships this week", lane "Core".',
    'Goal:\nFinish task a\n\nBrief:\ntoCsv() reads rows too early.',
    'Scope (the paths you may change):\n- src/a',
    'Done when: this worktree merges after its gates pass.',
  ])
    expect(first).toContain(text);
  expect(first).not.toContain("The user's message");

  f.store.update<Session>(
    'sessions',
    { ...current(f, opened.id), state: 'closed', outcome: 'merged' },
    current(f, opened.id).revision,
  );
  const again = await openTask(f, lead.id, 'a');
  const next = f.turns(again.id)[0]!.input;
  expect(next).toContain('Goal:\nFinish task a');
  expect(next).toContain(`[Pantheon] The earlier session of this task ended merged.`);
  expect(next).toMatch(/\n\nThe user's message:\nWork on task a$/);
});

it('refuses the user a session for a task whose upstream task is not done', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('b', { depends_on: ['a'] })]);
  const error = refusal(() => openTask(f, lead.id, 'b'));
  expect(error.code).toBe('invalid_state');
  expect(error.message).toContain('unfinished tasks a');
});

it('refuses the user a session for a task whose scope overlaps a task under way', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a'), task('c', { scope: ['src/a/export'] })]);
  await openTask(f, lead.id, 'a');
  const error = refusal(() => openTask(f, lead.id, 'c'));
  expect(error.code).toBe('invalid_state');
  expect(error.message).toContain('overlaps tasks a');
});

it('binds the session the user opens to the task, drops its start request and tells the lead', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, [task('a')]);
  f.call('task.start', { project_id: f.project.id, task_ids: ['a'] }, null, leadOf(f, lead.id));
  expect(Object.keys(planOf(f, lead.id).dispatch ?? {})).toEqual(['a']);
  const before = userEdits(f, lead.id).length;
  const session = await openTask(f, lead.id, 'a');
  expect(current(f, session.id).task).toMatchObject({ lead_session_id: lead.id, id: 'a' });
  expect(planOf(f, lead.id).dispatch ?? {}).toEqual({});
  const notes = userEdits(f, lead.id);
  expect(notes).toHaveLength(before + 1);
  expect(notes.at(-1)).toMatchObject({ task_id: 'a', text: expect.stringContaining(session.id) });
});
