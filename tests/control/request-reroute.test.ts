import { expect, it } from 'vitest';
import type { AgentProfile, BoardPlan, Principal, Session, SessionTurn } from '@pantheon/domain';
import { eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Routed = { session_id: string; turn_id: string };
type PlanTask = BoardPlan['tasks'][number];

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const task = (id: string, lane: string): PlanTask => ({
  id,
  title: `Task ${id}`,
  goal: `Finish task ${id}`,
  lane,
  depends_on: [],
  source: ['Plan the export feature'],
  scope: [`src/${id}`],
  acceptance: ['pnpm test'],
});

const lanes = { core: { id: 'core', title: 'Core' } };

const writePlan = (
  f: Fixture,
  sessionId: string,
  planLanes: BoardPlan['lanes'],
  tasks: PlanTask[],
) =>
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: f.store.get<BoardPlan>('board_plans', sessionId)?.plan_version ?? 0,
      headline: 'Export ships this week',
      lanes: planLanes,
      tasks,
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, sessionId),
  );

/** The user's request to the project's Assistant. */
const request = (f: Fixture, input: string) => {
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  return f.call<Routed>('request.send', {
    project_id: f.project.id,
    input,
    target: { kind: 'session', session_id: assistant.id },
  });
};

const turnOf = (f: Fixture, turnId: string) => f.store.must<SessionTurn>('session_turns', turnId);

/** Waits until the session takes input again with no turn left to run. */
const idle = (f: Fixture, sessionId: string) =>
  eventually(
    () =>
      f.store.must<Session>('sessions', sessionId).state === 'open' &&
      f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );

/** The assistant, after the request the plan tasks quote has ended. */
async function askedAssistant(f: Fixture) {
  const routed = request(f, 'Plan the export feature');
  await idle(f, routed.session_id);
  return routed.session_id;
}

it('steers the assistant once with a message that names the lane the user routes to', async () => {
  const f = await workbenchFixture();
  const assistant = await askedAssistant(f);
  writePlan(f, assistant, [lanes.core], [task('a', 'core')]);
  const routed = request(f, 'Add a CSV export');
  await idle(f, routed.session_id);
  const before = f.turns(assistant).map((turn) => turn.id);

  f.call('request.reroute', { turn_id: routed.turn_id, to: { lane_id: 'core' } });

  const added = f.turns(assistant).filter((turn) => !before.includes(turn.id));
  expect(added).toHaveLength(1);
  expect(added[0]!.input).toMatch(/^\[Pantheon\] The user routes this request/);
  expect(added[0]!.input).toContain('lane core (Core)');
  expect(added[0]!.input).toContain('Add a CSV export');
});

it("reroutes only the user's words of a request that carried board updates to another agent", async () => {
  const f = await workbenchFixture();
  const assistant = await askedAssistant(f);
  writePlan(f, assistant, [lanes.core], [task('a', 'core')]);
  const plan = f.store.must<BoardPlan>('board_plans', assistant);
  f.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      inbox: [
        {
          id: 'note-risk',
          at: f.store.now(),
          session_id: '',
          task_id: '',
          kind: 'risk',
          text: 'The disk is almost full',
        },
      ],
    },
    plan.revision,
  );
  const routed = request(f, 'Add a CSV export');
  await idle(f, routed.session_id);
  expect(turnOf(f, routed.turn_id).input).toContain('The disk is almost full');
  const helper = f.call<AgentProfile>('agent.create', {
    project_id: f.project.id,
    template: 'custom',
    name: 'Exporter',
    role: 'Helper',
    instructions: 'You help with exports.',
  });

  const rerouted = f.call<Routed>('request.reroute', {
    turn_id: routed.turn_id,
    to: { agent_id: helper.id },
  });

  const input = turnOf(f, rerouted.turn_id).input;
  expect(input).toContain('Add a CSV export');
  expect(input).not.toContain('The disk is almost full');
});
