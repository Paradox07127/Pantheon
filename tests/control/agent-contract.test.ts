import { afterEach, expect, it, vi } from 'vitest';
import type {
  AgentContract,
  AgentMessage,
  AgentProfile,
  BoardPlan,
  LeadNote,
  LeadQuestion,
  Principal,
  Session,
  SessionTurn,
  Usage,
  WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { wakeHold } from '../../packages/control/dist/agent-contract.js';
import { residentPlan } from '../../packages/control/dist/agent-always-on.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
});

const MINUTE = 60_000;

const lead = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60 * MINUTE,
});

/** A fixture whose store clock starts at 09:00 local time tomorrow and moves only by advance. */
async function clockFixture(kind: 'assistant' | 'triage' = 'assistant') {
  const f = await workbenchFixture();
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  let now = start.getTime();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind,
  });
  const as = <T = unknown>(type: Parameters<Fixture['call']>[0], input: Record<string, unknown>) =>
    f.call<T>(type, { project_id: f.project.id, ...input }, null, lead(f, assistant.id));
  const profile = () => f.store.must<AgentProfile>('agents', assistant.resident!.agent_id!);
  const setContract = (contract: AgentContract) =>
    f.call('agent.update', { agent_id: profile().id, revision: profile().revision, contract });
  return {
    f,
    assistant,
    as,
    profile,
    setContract,
    start: start.getTime(),
    advance: (ms: number) => (now += ms),
  };
}

const notesOf = (f: Fixture, kind: LeadNote['kind']) =>
  f.store
    .events(0, f.project.id, 1000, ['lead.note_added'])
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);
const trackerTurns = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');
const holds = (f: Fixture) =>
  f.store.events(0, f.project.id, 1000, ['agent.wake_held']).map((event) => event.payload);
const ended = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).every((turn) => turn.state !== 'queued' && turn.state !== 'running');

/** Ticks several times, since a wake the lead first refused is tried again on later ticks. */
async function ticks(f: Fixture) {
  for (let index = 0; index < 5; index++) {
    await f.control.tick();
    await sleep(20);
  }
}

/** Sets the usage of the session's latest turn, as its runtime would have reported it. */
function spend(f: Fixture, sessionId: string, usage: Partial<Usage>) {
  const turn = f.turns(sessionId).at(-1)!;
  f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, usage: { input_tokens: 0, output_tokens: 0, ...usage } },
    turn.revision,
  );
}

/** Runs one hourly routine wake to its end and charges it 150 input tokens. */
async function spentHour(fixture: Awaited<ReturnType<typeof clockFixture>>) {
  const { f, assistant, as, advance } = fixture;
  const routine = as<{ id: string }>('agent.routine.set', {
    prompt: 'Look for stalled tasks',
    every_minutes: 60,
    enabled: true,
  });
  advance(60 * MINUTE);
  await f.control.tick();
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1 && ended(f, assistant.id),
    () => f.control.tick(),
  );
  spend(f, assistant.id, { input_tokens: 150 });
  return routine;
}

it('holds routines while the weekly cap is spent, records the hold once, and wakes with both notes once the week rolls', async () => {
  const fixture = await clockFixture();
  const { f, assistant, as, profile, setContract, advance } = fixture;
  const routine = await spentHour(fixture);
  setContract({ weekly_input_tokens: 100 });

  advance(60 * MINUTE);
  await ticks(f);
  expect(trackerTurns(f, assistant.id)).toHaveLength(1);
  expect(holds(f)).toEqual([
    { agent_id: profile().id, reason: 'weekly_budget', since: f.store.now() },
  ]);

  advance(60 * MINUTE);
  await ticks(f);
  expect(trackerTurns(f, assistant.id)).toHaveLength(1);
  expect(holds(f)).toHaveLength(1);
  as('agent.routine.cancel', { routine_id: routine.id });

  const monday = new Date(f.store.now());
  monday.setHours(0, 1, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + 7);
  advance(monday.getTime() - f.store.now());
  await eventually(
    () => trackerTurns(f, assistant.id).length === 2,
    () => f.control.tick(),
  );
  const turns = trackerTurns(f, assistant.id);
  expect(turns[1]!.lead_note_ids).toEqual(
    notesOf(f, 'routine')
      .slice(1)
      .map((note) => note.id),
  );
  expect(turns[1]!.wake).toEqual({ causes: ['routine'], routine_ids: [routine.id] });
  expect(holds(f)).toHaveLength(1);
});

it('holds a follow-up inside the contract quiet hours and wakes it on the first tick after them', async () => {
  const { f, assistant, as, profile, setContract, advance } = await clockFixture();
  setContract({ quiet_hours: { from: '10:00', to: '11:00' } });
  as('agent.follow_up', { after_minutes: 90, note: 'Check whether the export task merged' });

  advance(91 * MINUTE);
  await ticks(f);
  expect(notesOf(f, 'follow_up')).toHaveLength(1);
  expect(trackerTurns(f, assistant.id)).toEqual([]);
  expect(holds(f)).toEqual([
    { agent_id: profile().id, reason: 'quiet_hours', since: f.store.now() },
  ]);

  advance(28 * MINUTE);
  await ticks(f);
  expect(trackerTurns(f, assistant.id)).toEqual([]);

  advance(MINUTE);
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1,
    () => f.control.tick(),
  );
  const turns = trackerTurns(f, assistant.id);
  expect(turns[0]!.input).toContain('Check whether the export task merged');
  expect(holds(f)).toHaveLength(1);
});

