import {
  credentialRole,
  hash,
  id,
  permissionRule,
  requireThat,
  type AgentEvent,
  type Approval,
  type BoardPlan,
  type LeadNote,
  type LeadQuestion,
  type PermissionDecision,
  type Project,
  type Principal,
  type Receipt,
  type Session,
  type SessionHandle,
} from '@pantheon/domain';
import {
  approvalQuestions,
  inputSchemas,
  type Command,
  type ProjectPermissionRule,
} from '@pantheon/protocol';
import {
  sessionAdapter,
  projectAccess,
  revision,
  sessionWorkspaceKind,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { isolationWaived } from './admission.js';
import { charterMode, chartered } from './charter.js';
import { SHELL_TOOLS } from './handoff.js';
import { answerQuestion, appendNote, askQuestion, recordNote } from './lead-inbox.js';
import { mustAsk } from './must-ask.js';
import { unsnooze } from './session.js';
import { projectDefaults, userConfigDirectory, writeUserConfig } from './user-config.js';

const detailInput = (detail: unknown): unknown =>
  detail && typeof detail === 'object' && 'input' in detail ? detail.input : detail;

function approvalInputSummary(tool: string | undefined, detail: unknown): string | undefined {
  const input = detailInput(detail);
  if (input === undefined || input === null) return;
  // A shell command is the request itself; its other fields only describe it.
  const text =
    SHELL_TOOLS.has(tool ?? '') &&
    typeof input === 'object' &&
    'command' in input &&
    typeof input.command === 'string'
      ? input.command
      : typeof input === 'object'
        ? Object.entries(input)
            .map(
              ([key, value]) =>
                `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
            )
            .join(', ')
        : String(input);
  const summary = text.replace(/\s+/g, ' ').trim();
  return summary.length > 300 ? `${summary.slice(0, 299)}…` : summary || undefined;
}

function approvalEventPayload(approval: Approval): Omit<Approval, 'input_summary'> {
  const { input_summary, ...payload } = approval;
  return payload;
}

function liveSessionHandle(ctx: ControlContext, sessionId?: string): SessionHandle | undefined {
  if (!sessionId) return;
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (!session) return;
  return [...ctx.handles.values()].find(
    (handle) =>
      handle.platform_session_id === sessionId &&
      (!session.native_id || handle.native_session_id === session.native_id),
  );
}

export function approvalAccess(ctx: ControlContext, p: Principal, approval: Approval): void {
  requireThat(p.role === 'user', 'permission_denied', 'Only the user can answer approvals');
  projectAccess(ctx, p, approval.project_id, 'approval.respond');
}

/** The caller checks that the approval is still pending. */
export function approvalBindingCurrent(ctx: ControlContext, approval: Approval): boolean {
  const session = ctx.store.get<Session>('sessions', approval.session_id!);
  return session !== undefined && session.state !== 'closed';
}

function voidApproval(
  ctx: ControlContext,
  approval: Approval,
  reason?: Approval['reason'],
  cause = '',
): void {
  if (approval.state !== 'pending') return;
  const next = ctx.store.update<Approval>(
    'approvals',
    { ...approval, state: 'void', reason },
    approval.revision,
  );
  ctx.store.event('approval.void', next, next.project_id, approvalEventPayload(next), cause);
  if (liveSessionHandle(ctx, next.session_id)) enqueueAnswer(ctx, next);
  closeRelay(ctx, next, cause);
}

/** The lead's board question that relays the approval to the user. */
export function relayingQuestion(
  ctx: ControlContext,
  approval: Approval,
): { plan: BoardPlan; question: LeadQuestion } | undefined {
  for (const plan of ctx.store.list<BoardPlan>('board_plans')) {
    const question =
      plan.project_id === approval.project_id &&
      plan.questions?.find((candidate) => candidate.source?.approval_id === approval.id);
    if (question) return { plan, question };
  }
}

/** Puts a task session's question on its lead's board, which answers the approval in turn. */
function relayQuestion(ctx: ControlContext, session: Session, approval: Approval): void {
  if (
    approval.tool !== 'AskUserQuestion' ||
    !approval.questions ||
    credentialRole(session, sessionWorkspaceKind(ctx, session)) !== 'worker'
  )
    return;
  const plan = ctx.store.get<BoardPlan>('board_plans', session.task!.lead_session_id);
  if (!plan) return;
  const first = approval.questions[0]!;
  askQuestion(ctx, plan, {
    question: first.question,
    options: first.options.map((option) => option.label),
    recommended: first.recommended ?? '',
    assumption: '',
    blocks: [session.task!.id],
    source: { session_id: session.id, approval_id: approval.id },
    questions: approval.questions,
  });
}

/** The plan of a worker's lead when the project's charter lets the lead approve this prompt at once. */
function leadApproves(
  ctx: ControlContext,
  session: Session,
  approval: Approval,
): BoardPlan | undefined {
  if (
    credentialRole(session, sessionWorkspaceKind(ctx, session)) !== 'worker' ||
    approval.tool === 'AskUserQuestion' ||
    approval.tool === 'ExitPlanMode' ||
    session.permission_mode === 'plan' ||
    // mustAsk cannot read the inputs of a runtime without verified isolation.
    isolationWaived(ctx, session.runtime) ||
    // mustAsk cannot see the part of the input the summary cut off.
    approval.input_summary?.endsWith('…') ||
    charterMode(ctx, session.project_id, 'approve_worker_prompts') !== 'on' ||
    mustAsk(ctx, session.project_id, approval)
  )
    return;
  return ctx.store.get<BoardPlan>('board_plans', session.task!.lead_session_id);
}

/** Prompts a lead's note lists by tool and input. */
const APPROVED_PROMPT_LINES = 5;

/** Keeps one unread note per task session of the prompts approved for its lead; it does not wake the lead. */
function notePromptsApproved(
  ctx: ControlContext,
  plan: BoardPlan,
  session: Session,
  approval: Approval,
): void {
  const index = plan.inbox.findIndex(
      (note) => note.kind === 'prompts_approved' && note.session_id === session.id,
    ),
    // From the first prompt's own time, so the count that replaces this note includes it.
    at = index < 0 ? approval.created_at : plan.inbox[index]!.at,
    approved =
      index < 0
        ? [approval]
        : ctx.store
            .list<Approval>('approvals')
            .filter(
              (a) => a.session_id === session.id && a.decider === 'lead' && a.created_at >= at,
            ),
    note: LeadNote = {
      at,
      session_id: session.id,
      task_id: session.task!.id,
      kind: 'prompts_approved',
      text: [
        `${approved.length} permission ${approved.length === 1 ? 'prompt' : 'prompts'} of this session approved on your behalf, as the project's charter allows; the latest:`,
        ...approved
          .slice(-APPROVED_PROMPT_LINES)
          .map((a) => `${a.tool ?? 'tool'} ${a.input_summary ?? ''}`.trim()),
      ].join('\n'),
    };
  if (index < 0) appendNote(ctx, plan, note);
  else
    ctx.store.update<BoardPlan>(
      'board_plans',
      {
        ...plan,
        inbox: plan.inbox.map((entry, position) =>
          position === index ? recordNote(ctx, plan, note) : entry,
        ),
      },
      plan.revision,
    );
}

