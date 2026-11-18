import {
  DomainError,
  id,
  requireThat,
  type AgentFields,
  type AgentProfile,
  type BoardPlan,
  type Improvement,
  type Principal,
  type Project,
  type Retrospective,
  type Review,
  type Session,
  type SessionTurn,
  type StepRun,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { runtime } from './admission.js';
import { BOARD_READ_ONLY_TEMPLATES } from './agent-prompts.js';
import { residentPlan, routineOf, scheduleRoutine } from './agent-always-on.js';
import { AGENT_TEMPLATES, BUILT_IN_TEMPLATES } from './agent-templates.js';
import { checkAgentFields, ensureAgents } from './agents.js';
import { usageLimitWaiting } from './continuation.js';
import { transferPlan } from './board-plan.js';
import {
  actsAsUser,
  projectAccess,
  sessionAdapter,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { returnNotes } from './lead-inbox.js';
import { personalHome } from './personal-agent.js';
import { acceptInput, nativeTurnActive, releaseIdleConversation, unsnooze } from './session.js';
import { queueTurn, syncBrief, TAKEOVER_TEXT } from './task-tracking.js';
import { sessionDefaults } from './user-config.js';
import { afterCommit, changeModel } from './workbench-session.js';

type BuiltInKind = (typeof BUILT_IN_TEMPLATES)[number];

/**
 * The profile's runtime when it can run read-only, else the project's session default runtime when
 * it can, else the first installed one that can.
 */
function residentChoice(ctx: ControlContext, project: Project, profile: AgentProfile) {
  const defaults = sessionDefaults(ctx, project);
  const name = [profile.runtime, defaults?.runtime, ...ctx.adapters.keys()].find((candidate) => {
    if (candidate === undefined) return false;
    try {
      runtime(ctx, candidate, 'reviewer');
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  });
  requireThat(name, 'unsupported_capability', 'No installed runtime can run a read-only session');
  return name === profile.runtime
    ? { runtime: name, model: profile.model, effort: profile.effort }
    : name === defaults?.runtime
      ? { runtime: name, model: defaults.model, effort: defaults.effort }
      : { runtime: name };
}

export const openOf = (ctx: ControlContext, profile: AgentProfile) =>
  ctx.store
    .list<Session>('sessions')
    .find(
      (session) =>
        session.resident?.agent_id === profile.id &&
        !session.archived_at &&
        session.state !== 'closed',
    );

/** The project's open resident session of the built-in kind, as openAgent opens it. */
export function openResident(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  kind: BuiltInKind,
  cause: string,
): Session {
  actsAsUser(p);
  // A personal principal opens a resident only to send it a request.
  projectAccess(ctx, p, projectId, p.role === 'personal' ? 'request.send' : 'resident.open');
  return openAgent(
    ctx,
    ensureAgents(ctx, projectId).find((agent) => agent.template === kind)!,
    cause,
  );
}

/**
 * The agent's open resident session. Without one it opens a new one, which takes over the plan of
 * the agent's newest closed one, with the notes its undelivered turns had taken; after a handoff its
 * first turn names the closed session and the handoff note.
 */
export function openAgent(
  ctx: ControlContext,
  profile: AgentProfile,
  cause: string,
  handoff = false,
): Session {
  requireThat(!profile.archived_at, 'invalid_state', 'Unarchive the agent first');
  const projectId = profile.project_id;
  const open = openOf(ctx, profile);
  if (open) return open;
  const residents = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.resident?.agent_id === profile.id);
  const project = ctx.store.must<Project>('projects', projectId);
  const choice = residentChoice(ctx, project, profile);
  const session: Session = {
    id: id(),
    revision: 1,
    project_id: projectId,
    runtime: choice.runtime,
    device_id: 'local',
    state: 'open',
    turn_count: 0,
    title: profile.name,
    resident: { kind: profile.template, agent_id: profile.id },
    ...(choice.model !== undefined && { requested_model: choice.model }),
    ...(choice.effort !== undefined && { requested_effort: choice.effort }),
  };
  ctx.store.insert('sessions', session);
  ctx.store.event('session.opened', session, projectId, { purpose: 'resident' }, cause);
  const ended = residents
    .filter((resident) => resident.state === 'closed')
    .map((resident) => ctx.store.get<BoardPlan>('board_plans', resident.id))
    .filter((plan) => plan !== undefined)
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  if (!ended) return session;
  returnNotes(
    ctx,
    ended.id,
    ctx.store
      .list<SessionTurn>('session_turns')
      .filter(
        (turn) =>
          turn.session_id === ended.id && turn.state === 'queued' && turn.delivery === 'pending',
      ),
  );
  transferPlan(ctx, ctx.store.must<BoardPlan>('board_plans', ended.id), session.id, cause);
  takeOverReferences(ctx, ended.id, session.id);
  // The personal agent keeps no board or memory to take over; it reads live state again.
  if (profile.template === 'personal') return ctx.store.must<Session>('sessions', session.id);
  queueTurn(
    ctx,
    ctx.store.must<Session>('sessions', session.id),
    [
      TAKEOVER_TEXT,
      ...(handoff
        ? [
            `That session, ${ended.id}, ended because its context was nearly full; read it with session_read when you need more of it.`,
            `It left the handoff note ${handoffKey(profile)} in project memory: read it with memory_get or memory_search before you act on anything.`,
          ]
        : []),
      syncBrief(
        ctx,
        ctx.store.must<BoardPlan>('board_plans', session.id),
        [],
        BOARD_READ_ONLY_TEMPLATES.includes(profile.template),
      ),
    ].join('\n'),
    'sync',
    cause,
  );
  return ctx.store.must<Session>('sessions', session.id);
}

/** Points the reviews, step runs, retrospectives and improvements of the old lead to the new one. */
function takeOverReferences(ctx: ControlContext, from: string, to: string): void {
  for (const review of ctx.store.list<Review>('reviews'))
    if (review.requester?.lead_session_id === from)
      ctx.store.update(
        'reviews',
        { ...review, requester: { ...review.requester, lead_session_id: to } },
        review.revision,
      );
  for (const table of ['workflow_step_runs', 'retrospectives', 'improvements'] as const)
    for (const row of ctx.store.list<StepRun | Retrospective | Improvement>(table))
      if (row.lead_session_id === from)
        ctx.store.update(table, { ...row, lead_session_id: to }, row.revision);
}

/**
 * Ends the idle resident session: its idle native conversation closes, and it takes no more input.
 * Its plan stays for the successor openResident opens.
 */
function closeResident(
  ctx: ControlContext,
  session: Session,
  reason: 'agent_runtime_changed' | 'agent_archived' | 'context_full',
  cause: string,
): void {
  // The release only closes the process of an open session; its stop leaves a closed one closed.
  releaseIdleConversation(ctx, session);
  const next = ctx.store.update(
    'sessions',
    { ...session, state: 'closed' as const },
    session.revision,
  );
  ctx.store.event('session.closed', next, next.project_id, { reason }, cause);
  unsnooze(ctx, session.id, 'session_ended', cause);
}

/** A resident's context is full from this share of where its runtime compacts, else of its window. */
const CONTEXT_FULL_SHARE = 0.8;

const handoffKey = (profile: AgentProfile) => `handoff/${profile.id}`;

function contextFull(session: Session): boolean {
  const limit = session.auto_compact_at_tokens ?? session.usage?.context_window,
    used = session.usage?.context_tokens;
  return !!limit && used !== undefined && used >= CONTEXT_FULL_SHARE * limit;
}

const handoffText = (session: Session, profile: AgentProfile) =>
  [
    'Your context is nearly full: after this turn a new session of this agent takes over, without this conversation.',
    `Call guide with name "handoff" and follow it: write the handoff note with memory_propose under the key "${handoffKey(profile)}" and the title "Handoff from ${session.title ?? profile.name}".`,
  ].join('\n');

/**
 * Called when a turn of the session ended. Once a resident has no turn left and its context is
 * full, it queues the turn that writes the handoff note; once that turn and any queued after it
 * have ended, the session closes and a new one of its agent takes over.
 */
export function afterResidentTurn(ctx: ControlContext, sessionId: string, turnId: string): void {
  if (ctx.closing) return;
  const cause = `turn:${turnId}`;
  try {
    ctx.store.transaction(() => {
      const session = ctx.store.must<Session>('sessions', sessionId);
      if (
        !session.resident?.agent_id ||
        session.state !== 'open' ||
        usageLimitWaiting(ctx, session.id) ||
        ctx.store
          .list<SessionTurn>('session_turns')
          .some(
            (turn) =>
              turn.session_id === session.id &&
              (turn.state === 'queued' || turn.state === 'running'),
          )
      )
        return;
      const profile = ctx.store.must<AgentProfile>('agents', session.resident.agent_id);
      if (session.rotation) {
        // Without a plan the new session would have no takeover turn to name the handoff in.
        residentPlan(ctx, session);
        closeResident(ctx, session, 'context_full', cause);
        openAgent(ctx, profile, cause, true);
        return;
      }
      if (!contextFull(session)) return;
      acceptInput(ctx, session, 'send');
      const turn = queueTurn(ctx, session, handoffText(session, profile), 'tracker', cause);
      const queued = ctx.store.must<Session>('sessions', session.id);
      ctx.store.update(
        'sessions',
        { ...queued, rotation: { flush_turn_id: turn.id, at: ctx.store.now() } },
        queued.revision,
      );
    });
  } catch (error) {
    // Left as it is, the session tries again when its next turn ends.
    if (!(error instanceof DomainError)) throw error;
  }
}

/** Creates the agent with its routines; its session opens on its first message or trigger. */
export function createAgent(
  ctx: ControlContext,
  projectId: string,
  fields: AgentFields,
  createdBy: AgentProfile['created_by'],
  cause: string,
): AgentProfile {
  checkAgentFields(ctx, projectId, fields);
  const { routines, ...kept } = fields;
  const profile = ctx.store.insert<AgentProfile>('agents', {
    ...kept,
    id: id(),
    revision: 1,
    project_id: projectId,
    routines: routines
      ? routines.map(routineOf)
      : (AGENT_TEMPLATES[fields.template].routines ?? []),
    created_by: createdBy,
    created_at: ctx.store.now(),
  });
  ctx.store.event('agent_profile.created', profile, projectId, profile, cause);
  for (const routine of profile.routines) scheduleRoutine(ctx, profile, routine);
  return profile;
}

/** Changes the agent profile, and its open session as the change needs; the caller checks the revision. */
export function updateAgent(
  ctx: ControlContext,
  profile: AgentProfile,
  fields: Partial<Omit<AgentFields, 'contract'>> & { contract?: AgentFields['contract'] | null },
  cause: string,
): AgentProfile {
  const { contract, ...rest } = fields;
  checkAgentFields(ctx, profile.project_id, rest, profile);
  const open = openOf(ctx, profile);
  const moved =
    fields.runtime !== undefined && fields.runtime !== (open?.runtime ?? profile.runtime);
  if (moved)
    requireThat(
      !open || (open.state === 'open' && !nativeTurnActive(ctx, open)),
      'invalid_state',
      'Change the runtime between turns',
    );
  else if (open && (fields.model !== undefined || fields.effort !== undefined))
    requireThat(
      sessionAdapter(ctx, open)?.setModel ||
        (open.state !== 'running' && !nativeTurnActive(ctx, open)),
      'unsupported_capability',
      'Runtime cannot change the model during a turn',
    );
  const { model: _model, effort: _effort, ...kept } = profile;
  const { routines, ...changed } = rest;
  // Another runtime starts on its own default model unless one comes with it.
  const { contract: _contract, ...uncontracted } = moved ? kept : profile;
  const next = ctx.store.update<AgentProfile>(
    'agents',
    {
      ...(contract === null ? uncontracted : moved ? kept : profile),
      ...changed,
      ...(contract && { contract }),
      ...(routines && { routines: routines.map(routineOf) }),
    },
    profile.revision,
  );
  ctx.store.event(
    'agent_profile.updated',
    next,
    next.project_id,
    {
      ...changed,
      ...(contract !== undefined && { contract }),
      ...(routines && { routines: next.routines }),
    },
    cause,
  );
  if (routines) {
    for (const routine of profile.routines)
      if (!next.routines.some((each) => each.id === routine.id))
        scheduleRoutine(ctx, next, { ...routine, enabled: false });
    if (!next.archived_at) for (const routine of next.routines) scheduleRoutine(ctx, next, routine);
  }
  if (!open) return next;
  if (moved) {
    closeResident(
      ctx,
      ctx.store.must<Session>('sessions', open.id),
      'agent_runtime_changed',
      cause,
    );
    openAgent(ctx, next, cause);
    return next;
  }
  const model = next.model ?? open.requested_model;
  if ((fields.model !== undefined || fields.effort !== undefined) && model !== undefined)
    changeModel(ctx, open, model, next.effort, cause);
  if (fields.name !== undefined || fields.instructions !== undefined || fields.tools) {
    // An idle process keeps the instructions and tools it started with; the next input resumes it on the new ones.
    const committed = afterCommit(ctx);
    const completion = Promise.resolve()
      .then(() => {
        if (committed()) releaseIdleConversation(ctx, open);
      })
      .finally(() => ctx.completions.delete(completion));
    ctx.completions.add(completion);
  }
  return next;
}

/** The agent profile a user command names, once the user may act on its project. */
function userAgent(ctx: ControlContext, p: Principal, agentId: string, action: string) {
  userOnly(p);
  const profile = ctx.store.must<AgentProfile>('agents', agentId);
  projectAccess(ctx, p, profile.project_id, action);
  return profile;
}

export const residentHandlers: Handlers = {
  'resident.open': (ctx, p, c) => {
    const input = inputSchemas['resident.open'].parse(c.input);
    if ('kind' in input && input.kind === 'personal') {
      userOnly(p);
      return openAgent(ctx, personalHome(ctx, c.command_id).profile, c.command_id);
    }
    if ('kind' in input) return openResident(ctx, p, input.project_id, input.kind, c.command_id);
    return openAgent(ctx, userAgent(ctx, p, input.agent_id, c.type), c.command_id);
  },
  'agent.create': (ctx, p, c) => {
    userOnly(p);
    const { project_id, ...fields } = inputSchemas['agent.create'].parse(c.input);
    projectAccess(ctx, p, project_id, c.type);
    return createAgent(ctx, project_id, fields, { kind: 'user' }, c.command_id);
  },
  'agent.update': (ctx, p, c) => {
    const { agent_id, revision, ...fields } = inputSchemas['agent.update'].parse(c.input),
      profile = userAgent(ctx, p, agent_id, c.type);
    requireThat(
      revision === profile.revision,
      'revision_conflict',
      'Supply the current agent revision',
    );
    return updateAgent(ctx, profile, fields, c.command_id);
  },
  'agent.archive': (ctx, p, c) => {
    const input = inputSchemas['agent.archive'].parse(c.input),
      profile = userAgent(ctx, p, input.agent_id, c.type);
    requireThat(
      profile.template !== 'assistant',
      'invalid_input',
      'The assistant cannot be archived',
    );
    requireThat(!profile.archived_at, 'invalid_state', 'The agent is archived already');
    const open = openOf(ctx, profile);
    if (open) {
      requireThat(
        open.state === 'open' && !nativeTurnActive(ctx, open),
        'invalid_state',
        'Archive the agent between turns',
      );
      closeResident(ctx, open, 'agent_archived', c.command_id);
    }
    const next = ctx.store.update<AgentProfile>(
      'agents',
      { ...profile, archived_at: ctx.store.now() },
      profile.revision,
    );
    ctx.store.event(
      'agent_profile.updated',
      next,
      next.project_id,
      { archived_at: next.archived_at },
      c.command_id,
    );
    for (const routine of next.routines) scheduleRoutine(ctx, next, { ...routine, enabled: false });
    return next;
  },
  'agent.unarchive': (ctx, p, c) => {
    const input = inputSchemas['agent.unarchive'].parse(c.input),
      profile = userAgent(ctx, p, input.agent_id, c.type);
    requireThat(profile.archived_at, 'invalid_state', 'The agent is not archived');
    checkAgentFields(ctx, profile.project_id, { name: profile.name }, profile);
    const { archived_at: _archived, ...kept } = profile;
    const next = ctx.store.update<AgentProfile>('agents', kept, profile.revision);
    ctx.store.event(
      'agent_profile.updated',
      next,
      next.project_id,
      { archived_at: null },
      c.command_id,
    );
    for (const routine of next.routines) scheduleRoutine(ctx, next, routine);
    return next;
  },
};
