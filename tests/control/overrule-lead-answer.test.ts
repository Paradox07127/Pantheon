import { expect, it, vi } from 'vitest';
import {
  id,
  type AgentEvent,
  type Approval,
  type BoardPlan,
  type LeadNote,
  type Principal,
  type Session,
  type SessionTurn,
  type WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, settle } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;

const sessionPrincipal = (f: Fixture, sessionId: string, role: 'lead' | 'worker'): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const request = 'Plan the export feature; finance opens the files in spreadsheets';
const formatQuestion = 'Which format should the export use?';

/** A lead with a one-task plan, a worker of that task running a turn, and the worker's question on the board. */
async function askedFixture() {
  const f = await workbenchFixture();
  const lead = await f.create(request);
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Task a',
          goal: 'Finish task a',
          lane: 'core',
          depends_on: [],
          source: [request],
          scope: ['src/a'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    sessionPrincipal(f, lead.id, 'lead'),
  );
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const worker = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:a`,
  });
  await awaitWorkspaceReady(f.control, worker.workspace_id!);
  const turn = f.turns(worker.id)[0]!;
  await eventually(
    () =>
      f.control.handles.has(turn.id) &&
      f.store.must<Session>('sessions', worker.id).state === 'running',
    () => f.control.tick(),
  );
  agentEvent(ctxOf(f), worker.id, {
    key: 'question',
    provider_sequence: 100,
    turn_id: turn.id,
    kind: 'permission.requested',
    request_id: 'request-question',
    tool: 'AskUserQuestion',
    detail: {
      questions: [
        {
          question: formatQuestion,
          header: 'Format',
          options: [
            { label: 'CSV', description: 'Plain rows' },
            { label: 'JSON', description: 'Nested records' },
          ],
          multiSelect: false,
        },
      ],
    },
  } as AgentEvent);
  const approval = f.store.list<Approval>('approvals').at(-1)!;
  const card = f.store
    .must<BoardPlan>('board_plans', lead.id)
    .questions!.find((entry) => entry.source?.approval_id === approval.id)!;
  return { f, lead, worker, turn, card };
}

type Asked = Awaited<ReturnType<typeof askedFixture>>;

const citations = [{ kind: 'user_words', ref: 'finance opens the files in spreadsheets' }];

const leadAnswers = ({ f, lead, card }: Asked) =>
  f.call(
    'lead.worker_question.answer',
    {
      project_id: f.project.id,
      question_id: card.id,
      answers: { [formatQuestion]: 'CSV' },
      citations,
    },
    null,
    sessionPrincipal(f, lead.id, 'lead'),
  );

const overrule = ({ f, lead, card }: Asked, principal?: Principal) =>
  f.call(
    'lead.question.overrule',
    { project_id: f.project.id, lead_session_id: lead.id, question_id: card.id, answer: 'JSON' },
    null,
    principal,
  );

const boardQuestion = ({ f, lead, card }: Asked) =>
  f.store.must<BoardPlan>('board_plans', lead.id).questions!.find((entry) => entry.id === card.id)!;

const answerNotes = ({ f, lead }: Asked) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === lead.id)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === 'answer');

/** The error code a refused call gives; 'overruled' when it went through. */
const outcome = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'overruled';
};

/** Ends the worker's running turn through its runtime, so it waits for input. */
async function idle({ f, worker, turn }: Asked) {
  const [, emit] = f.start.mock.calls.find(([spec]) => spec.platform_session_id === worker.id)!;
  emit({
    key: 'turn-end',
    provider_sequence: 200,
    turn_id: turn.id,
    kind: 'turn.completed',
    status: 'completed',
  });
  await eventually(() => f.store.must<Session>('sessions', worker.id).state === 'open');
}

const workerRow = ({ f, worker }: Asked, fields: Partial<Session>) => {
  const row = f.store.must<Session>('sessions', worker.id);
  f.store.update('sessions', { ...row, ...fields }, row.revision);
};

/** Spends the project's whole budget with one ended turn of the worker. */
function overBudget({ f, worker }: Asked) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, project_budget: { input_tokens: 100 } },
    row?.revision ?? null,
  );
  // The spending turn must end after the budget started.
  vi.spyOn(f.store, 'now').mockImplementation(() => Date.now() + 1000);
  const spent = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: worker.id,
    input: 'work',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  } as SessionTurn);
  f.store.event('turn.completed', spent, f.project.id, {});
}

type Expected =
  { result: 'overruled'; sessionTold: boolean; leadWoken: boolean } | { result: string };

it.each<[string, (asked: Asked) => unknown, Expected]>([
  [
    'a lead answer while the task session waits for input',
    async (asked) => {
      leadAnswers(asked);
      await idle(asked);
    },
    { result: 'overruled', sessionTold: true, leadWoken: true },
  ],
  [
    'a lead answer while the task session still runs its turn',
    leadAnswers,
    { result: 'overruled', sessionTold: true, leadWoken: true },
  ],
  [
    'a lead answer after the task session closed',
    (asked) => {
      leadAnswers(asked);
      workerRow(asked, { state: 'closed' });
    },
    { result: 'overruled', sessionTold: false, leadWoken: true },
  ],
  [
    'a lead answer after the task session merged',
    async (asked) => {
      leadAnswers(asked);
      await idle(asked);
      workerRow(asked, { outcome: 'merged' });
    },
    { result: 'overruled', sessionTold: false, leadWoken: true },
  ],
  [
    'a lead answer while the project is over its budget',
    async (asked) => {
      leadAnswers(asked);
      await idle(asked);
      overBudget(asked);
    },
    { result: 'overruled', sessionTold: false, leadWoken: false },
  ],
  [
    'a user answer',
    ({ f, lead, card }) =>
      f.call('lead.question.answer', {
        project_id: f.project.id,
        lead_session_id: lead.id,
        question_id: card.id,
        answer: 'CSV',
      }),
    { result: 'invalid_state' },
  ],
  ['no answer yet', () => {}, { result: 'invalid_state' }],
])('overrules a task session question with %s', async (_label, setup, expected) => {
  const asked = await askedFixture();
  const { f, lead, worker } = asked;
  await setup(asked);
  const before = boardQuestion(asked),
    workerTurns = f.turns(worker.id).length;
  expect(outcome(() => overrule(asked))).toBe(expected.result);
  const told = f.turns(worker.id).slice(workerTurns),
    notes = answerNotes(asked);
  if (!('sessionTold' in expected)) {
    expect(boardQuestion(asked)).toEqual(before);
    expect(told).toEqual([]);
    expect(notes).toEqual([]);
    return;
  }
  expect(boardQuestion(asked)).toMatchObject({
    answered_by: 'user',
    citations,
    answer: { text: 'JSON', overruled: { text: 'CSV', at: before.answer!.at } },
  });
  expect(told).toHaveLength(expected.sessionTold ? 1 : 0);
  if (expected.sessionTold)
    expect(told[0]!.input).toMatch(
      /^\[Pantheon\] The user changed the answer to your question "Which format should the export use\?": "CSV" is now "JSON"\./,
    );
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({
    question_id: asked.card.id,
    answer: 'JSON',
    session_id: worker.id,
    task_id: 'a',
  });
  const wake = f.turns(lead.id).find((turn) => turn.lead_note_ids?.includes(notes[0]!.id!));
  const inbox = f.store.must<BoardPlan>('board_plans', lead.id).inbox;
  if (!expected.leadWoken) {
    expect(wake).toBeUndefined();
    expect(inbox.map((note) => note.id)).toContain(notes[0]!.id);
    return;
  }
  expect(wake).toMatchObject({
    origin: 'tracker',
    wake: { causes: expect.arrayContaining(['answer']) },
  });
  expect(wake!.input).toContain(
    `the user overruled your answer to "${formatQuestion}": you answered "CSV", the user says "JSON".`,
  );
  expect(wake!.input).toContain(
    expected.sessionTold
      ? 'Pantheon sent the task session the new answer'
      : 'tell the task session what changes',
  );
});

it.each(['lead', 'worker'] as const)('refuses a %s principal the overrule', async (role) => {
  const asked = await askedFixture();
  leadAnswers(asked);
  const principal = sessionPrincipal(
    asked.f,
    role === 'lead' ? asked.lead.id : asked.worker.id,
    role,
  );
  expect(outcome(() => overrule(asked, principal))).toBe('permission_denied');
  expect(boardQuestion(asked)).toMatchObject({ answered_by: 'lead', answer: { text: 'CSV' } });
  expect(answerNotes(asked)).toEqual([]);
});
