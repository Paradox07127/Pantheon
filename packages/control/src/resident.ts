import {
  DomainError,
  id,
  requireThat,
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
import { transferPlan } from './board-plan.js';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { returnNotes } from './lead-inbox.js';
import { queueTurn, syncBrief, TAKEOVER_TEXT } from './task-tracking.js';
import { sessionDefaults } from './user-config.js';

type ResidentKind = NonNullable<Session['resident']>['kind'];

const TITLES: Record<ResidentKind, string> = { assistant: 'Assistant', triage: 'Triage' };

/** The project's session default runtime when it can run read-only, else the first installed one that can. */
function residentChoice(ctx: ControlContext, project: Project) {
  const defaults = sessionDefaults(ctx, project);
  const name = [defaults?.runtime, ...ctx.adapters.keys()].find((candidate) => {
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
  return name === defaults?.runtime
    ? { runtime: name, model: defaults.model, effort: defaults.effort }
    : { runtime: name };
}

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
  const residents = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.project_id === projectId && session.resident?.kind === kind);
  const open = residents.find((session) => !session.archived_at && session.state !== 'closed');
  if (open) return open;
  const project = ctx.store.must<Project>('projects', projectId);
  const choice = residentChoice(ctx, project);
  const session: Session = {
    id: id(),
    revision: 1,
    project_id: projectId,
    runtime: choice.runtime,
    device_id: 'local',
    state: 'open',
    turn_count: 0,
    title: TITLES[kind],
    resident: { kind },
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

export const residentHandlers: Handlers = {
  'resident.open': (ctx, p, c) => {
    const input = inputSchemas['resident.open'].parse(c.input);
    return openResident(ctx, p, input.project_id, input.kind, c.command_id);
  },
};
