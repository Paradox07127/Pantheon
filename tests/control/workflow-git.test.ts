import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  BoardPlan,
  Project,
  Session,
  SessionTurn,
  StepRun,
  Workspace,
} from '@pantheon/domain';
import * as validation from '../../packages/control/dist/validation-executor.js';
import { countingGit, eventually, settle } from '../helpers.js';
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

const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const runs = (f: Fixture) => f.store.list<StepRun>('workflow_step_runs');

function commit(repository: string, name: string) {
  writeFileSync(path.join(repository, name), `${name}\n`);
  git(repository, 'add', '--', name);
  git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
}

/** A lead with one task on the path whose project merges automatically. */
async function workflowTask(taskPath: BoardPlan['tasks'][number]['path'] = 'dispatch') {
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
        path: taskPath,
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

it('starts a review step while the event loop runs', async () => {
  const { f, worker } = await workflowTask('review_loop');
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
  const slow = slowGit('diff --no-color --no-ext-diff');
  const stall = longestStall();
  await eventually(
    () => !!runs(f)[0]?.review_id,
    () => f.control.tick(),
    10000,
  );
  expect(stall()).toBeLessThan(500);
  expect(slow.log()).toContain('slow start');
});

it('records the merge a review step before the merge holds as a session event', async () => {
  const { f, worker } = await workflowTask('review_loop');
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

it('admits the merge after a review step before the merge while the event loop runs', async () => {
  const { f, worker } = await workflowTask('review_loop');
  const reviewer = new FixtureAdapter(1);
  reviewer.name = 'reviewer';
  f.control.adapters.set(reviewer.name, reviewer);
  // Each reviewer session hands in a pass verdict as its turn starts, as review_verdict does.
  const send = reviewer.send.bind(reviewer);
  reviewer.send = async (handle, turn) => {
    const session = current(f, f.store.must<SessionTurn>('session_turns', turn.turn_id).session_id);
    if (session.review_id)
      f.call(
        'review.verdict',
        { verdict: 'pass', summary: 'No findings: checked answer.txt' },
        null,
        {
          id: `session:${session.id}`,
          role: 'reviewer',
          session_id: session.id,
          project_id: f.project.id,
          expires_at: Date.now() + 60000,
        },
      );
    return send(handle, turn);
  };
  await eventually(
    () => runs(f).some((run) => run.state === 'running'),
    () => f.control.tick(),
    10000,
  );
  slowGit('status --porcelain=v2');
  const stall = longestStall();
  await eventually(
    () => current(f, worker.id).merge?.state === 'running' || !!current(f, worker.id).outcome,
    () => f.control.tick(),
    10000,
  );
  expect(stall()).toBeLessThan(500);
});
