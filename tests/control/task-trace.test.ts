import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { BoardPlan, Principal, Project, Session, Workspace } from '@pantheon/domain';
import type { TaskTraceEntry } from '@pantheon/protocol';
import { eventually, insideSandbox, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const sessionOf = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
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
  acceptance: ['true'],
});

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** A lead with tasks a and b started, and the settled session of each. */
async function startedTasks(f: Fixture) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task('a'), task('b')],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  f.call(
    'task.start',
    { project_id: f.project.id, task_ids: ['a', 'b'] },
    null,
    sessionOf(f, lead.id, 'lead'),
  );
  await f.control.tick();
  const workerOf = (taskId: string) =>
    f.store.list<Session>('sessions').find((session) => session.task?.id === taskId)!;
  const a = workerOf('a'),
    b = workerOf('b');
  await settle(f, a);
  await settle(f, b);
  return { lead, a, b };
}

const message = (f: Fixture, leadId: string, taskId: string, text: string) =>
  f.call(
    'task.message',
    { project_id: f.project.id, task_id: taskId, text },
    null,
    sessionOf(f, leadId, 'lead'),
  );

const report = (f: Fixture, workerId: string, text: string) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'risk', text },
    null,
    sessionOf(f, workerId, 'worker'),
  );

const trace = (f: Fixture, leadId: string, taskId: string) =>
  f.control.taskTrace(user, f.project.id, leadId, taskId) as TaskTraceEntry[];

it.skipIf(insideSandbox)(
  'lists the start request, dispatch, lead message, report and merge of a task in time order',
  async () => {
    const f = await workbenchFixture();
    git(f.source, 'config', 'user.name', 'Source User');
    git(f.source, 'config', 'user.email', 'source@example.invalid');
    const { lead, a } = await startedTasks(f);
    report(f, a.id, 'The export format is undecided');
    await f.call<Project>(
      'project.gate.set',
      {
        project_id: f.project.id,
        root: f.source,
        commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
      },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    f.call<Project>(
      'project.autoMerge.set',
      { project_id: f.project.id, enabled: true },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    const workspace = f.store.must<Workspace>('workspaces', a.workspace_id!);
    mkdirSync(path.join(workspace.path, 'src/a'), { recursive: true });
    writeFileSync(path.join(workspace.path, 'src/a/export.txt'), 'export\n');
    git(workspace.path, 'add', '--', 'src/a/export.txt');
    git(workspace.path, 'commit', '--quiet', '-m', 'Add export');
    message(f, lead.id, 'a', 'Commit your work');
    await eventually(
      () => current(f, a.id).outcome === 'merged',
      () => f.control.tick(),
      10000,
    );

    const entries = trace(f, lead.id, 'a');
    expect(entries.map((entry) => entry.kind)).toEqual([
      'start_requested',
      'dispatched',
      'report',
      'lead_message',
      'merge_started',
      'gate_passed',
      'merged',
    ]);
    expect(entries.find((entry) => entry.kind === 'dispatched')!.session_id).toBe(a.id);
    expect(entries.find((entry) => entry.kind === 'report')).toMatchObject({
      session_id: a.id,
      text: 'The export format is undecided',
    });
    expect(entries.find((entry) => entry.kind === 'lead_message')!.text).toContain(
      'Commit your work',
    );
    const times = entries.map((entry) => entry.at);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  },
);

it("leaves out the other task's entries and cuts long texts", async () => {
  const f = await workbenchFixture();
  const { lead, a, b } = await startedTasks(f);
  report(f, b.id, 'Task b found a risk');
  message(f, lead.id, 'b', 'Look at the download button');
  message(f, lead.id, 'a', 'x'.repeat(2000));

  const entries = trace(f, lead.id, 'a');
  expect(entries.some((entry) => entry.session_id === b.id)).toBe(false);
  expect(entries.some((entry) => entry.text?.includes('download button'))).toBe(false);
  expect(entries.map((entry) => entry.kind)).toEqual([
    'start_requested',
    'dispatched',
    'lead_message',
  ]);
  const long = entries.find((entry) => entry.kind === 'lead_message')!;
  expect(long.session_id).toBe(a.id);
  expect(long.text).toBe(`[Lead] ${'x'.repeat(1993)}…`);
});

it('shows one user edit of two tasks in the trace of each', async () => {
  const f = await workbenchFixture();
  const { lead } = await startedTasks(f);
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      lead_session_id: lead.id,
      base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
      ops: [
        { type: 'set_task', task_id: 'a', patch: { title: 'Export file' } },
        { type: 'set_task', task_id: 'b', patch: { title: 'Download button' } },
      ],
    },
    null,
    user,
  );

  for (const taskId of ['a', 'b'])
    expect(trace(f, lead.id, taskId).map((entry) => entry.kind)).toContain('user_edit');
});
