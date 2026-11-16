import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { BoardPlan, Principal, Project, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;
type PlanTask = BoardPlan['tasks'][number];

const leadId = 'lead-session-of-plan';

/** A workbench whose source repository names the user who rebases onto it. */
function mergeFixture() {
  const f = workbenchFixture();
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  return f;
}

const task = (id: string, fields: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish ${id}`,
  lane: 'core',
  depends_on: [],
  source: [],
  scope: [`src/${id}`],
  acceptance: [],
  ...fields,
});

function setPlan(f: Fixture, tasks: PlanTask[]) {
  f.store.insert<BoardPlan>('board_plans', {
    id: leadId,
    revision: 1,
    project_id: f.project.id,
    headline: 'Scoped work',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks,
    risks: [],
    assumptions: [],
    plan_version: 0,
    pending_edits: [],
    inbox: [],
    notified: {},
    updated_at: f.store.now(),
  });
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);

/** An idle session bound to the board task, with its ready worktree. */
async function taskSession(f: Fixture, taskId: string) {
  const session = f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.turns(session.id)[0]!.state === 'completed' && current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  const idle = current(f, session.id);
  f.store.update<Session>(
    'sessions',
    { ...idle, task: { lead_session_id: leadId, id: taskId } },
    idle.revision,
  );
  return { session, workspace };
}

function commit(repository: string, name: string, contents: string) {
  mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
  writeFileSync(path.join(repository, name), contents);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Update ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

const merge = (f: Fixture, sessionId: string, allowOutOfScope = false) =>
  f.call<Session>(
    'session.merge',
    { session_id: sessionId, ...(allowOutOfScope ? { allow_out_of_scope: true } : {}) },
    current(f, sessionId).revision,
  );

const settled = (f: Fixture, sessionId: string) =>
  eventually(
    () =>
      current(f, sessionId).outcome === 'merged' ||
      current(f, sessionId).merge?.state === 'blocked',
    () => f.control.tick(),
    10000,
  );

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

/** An idle lead whose plan holds the tasks, written through update_board. */
async function leadWithPlan(f: Fixture, tasks: PlanTask[]) {
  const lead = f.create('Plan the export feature');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: tasks.map((each) => ({
        ...each,
        source: ['Plan the export feature'],
        acceptance: ['true'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  return lead;
}

/** An idle session the user opened for the lead's task, with its ready worktree. */
async function leadTaskSession(f: Fixture, lead: Session, taskId: string) {
  const session = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:${taskId}`,
  });
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () =>
      f.turns(session.id).every((turn) => turn.state === 'completed') &&
      current(f, session.id).state === 'open',
    () => f.control.tick(),
  );
  return { session, workspace };
}

const mergeTask = (f: Fixture, lead: Session, taskId: string, reason: string) =>
  f.call<Session>(
    'session.merge',
    { project_id: f.project.id, task_id: taskId, allow_out_of_scope: true, reason },
    null,
    leadOf(f, lead.id),
  );

it('lets a lead merge files outside the task scope that no unfinished task holds, recording why', async () => {
  const f = mergeFixture();
  const lead = await leadWithPlan(f, [task('first'), task('second')]);
  const { session, workspace } = await leadTaskSession(f, lead, 'first');
  commit(workspace.path, 'src/first/x.ts', 'export const x = 1;\n');
  commit(workspace.path, 'README.md', 'Names the first module\n');
  merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).merge).toMatchObject({ reason: 'out_of_scope' });
  await eventually(
    () => f.turns(lead.id).some((turn) => turn.origin === 'tracker'),
    () => f.control.tick(),
  );
  expect(f.turns(lead.id).find((turn) => turn.origin === 'tracker')!.input).toContain(
    'Reason: out_of_scope. To merge the files anyway, call merge_task with allow_out_of_scope and the reason; or widen the scope of the task with update_board; or stop it with stop_task.',
  );
  mergeTask(f, lead, 'first', 'The README names the new module');
  await settled(f, session.id);
  expect(current(f, session.id).outcome).toBe('merged');
  expect(
    f.store
      .kindEvents(f.project.id, ['session.merge_started'])
      .filter((event) => event.aggregate_id === session.id)
      .at(-1)!.payload,
  ).toEqual({ reason: 'The README names the new module' });
});

