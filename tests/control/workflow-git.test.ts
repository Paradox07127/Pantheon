import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  BoardPlan,
  Project,
  Session,
  StepRun,
  WorkflowDefinition,
  WorkflowStep,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { readConditions, workflowCondition } from '../../packages/control/dist/workflow-engine.js';
import { awaitWorkspaceReady, countingGit, eventually, gitRunsOf, settle } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** The longest time the event loop went without running a 10 ms interval, up to the returned check. */
function longestStall(): () => number {
  let last = performance.now(),
    longest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    longest = Math.max(longest, now - last);
    last = now;
  }, 10);
  restores.push(() => clearInterval(timer));
  return () => Math.max(longest, performance.now() - last);
}

function slowGit(pattern: string) {
  const counter = countingGit();
  restores.push(counter.restore);
  counter.slowOn(pattern);
  return counter;
}

const contextOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const runs = (f: Fixture) => f.store.list<StepRun>('workflow_step_runs');

function commit(repository: string, name: string) {
  writeFileSync(path.join(repository, name), `${name}\n`);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
}

/** A lead with one dispatch task whose project merges automatically through the definition. */
async function workflowTask(beforeMerge: WorkflowStep[]) {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue({
    exit_code: 0,
    signal: null,
    duration_ms: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: '',
    timedOut: false,
    stdout_sha256: '',
    stderr_sha256: '',
    output_truncated: false,
    boundary: {
      kind: 'macos-seatbelt',
      network: 'loopback',
      supported: true,
      stop_scope: 'process-group',
    },
  });
  const f = await workbenchFixture({ delay: 1 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const lead = await f.create('Plan the export');
  await settle(f, lead);
  const definition: WorkflowDefinition = {
    slots: { before_dispatch: [], before_merge: beforeMerge, after_merge: [] },
    plan_review: { tiers: ['t3'] },
    review: { max_rounds: 3 },
  };
  await f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition,
    base_version: 0,
  });
  f.store.insert<BoardPlan>('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Ship export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'export',
        title: 'Export the report',
        goal: 'Export the report',
        lane: 'core',
        depends_on: [],
        source: ['Plan the export'],
        scope: ['.'],
        acceptance: ['true'],
        path: 'dispatch',
        kind: { tier: 't2', domain: 'backend-logic' },
      },
    ],
    risks: [],
    assumptions: [],
    plan_version: 1,
    pending_edits: [],
    inbox: [],
    notified: {},
    updated_at: Date.now(),
  });
  const project = f.store.must<Project>('projects', f.project.id);
  f.call('project.autoMerge.set', { project_id: project.id, enabled: true }, project.revision);
  f.call('task.start', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_ids: ['export'],
  });
  await f.control.tick();
  const worker = f.store
    .list<Session>('sessions')
    .find((s) => s.task?.lead_session_id === lead.id)!;
  await settle(f, worker);
  commit(f.store.must<Workspace>('workspaces', worker.workspace_id!).path, 'answer.txt');
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Finish the export' },
    current(f, worker.id).revision,
  );
  return { f, worker };
}

it('reads the changed paths of a step condition from the merge base with one source rev-parse', async () => {
  const f = await workbenchFixture();
  const session = await f.create();
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => current(f, session.id).state === 'open' && f.turns(session.id)[0]?.state === 'completed',
    () => f.control.tick(),
  );
  // The worktree starts past its base, and the source moves on after that.
  commit(f.source, 'source-first.txt');
  git(workspace.path, 'merge', '--quiet', '--ff-only', 'main');
  commit(workspace.path, 'work.txt');
  commit(f.source, 'source-second.txt');
  const head = git(workspace.path, 'rev-parse', 'HEAD'),
    base = git(workspace.path, 'merge-base', head, git(f.source, 'rev-parse', 'HEAD')),
    separate = git(workspace.path, 'diff', '--name-only', '--no-renames', base, head).split('\n');
  expect(separate).toEqual(['work.txt']);
  const step: WorkflowStep = {
    id: 'work',
    title: 'Work',
    when: { changed_paths: ['work.txt'] },
    kind: { type: 'approval' },
  };
  const counter = countingGit();
  restores.push(counter.restore);
  await readConditions(contextOf(f), session.id, 'before_merge');
  counter.reset();
  const changed = await readConditions(contextOf(f), session.id, 'before_merge');
  expect(
    workflowCondition(contextOf(f), step, session.id, 'before_merge', undefined, changed),
  ).toBe(true);
  expect([...changed.values()]).toEqual([separate]);
  const runs = counter.runs();
  expect(gitRunsOf(runs, 'merge-base')).toHaveLength(1);
  // The range's worktree HEAD, then the source HEAD with its objects path.
  expect(gitRunsOf(runs, 'rev-parse')).toHaveLength(2);
  expect(gitRunsOf(runs, 'diff')).toHaveLength(1);
  expect(runs, runs.join('\n')).toHaveLength(4);
});

it('starts a review step while the event loop runs', async () => {
  const { f, worker } = await workflowTask([
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking: true } },
  ]);
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  await eventually(
    () =>
      runs(f).some((run) => run.state === 'pending') &&
      current(f, worker.id).merge?.reason === 'workflow_approval',
    () => f.control.tick(),
    10000,
  );
  slowGit('diff --no-color --no-ext-diff');
  const stall = longestStall();
  await eventually(
    () => !!runs(f)[0]?.review_id,
    () => f.control.tick(),
    10000,
  );
  expect(stall()).toBeLessThan(500);
});

it('records the merge a review step before the merge holds as a session event', async () => {
  const { f, worker } = await workflowTask([
    { id: 'second-look', title: 'Review the diff', kind: { type: 'review', blocking: true } },
  ]);
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  await eventually(
    () => current(f, worker.id).merge?.reason === 'workflow_approval',
    () => f.control.tick(),
    10000,
  );
  const started = f.store
    .kindEvents(f.project.id, ['session.merge_started'])
    .filter((event) => event.aggregate_id === worker.id)
    .at(-1)!;
  expect(
    f.store
      .events(started.sequence, f.project.id, 100000)
      .filter((event) => event.aggregate_id === worker.id && event.kind === 'session.merge_held')
      .map((event) => event.payload),
  ).toMatchObject([{ state: 'blocked', reason: 'workflow_approval' }]);
});

it('admits the merge after an approval before the merge while the event loop runs', async () => {
  const { f, worker } = await workflowTask([
    { id: 'signoff', title: 'Approve the result', kind: { type: 'approval' } },
  ]);
  await eventually(
    () => runs(f).some((run) => run.state === 'waiting'),
    () => f.control.tick(),
    10000,
  );
  slowGit('status --porcelain=v2');
  const started = performance.now();
  f.call('workflow.step.decide', {
    step_run_id: runs(f).find((run) => run.state === 'waiting')!.id,
    decision: 'approve',
  });
  expect(performance.now() - started).toBeLessThan(500);
  await eventually(
    () => current(f, worker.id).merge?.state === 'running' || !!current(f, worker.id).outcome,
    () => f.control.tick(),
    10000,
  );
});
