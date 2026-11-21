import { expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  Approval,
  BoardPlan,
  LeadNote,
  LeadQuestion,
  MemoryRecord,
  Principal,
  Session,
  SessionTurn,
  WorkflowPolicy,
} from '@pantheon/domain';
import type { PersonalAnswerKind } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { INBOX_HEADER } from '../../packages/control/dist/lead-inbox.js';
import { awaitWorkspaceReady, eventually, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type PlanTask = BoardPlan['tasks'][number];
type Citation = NonNullable<LeadQuestion['citations']>[number];

const ctxOf = (f: Fixture) => (f.control as unknown as { ctx: ControlContext }).ctx;

const leadOf = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

const request = 'Plan the export feature; finance opens the files in spreadsheets';

const task: PlanTask = {
  id: 'a',
  title: 'Task a',
  goal: 'Finish task a',
  lane: 'core',
  depends_on: [],
  source: [request],
  scope: ['src/a'],
  acceptance: ['pnpm test'],
};

const assumption = 'Exports are CSV files';

function setPolicy(f: Fixture, input: Record<string, unknown>) {
  const row = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id);
  f.call('workflow.policy.set', { project_id: f.project.id, ...input }, row?.revision ?? null);
}

/** Runs a session's first turn until the runtime took it; the turn then stays running. */
async function running(f: Fixture, session: Session) {
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const turn = f.turns(session.id)[0]!;
  await eventually(
    () =>
      f.control.handles.has(turn.id) &&
      f.store.must<Session>('sessions', session.id).state === 'running',
    () => f.control.tick(),
  );
  return { turn, handle: f.control.handles.get(turn.id)! };
}

/**
 * A lead with a one-task plan and a worker of that task running a turn; with a requester, the task
 * quotes a request it sent to the lead instead of the lead's first message.
 */
async function workerFixture(policy?: Record<string, unknown>, requester?: Principal) {
  const f = await workbenchFixture({ userConfig: true });
  const lead = await f.create(requester ? 'Plan the export feature' : request);
  await settle(f, lead);
  if (requester) {
    const sent = f.call<{ session_id: string }>(
      'request.send',
      {
        project_id: f.project.id,
        input: request,
        target: { kind: 'session', session_id: lead.id },
      },
      null,
      requester,
    );
    await eventually(
      () =>
        f.store.must<Session>('sessions', sent.session_id).state === 'open' &&
        f.turns(sent.session_id).every((turn) => !['queued', 'running'].includes(turn.state)),
      () => f.control.tick(),
    );
  }
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [task],
      milestones: [],
      risks: [],
      assumptions: [{ text: assumption }],
    },
    null,
    leadOf(f, lead.id),
  );
  if (policy) setPolicy(f, policy);
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const answer = vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const worker = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Build it',
    task_id: `${lead.id}:${task.id}`,
  });
  const { turn, handle } = await running(f, worker);
  return { f, lead, worker, answer, handle, prompt: prompter(f, worker, turn) };
}