/** Marks the board question relaying an approval answered once the approval is settled elsewhere. */
function closeRelay(ctx: ControlContext, approval: Approval, cause = ''): void {
  const relay = relayingQuestion(ctx, approval);
  if (!relay || relay.question.answer) return;
  answerQuestion(
    ctx,
    relay.plan,
    relay.question,
    Object.values(approval.answers ?? {}).join('\n') || approval.state,
    cause,
  );
}

function allowSessionRule(ctx: ControlContext, approval: Approval, cause: string): void {
  const session = ctx.store.must<Session>('sessions', approval.session_id!),
    rule = approval.rule!;
  if (session.allowed_rules?.includes(rule)) return;
  const next = ctx.store.update<Session>(
    'sessions',
    { ...session, allowed_rules: [...(session.allowed_rules ?? []), rule] },
    session.revision,
  );
  ctx.store.event('session.rule_allowed', next, next.project_id, { rule }, cause);
}

function enqueueAnswer(ctx: ControlContext, approval: Approval): void {
  ctx.store.enqueue('permission.answer', {
    approval_id: approval.id,
    session_id: approval.session_id,
    request_id: approval.request_id,
    decision: permissionDecision(approval),
  });
}

function permissionDecision(approval: Approval): PermissionDecision {
  if (approval.state !== 'approved') return 'deny';
  return approval.session_wide ? 'allow_session' : 'allow';
}