it.each([
  ['23:30', 'quiet_hours', 23, 30],
  ['06:59', 'quiet_hours', 6, 59],
  ['07:00', undefined, 7, 0],
] as const)(
  'quiet hours from 22:00 to 07:00 at %s give the hold %s',
  async (_time, hold, hours, minutes) => {
    const { f, profile } = await clockFixture();
    const at = new Date(f.store.now());
    at.setHours(hours, minutes, 0, 0);
    expect(
      wakeHold(
        f.control['ctx'] as ControlContext,
        { ...profile(), contract: { quiet_hours: { from: '22:00', to: '07:00' } } },
        at.getTime(),
      ),
    ).toBe(hold);
  },
);

it("wakes a held agent with the user's answer, and the turn carries the held notes too", async () => {
  const { f, assistant, as, setContract, advance } = await clockFixture();
  setContract({ quiet_hours: { from: '09:00', to: '12:00' } });
  as('agent.follow_up', { after_minutes: 5, note: 'Check whether the export task merged' });
  advance(6 * MINUTE);
  await ticks(f);
  expect(trackerTurns(f, assistant.id)).toEqual([]);

  const question = as<LeadQuestion>('lead.ask', {
    question: 'Which export format comes first?',
    options: ['CSV', 'JSON'],
    recommended: 'CSV',
    assumption: 'CSV comes first',
    blocks: [],
  });
  f.call('lead.question.answer', {
    project_id: f.project.id,
    lead_session_id: assistant.id,
    question_id: question.id,
    answer: 'JSON',
  });
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1,
    () => f.control.tick(),
  );
  const turns = trackerTurns(f, assistant.id);
  expect(turns[0]!.wake?.causes).toEqual(['follow_up', 'answer']);
  expect(turns[0]!.input).toContain('Check whether the export task merged');
});

it("runs the user's message to a held agent", async () => {
  const { f, assistant, setContract } = await clockFixture();
  setContract({ quiet_hours: { from: '09:00', to: '12:00' } });
  f.call(
    'session.send',
    { session_id: assistant.id, input: 'Hello' },
    f.store.must<Session>('sessions', assistant.id).revision,
  );
  await eventually(
    () => f.turns(assistant.id).some((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  expect(holds(f)).toEqual([]);
});

it('wakes an agent without a contract as before', async () => {
  const { f, assistant, as, advance } = await clockFixture();
  as('agent.follow_up', { after_minutes: 90, note: 'Check whether the export task merged' });
  advance(91 * MINUTE);
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1,
    () => f.control.tick(),
  );
  expect(holds(f)).toEqual([]);
});

it("keeps the project budget's stop when the agent's own cap is not spent", async () => {
  const fixture = await clockFixture();
  const { f, assistant, setContract, advance } = fixture;
  f.call<WorkflowPolicy>('workflow.policy.set', {
    project_id: f.project.id,
    project_budget: { input_tokens: 100 },
  });
  advance(MINUTE);
  await spentHour(fixture);
  setContract({ weekly_input_tokens: 1_000_000 });

  advance(60 * MINUTE);
  await ticks(f);
  expect(notesOf(f, 'routine')).toHaveLength(2);
  expect(trackerTurns(f, assistant.id)).toHaveLength(1);
  expect(holds(f)).toEqual([]);
});

it.each([
  ['feed with loudest feed', { loudest: 'feed' }, false, 'feed'],
  [
    'feed in its quiet hours',
    { loudest: 'notify', quiet_hours: { from: '09:00', to: '12:00' } },
    false,
    'feed',
  ],
  [
    'notify for an urgent message in its quiet hours',
    { quiet_hours: { from: '09:00', to: '12:00' } },
    true,
    'notify',
  ],
  ['feed for an urgent message with loudest feed', { loudest: 'feed' }, true, 'feed'],
  ['notify without a contract', undefined, false, 'notify'],
] as const)(
  "stamps the assistant's message to the user %s",
  async (_case, contract, urgent, delivery) => {
    const { f, as, setContract } = await clockFixture();
    if (contract) setContract(contract);
    const message = as<AgentMessage>('agent.tell_user', {
      text: 'The export task merged.',
      urgency: urgent ? 'high' : 'normal',
    });
    expect(f.store.must<AgentMessage>('agent_messages', message.id).delivery ?? 'notify').toBe(
      delivery,
    );
    expect(
      f.store
        .events(0, f.project.id, 1000, ['agent_message.created'])
        .map((event) => (event.payload as AgentMessage).delivery ?? 'notify'),
    ).toEqual([delivery]);
  },
);

const askInput = {
  question: 'Which export format comes first?',
  options: ['CSV', 'JSON'],
  recommended: 'CSV',
  assumption: 'CSV comes first',
  blocks: [],
};

it.each(['feed', 'notify'] as const)(
  'refuses lead.ask from a resident whose loudest is %s',
  async (loudest) => {
    const { f, assistant, as, setContract } = await clockFixture();
    setContract({ loudest });
    residentPlan(f.control['ctx'] as ControlContext, assistant);
    expect(() => as('lead.ask', askInput)).toThrow(
      expect.objectContaining({
        code: 'permission_denied',
        message: 'Your contract lets you reach the user only with tell_user',
      }),
    );
  },
);

it.each([
  ['loudest ask', { loudest: 'ask' }],
  ['no contract', undefined],
] as const)('lets a resident with %s ask the user', async (_case, contract) => {
  const { f, assistant, as, setContract } = await clockFixture();
  if (contract) setContract(contract);
  residentPlan(f.control['ctx'] as ControlContext, assistant);
  const question = as<LeadQuestion>('lead.ask', askInput);
  expect(f.store.must<BoardPlan>('board_plans', assistant.id).questions).toEqual([
    expect.objectContaining({ id: question.id }),
  ]);
});
