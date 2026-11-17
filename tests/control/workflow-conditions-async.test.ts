import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  BoardPlan,
  Project,
  Session,
  StepRun,
  WorkflowDefinition,
  WorkflowStep,
  Workspace,
} from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { countingGit, eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  vi.restoreAllMocks();
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

// Only a step condition reads the changed paths with these arguments.
const CONDITION_DIFF = '--name-only --no-renames -z';

const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const runs = (f: Fixture) => f.store.list<StepRun>('workflow_step_runs');

const conditional = (id: string, glob: string, command = `check-${id}`): WorkflowStep => ({
  id,
  title: `Check ${id}`,
  when: { changed_paths: [glob] },
  kind: { type: 'command', command, timeout_seconds: 30 },
});

/** A lead with one dispatched task whose worktree commits answer.txt; finishing its turn merges it automatically. */
async function taskSession(slots: Partial<WorkflowDefinition['slots']>) {
  const execute = vi.spyOn(validation, 'runValidationCommand').mockResolvedValue({
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
  await f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition: {
      slots: { before_dispatch: [], before_merge: [], after_merge: [], ...slots },
      plan_review: { tiers: ['t3'] },
      review: { max_rounds: 3 },
    },
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
  const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
  writeFileSync(path.join(workspace.path, 'answer.txt'), 'exported\n');
  git(workspace.path, 'add', '--', 'answer.txt');
  git(workspace.path, 'commit', '--quiet', '-m', 'Export the report');
  const finish = () =>
    f.call(
      'session.send',
      { session_id: worker.id, input: 'Finish the export' },
      current(f, worker.id).revision,
    );
  return { f, worker, execute, finish };
}

it('lists the sessions of a project with a conditional command step before the merge without running Git', async () => {
  const { f, worker } = await taskSession({
    before_merge: [conditional('answer', 'answer.txt'), conditional('docs', 'docs/**')],
  });
  // Git started before this runs unlogged, and nothing else starts while the list runs.
  const counter = countingGit();
  restores.push(counter.restore);
  const listed = f.control.sessionList(user, f.project.id, 'cached');
  expect(counter.runs()).toEqual([]);
  expect(listed.map((row) => row.id)).toContain(worker.id);
  // The condition's read lands in the background, and the gates then show its answer.
  await eventually(
    () =>
      !f.control.sessionGates(user, worker.id).commands?.includes('docs: Check docs') &&
      !!f.control.sessionGates(user, worker.id).commands?.includes('answer: Check answer'),
    () => f.control.tick(),
  );
});

it('decides a conditional step after the merge in a tick while the event loop runs', async () => {
  const approval = (id: string, glob: string): WorkflowStep => ({
    id,
    title: `Approve ${id}`,
    when: { changed_paths: [glob] },
    kind: { type: 'approval' },
  });
  const { f, worker, finish } = await taskSession({
    after_merge: [approval('answer', 'answer.txt'), approval('docs', 'docs/**')],
  });
  const counter = countingGit();
  restores.push(counter.restore);
  counter.slowOn(CONDITION_DIFF);
  const stall = longestStall();
  finish();
  await eventually(
    () => runs(f).filter((run) => run.slot === 'after_merge').length === 2,
    () => f.control.tick(),
    15000,
  );
  expect(stall()).toBeLessThan(500);
  expect(current(f, worker.id).outcome).toBe('merged');
  const after = runs(f).filter((run) => run.slot === 'after_merge');
  expect(after.find((run) => run.step.id === 'answer')).toMatchObject({ state: 'waiting' });
  expect(after.find((run) => run.step.id === 'docs')).toMatchObject({
    state: 'skipped',
    reason: 'condition',
  });
});

it('runs a conditional command step before the merge once, while the event loop runs', async () => {
  const { f, worker, execute, finish } = await taskSession({
    before_merge: [conditional('answer', 'answer.txt'), conditional('docs', 'docs/**')],
  });
  const counter = countingGit();
  restores.push(counter.restore);
  counter.slowOn(CONDITION_DIFF);
  const stall = longestStall();
  finish();
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    15000,
  );
  expect(stall()).toBeLessThan(500);
  const commands = execute.mock.calls.map(([run]) => run.argv.at(-1));
  expect(commands.filter((command) => command === 'check-answer')).toHaveLength(1);
  expect(commands).not.toContain('check-docs');
});
