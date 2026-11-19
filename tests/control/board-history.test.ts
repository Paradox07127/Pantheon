import { describe, expect, it, vi } from 'vitest';
import type { BoardPlan, Milestone, Session, SessionTurn, StepRun } from '@pantheon/domain';
import { settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

async function leadWithPlan(f: Fixture, taskIds: string[]) {
  const lead = await f.create('Plan the export feature');
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

function taskWorker(f: Fixture, leadId: string, taskId: string, id = `${taskId}-worker`) {
  const worker = f.store.insert<Session>('sessions', {
    id,
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

it('counts gate attempts toward the generation the session worked on when each gate ran', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
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

it('does not count the turn a workflow prompt step queues on the task session as a handback', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
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

it('gives a revised milestone no reached time until it is accepted again', async () => {
  const f = await workbenchFixture();
  const merged = await f.create('Merge the export');
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

it('keeps reading the history after the clock steps back across local midnight', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
  const plan = f.store.must<BoardPlan>('board_plans', lead.id);
  const now = vi.spyOn(f.store, 'now').mockReturnValue(new Date(2027, 10, 17, 0, 1).getTime());
  f.store.event('board.plan_updated', plan, f.project.id, plan);
  now.mockReturnValue(new Date(2027, 10, 16, 23, 59).getTime());
  const days = f.control.boardHistory(user, f.project.id).days;
  expect(days.at(-2)).toMatchObject({ date: '2027-11-16' });
  expect(days.at(-1)).toMatchObject({ date: '2027-11-17', decisions: 1 });
});

it('reads only the project rows of turns, step runs, approvals and milestones', async () => {
  const f = await workbenchFixture();
  await leadWithPlan(f, ['exports']);
  const list = vi.spyOn(f.store, 'list');
  f.control.boardHistory(user, f.project.id);
  const tables = new Set(list.mock.calls.map(([table]) => table));
  for (const table of ['session_turns', 'workflow_step_runs', 'approvals', 'milestones'])
    expect(tables).not.toContain(table);
});

it('counts the parts of one parallel dispatch as one attempt', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
  const one = taskWorker(f, lead.id, 'exports', 'exports-part-one');
  const two = taskWorker(f, lead.id, 'exports', 'exports-part-two');
  f.store.event('task.dispatched', lead, f.project.id, {
    task_id: 'exports',
    session_id: one.id,
    session_ids: [one.id, two.id],
  });
  expect(historyTask(f, `${lead.id}:exports`)).toMatchObject({ attempts: 1 });
});

it('keeps the reason of a rejected approval inside a parallel step that then fails', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
  const approval = { id: 'sign-off', title: 'Sign off', kind: { type: 'approval' as const } };
  const run = (id: string, step: StepRun['step'], state: StepRun['state']) => {
    const row = f.store.insert<StepRun>('workflow_step_runs', {
      id,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: lead.id,
      task_id: 'exports',
      generation: 1,
      definition_version: 1,
      slot: 'before_merge',
      step,
      state,
      created_at: f.store.now(),
    });
    f.store.event('workflow.step_changed', row, f.project.id, {
      state,
      task_id: 'exports',
      slot: row.slot,
      step_id: step.id,
    });
  };
  run('sign-off-run', approval, 'rejected');
  run(
    'checks-run',
    { id: 'checks', title: 'Checks', kind: { type: 'parallel', steps: [approval] } },
    'failed',
  );
  f.store.event('task.handed_back', lead, f.project.id, { task_id: 'exports' });
  expect(historyTask(f, `${lead.id}:exports`).handback_reasons).toEqual({
    gate: 0,
    review: 1,
    other: 0,
  });
});

it('completes a task when its last unmerged part is discarded', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
  const one = taskWorker(f, lead.id, 'exports', 'exports-part-one');
  const two = taskWorker(f, lead.id, 'exports', 'exports-part-two');
  const end = (session: Session, outcome: 'merged' | 'discarded', at: Date) => {
    vi.spyOn(f.store, 'now').mockReturnValue(at.getTime());
    const row = f.store.must<Session>('sessions', session.id);
    f.store.update<Session>('sessions', { ...row, state: 'closed', outcome }, row.revision);
    f.store.event(`session.${outcome}`, row, f.project.id, {});
  };
  end(one, 'merged', new Date(2027, 9, 1, 12));
  const discarded = new Date(2027, 9, 4, 12);
  end(two, 'discarded', discarded);
  expect(historyTask(f, `${lead.id}:exports`)).toMatchObject({
    state: 'merged',
    merged_at: discarded.getTime(),
  });
  const days = f.control.boardHistory(user, f.project.id).days;
  expect(days.find((day) => day.date === '2027-10-04')).toMatchObject({ merged: 1 });
});

it('reads a direct task claimed by its lead under the lead session', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
  f.store.event('task.claimed', lead, f.project.id, { task_id: 'exports', generation: 1 });
  expect(historyTask(f, `${lead.id}:exports`)).toMatchObject({
    session_id: lead.id,
    runtime: f.adapter.name,
    attempts: 1,
  });
});

it('records a lead claiming its direct task as a start decision', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
  f.store.event('task.claimed', lead, f.project.id, { task_id: 'exports', generation: 1 });
  const history = f.control.boardHistory(user, f.project.id);
  expect(history.decisions.map(({ kind, title }) => ({ kind, title }))).toEqual([
    { kind: 'plan', title: 'Export ships this week' },
    { kind: 'start', title: 'exports' },
  ]);
  expect(history.days.reduce((sum, day) => sum + day.decisions, 0)).toBe(2);
});

describe('a plan change that answers a fired re-plan condition', () => {
  async function fired(f: Fixture) {
    const lead = await leadWithPlan(f, ['exports']);
    await settle(f, lead);
    const event = f.store.event('board.replan_triggered', lead, f.project.id, {
      milestone_id: 'milestone-row',
      trigger: { type: 'handbacks', count: 2 },
      task_id: 'exports',
      generation: 1,
      value: 2,
    });
    const edit = (title: string, trigger_event?: string) =>
      f.call(
        'board.plan.edit',
        {
          project_id: f.project.id,
          base_version: f.store.must<BoardPlan>('board_plans', lead.id).plan_version,
          ...(trigger_event ? { trigger_event } : {}),
          ops: [{ type: 'set_task', task_id: 'exports', patch: { title } }],
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
    return { lead, event, edit };
  }
  const answered = (eventId: string, title: string) => ({
    kind: 'replan',
    replan: {
      triggers: [
        {
          event_id: eventId,
          milestone_id: 'milestone-row',
          text: 'task exports was handed back 2 times',
        },
      ],
      added: [],
      removed: [],
      changed: [title],
    },
  });

  it('is a replan decision with the trigger and the tasks it changed when it names the event', async () => {
    const f = await workbenchFixture();
    const { event, edit } = await fired(f);
    edit('Exports v2', event.event_id);
    const history = f.control.boardHistory(user, f.project.id);
    expect(history.decisions.map(({ kind, replan }) => ({ kind, replan }))).toEqual([
      { kind: 'plan', replan: undefined },
      answered(event.event_id, 'Exports v2'),
    ]);
  });

  it("is the lead's first change in a turn begun after the condition fired", async () => {
    const f = await workbenchFixture();
    const { lead, event, edit } = await fired(f);
    edit('Exports v2');
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: 'wake-turn',
      revision: 1,
      project_id: f.project.id,
      session_id: lead.id,
      input: 'Board updates',
      kind: 'send',
      delivery: 'delivered',
      state: 'running',
      origin: 'tracker',
    });
    f.store.event('turn.running', turn, f.project.id, {});
    edit('Exports v3');
    edit('Exports v4');
    const kinds = f.control.boardHistory(user, f.project.id).decisions.map(({ kind }) => kind);
    expect(kinds).toEqual(['plan', 'plan', 'replan', 'plan']);
    expect(f.control.boardHistory(user, f.project.id).decisions[2]).toMatchObject(
      answered(event.event_id, 'Exports v3'),
    );
  });
});

it('reads a task claim after a finished system turn whose row is gone', async () => {
  const f = await workbenchFixture();
  const lead = await leadWithPlan(f, ['exports']);
  // A baseline turn logs only its purpose; its session_turns row goes with its session.
  const turn = { id: 'baseline-turn', revision: 1 };
  f.store.event('turn.queued', turn, f.project.id, { purpose: 'baseline' });
  f.store.event('turn.running', turn, f.project.id, {});
  f.store.event('turn.completed', turn, f.project.id, {});
  f.store.event('task.claimed', lead, f.project.id, { task_id: 'exports', generation: 1 });
  expect(historyTask(f, `${lead.id}:exports`)).toMatchObject({ session_id: lead.id });
});
