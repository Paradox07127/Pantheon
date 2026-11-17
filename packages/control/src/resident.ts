import {
  DomainError,
  id,
  requireThat,
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
import { ensureAgents } from './agents.js';
import { transferPlan } from './board-plan.js';
import {
  projectAccess,
  sessionAdapter,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { returnNotes } from './lead-inbox.js';
import { nativeTurnActive, releaseIdleConversation, unsnooze } from './session.js';
import { queueTurn, syncBrief, TAKEOVER_TEXT } from './task-tracking.js';
import { sessionDefaults } from './user-config.js';
import { afterCommit, changeModel } from './workbench-session.js';

type ResidentKind = NonNullable<Session['resident']>['kind'];

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

const openOf = (ctx: ControlContext, profile: AgentProfile) =>
  ctx.store
    .list<Session>('sessions')
    .find(
      (session) =>
        session.resident?.agent_id === profile.id &&
        !session.archived_at &&
        session.state !== 'closed',
    );

/**
 * The project's open resident session of the kind. Without one it opens a new one, which takes over
 * the plan of the newest closed one, with the notes its undelivered turns had taken.
 */
export function openResident(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  kind: ResidentKind,
  cause: string,
): Session {
  userOnly(p);
  projectAccess(ctx, p, projectId, 'resident.open');
  const profile = ensureAgents(ctx, projectId).find((agent) => agent.template === kind)!;
  const residents = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.project_id === projectId && session.resident?.kind === kind);
  const open = residents.find((session) => !session.archived_at && session.state !== 'closed');
  if (open) return open;
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
    resident: { kind, agent_id: profile.id },
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
  queueTurn(
    ctx,
    ctx.store.must<Session>('sessions', session.id),
    `${TAKEOVER_TEXT}\n${syncBrief(ctx, ctx.store.must<BoardPlan>('board_plans', session.id), [])}`,
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
function closeResident(ctx: ControlContext, session: Session, cause: string): void {
  // The release only closes the process of an open session; its stop leaves a closed one closed.
  releaseIdleConversation(ctx, session);
  const next = ctx.store.update(
    'sessions',
    { ...session, state: 'closed' as const },
    session.revision,
  );
  ctx.store.event(
    'session.closed',
    next,
    next.project_id,
    { reason: 'agent_runtime_changed' },
    cause,
  );
  unsnooze(ctx, session.id, 'session_ended', cause);
}

export const residentHandlers: Handlers = {
  'resident.open': (ctx, p, c) => {
    const input = inputSchemas['resident.open'].parse(c.input);
    return openResident(ctx, p, input.project_id, input.kind, c.command_id);
  },
  'agent.update': (ctx, p, c) => {
    userOnly(p);
    const cause = c.command_id,
      input = inputSchemas['agent.update'].parse(c.input),
      profile = ctx.store.must<AgentProfile>('agents', input.agent_id);
    projectAccess(ctx, p, profile.project_id, c.type);
    requireThat(
      input.revision === profile.revision,
      'revision_conflict',
      'Supply the current agent revision',
    );
    const open = openOf(ctx, profile);
    const moved =
      input.runtime !== undefined && input.runtime !== (open?.runtime ?? profile.runtime);
    if (moved) {
      runtime(ctx, input.runtime!, 'reviewer');
      requireThat(
        !open || (open.state === 'open' && !nativeTurnActive(ctx, open)),
        'invalid_state',
        'Change the runtime between turns',
      );
    } else if (open && (input.model !== undefined || input.effort !== undefined))
      requireThat(
        sessionAdapter(ctx, open)?.setModel ||
          (open.state !== 'running' && !nativeTurnActive(ctx, open)),
        'unsupported_capability',
        'Runtime cannot change the model during a turn',
      );
    const { model: _model, effort: _effort, ...kept } = profile;
    const next = ctx.store.update<AgentProfile>(
      'agents',
      {
        // Another runtime starts on its own default model unless one comes with it.
        ...(moved ? kept : profile),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.instructions !== undefined && { instructions: input.instructions }),
        ...(input.runtime !== undefined && { runtime: input.runtime }),
        ...(input.model !== undefined && { model: input.model }),
        ...(input.effort !== undefined && { effort: input.effort }),
      },
      profile.revision,
    );
    const { agent_id: _id, revision: _revision, ...changed } = input;
    ctx.store.event('agent_profile.updated', next, next.project_id, changed, cause);
    if (!open) return next;
    if (moved) {
      closeResident(ctx, ctx.store.must<Session>('sessions', open.id), cause);
      openResident(ctx, p, next.project_id, next.template, cause);
      return next;
    }
    const model = next.model ?? open.requested_model;
    if ((input.model !== undefined || input.effort !== undefined) && model !== undefined)
      changeModel(ctx, open, model, next.effort, cause);
    if (input.name !== undefined || input.instructions !== undefined) {
      // An idle process keeps the instructions it started with; the next input resumes it on the new ones.
      const committed = afterCommit(ctx);
      const completion = Promise.resolve()
        .then(() => {
          if (committed()) releaseIdleConversation(ctx, open);
        })
        .finally(() => ctx.completions.delete(completion));
      ctx.completions.add(completion);
    }
    return next;
  },
};