export function permissionRules(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): ProjectPermissionRule[] {
  projectAccess(ctx, p, projectId, 'project.read');
  return [...(ctx.store.must<Project>('projects', projectId).permission_rules ?? [])]
    .reverse()
    .sort((a, b) => b.added_at - a.added_at)
    .map((entry) => {
      const session = ctx.store.get<Session>('sessions', entry.session_id);
      return { ...entry, ...(session ? { session_title: session.title } : {}) };
    });
}

export function requestApproval(
  ctx: ControlContext,
  session: Session,
  event: Extract<AgentEvent, { kind: 'permission.requested' }>,
): void {
  if (session.review_id || session.runtime_review) {
    ctx.store.enqueue('permission.answer', {
      session_id: session.id,
      request_id: event.request_id,
      decision: 'deny',
    });
    ctx.store.event('permission.denied', session, session.project_id, {
      review_id: session.review_id,
      request_id: event.request_id,
      tool: event.tool,
      reason: 'reviewer_read_only',
    });
    return;
  }
  const inputHash = hash({ tool: event.tool, detail: event.detail }),
    previous = ctx.store
      .list<Approval>('approvals')
      .filter((a) => a.session_id === session.id && a.request_id === event.request_id)
      .at(-1);
  if (previous?.state === 'pending' && previous.input_hash === inputHash) {
    if (session.state === 'closed' || session.state === 'reconciling')
      voidApproval(ctx, previous, 'session_lost');
    return;
  }
  if (previous?.state === 'pending') voidApproval(ctx, previous, 'input_replaced');
  const createdAt = ctx.store.now();
  const inputSummary = approvalInputSummary(event.tool, event.detail);
  const input = detailInput(event.detail);
  // A rule from a truncated trace could cover more than the user saw.
  const rule =
    event.rule ??
    (event.tool &&
    !(input && typeof input === 'object' && 'truncated' in input && input.truncated === true)
      ? permissionRule(event.tool, input)
      : undefined);
  const questions =
    event.tool === 'AskUserQuestion'
      ? approvalQuestions.safeParse(
          event.detail && typeof event.detail === 'object' && 'questions' in event.detail
            ? event.detail.questions
            : undefined,
        )
      : undefined;
  const approval: Approval = {
    id: id(),
    revision: 1,
    project_id: session.project_id,
    kind: 'permission',
    session_id: session.id,
    ...(event.turn_id ? { turn_id: event.turn_id } : {}),
    request_id: event.request_id,
    ...(event.detail &&
    typeof event.detail === 'object' &&
    'tool_call_id' in event.detail &&
    typeof event.detail.tool_call_id === 'string'
      ? { tool_call_id: event.detail.tool_call_id }
      : {}),
    tool: event.tool,
    input_hash: inputHash,
    ...(inputSummary ? { input_summary: inputSummary } : {}),
    ...(rule ? { rule } : {}),
    ...(questions?.success ? { questions: questions.data } : {}),
    project_rule_supported:
      event.project_rule_supported === true &&
      !!rule &&
      event.tool !== 'AskUserQuestion' &&
      event.tool !== 'ExitPlanMode' &&
      session.permission_mode !== 'plan',
    decider: 'user',
    state: 'pending',
    created_at: createdAt,
  };
  ctx.store.insert('approvals', approval);
  ctx.store.event(
    'approval.requested',
    approval,
    approval.project_id,
    approvalEventPayload(approval),
  );
  if (session.state === 'closed' || session.state === 'reconciling')
    voidApproval(ctx, approval, 'session_lost');
  else {
    const projectRule =
      approval.project_rule_supported &&
      (ctx.store
        .must<Project>('projects', session.project_id)
        .permission_rules?.find((entry) => entry.rule === rule) ??
        projectDefaults(ctx.userConfigDir).permission_rules?.find((entry) => entry.rule === rule));
    const plan = projectRule ? undefined : leadApproves(ctx, session, approval);
    if (projectRule) {
      const next = ctx.store.update<Approval>(
        'approvals',
        { ...approval, state: 'approved', answered_by_rule: projectRule.rule },
        approval.revision,
      );
      ctx.store.event('approval.approved', next, next.project_id, approvalEventPayload(next));
      enqueueAnswer(ctx, next);
    } else if (plan) {
      const lead = `session:${plan.id}`;
      const next = ctx.store.update<Approval>(
        'approvals',
        { ...approval, state: 'approved', decider: 'lead', decided_by: lead },
        approval.revision,
      );
      ctx.store.event('approval.approved', next, next.project_id, approvalEventPayload(next));
      enqueueAnswer(ctx, next);
      chartered(
        ctx,
        { id: lead, role: 'lead', project_id: next.project_id, session_id: plan.id },
        'approve_worker_prompts',
        next,
      );
      notePromptsApproved(ctx, plan, session, next);
    } else {
      unsnooze(ctx, session.id, 'needs_you');
      relayQuestion(ctx, session, approval);
    }
  }
}

