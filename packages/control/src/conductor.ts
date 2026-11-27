import {
  DomainError,
  id,
  requireThat,
  type Approval,
  type NeedsYouItem,
  type Principal,
  type Project,
  type ProjectPlan,
  type Session,
  type SessionTurn,
  type SettingProposal,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, SPAWNED_SESSION_LIMIT, type Command } from '@pantheon/protocol';
import { projectChanges } from './changes.js';
import { globalExcludes } from './checkpoint.js';
import {
  projectAccess,
  revision,
  sessionWorkspaceKind,
  type ControlContext,
  type Handler,
  type Preparers,
} from './context.js';
import { runGit } from './git.js';
import { runtime as admittedRuntime } from './admission.js';
import { settleApproval } from './approvals.js';
import { gateCommands, inScope } from './landing.js';
import { sessionGoal } from './landing-diff.js';
import { executed, latestEvent, needsYou } from './needs-you.js';
import { SETTING_PROPOSALS } from './needs-you-settings.js';
import {
  requireCrossReview,
  requireNoBlockingReview,
  requireNoRunningReviewer,
  sessionChanges,
  startSessionReview,
} from './review.js';
import { interruptSession, queueInput } from './session.js';
import { notifySession, takesNotice } from './session-wake.js';
import {
  checkWorktreeSession,
  openWorktreeSession,
  prepareReadyMerge,
  readSessionOpening,
  stopWorktreeSession,
  worktreeStatusArgs,
} from './workbench-session.js';
import { projectOverBudget } from './workflow-policy.js';

/** The instructions Pantheon adds to a conductor session after the line on where it works. */
export const CONDUCTOR_INSTRUCTIONS =
  "Pantheon gives this session these tools. request_review: another vendor reviews your committed changes or those of a session you spawned; the result comes back to you as a message. report_ready: committed changes go through the project's gate and land. spawn_session: another vendor's session starts in a new worktree from your current commit, in permission mode ask or auto_edit; you hear when its turn ends. News of the sessions you spawned comes in batches while you are idle, at most 30 s after its first item; each item starts on a new line with its state in brackets: [completed], [failed], [input_required] when it waits for the user, [review], [landed] or [blocked]. News of sessions, reviews and landings reaches you only after your turn ends: once you have spawned sessions or requested reviews and have nothing else to do now, end your turn and wait; do not sleep or poll read_state to wait. Give it acceptance, what done means; its first message ends with the list, and request_review on it checks each item. Give it owns, the paths it may change; its first message names them, and read_state lists its changed files outside them. Give runtimes, two or three, to run the same task once on each. To keep the best result, review them, land one with report_ready and close the others with stop_session close. message_session: a message to a session you spawned, or a steer into its running turn; at most 2 a minute to one session. stop_session: interrupts the running turn of a session you spawned, or closes that session. read_state: this project's changes, checks, landing queue and items waiting for the user, and each session you spawned with its state and what it used. read_needs_you: the items waiting for the user, with the questions of the sessions you spawned. answer_request: answers or declines a question of a session you spawned, with your reason, which the user reads; the first answer, yours or the user's, counts; only the user answers a permission request. propose_setting: a change to the project's gate commands, protected paths, budget, session defaults or extension switches, which waits for the user and runs only once the user approves it; the outcome comes back at once on a line that starts with [setting]. write_plan: the project's plan, milestones and items with stable ids and the sessions working on each; each call replaces the whole plan, so read it back with read_state first; items the user accepted must stay, marked dropped if you give one up. project_read: the project's settings, budget, session defaults, brief and memory. memory_context, memory_search, memory_related and memory_get: project memory, which Pantheon does not add to your turns. memory_propose: a memory entry; a decision stays a draft until the user confirms it. draw: a chart or diagram the user sees in this session. Plan, split work and run subagents with your own tools.";

