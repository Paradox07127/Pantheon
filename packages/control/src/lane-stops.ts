import { requireThat, type BoardPlan, type Principal } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { ownEntry, taskSessions, taskState } from './board-plan.js';
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
  return !!stop && stop.approved_at === undefined;
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
