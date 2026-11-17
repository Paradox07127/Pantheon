import { expect, it, vi } from 'vitest';
import type { BoardPlan, Principal, Session, SessionTurn } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { residentPlan } from '../../packages/control/dist/agent-always-on.js';
import { appendNote } from '../../packages/control/dist/lead-inbox.js';
import { recordSignal } from '../../packages/control/dist/signals.js';
import { wakeLead } from '../../packages/control/dist/task-tracking.js';
import { eventually, settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const MINUTE = 60_000;

const lead = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60 * MINUTE,
});

const trackerTurns = (f: Fixture, sessionId: string) =>
  f.turns(sessionId).filter((turn) => turn.origin === 'tracker');

/** A project whose store clock moves only by advance, with an open Assistant resident. */
async function assistantFixture() {
  const f = await workbenchFixture();
  let now = Date.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const as = <T = unknown>(type: Parameters<Fixture['call']>[0], input: Record<string, unknown>) =>
    f.call<T>(type, { project_id: f.project.id, ...input }, null, lead(f, assistant.id));
  return { f, ctx, assistant, as, advance: (ms: number) => (now += ms) };
}

/** The first tracker turn the routine's timer queued for the Assistant, with the routine's id. */
async function routineWake() {
  const { f, assistant, as, advance } = await assistantFixture();
  const routine = as<{ id: string }>('agent.routine.set', {
    prompt: 'Look for stalled tasks',
    every_minutes: 60,
    enabled: true,
  });
  advance(60 * MINUTE);
  await eventually(
    () => trackerTurns(f, assistant.id).length === 1,
    () => f.control.tick(),
  );
  return { turn: trackerTurns(f, assistant.id)[0]!, routineId: routine.id };
}

async function followUpWake() {
  const { f, assistant, as, advance } = await assistantFixture();
  as('agent.follow_up', { after_minutes: 30, note: 'Check whether the export task merged' });
  advance(31 * MINUTE);
  await f.control.tick();
  return trackerTurns(f, assistant.id)[0]!;
}

async function signalWake() {
  const { f, ctx, advance } = await assistantFixture();
  recordSignal(ctx, {
    project_id: f.project.id,
    source: 'gate_failures',
    fingerprint: 'typecheck',
    title: 'Typecheck fails on main',
  });
  advance(31_000);
  await f.control.tick();
  const triage = f.store
    .list<Session>('sessions')
    .find((session) => session.resident?.kind === 'triage')!;
  return trackerTurns(f, triage.id)[0]!;
}

async function answerWake() {
  const f = await workbenchFixture();
  const planner = await f.create('Plan the export feature');
  await settle(f, planner);
  const owner = lead(f, planner.id);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export files',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'format',
          title: 'format',
          goal: 'Export files',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/format'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    owner,
  );
  const plan = f.store.must<BoardPlan>('board_plans', planner.id);
  f.store.update<BoardPlan>('board_plans', { ...plan, inbox: [] }, plan.revision);
  const card = f.call<{ id: string }>(
    'lead.ask',
    {
      project_id: f.project.id,
      question: 'Which export format?',
      options: ['CSV', 'JSON'],
      recommended: 'CSV',
      assumption: 'Build the rest while the format is undecided.',
      blocks: ['format'],
    },
    null,
    owner,
  );
  f.call('lead.question.answer', {
    project_id: f.project.id,
    lead_session_id: planner.id,
    question_id: card.id,
    answer: 'JSON',
  });
  return trackerTurns(f, planner.id)[0]!;
}

it.each([
  {
    via: 'a routine timer',
    wake: async () => {
      const { turn, routineId } = await routineWake();
      return { turn, expected: { causes: ['routine'], routine_ids: [routineId] } };
    },
  },
  {
    via: 'a follow-up timer',
    wake: async () => ({ turn: await followUpWake(), expected: { causes: ['follow_up'] } }),
  },
  {
    via: 'a signal that interrupts',
    wake: async () => ({ turn: await signalWake(), expected: { causes: ['signal'] } }),
  },
  {
    via: "the user's answer to a lead question",
    wake: async () => ({ turn: await answerWake(), expected: { causes: ['answer'] } }),
  },
])('records on the turn that $via queued why it woke the agent', async ({ wake }) => {
  const { turn, expected } = await wake();
  expect(turn.wake).toEqual(expected);
});

it('merges the causes of a board note folded into a queued routine wake', async () => {
  const { f, ctx, assistant, as, advance } = await assistantFixture();
  const routine = as<{ id: string }>('agent.routine.set', {
    prompt: 'Look for stalled tasks',
    every_minutes: 60,
    enabled: true,
  });
  const running = f.call<SessionTurn>(
    'session.send',
    {
      session_id: assistant.id,
      input: `fixture-script\n${JSON.stringify([{ hang: true }])}`,
    },
    f.store.must<Session>('sessions', assistant.id).revision,
  );
  await eventually(
    () => f.store.must<SessionTurn>('session_turns', running.id).state === 'running',
    () => f.control.tick(),
  );
  advance(60 * MINUTE);
  await f.control.tick();
  const [queued] = trackerTurns(f, assistant.id);
  expect(queued).toMatchObject({ state: 'queued', wake: { causes: ['routine'] } });

  const plan = appendNote(ctx, residentPlan(ctx, f.store.must<Session>('sessions', assistant.id)), {
    at: f.store.now(),
    session_id: '',
    task_id: '',
    kind: 'risk',
    text: 'Exports may time out',
  });
  wakeLead(ctx, plan, '');
  const folded = trackerTurns(f, assistant.id);
  expect(folded).toHaveLength(1);
  expect(folded[0]!.lead_note_ids).toHaveLength(2);
  expect(folded[0]!.wake).toEqual({ causes: ['routine', 'risk'], routine_ids: [routine.id] });
});

it('leaves a user turn that carries inbox notes without a wake', async () => {
  const { f, ctx, assistant } = await assistantFixture();
  appendNote(ctx, residentPlan(ctx, assistant), {
    at: f.store.now(),
    session_id: '',
    task_id: '',
    kind: 'risk',
    text: 'Exports may time out',
  });
  const sent = f.call<SessionTurn>(
    'session.send',
    { session_id: assistant.id, input: 'Keep going' },
    f.store.must<Session>('sessions', assistant.id).revision,
  );
  expect(sent.lead_note_ids).toHaveLength(1);
  expect(sent).not.toHaveProperty('wake');
});
