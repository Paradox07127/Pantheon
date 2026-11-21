import {
  requireThat,
  type BoardPlan,
  type LaneDepth,
  type LaneStop,
  type Principal,
} from '@pantheon/domain';
import { ownEntry, type ControlContext } from './context.js';
import { taskSessions, taskState } from './board-plan.js';
import { appendNote } from './lead-inbox.js';
import { personalKeyId } from './personal-scope.js';
import { wakeLead } from './task-tracking.js';

/**
 * The lanes a lead's write adds, new to both the plan and its stops, that have an unfinished t3
 * task; their tasks wait for the user's approval of the plan.
 */
export function firstPlanHolds(
  ctx: ControlContext,
  current: BoardPlan | undefined,
  next: Pick<BoardPlan, 'lanes' | 'tasks'>,
  principal: Principal,
): string[] {
  if (principal.role !== 'lead') return [];
  return next.lanes
    .filter(
      (lane) =>
        !current?.lanes.some((old) => old.id === lane.id) &&
        !ownEntry(current?.lane_stops, lane.id) &&
        next.tasks.some(
          (task) =>
            task.lane === lane.id &&
            task.kind?.tier === 't3' &&
            (!current ||
              taskState(current, task.id, taskSessions(ctx, current.id, task.id)) !== 'done'),
        ),
    )
    .map((lane) => lane.id);
}

/** True while the lane waits for the user's approval of its plan. */
export function laneHeld(plan: BoardPlan, laneId: string): boolean {
  const stop = ownEntry(plan.lane_stops, laneId);
  return stop?.held_at !== undefined && stop.approved_at === undefined;
}

/** The user's depth for the lane, else the lead's, else plan_first once Pantheon held it. */
export function effectiveDepth(
  plan: BoardPlan,
  lane: BoardPlan['lanes'][number],
): LaneDepth | undefined {
  const stop = ownEntry(plan.lane_stops, lane.id);
  return stop?.user_depth ?? lane.depth ?? (stop?.held_at !== undefined ? 'plan_first' : undefined);
}

/**
 * Sets the user's depth of a lane: just_do approves a held lane; plan_first and spec_first hold a
 * lane with tasks not yet opened. Running sessions keep running. Tells and wakes the lead.
 */
export function setLaneDepth(
  ctx: ControlContext,
  plan: BoardPlan,
  laneId: string,
  depth: LaneDepth,
  commandId: string,
): BoardPlan {
  const lane = plan.lanes.find((entry) => entry.id === laneId);
  requireThat(lane, 'not_found', `Not found: lane ${laneId}`);
  const from = effectiveDepth(plan, lane);
  const stop = ownEntry(plan.lane_stops, laneId),
    held = laneHeld(plan, laneId),
    now = ctx.store.now();
  const holds =
    depth !== 'just_do' &&
    !held &&
    plan.tasks.some((task) => {
      const sessions = taskSessions(ctx, plan.id, task.id);
      return (
        task.lane === laneId && !sessions.length && taskState(plan, task.id, sessions) !== 'done'
      );
    });
  const next: LaneStop = holds
    ? { held_at: now, plan_version: plan.plan_version }
    : depth === 'just_do' && held
      ? { ...stop, approved_at: now, approved_by: 'user', via: 'depth' }
      : { ...stop };
  const written = ctx.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      lane_stops: {
        ...plan.lane_stops,
        [laneId]: { ...next, user_depth: depth, user_depth_at: now },
      },
    },
    plan.revision,
  );
  ctx.store.event(
    'board.lane_depth_overridden',
    written,
    plan.project_id,
    { lane_id: laneId, from, to: depth },
    commandId,
  );
  const effect = laneHeld(written, laneId)
    ? ' Its tasks that have not started wait for the user to approve its plan; start_task queues them until then.'
    : held
      ? ' Its tasks start now.'
      : '';
  const noted = appendNote(
    ctx,
    written,
    {
      at: now,
      session_id: '',
      task_id: '',
      kind: 'user_edit',
      text: `The user set the depth of lane ${laneId} to ${depth}.${effect}`,
    },
    commandId,
  );
  wakeLead(ctx, noted, commandId);
  return ctx.store.must<BoardPlan>('board_plans', plan.id);
}

/** Approves the plan of a held lane, so its queued tasks open, and tells and wakes the lead. */
export function approveLane(
  ctx: ControlContext,
  p: Principal,
  plan: BoardPlan,
  laneId: string,
  commandId: string,
): BoardPlan {
  requireThat(
    laneHeld(plan, laneId),
    'not_found',
    `Not found: lane ${laneId} waiting for plan approval`,
  );
  const approved = ctx.store.update<BoardPlan>(
    'board_plans',
    {
      ...plan,
      lane_stops: {
        ...plan.lane_stops,
        [laneId]: {
          ...plan.lane_stops![laneId]!,
          approved_at: ctx.store.now(),
          approved_by: p.role === 'personal' ? 'personal' : 'user',
          via: 'approve',
        },
      },
    },
    plan.revision,
  );
  ctx.store.event('board.lane_approved', approved, plan.project_id, { lane_id: laneId }, commandId);
  const noted = appendNote(
    ctx,
    approved,
    {
      at: ctx.store.now(),
      session_id: '',
      task_id: '',
      kind: 'user_edit',
      text: `The user approved the plan of lane ${laneId}; its tasks start now.`,
      ...(p.role === 'personal' ? { via: { kind: 'personal', key_id: personalKeyId(p) } } : {}),
    },
    commandId,
  );
  wakeLead(ctx, noted, commandId);
  return ctx.store.must<BoardPlan>('board_plans', plan.id);
}