/** conductor.review; the session's committed range and its diff are read before the transaction. */
function prepareConductorReview(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Promise<Handler> {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const target = (ctx: ControlContext, p: Principal, command: Command) => {
    const input = inputSchemas['conductor.review'].parse(command.input);
    const session = ctx.store.get<Session>('sessions', input.session_id ?? p.session_id!);
    requireThat(
      session && (session.id === p.session_id || session.spawned_by?.session_id === p.session_id),
      'permission_denied',
      'Review your own session or a session you spawned',
    );
    projectAccess(ctx, p, session.project_id, command.type);
    revision(ctx, command);
    requireCrossReview(ctx, session, input.runtimes);
    return { input, session };
  };
  const { session } = target(ctx, p, command);
  return (async () => {
    const changes = await sessionChanges(ctx, session);
    return (ctx: ControlContext, p: Principal, command: Command) => {
      const { input, session } = target(ctx, p, command);
      requireNoRunningReviewer(ctx, session, input.runtimes);
      const acceptance = session.contract?.acceptance;
      const review = startSessionReview(ctx, session, input.runtimes, {
        cause: command.command_id,
        goal: sessionGoal(ctx, session),
        changes,
        notify_session_id: p.session_id!,
        ...(acceptance
          ? {
              focus: `What done means for this session. Give each item a verdict, met or not met, with the evidence for it:\n${itemLines(acceptance)}`,
            }
          : {}),
      });
      return { review_id: review.id, runtimes: review.runtimes };
    };
  })();
}

/** Records on the session what its main agent did to it, for the decisions made for the user. */
function mainAgentDecided(
  ctx: ControlContext,
  p: Principal,
  sessionId: string,
  action: 'spawn' | 'interrupt' | 'close' | 'ready',
  reason: string | undefined,
  cause: string,
): void {
  const session = ctx.store.must<Session>('sessions', sessionId);
  ctx.store.event(
    'session.main_agent_decided',
    session,
    session.project_id,
    { action, main_agent_session_id: p.session_id!, ...(reason ? { reason } : {}) },
    cause,
  );
}

/** conductor.ready */
function prepareConductorReady(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Handler | Promise<Handler> {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const input = inputSchemas['conductor.ready'].parse(command.input),
    target = ctx.store.must<Session>('sessions', input.session_id ?? p.session_id!);
  projectAccess(ctx, p, target.project_id, command.type);
  requireThat(
    target.id === p.session_id || target.spawned_by?.session_id === p.session_id,
    'permission_denied',
    'Name a session you spawned',
  );
  requireThat(
    !target.in_place,
    'invalid_state',
    'This session works in the project folder; report_ready does not land it, the user lands it in the app',
  );
  requireNoBlockingReview(ctx, target.id);
  if (input.session_id) {
    requireThat(
      target.state !== 'running',
      'resource_busy',
      'That session is taking a turn; call report_ready again once its turn ends',
    );
    return prepareReadyMerge(
      ctx,
      { ...command, expected_revision: target.revision },
      target.id,
    ).then((admit) => (ctx) => {
      admit(ctx);
      mainAgentDecided(ctx, p, target.id, 'ready', input.reason, command.command_id);
      return {
        session_id: target.id,
        next: gated(ctx, target)
          ? 'The gate runs now; the result comes back to you as a message.'
          : 'This project has no gate commands, so the work lands without a gate; the result comes back to you as a message.',
      };
    });
  }
  const turn = ctx.store
    .list<SessionTurn>('session_turns')
    .find((each) => each.session_id === target.id && each.state === 'running');
  requireThat(turn, 'invalid_state', 'Call report_ready during your turn');
  return (ctx) => {
    const session = ctx.store.must<Session>('sessions', target.id);
    ctx.store.update(
      'sessions',
      { ...session, ready: { turn_id: turn.id, command_id: command.command_id } },
      session.revision,
    );
    mainAgentDecided(ctx, p, session.id, 'ready', input.reason, command.command_id);
    const when = ctx.store
      .list<SessionTurn>('session_turns')
      .some((each) => each.session_id === session.id && each.state === 'queued')
      ? 'once this turn and the turns queued after it end'
      : 'when this turn ends';
    return {
      next: gated(ctx, session)
        ? `The gate and landing start ${when}; the result comes back to you as a message.`
        : `This project has no gate commands, so the work lands without a gate ${when}; the result comes back to you as a message.`,
    };
  };
}

/**
 * Drops the session's ready declaration once a turn after the one that declared it failed or was
 * cancelled, and tells the session; that turn's work was not what was declared ready.
 */
export function dropReadyAfterEndedTurn(ctx: ControlContext, sessionId: string): void {
  const ready = ctx.store.get<Session>('sessions', sessionId)?.ready;
  // A turn the daemon's shutdown ends says nothing of the work.
  if (!ready || ctx.closing) return;
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((each) => each.session_id === sessionId);
  const declaring = turns.findIndex((each) => each.id === ready.turn_id);
  const ended = turns
    .slice(declaring + 1)
    .find((each) => each.state === 'failed' || each.state === 'cancelled');
  if (declaring < 0 || turns[declaring]!.state !== 'completed' || !ended) return;
  ctx.store.transaction(() => {
    const session = ctx.store.must<Session>('sessions', sessionId);
    ctx.store.update('sessions', { ...session, ready: undefined }, session.revision);
    notifySession(
      ctx,
      sessionId,
      `[blocked] [Pantheon] Your work did not land: a turn after the one that called report_ready ${ended.state === 'failed' ? 'failed' : 'was cancelled'}. Call report_ready again once the work is ready.`,
      ready.command_id,
    );
  });
}

/** Whether the project's gate has commands for the session's worktree; without any, a landing runs no gate. */
function gated(ctx: ControlContext, session: Session): boolean {
  const project = ctx.store.must<Project>('projects', session.project_id),
    workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
  return !!gateCommands(ctx, project, workspace, session)?.length;
}

/** Refuses a spawned session's new turn once the project spent its budget. */
function requireBudgetLeft(ctx: ControlContext, projectId: string): void {
  requireThat(
    !projectOverBudget(ctx, projectId),
    'budget_exceeded',
    'Project runtime budget is exhausted',
  );
}

/** Refuses count new turns unless they fit beside the caller's spawned sessions that have one to take. */
function requireTurnSlot(ctx: ControlContext, caller: Session, count = 1): void {
  const busy = new Set(
    ctx.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.state === 'queued' || turn.state === 'running')
      .map((turn) => turn.session_id),
  );
  const taking = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.spawned_by?.session_id === caller.id && busy.has(session.id));
  const more = count > 1 ? ` ${count} new sessions do not fit beside them.` : '';
  requireThat(
    taking.length + count <= SPAWNED_SESSION_LIMIT,
    'resource_busy',
    `At most ${SPAWNED_SESSION_LIMIT} spawned sessions take a turn at a time; these are taking one: ${taking
      .map((session) => `${session.id} (${session.title ?? ''})`)
      .join(', ')}.${more} You get a message as each turn ends.`,
  );
}

