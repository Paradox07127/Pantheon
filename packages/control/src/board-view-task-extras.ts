import type { BoardPlan, MilestoneView, Session } from '@pantheon/domain';
import type { BoardMilestoneExtras, BoardTaskExtras } from '@pantheon/protocol';
import type { ControlContext } from './context.js';
import { milestoneEvidenceLevel } from './evidence-level.js';

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
  milestone: MilestoneView,
  taskLevels: NonNullable<BoardTaskExtras['evidence_level']>[],
): BoardMilestoneExtras {
  const level = milestoneEvidenceLevel({
    status: milestone.status,
    acceptance_actor: milestone.milestone.acceptance?.actor,
    verification_state: milestone.verification?.state,
    tasks: taskLevels,
    done_tasks: milestone.tasks?.done,
  });
  return {
    ...(milestone.verification ? { verification: milestone.verification } : {}),
    ...(milestone.milestone.goal_id ? { goal_id: milestone.milestone.goal_id } : {}),
    ...(level ? { evidence_level: level } : {}),
  };
}
