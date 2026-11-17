import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import type { BoardPlan, LeadNote, Principal, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, countingGit, gitRunsOf, settle } from '../helpers.js';
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
  acceptance: ['pnpm test'],
});

const told = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker');

/** The notes the lead was left, of one kind, oldest first. */
const notes = (f: Fixture, leadId: string, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === leadId)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);

/** A lead with a plan of task a and a settled session of that task. */
async function taskSession(f: Fixture) {
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
    sessionOf(f, lead.id, 'lead'),
  );
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:a`,
  });
  await settle(f, worker);
  const workspace = await awaitWorkspaceReady(f.control, worker.workspace_id!);
  return { lead, worker, worktree: workspace.path };
}

const reportDone = (f: Fixture, worker: Session) =>
  f.call(
    'task.report',
    { project_id: f.project.id, kind: 'done', text: 'All tests pass' },
    null,
    sessionOf(f, worker.id, 'worker'),
  );

it('tells the lead when a merge task reports done without commits while auto-merge is off', async () => {
  const f = await workbenchFixture();
  const { lead, worker } = await taskSession(f);

  await reportDone(f, worker);
  const [note] = notes(f, lead.id, 'no_changes');
  expect(note).toMatchObject({ session_id: worker.id, task_id: 'a' });
  expect(note!.text).toBe(
    'The session reported done, but its worktree has no commits since it started and auto-merge is off, so nothing merges it. Commits since it started: 0; worktree clean: yes.',
  );
  expect(told(f, lead.id)).toHaveLength(1);
  expect(told(f, lead.id)[0]!.input).toContain(': no_changes: The session reported done');
});

it('tells the lead when a task reports done while its worktree has uncommitted files', async () => {
  const f = await workbenchFixture();
  const { lead, worker, worktree } = await taskSession(f);
  mkdirSync(path.join(worktree, 'src/a'), { recursive: true });
  writeFileSync(path.join(worktree, 'src/a/export.ts'), 'export const format = "csv";\n');
  git(worktree, 'add', '--', 'src/a/export.ts');
  git(worktree, 'commit', '--quiet', '-m', 'Add the export format');
  writeFileSync(path.join(worktree, 'src/a/export.ts'), 'export const format = "json";\n');

  await reportDone(f, worker);
  const [note] = notes(f, lead.id, 'no_changes');
  expect(note!.text).toBe(
    'The session reported done, but its worktree has uncommitted files, which a merge leaves out. Commits since it started: 1; worktree clean: no.',
  );
  expect(told(f, lead.id)).toHaveLength(1);
});

it('checks the worktree of a done report while other work goes on, with one status and one count', async () => {
  const f = await workbenchFixture();
  const { worker, worktree } = await taskSession(f);
  const counter = countingGit();
  onTestFinished(counter.restore);
  counter.slowOn('rev-list --count');
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  onTestFinished(() => clearTimeout(timer));
  await reportDone(f, worker);
  expect(fired).toBe(true);
  const runs = counter.runs().filter((run) => run.startsWith(`${worktree}|`));
  expect(gitRunsOf(runs, 'status')).toHaveLength(1);
  expect(gitRunsOf(runs, 'rev-list')).toHaveLength(1);
});