const itemLines = (items: string[]) => items.map((item) => `- ${item}`).join('\n');

/**
 * The session.create inputs of the sessions a spawn starts, one per runtime in its order, each a
 * worktree cut from the caller's committed HEAD, and the contract each of them keeps.
 */
function spawnInputs(ctx: ControlContext, p: Principal, command: Command) {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  projectAccess(ctx, p, p.project_id!, command.type);
  const { runtime, runtimes, input, acceptance, owns, model, effort, permission_mode, reason } =
    inputSchemas['conductor.spawn'].parse(command.input);
  requireThat(
    (runtime === undefined) !== (runtimes === undefined),
    'invalid_input',
    'Give either runtime or runtimes',
  );
  requireThat(
    !runtimes || new Set(runtimes).size === runtimes.length,
    'invalid_input',
    'Name each runtime in runtimes once',
  );
  requireThat(
    !runtimes || model === undefined,
    'invalid_input',
    "With runtimes each session starts on its runtime's default model; give model only with runtime",
  );
  const names = runtimes ?? [runtime!];
  // A runtime that is out stops the whole call; a fallback would run two of the tries on one runtime.
  if (runtimes) for (const name of runtimes) admittedRuntime(ctx, name, 'writer');
  const caller = ctx.store.must<Session>('sessions', p.session_id!);
  requireBudgetLeft(ctx, caller.project_id);
  requireTurnSlot(ctx, caller, names.length);
  const inputs = names.map((name) =>
    inputSchemas['session.create'].parse({
      project_id: caller.project_id,
      workspace: 'worktree',
      runtime: name,
      model,
      effort,
      ...(permission_mode ? { permission_mode } : {}),
      input: [
        input,
        ...(owns ? [`Change only these paths:\n${itemLines(owns)}`] : []),
        ...(acceptance ? [`Done when:\n${itemLines(acceptance)}`] : []),
      ].join('\n\n'),
      // An in-place caller's HEAD is the project folder's, which a start without `from` reads.
      ...(sessionWorkspaceKind(ctx, caller) === 'linked_worktree'
        ? { from: { session_id: caller.id } }
        : {}),
    }),
  );
  const contract: NonNullable<Session['contract']> = {
    ...(acceptance ? { acceptance } : {}),
    ...(owns ? { owns } : {}),
  };
  return { inputs, contract, reason };
}