it('refuses a lead merge of files outside the task scope that another unfinished task holds', async () => {
  const f = mergeFixture();
  const lead = await leadWithPlan(f, [task('first'), task('second')]);
  const { session, workspace } = await leadTaskSession(f, lead, 'first');
  commit(workspace.path, 'src/second/y.ts', 'export const y = 2;\n');
  merge(f, session.id);
  await settled(f, session.id);
  expect(() => mergeTask(f, lead, 'first', 'The file belongs here')).toThrow(/task second/);
  expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'out_of_scope' });
});

it('checks files committed after the block against the scope when a lead merges', async () => {
  const f = mergeFixture();
  const lead = await leadWithPlan(f, [task('first'), task('second')]);
  const { session, workspace } = await leadTaskSession(f, lead, 'first');
  commit(workspace.path, 'README.md', 'Names the first module\n');
  merge(f, session.id);
  await settled(f, session.id);
  commit(workspace.path, 'src/second/y.ts', 'export const y = 2;\n');
  mergeTask(f, lead, 'first', 'The README names the new module');
  await settled(f, session.id);
  expect(current(f, session.id).outcome).toBeUndefined();
  expect(current(f, session.id).merge).toMatchObject({
    state: 'blocked',
    reason: 'out_of_scope',
    conflicts: ['src/second/y.ts'],
  });
});

it('refuses a lead merge of a task in the plan of another lead', async () => {
  const f = mergeFixture();
  const owner = await leadWithPlan(f, [task('first')]);
  const other = await leadWithPlan(f, [task('third')]);
  const { session, workspace } = await leadTaskSession(f, owner, 'first');
  commit(workspace.path, 'README.md', 'Names the first module\n');
  merge(f, session.id);
  await settled(f, session.id);
  expect(() => mergeTask(f, other, 'first', 'The README names the module')).toThrow(
    /task first in your plan/,
  );
  expect(current(f, session.id).merge).toMatchObject({ state: 'blocked', reason: 'out_of_scope' });
});

it('blocks every file a report task with no scope paths merges', async () => {
  const f = mergeFixture();
  setPlan(f, [task('notes', { done_when: 'report', scope: [] })]);
  const sourceHead = git(f.source, 'rev-parse', 'HEAD');
  const { session, workspace } = await taskSession(f, 'notes');
  commit(workspace.path, 'notes.md', 'Findings\n');
  merge(f, session.id);
  await settled(f, session.id);
  expect(current(f, session.id).merge).toEqual({
    state: 'blocked',
    reason: 'out_of_scope',
    conflicts: ['notes.md'],
  });
  expect(git(f.source, 'rev-parse', 'main')).toBe(sourceHead);
});

it('blocks a later task that changed the same file outside its scope as an earlier one before rebasing it', async () => {
  const f = mergeFixture();
  // A gate rebases the later task onto the earlier one before it checks it.
  f.call<Project>(
    'project.gate.set',
    {
      project_id: f.project.id,
      root: f.source,
      commands: [{ name: 'Passes', argv: [process.execPath, '-e', 'process.exit(0)'] }],
    },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  setPlan(f, [task('first'), task('second')]);
  const first = await taskSession(f, 'first'),
    second = await taskSession(f, 'second');
  commit(first.workspace.path, 'src/first/x.ts', 'export const x = 1;\n');
  commit(first.workspace.path, 'README.md', 'Written by the first task\n');
  commit(second.workspace.path, 'src/second/y.ts', 'export const y = 2;\n');
  commit(second.workspace.path, 'README.md', 'Written by the second task\n');
  merge(f, first.session.id, true);
  await settled(f, first.session.id);
  expect(current(f, first.session.id).outcome).toBe('merged');
  merge(f, second.session.id);
  await settled(f, second.session.id);
  expect(current(f, second.session.id).merge).toEqual({
    state: 'blocked',
    reason: 'out_of_scope',
    conflicts: ['README.md'],
  });
});