export function loseSessionApprovals(ctx: ControlContext, sessionId: string): void {
  for (const approval of ctx.store
    .list<Approval>('approvals')
    .filter((a) => a.session_id === sessionId && a.state === 'pending'))
    voidApproval(ctx, approval, 'session_lost');
}

export function recoverApprovals(ctx: ControlContext): void {
  for (const approval of ctx.store
    .list<Approval>('approvals')
    .filter((a) => a.state === 'pending')) {
    if (!liveSessionHandle(ctx, approval.session_id)) voidApproval(ctx, approval, 'session_lost');
    else if (!approvalBindingCurrent(ctx, approval)) voidApproval(ctx, approval);
  }
}

export function resolvePermission(
  ctx: ControlContext,
  session: Session,
  event: Extract<AgentEvent, { kind: 'permission.resolved' }>,
): void {
  const approval = ctx.store
    .list<Approval>('approvals')
    .filter((a) => a.session_id === session.id && a.request_id === event.request_id)
    .at(-1);
  if (!approval || approval.resolved_at !== undefined) return;
  // A request the adapter withdrew was lost, not rejected by the user; an answer to it never arrived.
  const withdrawn = approval.state !== 'void' && event.cancelled === true;
  const next = ctx.store.update<Approval>(
    'approvals',
    {
      ...approval,
      state: withdrawn
        ? 'void'
        : approval.state === 'pending'
          ? event.decision === 'deny'
            ? 'rejected'
            : 'approved'
          : approval.state,
      ...(withdrawn ? { reason: 'session_lost' as const } : {}),
      resolved_at: ctx.store.now(),
    },
    approval.revision,
  );
  ctx.store.event('approval.resolved', next, next.project_id, approvalEventPayload(next));
  closeRelay(ctx, next);
}

export type PermissionAnswer = { approval_id: string } | { session_id: string; request_id: string };

/** Keeps the latest delivery failure of an answer on its approval; undefined clears it. */
export function recordAnswerDelivery(
  ctx: ControlContext,
  answer: PermissionAnswer,
  error?: string,
): void {
  if (!('approval_id' in answer)) return;
  const approval = ctx.store.get<Approval>('approvals', answer.approval_id);
  if (!approval || approval.delivery_error === error) return;
  const { delivery_error, ...rest } = approval;
  ctx.store.transaction(() => {
    const next = ctx.store.update<Approval>(
      'approvals',
      error === undefined ? rest : { ...rest, delivery_error: error },
      approval.revision,
    );
    ctx.store.event(
      error === undefined ? 'approval.delivered' : 'approval.delivery_failed',
      next,
      next.project_id,
      approvalEventPayload(next),
    );
  });
}