/** conductor.spawn */
function prepareConductorSpawn(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Promise<Handler> {
  const { inputs } = spawnInputs(ctx, p, command);
  for (const input of inputs) checkWorktreeSession(ctx, input, undefined, p);
  return Promise.all(inputs.map((input) => readSessionOpening(ctx, input))).then(
    (openings) => (ctx: ControlContext, p: Principal, command: Command) => {
      const { inputs, contract, reason } = spawnInputs(ctx, p, command);
      const terms = inputs.length > 1 ? { ...contract, group: id() } : contract;
      const opened = inputs.map((input, index) => {
        const session = openWorktreeSession(
          ctx,
          input,
          command.command_id,
          openings[index]!,
          undefined,
          p,
        );
        ctx.store.update<Session>(
          'sessions',
          {
            ...session,
            spawned_by: { session_id: p.session_id! },
            ...(Object.keys(terms).length ? { contract: terms } : {}),
          },
          session.revision,
        );
        mainAgentDecided(ctx, p, session.id, 'spawn', reason, command.command_id);
        return session.id;
      });
      return inputs.length > 1 ? { session_ids: opened } : { session_id: opened[0]! };
    },
  );
}

/** The session the conductor spawned that the command names. */
function spawnedTarget(
  ctx: ControlContext,
  p: Principal,
  command: Command,
  sessionId: string,
): Session {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  projectAccess(ctx, p, p.project_id!, command.type);
  const target = ctx.store.get<Session>('sessions', sessionId);
  requireThat(
    target && p.session_id && target.spawned_by?.session_id === p.session_id,
    'permission_denied',
    'Name a session you spawned',
  );
  return target;
}

/** How many messages a conductor sends to one spawned session within a minute. */
const MESSAGES_PER_MINUTE = 2;

/** conductor.message; the turn is queued as the user's send or steer would be, marked as the agent's. */
const conductorMessage: Handler = (ctx, p, command) => {
  const input = inputSchemas['conductor.message'].parse(command.input);
  const target = spawnedTarget(ctx, p, command, input.session_id);
  const caller = ctx.store.must<Session>('sessions', p.session_id!);
  const now = ctx.store.now();
  const recent = ctx.store
    .statement(
      "SELECT created_at FROM events WHERE aggregate_id=? AND kind='session.conductor_messaged' AND created_at>? ORDER BY created_at",
    )
    .all(target.id, now - 60_000) as { created_at: number }[];
  if (recent.length >= MESSAGES_PER_MINUTE)
    throw new DomainError(
      'rate_limited',
      `At most ${MESSAGES_PER_MINUTE} messages a minute go to one session; send again in ${Math.ceil((recent[0]!.created_at + 60_000 - now) / 1000)} seconds`,
    );
  requireBudgetLeft(ctx, target.project_id);
  if (input.mode === 'steer')
    requireThat(
      ctx.store
        .list<SessionTurn>('session_turns')
        .some((turn) => turn.session_id === target.id && turn.state === 'running'),
      'invalid_state',
      'That session has no running turn to steer; message it with mode send',
    );
  else requireTurnSlot(ctx, caller);
  const type = input.mode === 'steer' ? 'session.steer' : 'session.send';
  // The conductor's access is checked above; the send then runs as the user's.
  const turn = queueInput(
    ctx,
    { id: p.id, role: 'user' },
    {
      ...command,
      type,
      input: {
        session_id: target.id,
        input: `[Pantheon] From the main agent "${caller.title ?? ''}":\n${input.text}`,
      },
      expected_revision: target.revision,
    },
    'agent',
  );
  ctx.store.event(
    'session.conductor_messaged',
    ctx.store.must<Session>('sessions', target.id),
    target.project_id,
    { turn_id: turn.id, session_id: p.session_id },
    command.command_id,
  );
  return { session_id: target.id, turn_id: turn.id };
};

/** conductor.stop */
const conductorStop: Handler = (ctx, p, command) => {
  const input = inputSchemas['conductor.stop'].parse(command.input);
  const target = spawnedTarget(ctx, p, command, input.session_id);
  if (!input.close) {
    interruptSession(ctx, target, command.command_id);
    mainAgentDecided(ctx, p, target.id, 'interrupt', input.reason, command.command_id);
    return { session_id: target.id, next: 'Its running turn stops; the session stays open.' };
  }
  requireThat(
    target.workspace_id && !target.outcome && !target.stop_requested,
    'invalid_state',
    'That session has already ended',
  );
  stopWorktreeSession(
    ctx,
    target,
    { reason: 'Closed by the session that started it', by: 'agent' },
    command.command_id,
  );
  mainAgentDecided(ctx, p, target.id, 'close', input.reason, command.command_id);
  return { session_id: target.id, next: 'The session closes and its worktree is discarded.' };
};

/**
 * Whether the request is a question whose questions were read and none asks for a secret, the one
 * kind a main agent answers.
 */
function isAnswerableQuestion(approval: Approval): boolean {
  return (
    approval.tool === 'AskUserQuestion' &&
    !!approval.questions?.length &&
    !approval.questions.some((question) => question.secret)
  );
}

/** conductor.answer; the main agent's answer settles the question as the user's would, first answer first. */
const conductorAnswer: Handler = (ctx, p, command) => {
  const input = inputSchemas['conductor.answer'].parse(command.input);
  const target = spawnedTarget(ctx, p, command, input.session_id);
  const approval = ctx.store.get<Approval>('approvals', input.approval_id);
  requireThat(
    approval?.session_id === target.id,
    'not_found',
    'Name a request of the session you name',
  );
  requireThat(
    isAnswerableQuestion(approval),
    'invalid_state',
    'Only the user answers this request',
  );
  const asked = new Set(approval.questions!.map((question) => question.question));
  requireThat(
    input.decision === 'approve'
      ? Object.keys(input.answers ?? {}).every((question) => asked.has(question))
      : input.answers === undefined,
    'invalid_input',
    'Answer only the questions asked, and decline without answers',
  );
  if (input.decision === 'approve')
    for (const question of approval.questions!) {
      const answer = input.answers?.[question.question];
      // A question without options takes text, whatever other says.
      if (question.other !== false || !question.options.length || !answer?.trim()) continue;
      const labels = question.options.map((option) => option.label);
      // Runtimes split a multi-select answer at ", " to map it to their options.
      const parts = question.multiSelect ? answer.split(', ') : [answer];
      requireThat(
        new Set(parts).size === parts.length && parts.every((part) => labels.includes(part)),
        'invalid_input',
        `Answer "${question.question}" with its option labels only`,
      );
    }
  const settled = settleApproval(
    ctx,
    p,
    approval,
    {
      decision: input.decision,
      ...(input.answers ? { answers: input.answers } : {}),
      // Runtimes pass a denial reason on as the user's words, so the session gets a plain decline.
      conductor_reason: input.reason,
    },
    command.command_id,
  );
  // The request input stays with the user, as read_needs_you leaves it out.
  return 'error' in settled ? settled : { approval_id: settled.id, state: settled.state };
};

/**
 * What a conductor reads of an item waiting for the user: no actions that answer it, no request
 * input, and the questions of the sessions it spawned, which it may answer.
 */
function waitingItem(ctx: ControlContext, item: NeedsYouItem, spawned: ReadonlySet<string>) {
  const sessionId = item.source.table === 'sessions' ? item.source.id : item.session_id;
  const asked =
    item.source.table === 'approvals' && !!sessionId && spawned.has(sessionId)
      ? ctx.store.get<Approval>('approvals', item.source.id)
      : undefined;
  return {
    kind: item.kind,
    reason: item.reason,
    decision: item.decision,
    status: item.status,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(item.binding?.action ? { request: item.binding.action } : {}),
    ...(asked?.state === 'pending' && isAnswerableQuestion(asked)
      ? { approval_id: asked.id, questions: asked.questions }
      : {}),
    ...(item.next_step ? { next_step: item.next_step } : {}),
    created_at: item.created_at,
  };
}

/** conductor.needs_you */
function prepareConductorNeedsYou(ctx: ControlContext, p: Principal, command: Command): Handler {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const projectId = p.project_id ?? '';
  projectAccess(ctx, p, projectId, command.type);
  // The conductor's access is checked above; the shared read then runs as for the user.
  return (ctx) => {
    const spawned = new Set(
      ctx.store
        .list<Session>('sessions')
        .flatMap((session) => (session.spawned_by?.session_id === p.session_id ? session.id : [])),
    );
    return {
      items: needsYou(ctx, { id: p.id, role: 'user' }, projectId).items.map((item) =>
        waitingItem(ctx, item, spawned),
      ),
    };
  };
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The sessions the caller spawned, without those discarded over a day ago, with what each spent:
 * the tokens its runtime reported, the turns it ran and their wall time.
 */
function spawnedSessions(
  ctx: ControlContext,
  callerId: string,
  projectId: string,
  changed: Map<string, string[] | null>,
) {
  const now = ctx.store.now();
  const discarded = new Map(
    ctx.store
      .kindEvents(projectId, ['session.discarded'])
      .map((event) => [event.aggregate_id, event.created_at]),
  );
  const times = new Map(
    (
      ctx.store
        .statement(
          "SELECT session_id, count(*) AS turns, sum(coalesce(ended, ?) - started) AS wall_ms FROM (SELECT t.data->>'$.session_id' AS session_id, min(CASE WHEN e.kind='turn.running' THEN e.created_at END) AS started, min(CASE WHEN e.kind<>'turn.running' THEN e.created_at END) AS ended FROM events e INDEXED BY events_project_kind JOIN session_turns t ON t.id=e.aggregate_id WHERE e.project_id=? AND e.kind IN ('turn.running','turn.completed','turn.failed','turn.cancelled') AND t.data->>'$.session_id' IN (SELECT id FROM sessions WHERE data->>'$.spawned_by.session_id'=?) GROUP BY t.id) WHERE started IS NOT NULL GROUP BY session_id",
        )
        .all(now, projectId, callerId) as { session_id: string; turns: number; wall_ms: number }[]
    ).map((row) => [row.session_id, row]),
  );
  return ctx.store
    .list<Session>('sessions')
    .filter(
      (session) =>
        session.spawned_by?.session_id === callerId &&
        !(session.outcome === 'discarded' && (discarded.get(session.id) ?? now) < now - DAY_MS),
    )
    .map((session) => {
      const usage = session.usage,
        counted = usage && !usage.tokens_unreported;
      const owns = session.contract?.owns;
      return {
        session_id: session.id,
        title: session.title ?? '',
        runtime: session.runtime,
        state: session.state,
        ...(session.outcome ? { outcome: session.outcome } : {}),
        ...(session.contract?.group ? { group: session.contract.group } : {}),
        ...(owns && changed.has(session.id)
          ? changed.get(session.id) === null
            ? { outside_owns_unknown: true as const }
            : {
                outside_owns: changed
                  .get(session.id)!
                  .filter((file) => !owns.some((entry) => inScope(file, entry)))
                  .slice(0, OUTSIDE_OWNS_LIMIT),
              }
          : {}),
        usage: {
          ...(counted
            ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }
            : {}),
          ...(counted && usage.cached_input_tokens !== undefined
            ? { cached_input_tokens: usage.cached_input_tokens }
            : {}),
          ...(usage?.tokens_unreported ? { tokens_unreported: true as const } : {}),
          turns: times.get(session.id)?.turns ?? 0,
          wall_ms: times.get(session.id)?.wall_ms ?? 0,
        },
      };
    });
}

/** The most changed files outside its owned paths read_state lists for one spawned session. */
const OUTSIDE_OWNS_LIMIT = 50;

/**
 * The files each open session the caller spawned with owned paths changed against its worktree's
 * base commit, committed or not, as the session list's change counts read them; null when a read failed.
 */
async function ownedSessionChanges(
  ctx: ControlContext,
  callerId: string,
): Promise<Map<string, string[] | null>> {
  const owning = ctx.store
    .list<Session>('sessions')
    .filter(
      (session) =>
        session.spawned_by?.session_id === callerId &&
        session.contract?.owns &&
        session.workspace_id &&
        !session.outcome,
    );
  if (!owning.length) return new Map();
  const untracked = [
    ...(await globalExcludes()),
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ];
  const reads = owning.map(async (session): Promise<[string, string[] | null]> => {
    const workspace = ctx.store.get<Workspace>('workspaces', session.workspace_id!);
    if (!workspace?.base_sha) return [session.id, null];
    const results = await Promise.all([
      runGit(
        workspace.path,
        // A rename reported as one path would hide its deleted source.
        ['diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', workspace.base_sha, '--'],
        undefined,
        true,
      ),
      runGit(workspace.path, untracked, undefined, true),
    ]);
    return [
      session.id,
      results.every((result) => result.exit_code === 0)
        ? results.flatMap((result) => result.stdout.toString().split('\0').filter(Boolean))
        : null,
    ];
  });
  return new Map(await Promise.all(reads));
}

/** Per control, the callers a notice did not reach because they took no input then. */
const unreached = new WeakMap<ControlContext, Set<string>>();

function unreachedCaller(ctx: ControlContext, callerId: string): void {
  let callers = unreached.get(ctx);
  if (!callers) unreached.set(ctx, (callers = new Set()));
  callers.add(callerId);
}

/**
 * The spawned session's completed and failed turns its caller has not heard of, in the order they
 * ended; a steer delivered into a running turn and a turn that ended once the session was stopped
 * are left out.
 */
function untoldTurns(ctx: ControlContext, sessionId: string): SessionTurn[] {
  const told = new Set(
    (
      ctx.store
        .statement(
          "SELECT json_extract(payload,'$.turn_id') AS turn_id FROM events WHERE aggregate_id=? AND kind='session.spawner_notified'",
        )
        .all(sessionId) as { turn_id: string }[]
    ).map((row) => row.turn_id),
  );
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((each) => each.session_id === sessionId && executed(ctx, each));
  const stop = ctx.store.must<Session>('sessions', sessionId).stop_requested;
  // Notices go out in order, so a turn before the last one told was passed over before that held.
  return turns
    .slice(turns.findLastIndex((each) => told.has(each.id)) + 1)
    .filter(
      (each) =>
        (each.state === 'completed' || each.state === 'failed') &&
        (!stop ||
          (latestEvent(ctx, each.id, `turn.${each.state}`)?.created_at ?? Infinity) < stop.at),
    );
}

/** How long news for an idle main agent waits, from its oldest item, for more to join it. */
export const NOTICE_HOLD_MS = 30_000;

/**
 * The spawned session's requests waiting for the user that its caller has not heard of, and
 * whether the caller heard of another request of the same wait; each wait is told once.
 */
function untoldWait(ctx: ControlContext, sessionId: string) {
  const told = new Set(
    (
      ctx.store
        .statement(
          "SELECT json_extract(payload,'$.approval_id') AS approval_id FROM events WHERE aggregate_id=? AND kind='session.spawner_notified'",
        )
        .all(sessionId) as { approval_id: string | null }[]
    ).map((row) => row.approval_id),
  );
  const waiting = ctx.store
    .list<Approval>('approvals')
    .filter(
      (each) =>
        each.session_id === sessionId && each.state === 'pending' && each.decider === 'user',
    );
  const untold = waiting.filter((each) => !told.has(each.id));
  return untold.length ? { untold, told: untold.length < waiting.length } : undefined;
}

/** What a spawned session's caller has not heard of, the events that record it told, and when its oldest line happened. */
interface News {
  session: Session;
  lines: string[];
  told: ({ turn_id: string } | { approval_id: string })[];
  since: number;
  cause: string;
}

/**
 * How each turn of the spawned session ended, once per turn and in order, and that it waits for
 * the user, once per wait; a turn the user cancelled or stopped tells nothing.
 */
function untoldNews(ctx: ControlContext, session: Session): News | undefined {
  const turns = untoldTurns(ctx, session.id);
  const wait = untoldWait(ctx, session.id);
  if (!turns.length && !wait) return;
  const named = `Session "${session.title ?? ''}" (${session.id}, ${session.runtime}), which you spawned,`;
  const ended =
    session.outcome === 'discarded'
      ? 'discarded'
      : session.state === 'closed'
        ? 'closed'
        : undefined;
  const notice = (turn: SessionTurn) => {
    const failure = latestEvent(ctx, turn.id, 'turn.failed');
    const { error, error_code } = failure
      ? (JSON.parse(failure.payload) as { error?: string; error_code?: string })
      : {};
    const reason = error_code ?? error?.split('\n')[0];
    return [
      `[${turn.state}] [Pantheon] ${named} ${
        turn.state === 'completed'
          ? 'completed its turn.'
          : `failed its turn${reason ? `: ${reason}` : ''}.`
      }`,
      ...(ended
        ? [`It was ${ended}.`]
        : [
            'Find its branch with read_state.',
            ...(turn.state === 'completed'
              ? [
                  'Review it with request_review, land it with report_ready, or read it in its worktree.',
                ]
              : []),
          ]),
    ].join(' ');
  };
  // A question the main agent may answer is told even within a wait it heard of.
  const telling = !wait ? [] : wait.told ? wait.untold.filter(isAnswerableQuestion) : wait.untold;
  const asked = telling[0];
  return {
    session,
    lines: [
      ...turns.map(notice),
      ...(asked
        ? [
            telling.length > 1
              ? waitsOn(
                  `[input_required] [Pantheon] ${named}`,
                  telling.length,
                  telling.some(isAnswerableQuestion),
                )
              : `[input_required] [Pantheon] ${named} waits for the user to ${isAnswerableQuestion(asked) ? `answer a question. Answer it ${ANSWER_IT} or leave it to the user` : `allow ${asked.tool ?? 'a tool call'}. Only the user answers it`}; read it with read_needs_you.`,
          ]
        : []),
    ],
    told: [
      ...turns.map((turn) => ({ turn_id: turn.id })),
      ...(wait?.untold ?? []).map((approval) => ({ approval_id: approval.id })),
    ],
    since: Math.min(
      ...turns.map((turn) => latestEvent(ctx, turn.id, `turn.${turn.state}`)?.created_at ?? 0),
      ...(asked ? [asked.created_at] : []),
    ),
    cause: turns[0]?.id ?? wait!.untold[0]!.id,
  };
}

/** In the told item of a wait the main agent may answer; foldWaits looks for it. */
const ANSWER_IT = 'with answer_request, giving your reason,';

const waitsOn = (head: string, count: number, answerable: boolean) =>
  `${head} waits for the user on ${count} requests. ${answerable ? `Answer those you may ${ANSWER_IT} or leave them to the user` : 'Only the user answers them'}; read them with read_needs_you.`;
const WAIT_ITEM =
  /^(\[input_required\] \[Pantheon\] .*, which you spawned,) waits for the user (?:on (\d+) requests|to )/;

/** The items, with the waits of one spawned session told as one item that counts their requests. */
function foldWaits(items: string[]): string[] {
  const heads = items.map((item) => WAIT_ITEM.exec(item));
  const counts = new Map<string, number>();
  const answerable = new Set<string>();
  for (const [index, head] of heads.entries())
    if (head) {
      counts.set(head[1]!, (counts.get(head[1]!) ?? 0) + Number(head[2] ?? 1));
      if (items[index]!.includes(ANSWER_IT)) answerable.add(head[1]!);
    }
  return items.flatMap((item, index) => {
    const head = heads[index]?.[1];
    if (!head || heads.filter((each) => each?.[1] === head).length === 1) return [item];
    return heads.findIndex((each) => each?.[1] === head) === index
      ? [waitsOn(head, counts.get(head)!, answerable.has(head))]
      : [];
  });
}

/**
 * Sends the caller, in one message, what the sessions it spawned did that it has not heard of. A
 * notice the caller cannot take yet waits for it, one the daemon's shutdown holds back goes out on
 * the next start, and an idle main agent's waits NOTICE_HOLD_MS from its oldest line for more.
 */
function tellCaller(ctx: ControlContext, callerId: string): void {
  if (ctx.closing) return;
  const caller = ctx.store.get<Session>('sessions', callerId);
  if (!caller || caller.state === 'closed') return;
  const news = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.spawned_by?.session_id === callerId)
    .flatMap((session) => untoldNews(ctx, session) ?? [])
    .sort((a, b) => a.since - b.since);
  if (!news.length) return;
  const lines = news.flatMap((each) => each.lines);
  if (
    lines.length &&
    caller.conductor &&
    caller.state !== 'running' &&
    ctx.store.now() - news[0]!.since < NOTICE_HOLD_MS &&
    // A caller that takes no notice now goes on to the refusal, which a resident records.
    takesNotice(ctx, caller)
  )
    return unreachedCaller(ctx, callerId);
  ctx.store.transaction(() => {
    if (lines.length) {
      // The newest news is what reached the caller now; older ones were refused before.
      const turn = notifySession(ctx, callerId, lines.join('\n\n'), news.at(-1)!.cause);
      if (!turn) return unreachedCaller(ctx, callerId);
      if (caller.state === 'running') {
        const items = turn.input.split('\n\n');
        const folded = foldWaits(items);
        if (folded.length < items.length)
          ctx.store.update('session_turns', { ...turn, input: folded.join('\n\n') }, turn.revision);
      }
    } else if (!takesNotice(ctx, caller)) return unreachedCaller(ctx, callerId);
    for (const each of news)
      for (const told of each.told)
        ctx.store.event(
          'session.spawner_notified',
          ctx.store.must<Session>('sessions', each.session.id),
          each.session.project_id,
          { ...told, session_id: callerId },
        );
  });
}

