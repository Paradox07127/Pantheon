import { expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Approval,
  BoardPlan,
  LeadNote,
  LeadQuestion,
  Principal,
  Session,
  Timer,
  WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const HOUR = 60 * 60_000;
const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;
const planOf = (f: Fixture, id: string) => f.store.must<BoardPlan>('board_plans', id);
const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 1000 * HOUR,
});

/** An idle lead whose plan holds the tasks, each in one lane with its own directory. */
async function plannedLead(f: Fixture, taskIds: string[]) {
  const lead = await f.create('Plan the export feature');
  await settle(f, lead);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export files',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: taskIds.map((id) => ({
        id,
        title: id,
        goal: 'Export files',
        lane: 'core',
        depends_on: [],
        source: ['Plan the export feature'],
        scope: [`src/${id}`],
        acceptance: ['pnpm test'],
      })),
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, lead.id),
  );
  return lead;
}

const ask = (
  f: Fixture,
  leadId: string,
  question: string,
  fields: { blocks?: string[]; reversible?: boolean } = {},
) =>
  f.call<LeadQuestion>(
    'lead.ask',
    {
      project_id: f.project.id,
      question,
      options: ['Yes', 'No'],
      recommended: 'Yes',
      assumption: 'Yes',
      blocks: [],
      ...fields,
    },
    null,
    leadOf(f, leadId),
  );

function setPolicy(f: Fixture, input: Record<string, unknown>) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call('workflow.policy.set', { project_id: f.project.id, ...input }, row?.revision ?? null);
}

const answerBatch = (f: Fixture, leadId: string, answers: Record<string, unknown>[]) =>
  f.call<LeadQuestion[]>('lead.questions.answer_batch', {
    project_id: f.project.id,
    lead_session_id: leadId,
    answers,
  });

const answeredEvents = (f: Fixture) => f.store.kindEvents(f.project.id, ['lead.question_answered']);
const trackerTurns = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker');
const defaultTimers = (f: Fixture) =>
  f.store.list<Timer>('timers').filter((timer) => timer.kind === 'question-default');
const answerNotes = (f: Fixture, leadId: string) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === leadId)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === 'answer');

/** Moves the store clock only when advanced. */
function clock(f: Fixture) {
  let now = f.store.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  return (ms: number) => (now += ms);
}

it('answers three questions of a plan in one command with three events and wakes the lead once', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a', 'b']);
  const questions = ['Use CSV?', 'Add a header row?', 'Zip the files?'].map((text) =>
    ask(f, lead.id, text),
  );

  const answered = answerBatch(
    f,
    lead.id,
    questions.map((question, index) => ({
      question_id: question.id,
      answer: index ? 'No' : 'Yes',
    })),
  );

  expect(answered.map((question) => question.answer!.text)).toEqual(['Yes', 'No', 'No']);
  expect(answeredEvents(f).map((event) => (event.payload as LeadQuestion).id)).toEqual(
    questions.map((question) => question.id),
  );
  expect(answerNotes(f, lead.id).map((note) => note.question_id)).toEqual(
    questions.map((question) => question.id),
  );
  expect(trackerTurns(f, lead.id)).toHaveLength(1);
  expect(planOf(f, lead.id).questions!.every((question) => question.answer)).toBe(true);
});

it('refuses a batch that holds an answered question and answers none of it', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  const first = ask(f, lead.id, 'Use CSV?'),
    second = ask(f, lead.id, 'Add a header row?');
  answerBatch(f, lead.id, [{ question_id: second.id, answer: 'No' }]);

  expect(() =>
    answerBatch(f, lead.id, [
      { question_id: first.id, answer: 'Yes' },
      { question_id: second.id, answer: 'Yes' },
    ]),
  ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
  expect(planOf(f, lead.id).questions!.find((question) => question.id === first.id)!.answer).toBe(
    undefined,
  );
  expect(answeredEvents(f)).toHaveLength(1);
});

it('gives a reversible question no default while question defaults are off', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  const advance = clock(f);
  const question = ask(f, lead.id, 'Use CSV?', { blocks: ['a'], reversible: true });

  advance(1000 * HOUR);
  await f.control.tick();

  expect(question).not.toHaveProperty('default_after_ms');
  expect(defaultTimers(f)).toEqual([]);
  expect(planOf(f, lead.id).questions![0]!.answer).toBe(undefined);
});

it('applies the recommended answer of a reversible question once its deadline passes', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  setPolicy(f, { question_defaults: { after_hours: 8 } });
  const advance = clock(f);
  const reversible = ask(f, lead.id, 'Use CSV?', { blocks: ['a'], reversible: true }),
    fixed = ask(f, lead.id, 'Delete the old exports?');

  expect(reversible.default_after_ms).toBe(8 * HOUR);
  expect(defaultTimers(f).map((timer) => timer.subject_id)).toEqual([reversible.id]);
  advance(7 * HOUR);
  await f.control.tick();
  expect(planOf(f, lead.id).questions![0]!.answer).toBe(undefined);

  advance(2 * HOUR);
  await f.control.tick();
  const [defaulted, untouched] = planOf(f, lead.id).questions!;
  expect(defaulted).toMatchObject({ answered_by: 'default', answer: { text: 'Yes' } });
  expect(untouched!.id).toBe(fixed.id);
  expect(untouched!.answer).toBe(undefined);
  expect(answerNotes(f, lead.id)).toMatchObject([{ question_id: reversible.id, answer: 'Yes' }]);
  // A wake the idle lead refuses while its runtime closes is tried again on a later tick.
  await eventually(
    () => trackerTurns(f, lead.id).length > 0,
    () => f.control.tick(),
  );
  const wake = trackerTurns(f, lead.id);
  expect(wake).toHaveLength(1);
  expect(wake[0]!.input).toContain(
    'the user did not answer your question "Use CSV?" before its deadline, so your recommended answer "Yes" applies.',
  );
});

