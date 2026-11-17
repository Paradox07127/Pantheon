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
import { eventually, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

afterEach(() => {
  vi.restoreAllMocks();
});

const empty = (): WorkflowDefinition => ({
  slots: { before_dispatch: [], before_merge: [], after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
});
const approval: WorkflowStep = {
  id: 'signoff',
  title: 'Approve the result',
  kind: { type: 'approval' },
};
const current = (f: Fixture, id: string) => f.store.must<Session>('sessions', id);
const runs = (f: Fixture) => f.store.list<StepRun>('workflow_step_runs');
const workerOf = (f: Fixture, lead: Session) =>
  f.store.list<Session>('sessions').find((s) => s.task?.lead_session_id === lead.id)!;

function validationResult(exit_code = 0): validation.ValidationResult {
  return {
    exit_code,
    signal: null,
    duration_ms: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: exit_code ? 'acceptance failed' : '',
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
  };
}

/** A task worker on an auto-merging project, whose acceptance is the only gate command. */
async function taskWorker(definition: WorkflowDefinition) {
  const f = await workbenchFixture({ delay: 1 });
  git(f.source, 'config', 'user.name', 'Source User');
  git(f.source, 'config', 'user.email', 'source@example.invalid');
  const lead = await f.create('Plan the export');
  await settle(f, lead);
  f.call('workflow.definition.set', {
    project_id: f.project.id,
    definition,
    base_version: f.control.workflowDefinition(user, f.project.id).definition_version,
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
  const worker = workerOf(f, lead);
  await settle(f, worker);
  const workspace = f.store.must<Workspace>('workspaces', worker.workspace_id!);
  return { f, worker, workspace };
}

function commit(repository: string, name: string) {
  writeFileSync(path.join(repository, name), `${name}\n`);
  git(repository, 'add', name);
  git(repository, 'commit', '--quiet', '-m', `Add ${name}`);
  return git(repository, 'rev-parse', 'HEAD');
}

const finish = (f: Fixture, worker: Session) =>
  f.call(
    'session.send',
    { session_id: worker.id, input: 'Finish the export' },
    current(f, worker.id).revision,
  );

it('counts only its own commits as the change of a session rebased for a gate that failed', async () => {
  vi.spyOn(validation, 'runValidationCommand').mockResolvedValue(validationResult(1));
  const { f, worker, workspace } = await taskWorker(empty());
  commit(workspace.path, 'session.txt');
  // Another task landed first.
  const landed = commit(f.source, 'source.txt');
  finish(f, worker);
  await eventually(
    () =>
      f.store
        .kindEvents(f.project.id, ['session.merge_blocked'])
        .some((e) => (e.payload as { reason: string }).reason === 'gate_failed'),
    () => f.control.tick(),
    10000,
  );
  const base = f.store.must<Workspace>('workspaces', workspace.id).base_sha!;
  expect(base).toBe(landed);
  expect(git(workspace.path, 'diff', '--name-only', base, 'HEAD')).toBe('session.txt');
});

it('runs the gate again when the project environment changed while the merge waited for approval', async () => {
  const execute = vi
    .spyOn(validation, 'runValidationCommand')
    .mockResolvedValue(validationResult());
  const definition = empty();
  definition.slots.before_merge = [approval];
  const { f, worker, workspace } = await taskWorker(definition);
  const head = commit(workspace.path, 'session.txt');
  finish(f, worker);
  await eventually(
    () => runs(f).some((r) => r.step.id === approval.id && r.state === 'waiting'),
    () => f.control.tick(),
    10000,
  );
  const project = f.store.must<Project>('projects', f.project.id);
  await f.call(
    'project.environment.set',
    {
      project_id: project.id,
      name: project.name,
      roots: project.roots,
      env: { ...project.env, GATE_MODE: 'strict' },
    },
    project.revision,
  );
  f.call('workflow.step.decide', {
    step_run_id: runs(f).find((r) => r.state === 'waiting')!.id,
    decision: 'approve',
  });
  await eventually(
    () => current(f, worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  expect(git(f.source, 'rev-parse', 'HEAD')).toBe(head);
  expect(execute.mock.calls.map((call) => call[0].env?.GATE_MODE)).toEqual([undefined, 'strict']);
});