/**
 * Once a turn of the session ended: tells its spawner, when it has one, and sends the notices
 * that waited for this session to end its own turn.
 */
export function afterSpawnedTurn(ctx: ControlContext, sessionId: string): void {
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (!session || ctx.closing) return;
  if (session.spawned_by) tellCaller(ctx, session.spawned_by.session_id);
  tellCaller(ctx, sessionId);
}

/** Once the session asked the user for something: tells its spawner, when it has one. */
export function afterSpawnedRequest(ctx: ControlContext, sessionId: string): void {
  const callerId = ctx.store.get<Session>('sessions', sessionId)?.spawned_by?.session_id;
  if (callerId) tellCaller(ctx, callerId);
}

const untoldAnswer = (row: SettingProposal) => row.state !== 'pending' && !row.notified_at;

/**
 * Tells the main agent, at once, the user's answers to its settings proposals it has not heard of;
 * inside a transaction. One it cannot take yet waits for it as its news does.
 */
export function tellAnswers(ctx: ControlContext, sessionId: string, cause?: string): void {
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (!session || session.state === 'closed') return;
  const untold = ctx.store
    .list<SettingProposal>(SETTING_PROPOSALS)
    .filter((row) => row.session_id === sessionId && untoldAnswer(row));
  if (!untold.length) return;
  const lines = untold.map(
    (row) => `[setting] [Pantheon] ${row.state}: ${row.command} — ${row.error ?? row.reason}`,
  );
  if (!notifySession(ctx, sessionId, lines.join('\n\n'), cause ?? untold[0]!.id))
    return unreachedCaller(ctx, sessionId);
  for (const row of untold)
    ctx.store.update<SettingProposal>(
      SETTING_PROPOSALS,
      { ...row, notified_at: ctx.store.now() },
      row.revision,
    );
}

