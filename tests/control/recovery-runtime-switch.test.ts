import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  BoardPlan,
  LeadNote,
  Principal,
  Project,
  Session,
  WorkflowPolicy,
} from '@pantheon/domain';
import { eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, leadId: string): Principal => ({
  id: `session:${leadId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: leadId,
  expires_at: f.store.now() + 60000,
});

const exportTask: PlanTask = {
  id: 'a',
  title: 'Serve exports over HTTP',
  goal: 'Exports download',
  lane: 'core',
  depends_on: [],
  source: ['Plan the export feature'],
  scope: ['src/export'],
  acceptance: ['pnpm test'],
  kind: { domain: 'backend-logic', tier: 't2' },
};

function writePlan(f: Fixture, leadId: string, task: PlanTask = exportTask) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', leadId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, leadId),
  );
}

const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const planOf = (f: Fixture, leadId: string) => f.store.must<BoardPlan>('board_plans', leadId);
const fromTracker = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');
const runtimeChanges = (f: Fixture) =>
  f.store.kindEvents(f.project.id, ['session.runtime_changed']).map((event) => event.payload);
const notesOf = (f: Fixture, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);

/** Blocks the session's merge on a failed gate the way the automatic merge does. */
function gateFails(f: Fixture, sessionId: string, output: string) {
  const session = current(f, sessionId);
  f.store.event('session.merge_started', session, session.project_id, { auto: true }, '');
  f.store.update<Session>(
    'sessions',
    {
      ...current(f, sessionId),
      merge: { state: 'blocked', reason: 'gate_failed', gate: { name: 'Unit tests', output } },
    },
    session.revision,
  );
}

/**
 * A task session on runtime first whose failed gate was handed back three times, with its fourth
 * failure waiting for the tick; the project's writer fallback is runtime second unless alternate is
 * false.
 */
async function handBacksUsedUp(options: {
  recovery_switch?: 'auto' | 'off';
  alternate?: boolean;
  named?: boolean;
}) {
  const f = await workbenchFixture();
  // A plan may not name the fixture runtime, so the session starts on a runtime of another name.
  const [first, second] = ['first', 'second'].map((name) => {
    const adapter = new FixtureAdapter();
    adapter.name = name;
    f.control.adapters.set(name, adapter);
    return adapter;
  }) as [FixtureAdapter, FixtureAdapter];
  if (options.recovery_switch)
    f.call(
      'workflow.policy.set',
      { project_id: f.project.id, recovery_switch: options.recovery_switch },
      f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null,
    );
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  writePlan(
    f,
    lead.id,
    options.named
      ? { ...exportTask, runtime: first.name, route_reason: 'The export code is tuned for it' }
      : exportTask,
  );
  if (options.alternate !== false) {
    const project = f.store.must<Project>('projects', f.project.id);
    f.store.update<Project>(
      'projects',
      {
        ...project,
        session_defaults: {
          runtime: f.adapter.name,
          permission_mode: 'ask',
          fallbacks: { writer: { runtime: second.name, model: 'second-model' } },
        },
      },
      project.revision,
    );
  }
  const worker = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: first.name,
    input: 'Build the export endpoint',
    task_id: `${lead.id}:a`,
  });
  await settle(f, worker);
  for (const output of ['first failure', 'second failure', 'third failure']) {
    gateFails(f, worker.id, output);
    await f.control.tick();
    await settle(f, worker);
  }
  expect(fromTracker(f, worker.id)).toHaveLength(3);
  gateFails(f, worker.id, 'fourth failure');
  return { f, second, lead, worker };
}

/** Runs ticks until Pantheon has handed the fourth failure back, and that turn has ended. */
async function switched(f: Fixture, worker: Session) {
  await eventually(
    () => fromTracker(f, worker.id).length === 4,
    () => f.control.tick(),
  );
  await settle(f, worker);
}

const blockedNote = '": The merge of the session is blocked. Reason: gate_failed';
const toldLead = (f: Fixture, leadId: string) =>
  f
    .turns(leadId)
    .filter((turn) => turn.origin === 'tracker')
    .map((turn) => turn.input);

it('moves a task whose hand-backs ran out to the alternate runtime for one more hand-back', async () => {
  const { f, second, lead, worker } = await handBacksUsedUp({ recovery_switch: 'auto' });
  const sent = vi.spyOn(second, 'send');

  await switched(f, worker);

  expect(current(f, worker.id)).toMatchObject({
    runtime: 'second',
    requested_model: 'second-model',
  });
  expect(sent.mock.calls.map(([, turn]) => turn.input)).toEqual([
    expect.stringContaining('fourth failure'),
  ]);
  const heard = f
    .turns(worker.id)
    .map((turn) => turn.input)
    .join('\n');
  expect(heard).toContain('Pantheon moved this task from runtime first to second');
  expect(heard).not.toContain('The lead changed this task');
  expect(runtimeChanges(f)).toEqual([{ from: 'first', to: 'second' }]);
  const notes = notesOf(f, 'runtime_switched');
  expect(notes).toHaveLength(1);
  expect(notes[0]!.text).toContain(
    `gate_failed problem back to session ${worker.id} 3 times on runtime ${'first'}`,
  );
  expect(notes[0]!.text).toContain('moved the task to runtime second (model second-model)');
  expect(planOf(f, lead.id).handed_back).toEqual({
    [worker.id]: ['gate_failed', 'gate_failed', 'gate_failed', 'gate_failed'],
  });
  expect(planOf(f, lead.id).runtime_switches).toMatchObject({
    a: { from: 'first', to: { runtime: 'second', model: 'second-model' } },
  });
  await eventually(
    () => toldLead(f, lead.id).length > 0,
    () => f.control.tick(),
  );
  const wake = toldLead(f, lead.id).join('\n');
  expect(wake).toContain('<note kind="runtime_switched"');
  expect(wake).toContain('name that runtime on the task with update_board');
  expect(wake).not.toContain(blockedNote);
});

it('tells the lead of the next failure on the alternate runtime and switches no more', async () => {
  const { f, lead, worker } = await handBacksUsedUp({ recovery_switch: 'auto' });
  await switched(f, worker);

  gateFails(f, worker.id, 'fifth failure');
  await eventually(
    () => toldLead(f, lead.id).some((input) => input.includes(blockedNote)),
    () => f.control.tick(),
  );

  expect(fromTracker(f, worker.id)).toHaveLength(4);
  expect(runtimeChanges(f)).toHaveLength(1);
  expect(notesOf(f, 'runtime_switched')).toHaveLength(1);
  expect(current(f, worker.id).runtime).toBe('second');
});

it.each([
  ['the switch is off', { recovery_switch: 'off' as const }],
  ['no alternate runtime exists', { recovery_switch: 'auto' as const, alternate: false }],
  ['the plan names the runtime of the task', { recovery_switch: 'auto' as const, named: true }],
])('tells the lead when the hand-backs ran out and %s', async (_, options) => {
  const { f, lead, worker } = await handBacksUsedUp(options);

  await f.control.tick();

  expect(fromTracker(f, worker.id)).toHaveLength(3);
  expect(toldLead(f, lead.id)[0]).toContain(blockedNote);
  expect(runtimeChanges(f)).toEqual([]);
  expect(notesOf(f, 'runtime_switched')).toEqual([]);
  expect(planOf(f, lead.id).runtime_switches).toBeUndefined();
  expect(current(f, worker.id).runtime).toBe('first');
});

it('keeps the switch through a plan of the lead that names no runtime for the task', async () => {
  const { f, lead, worker } = await handBacksUsedUp({ recovery_switch: 'auto' });
  await switched(f, worker);

  writePlan(f, lead.id, { ...exportTask, title: 'Serve CSV exports over HTTP' });
  await eventually(
    () => f.turns(worker.id).some((turn) => turn.origin === 'lead'),
    () => f.control.tick(),
  );
  await settle(f, worker);

  expect(planOf(f, lead.id).runtime_switches).toHaveProperty('a');
  expect(current(f, worker.id).runtime).toBe('second');
  expect(runtimeChanges(f)).toHaveLength(1);
});

it('ends the switch when the lead names the old runtime for the task', async () => {
  const { f, lead, worker } = await handBacksUsedUp({ recovery_switch: 'auto' });
  await switched(f, worker);

  writePlan(f, lead.id, { ...exportTask, runtime: 'first' });
  expect(planOf(f, lead.id).runtime_switches).toEqual({});
  await eventually(
    () => current(f, worker.id).runtime === 'first',
    () => f.control.tick(),
  );

  expect(runtimeChanges(f)).toEqual([
    { from: 'first', to: 'second' },
    { from: 'second', to: 'first' },
  ]);
});

it('shows the switch Pantheon made on the board', async () => {
  const { f, lead, worker } = await handBacksUsedUp({ recovery_switch: 'auto' });
  await switched(f, worker);

  const row = f.control
    .boardView(user, f.project.id, 1)
    .tasks.find((each) => each.id === `${lead.id}:a`)!;
  expect(row.rung).toMatchObject({
    rung: 'switch',
    by: 'pantheon',
    switches: [{ from: 'first', to: 'second', by: 'pantheon' }],
  });
});
