import type { BoardPlan, MilestoneView, Session, SessionTurn } from '@pantheon/domain';
import type { BoardMilestoneExtras, BoardTaskExtras } from '@pantheon/protocol';
import { boardTaskId } from './board-plan.js';
import type { ControlContext } from './context.js';
import { milestoneEvidenceLevel } from './evidence-level.js';

/** Fields of a plan task's board row beyond those the board view builds itself. */
export function taskExtras(
  ctx: ControlContext,
  _plan: BoardPlan,
  _task: BoardPlan['tasks'][number],
  session: Session | undefined,
): BoardTaskExtras {
  return statusLineOf(ctx, session);
}

/** The session's status line while the turn that set it is the newest turn that started. */
export function statusLineOf(
  ctx: ControlContext,
  session: Session | undefined,
): Pick<BoardTaskExtras, 'status_line'> {
  if (!session?.status_line) return {};
  const line = session.status_line,
    id = session.id;
  const newest = ctx.store
    .list<SessionTurn>('session_turns')
    .findLast((turn) => turn.session_id === id && turn.state !== 'queued');
  return newest?.id === line.turn_id ? { status_line: { text: line.text, at: line.at } } : {};
}

/**
 * Fields of a milestone's board row beyond those the board view builds itself. refuted: the newest
 * refute of each assumption id of the owner plan.
 */
export function milestoneExtras(
  _ctx: ControlContext,
  milestone: MilestoneView,
  taskLevels: NonNullable<BoardTaskExtras['evidence_level']>[],
  plan?: BoardPlan,
  refuted?: Map<
    string,
    NonNullable<NonNullable<BoardMilestoneExtras['assumptions']>[number]['refuted']>
  >,
): BoardMilestoneExtras {
  const assumptions = (plan?.assumptions ?? []).flatMap((assumption) =>
    assumption.id && assumption.milestone === milestone.milestone.key
      ? [
          {
            id: assumption.id,
            text: assumption.text,
            affects: (assumption.affects ?? []).map((taskId) => boardTaskId(plan!.id, taskId)),
            ...(refuted?.has(assumption.id) ? { refuted: refuted.get(assumption.id)! } : {}),
          },
        ]
      : [],
  );
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
    ...(assumptions.length ? { assumptions } : {}),
  };
}