it('cancels the default when the user answers before the deadline', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  setPolicy(f, { question_defaults: { after_hours: 8 } });
  const advance = clock(f);
  const question = ask(f, lead.id, 'Use CSV?', { reversible: true });

  answerBatch(f, lead.id, [{ question_id: question.id, answer: 'No' }]);
  advance(9 * HOUR);
  await f.control.tick();

  expect(defaultTimers(f).map((timer) => timer.state)).toEqual(['cancelled']);
  expect(planOf(f, lead.id).questions![0]).toMatchObject({ answer: { text: 'No' } });
  expect(planOf(f, lead.id).questions![0]).not.toHaveProperty('answered_by');
});

it('applies no default once the user turned question defaults off before the deadline', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  setPolicy(f, { question_defaults: { after_hours: 8 } });
  const advance = clock(f);
  ask(f, lead.id, 'Use CSV?', { reversible: true });

  setPolicy(f, { question_defaults: null });
  advance(9 * HOUR);
  await f.control.tick();

  expect(planOf(f, lead.id).questions![0]!.answer).toBe(undefined);
  expect(answeredEvents(f)).toEqual([]);
});

const keepOpen = (f: Fixture, leadId: string, questionId: string, principal?: Principal) =>
  f.call(
    'lead.question.keep_open',
    { project_id: f.project.id, lead_session_id: leadId, question_id: questionId },
    null,
    principal,
  );

it('keeps a reversible question waiting for the user past its deadline once the user keeps it open', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  setPolicy(f, { question_defaults: { after_hours: 8 } });
  const advance = clock(f);
  const question = ask(f, lead.id, 'Use CSV?', { reversible: true });

  expect(() => keepOpen(f, lead.id, question.id, leadOf(f, lead.id))).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  keepOpen(f, lead.id, question.id);
  expect(planOf(f, lead.id).questions![0]).not.toHaveProperty('default_after_ms');
  advance(9 * HOUR);
  await f.control.tick();

  expect(defaultTimers(f).map((timer) => timer.state)).toEqual(['cancelled']);
  expect(planOf(f, lead.id).questions![0]!.answer).toBe(undefined);
  expect(answeredEvents(f)).toEqual([]);
});

it('refuses to keep an answered question open', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  const question = ask(f, lead.id, 'Use CSV?', { reversible: true });
  answerBatch(f, lead.id, [{ question_id: question.id, answer: 'No' }]);

  expect(() => keepOpen(f, lead.id, question.id)).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
});

it('lists a recommended answer applied at its deadline among the decisions made for the user, who can overrule it', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  setPolicy(f, { question_defaults: { after_hours: 8 } });
  const advance = clock(f);
  const question = ask(f, lead.id, 'Use CSV?', { blocks: ['a'], reversible: true });
  advance(9 * HOUR);
  await f.control.tick();
  const answers = () =>
    f.control
      .decisionsForUser(user, f.project.id)
      .items.filter((item) => item.kind === 'question_answered');
  const row = {
    kind: 'question_answered',
    answered_by: 'default',
    lead_session_id: lead.id,
    question_id: question.id,
    question: 'Use CSV?',
    answer: 'Yes',
    citations: [],
  };
  expect(answers()).toEqual([expect.objectContaining(row)]);
  await eventually(
    () => trackerTurns(f, lead.id).length > 0,
    () => f.control.tick(),
  );
  const wakes = trackerTurns(f, lead.id).length;

  f.call('lead.question.overrule', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    question_id: question.id,
    answer: 'No',
  });

  expect(planOf(f, lead.id).questions![0]).toMatchObject({
    answered_by: 'user',
    answer: { text: 'No', overruled: { text: 'Yes' } },
  });
  expect(answers()).toEqual([
    expect.objectContaining({ ...row, overruled: { answer: 'No', at: expect.any(Number) } }),
  ]);
  expect(answerNotes(f, lead.id).at(-1)).toMatchObject({ question_id: question.id, answer: 'No' });
  await eventually(
    () => trackerTurns(f, lead.id).length > wakes,
    () => f.control.tick(),
  );
  const wake = trackerTurns(f, lead.id).at(-1)!.input;
  expect(wake).toContain(
    'the user overruled your answer to "Use CSV?": you answered "Yes", the user says "No".',
  );
  expect(wake).toContain(
    "the user's answer replaces yours; fix anything in the plan built on yours.",
  );
});

const formatQuestion = 'Which format should the export use?';

it('settles a relayed worker question answered in a batch, which never gets a default', async () => {
  const f = await workbenchFixture();
  const lead = await plannedLead(f, ['a']);
  setPolicy(f, { question_defaults: { after_hours: 8 } });
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
    key: 'prompt-1',
    provider_sequence: 101,
    turn_id: turn.id,
    kind: 'permission.requested',
    request_id: 'request-1',
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
  const relayed = planOf(f, lead.id).questions!.find(
    (question) => question.source?.approval_id === approval.id,
  )!;
  const own = ask(f, lead.id, 'Use CSV?');
  expect(defaultTimers(f)).toEqual([]);

  answerBatch(f, lead.id, [
    { question_id: relayed.id, answer: 'JSON' },
    { question_id: own.id, answer: 'No' },
  ]);

  expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
    state: 'approved',
    answers: { [formatQuestion]: 'JSON' },
  });
  expect(answeredEvents(f)).toHaveLength(2);
});
