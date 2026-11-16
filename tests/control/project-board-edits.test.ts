import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { id } from '@pantheon/domain';
import type { BoardPlan, Principal, SessionTurn } from '@pantheon/domain';
import { fixture, insertSession, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Fixture = ReturnType<typeof fixture>;

function setup() {
  const f = fixture({ adapter: new FixtureAdapter(100), managedWorkspaces: true });
  cleanups.push(() => f.close());
  return f;
}

const REQUEST = 'Ship the export API and a download button this week.';

function leadOf(f: Fixture): Principal {
  const lead = insertSession(f);
  f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: lead.id,
    input: REQUEST,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  return {
    id: `session:${lead.id}`,
    role: 'lead',
    project_id: f.project.id,
    session_id: lead.id,
    expires_at: f.store.now() + 60_000_000,
  };
}

const task = (taskId: string, scope: string[]) => ({
  id: taskId,
  title: `Task ${taskId}`,
  goal: 'Serve exports',
  lane: 'core',
  depends_on: [],
  source: ['Ship the export API'],
  scope,
  acceptance: ['pnpm test'],
});

function writePlan(f: Fixture, lead: Principal, tasks = [task('a', ['src/a.ts'])]) {
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', lead.session_id!)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    lead,
  );
}

const planOf = (f: Fixture, lead: Principal) =>
  f.store.must<BoardPlan>('board_plans', lead.session_id!);
const kindOf = (f: Fixture, lead: Principal, taskId: string) =>
  planOf(f, lead).tasks.find((entry) => entry.id === taskId)?.kind;
const wakes = (f: Fixture, lead: Principal) =>
  f.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === lead.session_id && turn.origin === 'tracker').length;

it('gives a task the kind of the scope an edit sets, as a whole plan with that scope does', () => {
  const f = setup();
  const whole = leadOf(f);
  writePlan(f, whole, [task('a', ['src/auth.ts'])]);
  expect(kindOf(f, whole, 'a')).toEqual({ domain: 'backend-logic', tier: 't3' });

  const lead = leadOf(f);
  writePlan(f, lead);
  expect(kindOf(f, lead, 'a')).toEqual({ domain: 'backend-logic', tier: 't1' });
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      lead_session_id: lead.session_id,
      base_version: planOf(f, lead).plan_version,
      ops: [{ type: 'set_task', task_id: 'a', patch: { scope: ['src/auth.ts'] } }],
    },
    null,
    user,
  );
  expect(kindOf(f, lead, 'a')).toEqual({ domain: 'backend-logic', tier: 't3' });
});

it.each(['accept', 'reject'] as const)(
  'wakes the lead when the user chooses to %s its proposal',
  (decision) => {
    const f = setup();
    const lead = leadOf(f);
    writePlan(f, lead);
    const { proposal_id } = f.call<{ proposal_id: string }>(
      'board.plan.propose',
      {
        project_id: f.project.id,
        base_version: planOf(f, lead).plan_version,
        reason: 'The export needs a second task',
        ops: [{ type: 'add_task', task: task('z', ['src/z.ts']) }],
      },
      null,
      lead,
    );
    expect(wakes(f, lead)).toBe(0);
    f.call(
      'board.plan.proposal.resolve',
      {
        project_id: f.project.id,
        lead_session_id: lead.session_id,
        proposal_id,
        decision,
      },
      null,
      user,
    );
    expect(wakes(f, lead)).toBe(1);
  },
);

it("clears a task's model and effort that a set_task patch sets to null", () => {
  const f = setup();
  const lead = leadOf(f);
  const routed = {
    ...task('a', ['src/a.ts']),
    model: 'fixture-large',
    effort: 'high',
    route_reason: 'The task needs the large model',
  };
  writePlan(f, lead, [routed]);
  f.call(
    'board.plan.edit',
    {
      project_id: f.project.id,
      lead_session_id: lead.session_id,
      base_version: planOf(f, lead).plan_version,
      ops: [
        {
          type: 'set_task',
          task_id: 'a',
          patch: { model: null, effort: null },
        },
      ],
    },
    null,
    user,
  );
  const edited = planOf(f, lead).tasks.find((entry) => entry.id === 'a')!;
  expect(edited.route_reason).toBe('The task needs the large model');
  expect(edited).not.toHaveProperty('model');
  expect(edited).not.toHaveProperty('effort');
});