export async function deliverPermissionAnswer(
  ctx: ControlContext,
  answer: PermissionAnswer,
): Promise<Receipt> {
  if (!('approval_id' in answer)) {
    const session = ctx.store.must<Session>('sessions', answer.session_id),
      handle = liveSessionHandle(ctx, session.id);
    if (!(session.review_id || session.runtime_review) || !handle) return { ok: true };
    return sessionAdapter(ctx, session)!.answerPermission(handle, answer.request_id, 'deny');
  }
  let approval = ctx.store.must<Approval>('approvals', answer.approval_id);
  const handle = liveSessionHandle(ctx, approval.session_id),
    latest = ctx.store
      .list<Approval>('approvals')
      .filter((a) => a.session_id === approval.session_id && a.request_id === approval.request_id)
      .at(-1);
  if (latest?.id !== approval.id || approval.resolved_at !== undefined) return { ok: true };
  const session = ctx.store.must<Session>('sessions', approval.session_id!);
  if (
    approval.state === 'approved' &&
    (!approvalBindingCurrent(ctx, approval) || session.state !== 'running')
  ) {
    ctx.store.transaction(() => {
      const next = ctx.store.update<Approval>(
        'approvals',
        { ...approval, state: 'rejected', reason: 'session_lost' },
        approval.revision,
      );
      ctx.store.event('approval.rejected', next, next.project_id, approvalEventPayload(next));
      approval = next;
    });
  }
  if (!['approved', 'rejected', 'void'].includes(approval.state)) return { ok: true };
  // An ended session has no process the answer could still reach.
  if (!handle && (session.state === 'closed' || session.outcome || session.archived_at))
    return { ok: true };
  if (!handle)
    return {
      ok: false,
      reason: 'The session process is not running, so the answer cannot reach it',
    };
  const adapter = sessionAdapter(ctx, session)!,
    decision = permissionDecision(approval);
  const requestId = approval.request_id!;
  // Trailing arguments are passed only when present.
  const receipt = await (decision === 'deny' && approval.decision_reason
    ? adapter.answerPermission(handle, requestId, decision, undefined, approval.decision_reason)
    : decision !== 'deny' && approval.answers
      ? adapter.answerPermission(handle, requestId, decision, approval.answers)
      : adapter.answerPermission(handle, requestId, decision));
  if (receipt.refused && decision !== 'deny') {
    // The runtime still holds the request, so it stays open for another answer.
    const current = ctx.store.must<Approval>('approvals', approval.id);
    if (current.state === 'approved' && current.resolved_at === undefined)
      ctx.store.transaction(() => {
        const { decided_by, session_wide, project_wide, answers, delivery_error, ...rest } =
          current;
        const next = ctx.store.update<Approval>(
          'approvals',
          {
            ...rest,
            state: 'pending',
            decider: 'user',
            refused: { decision, reason: receipt.reason ?? 'The runtime refused this answer' },
          },
          current.revision,
        );
        ctx.store.event('approval.refused', next, next.project_id, approvalEventPayload(next));
      });
    return receipt;
  }
  // approval.respond already stored ask; the live native session follows once the plan is accepted.
  if (
    receipt.ok &&
    decision !== 'deny' &&
    approval.tool === 'ExitPlanMode' &&
    adapter.setPermissionMode &&
    ctx.store.must<Session>('sessions', session.id).permission_mode === 'ask'
  )
    await adapter.setPermissionMode(handle, 'ask');
  return receipt;
}

export const approvalHandlers: Handlers = {
  'permission.rule.add': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only the user can add permission rules');
    const { project_id, rule, session_id } = c.input as ReturnType<
      (typeof inputSchemas)['permission.rule.add']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    const project = ctx.store.must<Project>('projects', project_id);
    if (project.permission_rules?.some((entry) => entry.rule === rule)) return project;
    const entry = { rule, session_id, added_at: ctx.store.now() };
    const next = ctx.store.update<Project>(
      'projects',
      { ...project, permission_rules: [...(project.permission_rules ?? []), entry] },
      project.revision,
    );
    ctx.store.event('project.rule_allowed', next, project_id, entry, c.command_id);
    return next;
  },
  'permission.rule.remove': (ctx, p, c) => {
    requireThat(
      p.role === 'user',
      'permission_denied',
      'Only the user can remove permission rules',
    );
    const { project_id, rule } = c.input as ReturnType<
      (typeof inputSchemas)['permission.rule.remove']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    const project = ctx.store.must<Project>('projects', project_id);
    const next = ctx.store.update<Project>(
      'projects',
      {
        ...project,
        permission_rules: (project.permission_rules ?? []).filter((entry) => entry.rule !== rule),
      },
      project.revision,
    );
    ctx.store.event('project.rule_removed', next, project_id, { rule }, c.command_id);
    return next;
  },
  'permission.globalRule.add': (ctx, p, c) => {
    userOnly(p);
    const { rule } = inputSchemas['permission.globalRule.add'].parse(c.input),
      dir = userConfigDirectory(ctx),
      defaults = projectDefaults(dir),
      rules = defaults.permission_rules ?? [];
    if (rules.some((entry) => entry.rule === rule)) return rules;
    const entry = { rule, added_at: ctx.store.now() };
    writeUserConfig(dir, {
      project_defaults: { ...defaults, permission_rules: [...rules, entry] },
    });
    ctx.store.event(
      'permission.global_rule_allowed',
      { id: 'project.defaults', revision: 1 },
      '',
      entry,
      c.command_id,
    );
    return [...rules, entry];
  },
  'permission.globalRule.remove': (ctx, p, c) => {
    userOnly(p);
    const { rule } = inputSchemas['permission.globalRule.remove'].parse(c.input),
      dir = userConfigDirectory(ctx),
      { permission_rules, ...rest } = projectDefaults(dir),
      rules = (permission_rules ?? []).filter((entry) => entry.rule !== rule);
    writeUserConfig(dir, {
      project_defaults: rules.length ? { ...rest, permission_rules: rules } : rest,
    });
    ctx.store.event(
      'permission.global_rule_removed',
      { id: 'project.defaults', revision: 1 },
      '',
      { rule },
      c.command_id,
    );
    return rules;
  },
  'approval.respond': (ctx, p, c) => {
    const { approval_id, ...answer } = inputSchemas['approval.respond'].parse(c.input);
    return answerApproval(
      ctx,
      p,
      ctx.store.must<Approval>('approvals', approval_id),
      answer,
      c.command_id,
      c,
    );
  },
};

