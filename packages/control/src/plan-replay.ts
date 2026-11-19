import type { BoardPlan, LeadQuestion, Milestone, PlanProposal, Principal } from '@pantheon/domain';
import type { PlanReplay, PlanReplayFrame, PlanReplayTaskStatus } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { taskGeneration } from './board-plan.js';

const REPLAY_KINDS: PlanReplayFrame['kind'][] = [
  'board.plan_updated',
  'lead.question_asked',
  'lead.question_answered',
  'lead.question_overruled',
  'board.plan_proposed',
  'board.plan_proposal_resolved',
  'board.plan_proposal_withdrawn',
  'task.dispatched',
  'session.merged',
  'task.accepted',
  'milestone.accepted',
];

/** The lead's plan events in sequence order, each with the plan's task statuses at that point. */
export function planReplay(
  ctx: ControlContext,
  principal: Principal,
  leadId: string,
  after: number,
  limit: number,
): PlanReplay {
  const projectId = ctx.store.must<BoardPlan>('board_plans', leadId).project_id;
  projectAccess(ctx, principal, projectId, 'project.read');
  let plan: BoardPlan | undefined;
  // By task id, with the task generation the status was reached in.
  const statuses = new Map<string, { status: PlanReplayTaskStatus; generation: number }>(),
    // The dispatched sessions of each task not merged yet, and the task each session was opened for.
    parts = new Map<string, Set<string>>(),
    sessionTask = new Map<string, string>(),
    frames: PlanReplayFrame[] = [];
  for (const event of ctx.store.kindEvents(projectId, REPLAY_KINDS)) {
    const p = event.payload as Record<string, unknown>,
      onPlan = event.aggregate_id === leadId;
    let taskId: string | undefined, text: string | undefined;
    if (event.kind === 'board.plan_updated') {
      if (!onPlan) continue;
      plan = event.payload as BoardPlan;
      text = plan.headline;
    } else if (event.kind.startsWith('lead.question_')) {
      if (!onPlan) continue;
      const question = event.payload as LeadQuestion;
      text = event.kind === 'lead.question_asked' ? question.question : question.answer?.text;
    } else if (event.kind.startsWith('board.plan_propos')) {
      if (!onPlan) continue;
      text = (event.payload as PlanProposal).reason;
    } else if (event.kind === 'task.dispatched') {
      if (!onPlan) continue;
      taskId = p.task_id as string;
      const sessions = (p.session_ids as string[] | undefined) ?? [p.session_id as string];
      for (const id of sessions) sessionTask.set(id, taskId);
      parts.set(taskId, new Set(sessions));
      statuses.set(taskId, { status: 'dispatched', generation: taskGeneration(plan, taskId) });
    } else if (event.kind === 'session.merged') {
      if (onPlan && p.direct === true) {
        taskId = p.task_id as string;
        statuses.set(taskId, { status: 'merged', generation: p.generation as number });
      } else {
        taskId = sessionTask.get(event.aggregate_id);
        if (!taskId) continue;
        const open = parts.get(taskId)!;
        open.delete(event.aggregate_id);
        const status = statuses.get(taskId)!;
        if (!open.size) statuses.set(taskId, { ...status, status: 'merged' });
      }
    } else if (event.kind === 'task.accepted') {
      if (!onPlan) continue;
      taskId = p.task_id as string;
      statuses.set(taskId, {
        status: 'accepted',
        generation: (p.generation as number | undefined) ?? 1,
      });
    } else {
      const milestone = event.payload as Milestone;
      if (milestone.owner_session_id !== leadId) continue;
      text = milestone.title;
    }
    if (event.sequence <= after) continue;
    if (frames.length === limit) return { frames, next_after: frames.at(-1)!.sequence };
    frames.push({
      sequence: event.sequence,
      at: event.created_at,
      kind: event.kind as PlanReplayFrame['kind'],
      ...(taskId ? { task_id: taskId } : {}),
      ...(text !== undefined ? { text } : {}),
      tasks: (plan?.tasks ?? []).map((task) => {
        const reached = statuses.get(task.id);
        return {
          id: task.id,
          title: task.title,
          lane: task.lane,
          depends_on: task.depends_on,
          status:
            reached && reached.generation === taskGeneration(plan, task.id)
              ? reached.status
              : 'planned',
        };
      }),
    });
  }
  return { frames, next_after: null };
}
