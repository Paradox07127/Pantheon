import { expect, it, vi } from 'vitest';
import type { BoardPlan, Milestone, Session, SessionTurn, StepRun } from '@pantheon/domain';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = ReturnType<typeof workbenchFixture>;

function leadWithPlan(f: Fixture, taskIds: string[]) {
  const lead = f.create('Plan the export feature');
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: taskIds.map((id) => ({
        id,
        title: id,
        depends_on: [],
        goal: id,
        lane: 'core',
        source: ['Plan the export feature'],
        scope: [`src/${id}`],
        acceptance: ['pnpm test'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    {
      id: `session:${lead.id}`,
      role: 'lead',
      project_id: f.project.id,
      session_id: lead.id,
      expires_at: f.store.now() + 60000,
    },
  );
  return lead;
}

function taskWorker(f: Fixture, leadId: string, taskId: string) {
  const worker = f.store.insert<Session>('sessions', {
    id: `${taskId}-worker`,
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: f.store.must<Session>('sessions', leadId).workspace_id,
    state: 'open',
    turn_count: 0,
    task: { lead_session_id: leadId, id: taskId, generation: 1 },
  });
  f.store.event('session.opened', worker, f.project.id, worker);
  return worker;
}

const gate = (f: Fixture, session: Session, exit_code: number) =>
  f.store.event('session.gate_checked', session, f.project.id, {
    results: [{ name: 'Tests', exit_code }],
  });

const historyTask = (f: Fixture, id: string) =>
  f.control.boardHistory(user, f.project.id).tasks.find((task) => task.id === id)!;

it('counts gate attempts toward the generation the session worked on when each gate ran', () => {
  const f = workbenchFixture();
  const lead = leadWithPlan(f, ['exports']);
  const worker = taskWorker(f, lead.id, 'exports');
  gate(f, worker, 1);
  gate(f, worker, 0);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  const changed = f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      generations: { exports: { generation: 2, contract: 'changed contract' } },
      contract_changed: [worker.id],
    },
    plan.revision,
  );
  f.store.event('board.plan_updated', changed, f.project.id, changed);
  // Still on the first contract until the change reaches the worker.
  gate(f, worker, 1);
  const { sequence } = f.store.db
    .prepare('SELECT max(sequence) AS sequence FROM events WHERE aggregate_id=?')
    .get(lead.id) as { sequence: number };
  f.store.event('session.contract_notified', worker, f.project.id, { plan_sequence: sequence });
  const before = f.store.must<Session>('sessions', worker.id);
  const moved = f.store.update<Session>(
    'sessions',
    { ...before, task: { ...before.task!, generation: 2 } },
    before.revision,
  );
  expect(historyTask(f, `${lead.id}:exports`)).not.toHaveProperty('gate_passed_on_attempt');
  gate(f, moved, 0);
  expect(historyTask(f, `${lead.id}:exports`)).toHaveProperty('gate_passed_on_attempt', 1);
});

it('does not count the turn a workflow prompt step queues on the task session as a handback', () => {
  const f = workbenchFixture();
  const lead = leadWithPlan(f, ['exports']);
  const worker = taskWorker(f, lead.id, 'exports');
  const turn: SessionTurn = {
    id: 'changelog-turn',
    revision: 1,
    project_id: f.project.id,
    session_id: worker.id,
    input: 'Update the changelog',
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
    origin: 'tracker',
  };
  f.store.event('turn.queued', turn, f.project.id, turn);
  const run = f.store.insert<StepRun>('workflow_step_runs', {
    id: 'changelog-step',
    revision: 1,
    project_id: f.project.id,
    lead_session_id: lead.id,
    task_id: 'exports',
    generation: 1,
    definition_version: 1,
    slot: 'before_merge',
    step: {
      id: 'changelog',
      title: 'Changelog',
      kind: { type: 'prompt', target: 'task', prompt: 'Update the changelog' },
    },
    state: 'running',
    created_at: f.store.now(),
    session_id: worker.id,
    turn_id: turn.id,
  });
  f.store.event('workflow.step_changed', run, f.project.id, {
    state: 'running',
    task_id: 'exports',
    slot: run.slot,
    step_id: run.step.id,
  });
  const history = f.control.boardHistory(user, f.project.id);
  expect(history.tasks[0]).toMatchObject({ handbacks: 0 });
  expect(history.tasks[0]).not.toHaveProperty('handback_reasons');
  expect(history.days.reduce((sum, day) => sum + day.handbacks, 0)).toBe(0);
});

it('gives a revised milestone no reached time until it is accepted again', () => {
  const f = workbenchFixture();
  const merged = f.create('Merge the export');
  const ended = f.store.must<Session>('sessions', merged.id);
  f.store.update<Session>(
    'sessions',
    { ...ended, state: 'closed', outcome: 'merged' },
    ended.revision,
  );
  const input = { title: 'Ship export', required_sessions: [merged.id], criteria: ['Exports'] };
  const milestone = f.call<Milestone>('milestone.create', { project_id: f.project.id, ...input });
  const accept = (revision: number) =>
    f.call<Milestone>(
      'milestone.accept',
      { milestone_id: milestone.id, evidence_refs: [`session:${merged.id}`] },
      revision,
    );
  const reached = () => f.control.boardHistory(user, f.project.id).milestones[0]!;
  const accepted = accept(milestone.revision);
  expect(reached()).toMatchObject({ state: 'completed', reached_at: expect.any(Number) });
  const revised = f.call<Milestone>(
    'milestone.revise',
    { milestone_id: milestone.id, ...input, criteria: ['Exports', 'Docs'] },
    accepted.revision,
  );
  expect(reached()).toEqual({
    id: milestone.id,
    title: 'Ship export',
    state: 'ready_for_acceptance',
    reached_at: null,
  });
  accept(revised.revision);
  const again = f.store.kindEvents(f.project.id, ['milestone.accepted']).at(-1)!.created_at;
  expect(reached()).toMatchObject({ state: 'completed', reached_at: again });
});

it('keeps reading the history after the clock steps back across local midnight', () => {
  const f = workbenchFixture();
  const lead = leadWithPlan(f, ['exports']);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  const now = vi.spyOn(f.store, 'now').mockReturnValue(new Date(2027, 10, 17, 0, 1).getTime());
  f.store.event('board.plan_updated', plan, f.project.id, plan);
  now.mockReturnValue(new Date(2027, 10, 16, 23, 59).getTime());
  const days = f.control.boardHistory(user, f.project.id).days;
  expect(days.at(-2)).toMatchObject({ date: '2027-11-16' });
  expect(days.at(-1)).toMatchObject({ date: '2027-11-17', decisions: 1 });
});

it('reads only the project rows of turns, step runs, approvals and milestones', () => {
  const f = workbenchFixture();
  leadWithPlan(f, ['exports']);
  const list = vi.spyOn(f.store, 'list');
  f.control.boardHistory(user, f.project.id);
  const tables = new Set(list.mock.calls.map(([table]) => table));
  for (const table of ['session_turns', 'workflow_step_runs', 'approvals', 'milestones'])
    expect(tables).not.toContain(table);
});
