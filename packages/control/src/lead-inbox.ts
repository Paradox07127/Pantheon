import {
  type AgentEvent,
  type Approval,
  DomainError,
  id,
  requireThat,
  type BoardPlan,
  type LeadNote,
  type LeadQuestion,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { runtime } from './admission.js';
import { answerApproval } from './approvals.js';
import { buildHandoff } from './handoff.js';
import {
  nativeTurnActive,
  taskReportGeneration,
  unsnooze,
  withoutNativeConversation,
} from './session.js';
import { wakeLead } from './task-tracking.js';
import { taskRuntime } from './task-dispatch.js';
import { changeModel, workerInstructions } from './workbench-session.js';
import { causeTurn, chainDepth } from './progress.js';
import { retiredBinding } from './board-plan.js';

export const INBOX_HEADER = '[Pantheon] Board updates since your last message:';
/** Characters of one digest, so the notes leave most of the lead's turn input to everything else. */
export const DIGEST_BUDGET = 6000;
/** Characters of one note's text a digest shows before it cuts the rest. */
const NOTE_TEXT_LIMIT = 600;
// Five minutes catches repeated compression before useful work can refill a normal context window.
const COMPACTION_WINDOW_MS = 5 * 60_000;

/** Called for a deduplicated compaction, before its event is recorded. */
export function noteCompactionThrash(ctx: ControlContext, session: Session): void {
  if (!session.task) return;
  const compactions = ctx.store
    .kindEvents(session.project_id, ['agent.context.compacted'])
    .filter(
      (event) =>
        event.aggregate_id === session.id &&
        (event.payload as Extract<AgentEvent, { kind: 'context.compacted' }>).trigger !== 'manual',
    );
  const previous = compactions.at(-1);
  if (!previous || ctx.store.now() - previous.created_at > COMPACTION_WINDOW_MS) return;
  const plan = ctx.store.get<BoardPlan>('board_plans', session.task.lead_session_id);
  if (!plan || retiredBinding(plan, session)) return;
  appendNote(ctx, plan, {
    at: ctx.store.now(),
    session_id: session.id,
    task_id: session.task.id,
    kind: 'risk',
    text: `Compaction thrash: session ${session.id} has ${compactions.length + 1} compactions; its latest two were within five minutes. The session continues running.`,
  });
}

/** Pending compactions stay pending until the runtime accepts the turn carrying these instructions. */
export function compactionInstructions(
  ctx: ControlContext,
  sessionId: string,
): { text: string; sequence: number } | undefined {
  const session = ctx.store.must<Session>('sessions', sessionId);
  if (!session.task) return;
  const events = ctx.store
    .kindEvents(session.project_id, ['agent.context.compacted', 'session.context_restored'])
    .filter((event) => event.aggregate_id === session.id);
  const restored = events.findLast((event) => event.kind === 'session.context_restored')
    ?.payload as { compaction_sequence: number } | undefined;
  const pending = events.filter(
    (event) =>
      event.kind === 'agent.context.compacted' &&
      event.sequence > (restored?.compaction_sequence ?? 0),
  );
  if (!pending.length) return;
  const text = workerInstructions(ctx, session.task);
  return {
    text: pending.map(() => text).join('\n\n'),
    sequence: pending.at(-1)!.sequence,
  };
}

/**
 * The note with a new id and the depth of the turn it came from (a note without a session, the
 * lead's), kept as an event so read_note finds it after the inbox is taken.
 */
export function recordNote(
  ctx: ControlContext,
  plan: BoardPlan,
  note: LeadNote,
  cause = '',
): LeadNote {
  const recorded = {
    ...note,
    id: id(),
    causal_depth: chainDepth(ctx, causeTurn(ctx, note.session_id || plan.id), {
      lead_session_id: plan.id,
      id: note.task_id,
    }),
  };
  ctx.store.event('lead.note_added', plan, plan.project_id, recorded, cause);
  return recorded;
}

export function appendNote(
  ctx: ControlContext,
  plan: BoardPlan,
  note: LeadNote,
  cause = '',
): BoardPlan {
  return ctx.store.update(
    'board_plans',
    { ...plan, inbox: [...plan.inbox, recordNote(ctx, plan, note, cause)] },
    plan.revision,
  );
}

/** Characters of a user's message to a task session that a digest shows before it cuts the rest. */
const USER_MESSAGE_LIMIT = 200;

/** Leaves the task's lead a note of the user's message to a task session; it does not wake the lead. */
export function noteUserMessage(
  ctx: ControlContext,
  session: Session,
  turnId: string,
  text: string,
  cause: string,
): void {
  const plan = ctx.store.get<BoardPlan>('board_plans', session.task!.lead_session_id);
  if (!plan) return;
  appendNote(
    ctx,
    plan,
    {
      at: ctx.store.now(),
      session_id: session.id,
      task_id: session.task!.id,
      kind: 'user_message',
      text,
      turn_id: turnId,
    },
    cause,
  );
}

const generationText = (note: LeadNote) =>
  note.generation === undefined ? '' : ` (generation ${note.generation})`;

/** The closing line of a digest for the notes listed by id only and those left out. */
const closingLine = (folded: number, unlisted: number) =>
  [
    ...(folded ? [`${folded} more notes; read_note <id> reads each.`] : []),
    ...(unlisted
      ? [`${unlisted} notes past the size limit are not listed; they come with your next update.`]
      : []),
  ].join(' ');

/**
 * One line per note under a header line, all within the budget. A note is shown whole while the
 * id lines of the notes after it still fit; later notes get a line with their id only, and those
 * past the budget are counted in the closing line and returned as left.
 */
export function inboxDigest(
  ctx: ControlContext,
  plan: BoardPlan,
  notes: LeadNote[],
  budget = DIGEST_BUDGET,
): { text: string; left: LeadNote[] } {
  const idLines = notes.map(
      (note) => `- ${note.kind}: task ${note.task_id}${generationText(note)}, note ${note.id}`,
    ),
    // The characters the id lines of the notes from each index on take.
    after = new Array<number>(notes.length + 1).fill(0),
    // The longest closing line the counts of these notes can make.
    reserve = 1 + closingLine(notes.length, notes.length).length;
  for (let index = notes.length - 1; index >= 0; index--)
    after[index] = after[index + 1]! + (notes[index]!.id ? 1 + idLines[index]!.length : 0);
  const lines = [INBOX_HEADER],
    folded: string[] = [],
    left: LeadNote[] = [];
  let used = INBOX_HEADER.length,
    overflowed = false;
  const fits = (length: number, closing: boolean) =>
    used + length + (closing ? reserve : 0) <= budget;
  notes.forEach((note, index) => {
    const task = plan.tasks.find((candidate) => candidate.id === note.task_id)?.title,
      session = ctx.store.get<Session>('sessions', note.session_id)?.title,
      limit = note.kind === 'user_message' ? USER_MESSAGE_LIMIT : NOTE_TEXT_LIMIT,
      text =
        note.id && note.text.length > limit
          ? `${note.text.slice(0, limit)}… (${note.text.length} chars; read_note ${note.id} for the full text)`
          : note.text,
      line = `- ${note.task_id ? `${task ?? note.task_id}${generationText(note)} / ${session ?? note.session_id}: ` : ''}${note.kind}: ${text}${note.reason ? ` Reason: ${note.reason}.` : ''}${note.status ? ` Status: ${note.status}.` : ''}`,
      idLine = idLines[index]!;
    const last = index === notes.length - 1;
    // A note without an id cannot be read again, so it is shown whole whenever it fits.
    if (
      !note.id
        ? fits(1 + line.length, !last)
        : !overflowed && !folded.length && fits(1 + line.length + after[index + 1]!, !last)
    ) {
      lines.push(line);
      used += 1 + line.length;
    } else if (note.id && !overflowed && fits(1 + idLine.length, true)) {
      folded.push(idLine);
      used += 1 + idLine.length;
    } else {
      left.push(note);
      // Once an id line does not fit, the later notes with an id are left out too.
      if (note.id) overflowed = true;
    }
  });
  const closing = closingLine(folded.length, left.length);
  return { text: [...lines, ...folded, ...(closing ? [closing] : [])].join('\n'), left };
}

/** The plan's id and the ids it had before it was transferred to a new lead. */
function planIds(ctx: ControlContext, planId: string): string[] {
  const ids = [planId];
  for (let index = 0; index < ids.length; index++)
    for (const row of ctx.store.db
      .prepare("SELECT payload FROM events WHERE aggregate_id=? AND kind='board.plan_transferred'")
      .all(ids[index]!) as { payload: string }[])
      ids.push((JSON.parse(row.payload) as { from: string }).from);
  return ids;
}

/** Every note recorded for the plan, as recorded. */
function recordedNotes(ctx: ControlContext, planId: string): LeadNote[] {
  return planIds(ctx, planId)
    .flatMap(
      (id) =>
        ctx.store.db
          .prepare("SELECT payload FROM events WHERE aggregate_id=? AND kind='lead.note_added'")
          .all(id) as { payload: string }[],
    )
    .map((row) => JSON.parse(row.payload) as LeadNote);
}

/** Puts the notes that turns the lead never received had taken back at the front of its inbox. */
export function returnNotes(ctx: ControlContext, leadId: string, turns: SessionTurn[]): void {
  const taken = new Set(turns.flatMap((turn) => turn.lead_note_ids ?? []));
  const plan = ctx.store.get<BoardPlan>('board_plans', leadId);
  if (!plan || !taken.size) return;
  ctx.store.update(
    'board_plans',
    {
      ...plan,
      inbox: [...recordedNotes(ctx, plan.id).filter((note) => taken.has(note.id!)), ...plan.inbox],
    },
    plan.revision,
  );
}

/** Puts a question card on the plan for the user. */
export function askQuestion(
  ctx: ControlContext,
  plan: BoardPlan,
  fields: Omit<LeadQuestion, 'id' | 'at'>,
  cause = '',
): LeadQuestion {
  const question: LeadQuestion = { ...fields, id: id(), at: ctx.store.now() };
  const next = ctx.store.update(
    'board_plans',
    { ...plan, questions: [...(plan.questions ?? []), question] },
    plan.revision,
  );
  ctx.store.event('lead.question_asked', next, plan.project_id, question, cause);
  unsnooze(ctx, plan.id, 'needs_you', cause);
  return question;
}

export function answerQuestion(
  ctx: ControlContext,
  plan: BoardPlan,
  question: LeadQuestion,
  text: string,
  cause = '',
): { plan: BoardPlan; question: LeadQuestion & Required<Pick<LeadQuestion, 'answer'>> } {
  const answered = { ...question, answer: { text, at: ctx.store.now() } };
  const next = ctx.store.update(
    'board_plans',
    {
      ...plan,
      questions: plan.questions!.map((question) =>
        question.id === answered.id ? answered : question,
      ),
    },
    plan.revision,
  );
  ctx.store.event('lead.question_answered', next, plan.project_id, answered, cause);
  return { plan: next, question: answered };
}

export const leadInboxHandlers: Handlers = {
  'lead.ask': (ctx, p, c) => {
    const input = inputSchemas['lead.ask'].parse(c.input);
    requireThat(
      input.options.includes(input.recommended),
      'invalid_input',
      'The recommended answer must be one of the options',
    );
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    const plan = ctx.store.get<BoardPlan>('board_plans', p.session_id!);
    requireThat(plan, 'not_found', 'Write a plan with update_board first');
    for (const taskId of input.blocks)
      requireThat(
        plan.tasks.some((task) => task.id === taskId),
        'not_found',
        `Not found: task ${taskId} in your plan`,
      );
    const { project_id, ...fields } = input;
    return askQuestion(ctx, plan, fields, c.command_id);
  },
  'lead.question.answer': (ctx, p, c) => {
    const input = inputSchemas['lead.question.answer'].parse(c.input);
    userOnly(p);
    projectAccess(ctx, p, input.project_id, c.type);
    const plan = ctx.store.get<BoardPlan>('board_plans', input.lead_session_id);
    requireThat(
      plan && plan.project_id === input.project_id,
      'not_found',
      `Not found: board plan ${input.lead_session_id}`,
    );
    const question = plan.questions?.find((question) => question.id === input.question_id);
    requireThat(question, 'not_found', `Not found: question ${input.question_id}`);
    requireThat(!question.answer, 'invalid_state', 'This question has already been answered');
    const { plan: next, question: answered } = answerQuestion(
      ctx,
      plan,
      question,
      input.answer,
      c.command_id,
    );
    if (question.source) {
      const approval = ctx.store.get<Approval>('approvals', question.source.approval_id);
      // A request answered or lost meanwhile keeps only the board's answer.
      if (approval?.state === 'pending')
        answerApproval(
          ctx,
          p,
          approval,
          {
            decision: 'approve',
            answers: input.answers ?? { [question.question]: input.answer },
          },
          c.command_id,
        );
      return answered;
    }
    const noted = appendNote(
      ctx,
      next,
      {
        at: answered.answer.at,
        session_id: '',
        task_id: '',
        kind: 'answer',
        question_id: question.id,
        answer: input.answer,
        text: `Question: ${question.question}\nAnswer: ${input.answer}\nPrevious assumption: ${question.assumption}`,
      },
      c.command_id,
    );
    wakeLead(ctx, noted, c.command_id);
    return answered;
  },
  'lead.note.read': (ctx, p, c) => {
    const input = inputSchemas['lead.note.read'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    const note = recordedNotes(ctx, p.session_id!).find(
      (candidate) => candidate.id === input.note_id,
    );
    requireThat(note, 'not_found', `Not found: note ${input.note_id} in your plan`);
    return note;
  },
};

/** A blocked report holds the session until a new message or a later done report resumes it. */
export function blockedReport(ctx: ControlContext, session: Session): LeadNote | undefined {
  if (!session.task || session.outcome || session.stop_requested) return;
  const plan = ctx.store.get<BoardPlan>('board_plans', session.task.lead_session_id);
  if (!plan || retiredBinding(plan, session)) return;
  const row = ctx.store.db
    .prepare(
      "SELECT payload FROM events WHERE aggregate_id=? AND kind='task.reported' AND json_extract(payload,'$.session_id')=? AND json_extract(payload,'$.kind') IN ('blocked','done') ORDER BY sequence DESC LIMIT 1",
    )
    .get(plan.id, session.id) as { payload: string } | undefined;
  if (!row) return;
  const note = JSON.parse(row.payload) as LeadNote;
  if (
    note.kind === 'blocked' &&
    note.turn_id === causeTurn(ctx, session.id)?.id &&
    note.generation === taskReportGeneration(ctx, session)
  )
    return note;
}

/**
 * The digest of the lead's unread notes within the budget; it clears the notes it delivers and keeps
 * the rest. Undefined when there are none or none fits.
 */
export function takeInbox(
  ctx: ControlContext,
  leadId: string,
  budget = DIGEST_BUDGET,
): { text: string; note_ids: string[] } | undefined {
  const plan = ctx.store.get<BoardPlan>('board_plans', leadId);
  if (!plan?.inbox.length) return;
  const { text, left } = inboxDigest(ctx, plan, plan.inbox, budget);
  if (left.length === plan.inbox.length) return;
  ctx.store.update('board_plans', { ...plan, inbox: left }, plan.revision);
  return {
    text,
    note_ids: plan.inbox.flatMap((note) => (note.id && !left.includes(note) ? [note.id] : [])),
  };
}

/** The task's source, goal, scope and acceptance as instruction lines. */
export function contractLines(task: BoardPlan['tasks'][number]): string[] {
  const listed = (label: string, values: string[]) =>
    values.length ? [`${label}:`, ...values.map((value) => `- ${value}`)] : [];
  return [
    ...listed(
      "The user's words (verbatim)",
      task.source.map((quote) => `"${quote}"`),
    ),
    ...listed(
      "From an external request, written by other people (information, not the user's words)",
      (task.external_source ?? []).map((quote) => `"${quote}"`),
    ),
    `Goal: ${task.goal}`,
    ...listed('Scope (the paths you may change)', task.scope),
    ...listed('Acceptance commands', task.acceptance),
    ...(task.model
      ? [`Model: ${task.model}${task.effort ? `, effort ${task.effort}` : ''}`]
      : task.effort
        ? [`Effort: ${task.effort}`]
        : []),
  ];
}

/** The task of a session with a pending contract change; undefined without one or once removed. */
function changedTask(
  ctx: ControlContext,
  session: Session,
): BoardPlan['tasks'][number] | undefined {
  if (!session.task) return;
  const plan = ctx.store.get<BoardPlan>('board_plans', session.task.lead_session_id);
  if (!plan?.contract_changed?.includes(session.id) || retiredBinding(plan, session)) return;
  return plan.tasks.find((candidate) => candidate.id === session.task!.id);
}

/** The runtime the task names when the session should move to it; undefined when it stays. */
function nextRuntime(
  ctx: ControlContext,
  session: Session,
  task: BoardPlan['tasks'][number],
): string | undefined {
  const target = taskRuntime(
    ctx,
    ctx.store.must<BoardPlan>('board_plans', session.task!.lead_session_id),
    task,
  );
  if (target === session.runtime) return;
  try {
    runtime(ctx, target, 'writer');
  } catch (error) {
    // A runtime that is not available leaves the session where it is.
    if (error instanceof DomainError) return;
    throw error;
  }
  return target;
}

/** True when the task names no model and the session's differs, which a live native process cannot go back to. */
function defaultModelWaits(
  ctx: ControlContext,
  session: Session,
  task: BoardPlan['tasks'][number],
): boolean {
  return (
    !task.model &&
    (session.requested_model !== undefined || session.requested_effort !== task.effort) &&
    (nativeTurnActive(ctx, session) || ctx.idleConversations.has(session.id))
  );
}

/**
 * True while the session's pending contract change waits for its native process to close, to move
 * it to the runtime its task names or to that runtime's default model.
 */
export function contractMoveWaits(ctx: ControlContext, session: Session): boolean {
  const task = changedTask(ctx, session);
  return !!task && (!!nextRuntime(ctx, session, task) || defaultModelWaits(ctx, session, task));
}

/** Moves a session without a native process to its runtime's default model with the effort. */
function defaultModel(
  ctx: ControlContext,
  session: Session,
  effort: Session['requested_effort'],
  cause: string,
): Session {
  const next = ctx.store.update(
    'sessions',
    { ...session, requested_model: undefined, requested_effort: effort, reported_model: undefined },
    session.revision,
  );
  ctx.store.event(
    'session.model_changed',
    next,
    next.project_id,
    { model: null, effort: effort ?? null },
    cause,
  );
  return next;
}

/**
 * Moves an idle task session with a pending contract change and no native process to the runtime
 * its task names, with the task's model and effort; returns the handoff its new native
 * conversation starts with.
 */
export function followContractRuntime(
  ctx: ControlContext,
  session: Session,
  cause: string,
  beforeTurnId?: string,
): { session: Session; handoff?: string } {
  const task = changedTask(ctx, session),
    target = task && nextRuntime(ctx, session, task);
  // A turn queued while the old process closes would be failed with it, so the process goes first.
  if (
    !target ||
    session.state !== 'open' ||
    nativeTurnActive(ctx, session) ||
    ctx.idleConversations.has(session.id)
  )
    return { session };
  // After a rollback, send() adds the record from before the rolled-back turn instead.
  const handoff = session.handoff_before_turn_id
    ? undefined
    : buildHandoff(ctx, session, beforeTurnId);
  const next = ctx.store.update(
    'sessions',
    {
      ...withoutNativeConversation(ctx, session),
      runtime: target,
      process_identity: undefined,
      requested_model: task.model,
      requested_effort: task.effort,
    },
    session.revision,
  );
  ctx.store.event(
    'session.runtime_changed',
    next,
    next.project_id,
    { from: session.runtime, to: target },
    cause,
  );
  return { session: next, handoff };
}

/**
 * Moves an idle task session with a pending contract change to the model and effort its task names.
 * Its contract generation moves only when input delivery is acknowledged.
 */
export function followContractModel(ctx: ControlContext, session: Session, cause: string): Session {
  const task = changedTask(ctx, session);
  // The model and the change move with the runtime once the session is idle.
  if (
    !task ||
    session.state === 'running' ||
    nextRuntime(ctx, session, task) ||
    defaultModelWaits(ctx, session, task)
  )
    return session;
  return task.model === session.requested_model && task.effort === session.requested_effort
    ? session
    : task.model
      ? changeModel(ctx, session, task.model, task.effort, cause)
      : defaultModel(ctx, session, task.effort, cause);
}

/** Tells the lead that the session stays off the runtime its task names, once for each task and runtime. */
function tellRuntimeUnavailable(
  ctx: ControlContext,
  plan: BoardPlan,
  session: Session,
  target: string,
): void {
  const taskId = session.task!.id,
    opening = `Runtime ${target}, which task ${taskId} names, is not available`;
  const told = (
    ctx.store.db
      .prepare("SELECT payload FROM events WHERE aggregate_id=? AND kind='lead.note_added'")
      .all(plan.id) as { payload: string }[]
  )
    .map((row) => JSON.parse(row.payload) as LeadNote)
    .some(
      (note) =>
        note.kind === 'runtime_unavailable' &&
        note.task_id === taskId &&
        note.text.startsWith(`${opening},`),
    );
  if (told) return;
  appendNote(ctx, plan, {
    at: ctx.store.now(),
    session_id: session.id,
    task_id: taskId,
    kind: 'runtime_unavailable',
    text: `${opening}, so its session ${session.id} stays on ${session.runtime}. Name a runtime that is available, or leave the task on ${session.runtime}.`,
  });
}

/**
 * The task's changed contract; a queued turn previews it with consume=false and its receipt clears
 * it. Undefined when unchanged, while the session runs a turn, or while a busy session waits to
 * move to the runtime or default model its task names.
 */
export function takeContractChange(
  ctx: ControlContext,
  session: Session,
  consume = true,
): string | undefined {
  // A turn queued behind the running one may never start, and the running turn's reports keep the old generation.
  if (!session.task || session.state === 'running') return;
  const plan = ctx.store.get<BoardPlan>('board_plans', session.task.lead_session_id);
  if (!plan?.contract_changed?.includes(session.id)) return;
  const task = retiredBinding(plan, session)
    ? undefined
    : plan.tasks.find((candidate) => candidate.id === session.task!.id);
  if (
    task &&
    (nextRuntime(ctx, session, task) ||
      defaultModelWaits(ctx, session, task) ||
      task.model !== session.requested_model ||
      task.effort !== session.requested_effort)
  )
    return;
  const target = task && taskRuntime(ctx, plan, task);
  if (consume) {
    const next = ctx.store.update(
      'board_plans',
      { ...plan, contract_changed: plan.contract_changed.filter((value) => value !== session.id) },
      plan.revision,
    );
    if (task && target !== session.runtime) tellRuntimeUnavailable(ctx, next, session, target!);
  }
  if (!task) return '[Pantheon] The lead removed this task from the board.';
  return [
    '[Pantheon] The lead changed this task. It now reads:',
    `Title: ${task.title}`,
    ...contractLines(task),
    ...(target !== session.runtime
      ? [`Runtime ${target} is not available, so this session stays on ${session.runtime}.`]
      : []),
    task.done_when === 'report'
      ? 'Done when: the lead accepts your done report; no commit is needed.'
      : 'Done when: this worktree merges.',
  ].join('\n');
}