/** Feeds the session's runtime permission requests into the daemon; returns the stored request. */
function prompter(f: Fixture, session: Session, turn: SessionTurn) {
  let sequence = 100;
  return (tool: string, detail: unknown) => {
    sequence++;
    agentEvent(ctxOf(f), session.id, {
      key: `prompt-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: `request-${sequence}`,
      tool,
      detail,
    } as AgentEvent);
    return f.store.list<Approval>('approvals').at(-1)!;
  };
}

const formatQuestion = 'Which format should the export use?';

const question = {
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
};

const answers = { [formatQuestion]: 'CSV' };

const boardQuestion = (f: Fixture, leadId: string, approvalId: string) =>
  f.store
    .must<BoardPlan>('board_plans', leadId)
    .questions!.find((entry) => entry.source?.approval_id === approvalId)!;

const questionItems = (f: Fixture) =>
  f.control
    .needsYou(user, f.project.id)
    .items.filter((item) => String(item.kind) === 'lead.question');

const powerUses = (f: Fixture) =>
  f.store
    .kindEvents(f.project.id, ['charter.power_used'])
    .filter((event) => (event.payload as { power: string }).power === 'answer_worker_questions');

/** The notes left for the lead, of one kind, oldest first. */
const notes = (f: Fixture, leadId: string, kind: LeadNote['kind']) =>
  f.store
    .kindEvents(f.project.id, ['lead.note_added'])
    .filter((event) => event.aggregate_id === leadId)
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === kind);

const trackerTurns = (f: Fixture, leadId: string) =>
  f.turns(leadId).filter((turn) => turn.origin === 'tracker').length;

/** The error code a refused call gives, as the daemon answers it; 'answered' when it went through. */
const outcome = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    // The daemon answers a schema refusal with invalid_input.
    return (error as Error).name === 'ZodError'
      ? 'invalid_input'
      : (error as { code?: string }).code;
  }
  return 'answered';
};

const leadAnswers = (f: Fixture, leadId: string, questionId: string, citations: Citation[]) =>
  f.call(
    'lead.worker_question.answer',
    { project_id: f.project.id, question_id: questionId, answers, citations },
    null,
    leadOf(f, leadId),
  );

/** A current project memory note; returns its id. */
function memoryNote(f: Fixture): string {
  const draft = f.call<MemoryRecord>('memory.propose', {
    project_id: f.project.id,
    key: 'export-format',
    kind: 'note',
    text: 'Finance imports exports into spreadsheets, so they are CSV',
  });
  return f.call<MemoryRecord>('memory.commit', { memory_id: draft.id }, draft.revision).id;
}

const personal: Principal = { id: 'personal:k1', role: 'personal' };

/** Lets the user's personal agent answer decisions of these kinds. */
const allowPersonal = (f: Fixture, kinds: PersonalAnswerKind[]) =>
  f.call('app.settings.set', { personal_answers: kinds });

/** A question the lead asked the user and `by` answered; returns its id. */
function earlierAnswer(f: Fixture, leadId: string, by: Principal = user): string {
  const asked = f.call<LeadQuestion>(
    'lead.ask',
    {
      project_id: f.project.id,
      question: 'Should exports include archived rows?',
      options: ['Yes', 'No'],
      recommended: 'No',
      assumption: 'Archived rows stay out',
      blocks: [],
    },
    null,
    leadOf(f, leadId),
  );
  f.call(
    'lead.question.answer',
    { project_id: f.project.id, lead_session_id: leadId, question_id: asked.id, answer: 'No' },
    null,
    by,
  );
  return asked.id;
}

type Cite = (f: Fixture, leadId: string) => Citation[];
const userWords: Cite = () => [
  { kind: 'user_words', ref: 'finance opens the files in spreadsheets' },
];

/** The lead proposes a plan change and `by` rejects it giving the task's user words as the reason. */
function rejectWithUserWords(f: Fixture, leadId: string, by: Principal): Citation[] {
  const { proposal_id } = f.call<{ proposal_id: string }>(
    'board.plan.propose',
    {
      project_id: f.project.id,
      base_version: f.store.must<BoardPlan>('board_plans', leadId).plan_version,
      reason: 'Task a reads better as the export task',
      ops: [{ type: 'set_task', task_id: 'a', patch: { title: 'Export task' } }],
    },
    null,
    leadOf(f, leadId),
  );
  f.call(
    'board.plan.proposal.resolve',
    {
      project_id: f.project.id,
      lead_session_id: leadId,
      proposal_id,
      decision: 'reject',
      reason: 'finance opens the files in spreadsheets',
    },
    null,
    by,
  );
  return userWords(f, leadId);
}

/** A turn of the user's personal agent on the lead with `words` and a board updates digest after them. */
function keyTurnWithDigest(f: Fixture, leadId: string, words: string) {
  f.store.insert<SessionTurn>('session_turns', {
    id: `key-turn-${f.turns(leadId).length}`,
    revision: 1,
    project_id: f.project.id,
    session_id: leadId,
    input: `${words}\n\n${INBOX_HEADER}\n<note kind="user_edit" id="n1">\nWhat happened: the user changed your plan:\n- add task b "Task b" quoting: ${request}\n</note>`,
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    via: { kind: 'personal', key_id: 'k1' },
  });
}

it.each<[string, Record<string, unknown> | undefined, Cite, string]>([
  ['the user words of the task', undefined, userWords, 'answered'],
  ['a plan assumption', undefined, () => [{ kind: 'assumption', ref: assumption }], 'answered'],
  [
    'a current memory entry',
    undefined,
    (f) => [{ kind: 'memory', ref: memoryNote(f) }],
    'answered',
  ],
  [
    'an earlier answer',
    undefined,
    (f, leadId) => [{ kind: 'earlier_answer', ref: earlierAnswer(f, leadId) }],
    'answered',
  ],
  [
    "an earlier answer of the user's personal agent",
    undefined,
    (f, leadId) => {
      allowPersonal(f, ['question']);
      return [{ kind: 'earlier_answer', ref: earlierAnswer(f, leadId, personal) }];
    },
    'invalid_input',
  ],
  [
    'the user words the user also gave as the reason to reject a plan change',
    { plan_changes: 'confirm' },
    (f, leadId) => rejectWithUserWords(f, leadId, user),
    'answered',
  ],
  [
    "the user words the user's personal agent gave as the reason to reject a plan change",
    { plan_changes: 'confirm' },
    (f, leadId) => {
      allowPersonal(f, ['plan_change']);
      return rejectWithUserWords(f, leadId, personal);
    },
    'invalid_input',
  ],
  [
    "the user words a digest after a turn of the user's personal agent repeats",
    undefined,
    (f, leadId) => {
      keyTurnWithDigest(f, leadId, 'What is left on the export?');
      return userWords(f, leadId);
    },
    'answered',
  ],
  [
    "the user words a turn of the user's personal agent says ahead of its digest",
    undefined,
    (f, leadId) => {
      keyTurnWithDigest(f, leadId, 'Remember finance opens the files in spreadsheets');
      return userWords(f, leadId);
    },
    'invalid_input',
  ],
  ['no citation', undefined, () => [], 'invalid_input'],
  [
    'a quote the task source does not contain',
    undefined,
    () => [{ kind: 'user_words', ref: 'finance prefers JSON' }],
    'invalid_input',
  ],
  [
    'an unknown memory id',
    undefined,
    () => [{ kind: 'memory', ref: 'no-such-memory' }],
    'invalid_input',
  ],
  [
    'the user words while the charter asks the user first',
    { charter: { answer_worker_questions: 'ask' } },
    userWords,
    'permission_denied',
  ],
  [
    'the user words while the charter withholds the power',
    { charter: { answer_worker_questions: 'off' } },
    userWords,
    'permission_denied',
  ],
])("answers a task session's question citing %s", async (_label, policy, cite, expected) => {
  const { f, lead, answer, handle, prompt } = await workerFixture(policy);
  const approval = prompt('AskUserQuestion', question);
  const card = boardQuestion(f, lead.id, approval.id);
  const citations = cite(f, lead.id);
  expect(outcome(() => leadAnswers(f, lead.id, card.id, citations))).toBe(expected);
  await f.control.tick();
  const row = f.store.must<Approval>('approvals', approval.id);
  if (expected === 'answered') {
    expect(row).toMatchObject({
      state: 'approved',
      decider: 'lead',
      decided_by: `session:${lead.id}`,
      answers,
    });
    expect(answer).toHaveBeenCalledWith(handle, approval.request_id, 'allow', answers);
    expect(boardQuestion(f, lead.id, approval.id)).toMatchObject({
      answer: { text: 'CSV' },
      answered_by: 'lead',
      citations,
    });
    expect(powerUses(f)).toHaveLength(1);
    expect(powerUses(f)[0]!.payload).toMatchObject({ mode: 'on', session_id: lead.id });
    expect(questionItems(f)).toEqual([]);
    return;
  }
  expect(row).toMatchObject({ state: 'pending', decider: 'user' });
  expect(answer).not.toHaveBeenCalled();
  expect(boardQuestion(f, lead.id, approval.id)).not.toHaveProperty('answer');
  expect(powerUses(f)).toHaveLength(0);
  expect(questionItems(f).map((item) => item.request_id)).toEqual([card.id]);
});

it.each<[string, Principal, boolean]>([['the user', user, true]])(
  'lets the lead cite the words of a request %s sent only when the user sent it',
  async (_label, requester, resolves) => {
    const { f, lead, prompt } = await workerFixture(undefined, requester);
    const approval = prompt('AskUserQuestion', question);
    const card = boardQuestion(f, lead.id, approval.id);
    const send = () => leadAnswers(f, lead.id, card.id, userWords(f, lead.id));
    if (resolves) send();
    else
      expect(send).toThrow(
        'Citation user_words "finance opens the files in spreadsheets" does not resolve',
      );
    expect(f.store.must<Approval>('approvals', approval.id).state).toBe(
      resolves ? 'approved' : 'pending',
    );
  },
);

it("tells the lead of a task session's question at once and keeps it listed for the user", async () => {
  const { f, lead, worker, prompt } = await workerFixture();
  const approval = prompt('AskUserQuestion', question);
  const card = boardQuestion(f, lead.id, approval.id);
  const asked = notes(f, lead.id, 'worker_question');
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ question_id: card.id, task_id: 'a', session_id: worker.id });
  expect(asked[0]!.text).toContain(formatQuestion);
  const wake = f.turns(lead.id).find((turn) => turn.lead_note_ids?.includes(asked[0]!.id!));
  expect(wake).toMatchObject({
    origin: 'tracker',
    wake: { causes: expect.arrayContaining(['worker_question']) },
  });
  expect(wake!.input).toContain(`Task a "Task a" asks: ${formatQuestion}`);
  expect(questionItems(f).map((item) => item.request_id)).toEqual([card.id]);
});

it('leaves the lead untold while the charter asks the user first', async () => {
  const { f, lead, prompt } = await workerFixture({
    charter: { answer_worker_questions: 'ask' },
  });
  const before = trackerTurns(f, lead.id);
  const approval = prompt('AskUserQuestion', question);
  expect(notes(f, lead.id, 'worker_question')).toEqual([]);
  expect(trackerTurns(f, lead.id)).toBe(before);
  expect(questionItems(f).map((item) => item.request_id)).toEqual([
    boardQuestion(f, lead.id, approval.id).id,
  ]);
});

it('refuses the lead once the user answered the question first', async () => {
  const { f, lead, prompt } = await workerFixture();
  const approval = prompt('AskUserQuestion', question);
  const card = boardQuestion(f, lead.id, approval.id);
  f.call('lead.question.answer', {
    project_id: f.project.id,
    lead_session_id: lead.id,
    question_id: card.id,
    answer: 'JSON',
  });
  expect(outcome(() => leadAnswers(f, lead.id, card.id, userWords(f, lead.id)))).toBe(
    'invalid_state',
  );
  expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
    state: 'approved',
    decided_by: user.id,
    answers: { [formatQuestion]: 'JSON' },
  });
  expect(boardQuestion(f, lead.id, approval.id)).not.toHaveProperty('answered_by');
});

it("refuses a lead the question of another lead's task session", async () => {
  const { f, lead, prompt } = await workerFixture();
  const approval = prompt('AskUserQuestion', question);
  const card = boardQuestion(f, lead.id, approval.id);
  const other = await f.create('Plan the import feature');
  await awaitWorkspaceReady(f.control, other.workspace_id!);
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Import ships next week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [{ ...task, source: ['Plan the import feature'] }],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    leadOf(f, other.id),
  );
  expect(
    outcome(() =>
      leadAnswers(f, other.id, card.id, [{ kind: 'user_words', ref: 'Plan the import feature' }]),
    ),
  ).toBe('not_found');
  expect(f.store.must<Approval>('approvals', approval.id).state).toBe('pending');
});

it('refuses an answer to a question the lead asked the user itself', async () => {
  const { f, lead } = await workerFixture();
  const asked = f.call<LeadQuestion>(
    'lead.ask',
    {
      project_id: f.project.id,
      question: 'Should exports include archived rows?',
      options: ['Yes', 'No'],
      recommended: 'No',
      assumption: 'Archived rows stay out',
      blocks: [],
    },
    null,
    leadOf(f, lead.id),
  );
  expect(outcome(() => leadAnswers(f, lead.id, asked.id, userWords(f, lead.id)))).toBe(
    'invalid_input',
  );
  expect(
    f.store.must<BoardPlan>('board_plans', lead.id).questions!.find((q) => q.id === asked.id),
  ).not.toHaveProperty('answer');
});

it('adds no permission wait note for a question the lead was told of', async () => {
  const { f, lead, prompt } = await workerFixture();
  prompt('AskUserQuestion', question);
  await f.control.tick();
  await f.control.tick();
  expect(notes(f, lead.id, 'waiting')).toEqual([]);
});
