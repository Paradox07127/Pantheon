import type { BoardPlan, MilestoneView, Session } from '@pantheon/domain';
import type { BoardMilestoneExtras, BoardTaskExtras } from '@pantheon/protocol';
import type { ControlContext } from './context.js';

/** Fields of a plan task's board row beyond those the board view builds itself. */
export function taskExtras(
  _ctx: ControlContext,
  _plan: BoardPlan,
  _task: BoardPlan['tasks'][number],
  _session: Session | undefined,
): BoardTaskExtras {
  return {};
}

/** Fields of a milestone's board row beyond those the board view builds itself. */
export function milestoneExtras(
  _ctx: ControlContext,
  _milestone: MilestoneView,
): BoardMilestoneExtras {
  return {};
}