/** Sends the waiting notices of the callers that take input again or whose hold ended. */
export function retrySpawnerNotices(ctx: ControlContext): void {
  const callers = unreached.get(ctx);
  // A caller still held is added back while this runs.
  for (const callerId of [...(callers ?? [])]) {
    const caller = ctx.store.get<Session>('sessions', callerId);
    if (caller && caller.state !== 'closed' && !takesNotice(ctx, caller)) continue;
    callers!.delete(callerId);
    if (!caller || caller.state === 'closed') continue;
    ctx.store.transaction(() => tellAnswers(ctx, callerId));
    tellCaller(ctx, callerId);
  }
}

/** On start, sends every notice that did not go out before the daemon stopped. */
export function tellSpawners(ctx: ControlContext): void {
  const callers = new Set(
    ctx.store.list<Session>('sessions').flatMap((session) => session.spawned_by?.session_id ?? []),
  );
  for (const callerId of callers) tellCaller(ctx, callerId);
  const answered = new Set(
    ctx.store
      .list<SettingProposal>(SETTING_PROPOSALS)
      .flatMap((row) => (untoldAnswer(row) ? row.session_id : [])),
  );
  for (const sessionId of answered) ctx.store.transaction(() => tellAnswers(ctx, sessionId));
}

/** Whether the session's HEAD is the commit it last landed and its index and files are clean. */
async function atLandedCommit(ctx: ControlContext, sessionId: string): Promise<boolean> {
  const session = ctx.store.get<Session>('sessions', sessionId);
  const workspace = session?.workspace_id
    ? ctx.store.get<Workspace>('workspaces', session.workspace_id)
    : undefined;
  const merged = latestEvent(ctx, sessionId, 'session.merged');
  if (!workspace || !merged) return false;
  const status = await runGit(workspace.path, await worktreeStatusArgs(), undefined, true);
  if (status.exit_code !== 0) return false;
  // Porcelain v2 with --branch: header records start with "# ", every other record is a change.
  const records = status.stdout.toString().split('\0').filter(Boolean);
  return (
    records.every((record) => record.startsWith('# ')) &&
    records.includes(`# branch.oid ${(JSON.parse(merged.payload) as { to_sha?: string }).to_sha}`)
  );
}