/**
 * Writes the decision and any answers into the approval and queues them for its runtime.
 * With a command, the approval must have the revision the command expects.
 */
export function answerApproval(
  ctx: ControlContext,
  p: Principal,
  approval: Approval,
  {
    decision,
    reason,
    answers,
  }: Omit<ReturnType<(typeof inputSchemas)['approval.respond']['parse']>, 'approval_id'>,
  cause: string,
  expected?: Command,
): Approval | { error: 'revision_conflict'; message: string } {
  approvalAccess(ctx, p, approval);
  const asking = approval.tool === 'AskUserQuestion';
  requireThat(!answers || asking, 'invalid_input', 'Only an AskUserQuestion request has answers');
  requireThat(
    !asking || decision === 'reject' || (decision === 'approve' && answers),
    'invalid_input',
    'An AskUserQuestion request is approved once, with answers',
  );
  requireThat(
    !answers || (approval.questions ?? []).every((q) => answers[q.question]?.trim()),
    'invalid_input',
    'Every question needs an answer',
  );
  requireThat(
    decision !== 'approve_session' || (approval.kind === 'permission' && approval.rule),
    'invalid_input',
    'Only a tool permission request can be allowed for the session',
  );
  requireThat(
    decision !== 'approve_project' || approval.project_rule_supported,
    'invalid_input',
    'This request cannot be allowed for the project',
  );
  requireThat(approval.state === 'pending', 'approval_not_pending', 'Approval is not pending');
  requireThat(
    approval.refused?.decision !==
      (decision === 'reject' ? 'deny' : decision === 'approve_session' ? 'allow_session' : 'allow'),
    'invalid_input',
    approval.refused?.reason ?? '',
  );
  if (!approvalBindingCurrent(ctx, approval)) {
    voidApproval(ctx, approval, undefined, cause);
    return { error: 'revision_conflict', message: 'Approval binding has changed' };
  }
  if (expected) revision(ctx, expected, approval);
  const { refused, ...answered } = approval;
  const next = ctx.store.update<Approval>(
    'approvals',
    {
      ...answered,
      state: decision === 'reject' ? 'rejected' : 'approved',
      decided_by: p.id,
      ...(decision === 'approve_session' ? { session_wide: true } : {}),
      ...(decision === 'approve_project' ? { project_wide: true } : {}),
      ...(reason ? { decision_reason: reason } : {}),
      ...(answers ? { answers } : {}),
    },
    approval.revision,
  );
  if (decision === 'approve_session') allowSessionRule(ctx, next, cause);
  if (decision === 'approve_project') {
    const project = ctx.store.must<Project>('projects', next.project_id);
    if (!project.permission_rules?.some((entry) => entry.rule === next.rule)) {
      const entry = { rule: next.rule!, session_id: next.session_id!, added_at: ctx.store.now() };
      const updated = ctx.store.update<Project>(
        'projects',
        { ...project, permission_rules: [...(project.permission_rules ?? []), entry] },
        project.revision,
      );
      ctx.store.event('project.rule_allowed', updated, project.id, entry, cause);
    }
  }
  const session = ctx.store.must<Session>('sessions', next.session_id!);
  if (
    next.state === 'approved' &&
    next.tool === 'ExitPlanMode' &&
    session.permission_mode === 'plan'
  ) {
    const exited = ctx.store.update<Session>(
      'sessions',
      { ...session, permission_mode: 'ask' },
      session.revision,
    );
    ctx.store.event(
      'session.permission_mode_changed',
      exited,
      exited.project_id,
      { permission_mode: 'ask' },
      cause,
    );
  }
  ctx.store.event(
    `approval.${next.state}`,
    next,
    next.project_id,
    approvalEventPayload(next),
    cause,
  );
  enqueueAnswer(ctx, next);
  closeRelay(ctx, next, cause);
  return next;
}
