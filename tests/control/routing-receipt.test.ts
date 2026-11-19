import { expect, it } from 'vitest';
import type {
  AgentProfile,
  Approval,
  BoardPlan,
  Principal,
  Session,
  SessionTurn,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { askQuestion } from '../../packages/control/dist/lead-inbox.js';
import { eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Routed = { session_id: string; turn_id: string };
type PlanTask = BoardPlan['tasks'][number];

/** A message the fixture runtime runs as a script. */
const script = (...steps: object[]) => `fixture-script\n${JSON.stringify(steps)}`;

/** A script step that keeps the turn running until the user answers its approval. */
const hold = { ask: { tool: 'Bash', input: { command: 'true' } } };

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

const lanes = {
  core: { id: 'core', title: 'Core' },
  export: { id: 'export', title: 'Export' },
};

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

const request = (f: Fixture, input: string) =>
  f.call<Routed>('request.send', { project_id: f.project.id, input });

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

/** Sends a request whose turn waits on an approval, runs `during` while it waits, then lets it end. */
async function heldTurn(f: Fixture, during: (sessionId: string) => void) {
  const routed = request(f, script(hold));
  const pending = () =>
    f.store
      .list<Approval>('approvals')
      .find(
        (approval) => approval.session_id === routed.session_id && approval.state === 'pending',
      );
  await eventually(
    () => !!pending(),
    () => f.control.tick(),
  );
  during(routed.session_id);
  const approval = pending()!;
  f.call('approval.respond', { approval_id: approval.id, decision: 'approve' }, approval.revision);
  await idle(f, routed.session_id);
  return turnOf(f, routed.turn_id);
}

it('marks a turn of the assistant that only answered as answered here', async () => {
  const f = await workbenchFixture();
  const routed = request(f, 'What does the answer file hold?');
  await idle(f, routed.session_id);

  expect(turnOf(f, routed.turn_id)).toMatchObject({
    state: 'completed',
    routing: { kind: 'answered' },
  });
});

it('marks a turn that added a lane as a new plan with that lane', async () => {
  const f = await workbenchFixture();
  await askedAssistant(f);

  const turn = await heldTurn(f, (sessionId) =>
    writePlan(f, sessionId, [lanes.export], [task('csv', 'export')]),
  );

  expect(turn.routing).toEqual({
    kind: 'new_plan',
    lane_id: 'export',
    task_ids: ['csv'],
    lane_title: 'Export',
    task_titles: ['Task csv'],
  });
});

it('marks a turn that added tasks to an existing lane as added with their ids', async () => {
  const f = await workbenchFixture();
  const assistant = await askedAssistant(f);
  writePlan(f, assistant, [lanes.core], [task('a', 'core')]);

  const turn = await heldTurn(f, (sessionId) =>
    writePlan(
      f,
      sessionId,
      [lanes.core],
      [task('a', 'core'), task('b', 'core'), task('c', 'core')],
    ),
  );

  expect(turn.routing).toEqual({
    kind: 'added',
    lane_id: 'core',
    task_ids: ['b', 'c'],
    lane_title: 'Core',
    task_titles: ['Task b', 'Task c'],
  });
});

it('marks a turn that asked the user a question as asked', async () => {
  const f = await workbenchFixture();
  const assistant = await askedAssistant(f);
  writePlan(f, assistant, [lanes.core], [task('a', 'core')]);

  const turn = await heldTurn(f, (sessionId) =>
    f.call(
      'lead.ask',
      {
        project_id: f.project.id,
        question: 'Which file format comes first?',
        options: ['CSV', 'JSON'],
        recommended: 'CSV',
        assumption: 'CSV comes first',
        blocks: ['a'],
      },
      null,
      leadOf(f, sessionId),
    ),
  );

  expect(turn.routing).toEqual({ kind: 'asked' });
});

it("marks a turn during which a worker's question was relayed as answered here", async () => {
  const f = await workbenchFixture();
  const assistant = await askedAssistant(f);
  writePlan(f, assistant, [lanes.core], [task('a', 'core')]);

  const turn = await heldTurn(f, (sessionId) =>
    askQuestion(
      (f.control as unknown as { ctx: ControlContext }).ctx,
      f.store.must<BoardPlan>('board_plans', sessionId),
      {
        question: 'Which file format comes first?',
        options: ['CSV', 'JSON'],
        recommended: 'CSV',
        assumption: '',
        blocks: ['a'],
        source: { session_id: 'worker-session', approval_id: 'worker-approval' },
      },
    ),
  );

  expect(turn.routing).toEqual({ kind: 'answered' });
});

/** A user's own plan change for the assistant's plan, made ready before the turn and run during it. */
const userChanges: [string, (f: Fixture, assistant: string) => () => unknown][] = [
  [
    'adds a task with a plan edit',
    (f, assistant) => () =>
      f.call('board.plan.edit', {
        project_id: f.project.id,
        lead_session_id: assistant,
        base_version: f.store.must<BoardPlan>('board_plans', assistant).plan_version,
        ops: [{ type: 'add_task', task: task('mine', 'core') }],
      }),
  ],
  [
    'accepts a proposal that adds a lane',
    (f, assistant) => {
      f.call('workflow.policy.set', { project_id: f.project.id, plan_changes: 'confirm' });
      const { proposal_id } = f.call<{ proposal_id: string }>(
        'board.plan.propose',
        {
          project_id: f.project.id,
          base_version: f.store.must<BoardPlan>('board_plans', assistant).plan_version,
          reason: 'Exports need their own lane',
          ops: [
            { type: 'add_lane', lane: lanes.export },
            { type: 'add_task', task: task('csv', 'export') },
          ],
        },
        null,
        leadOf(f, assistant),
      );
      return () =>
        f.call('board.plan.proposal.resolve', {
          project_id: f.project.id,
          lead_session_id: assistant,
          proposal_id,
          decision: 'accept',
        });
    },
  ],
];

it.each(userChanges)(
  'marks a turn that only answered as answered when the user %s while it runs',
  async (_, prepare) => {
    const f = await workbenchFixture();
    const assistant = await askedAssistant(f);
    writePlan(f, assistant, [lanes.core], [task('a', 'core')]);
    const change = prepare(f, assistant);

    const turn = await heldTurn(f, change);

    expect(turn.routing).toEqual({ kind: 'answered' });
  },
);

it('counts only the lane and tasks the assistant added when the user adds a task in the same turn', async () => {
  const f = await workbenchFixture();
  const assistant = await askedAssistant(f);
  writePlan(f, assistant, [lanes.core], [task('a', 'core')]);

  const turn = await heldTurn(f, (sessionId) => {
    f.call('board.plan.edit', {
      project_id: f.project.id,
      lead_session_id: sessionId,
      base_version: f.store.must<BoardPlan>('board_plans', sessionId).plan_version,
      ops: [{ type: 'add_task', task: task('mine', 'core') }],
    });
    writePlan(
      f,
      sessionId,
      [lanes.core, lanes.export],
      [task('a', 'core'), task('mine', 'core'), task('csv', 'export')],
    );
  });

  expect(turn.routing).toEqual({
    kind: 'new_plan',
    lane_id: 'export',
    task_ids: ['csv'],
    lane_title: 'Export',
    task_titles: ['Task csv'],
  });
});

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

it('marks a turn that ended with another request queued behind it', async () => {
  const f = await workbenchFixture();
  let queued: Routed | undefined;

  const turn = await heldTurn(f, () => {
    queued = request(f, 'What does the answer file hold?');
  });

  expect(turnOf(f, queued!.turn_id).state).toBe('completed');
  expect(turn).toMatchObject({ state: 'completed', routing: { kind: 'answered' } });
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

it('gives no routing receipt to a turn of a direct session', async () => {
  const f = await workbenchFixture();
  const direct = await f.create('Explain the answer file');
  await idle(f, direct.id);

  expect(f.turns(direct.id).map((turn) => [turn.state, turn.routing])).toEqual([
    ['completed', undefined],
  ]);
});