/** conductor.state; the caller's worktree is read before the transaction. */
function prepareConductorState(
  ctx: ControlContext,
  p: Principal,
  command: Command,
): Promise<Handler> {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const projectId = p.project_id ?? '';
  projectAccess(ctx, p, projectId, command.type);
  return Promise.all([
    atLandedCommit(ctx, p.session_id!),
    ownedSessionChanges(ctx, p.session_id!),
  ]).then(([landed, owned]) => (ctx: ControlContext) => {
    // The conductor's access is checked above; the shared reads then run as for the user.
    const reader: Principal = { id: p.id, role: 'user' };
    const items = needsYou(ctx, reader, projectId).items;
    const mergedSince = new Date(ctx.store.now() - 24 * 60 * 60_000).toISOString();
    const changes = projectChanges(ctx, reader, projectId, items)
      .filter((row) => row.status !== 'merged' || row.updated_at >= mergedSince)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 30)
      .map((row) =>
        row.id === `session:${p.session_id}`
          ? {
              ...row,
              self: true,
              ...(row.status === 'running' && landed ? { landed: true as const } : {}),
            }
          : row,
      );
    const todo = items.slice(0, 20).map((item) => {
      const sessionId = item.source.table === 'sessions' ? item.source.id : item.session_id;
      return {
        reason: item.reason,
        ...(sessionId ? { session_id: sessionId } : {}),
        created_at: item.created_at,
      };
    });
    return {
      changes,
      todo,
      spawned: spawnedSessions(ctx, p.session_id!, projectId, owned),
      plan: ctx.store.get<ProjectPlan>('project_plans', projectId) ?? null,
    };
  });
}

export const conductorPreparers: Preparers = {
  'conductor.review': prepareConductorReview,
  'conductor.ready': prepareConductorReady,
  'conductor.spawn': prepareConductorSpawn,
  'conductor.state': prepareConductorState,
  'conductor.message': () => conductorMessage,
  'conductor.stop': () => conductorStop,
  'conductor.needs_you': prepareConductorNeedsYou,
  'conductor.answer': () => conductorAnswer,
};
