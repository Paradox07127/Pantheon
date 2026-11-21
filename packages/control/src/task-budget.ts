import type {
  BoardPlan,
  FlowPath,
  Session,
  SessionTurn,
  TaskBudget,
  TaskKind,
} from '@pantheon/domain';
import { awaitingChange, taskGeneration } from './board-plan.js';
import type { ControlContext } from './context.js';
import { firstPlannedAt, leadTurnsWithin, leadWakes, ratioToBudget } from './retrospective.js';
import { taskPath } from './task-dispatch.js';
import { turnInputTokens } from './turn-usage.js';
import { workflowPolicy } from './workflow-policy.js';

type LeadEvent = Parameters<typeof leadTurnsWithin>[3][number];

export interface TaskBudgetUse {
  ratio: number;
  input_tokens: number;
  wall_ms: number;
  limit: TaskBudget;
  path: FlowPath;
  tier: TaskKind['tier'];
}

/**
 * What the task's current generation spent by `now` of the budget of its tier and path, counted as
 * its retrospective counts it; undefined before it starts or without a budget.
 */
export function taskBudgetUse(
  ctx: ControlContext,
  plan: BoardPlan,
  taskId: string,
  now: number,
): TaskBudgetUse | undefined {
  const task = plan.tasks.find((each) => each.id === taskId),
    tier = task?.kind?.tier;
  const cells = tier && workflowPolicy(ctx, plan.project_id).budget[tier];
  if (!task || !tier || !cells) return;
  const generation = taskGeneration(plan, taskId),
    lead = ctx.store.get<Session>('sessions', plan.id);
  const direct = lead?.direct_task?.id === taskId && lead.direct_task.generation === generation;
  const path: FlowPath = direct
    ? 'direct'
    : taskPath(ctx, plan.project_id, task) === 'review_loop'
      ? 'review_loop'
      : 'dispatch';
  const limit = cells[path];
  if (!limit) return;
  const ids = direct
    ? []
    : ctx.store
        .list<Session>('sessions')
        .filter(
          (session) =>
            session.task?.lead_session_id === plan.id &&
            session.task.id === taskId &&
            ((session.task.generation ?? 1) === generation || awaitingChange(plan, session)),
        )
        .map((session) => session.id);
  // No budget is spent before the lead's claim of a direct task or the dispatch of another.
  const starts = ctx.store
    .kindEvents(plan.project_id, [direct ? 'task.claimed' : 'task.dispatched'])
    .filter((event) => {
      const payload = event.payload as {
        task_id?: string;
        generation?: number;
        session_id?: string;
      };
      return (
        event.aggregate_id === plan.id &&
        (direct
          ? payload.task_id === taskId && payload.generation === generation
          : ids.includes(payload.session_id!))
      );
    });
  const claim = starts.at(-1) as LeadEvent | undefined;
  if (!claim) return;
  const planned = firstPlannedAt(ctx, plan, taskId, generation);
  // As the retrospective counts: a direct task from its last claim, another from its plan write.
  const start = direct ? claim.created_at : (planned ?? starts[0]!.created_at);
  const allTurns = ctx.store.list<SessionTurn>('session_turns');
  const woken = leadWakes(ctx, plan, taskId, planned ?? 0);
  const leadTurns = allTurns.filter(
    (turn) => woken.includes(turn.id) && !['queued', 'running'].includes(turn.state),
  );
  // The direct task's work runs from the claim until now, past every event so far.
  if (direct)
    for (const turn of leadTurnsWithin(ctx, plan.id, allTurns, [
      claim,
      { ...claim, sequence: Number.MAX_SAFE_INTEGER },
    ]).ended)
      if (!woken.includes(turn.id)) leadTurns.push(turn);
  const inputTokens =
    leadTurns.reduce((sum, turn) => sum + (turn.usage?.input_tokens ?? 0), 0) +
    (direct
      ? 0
      : turnInputTokens(ctx, { project_id: plan.project_id, session_ids: ids, since: 0 }).reduce(
          (sum, turn) => sum + turn.input_tokens,
          0,
        ));
  const wallMs = Math.max(0, now - start);
  return {
    ratio: ratioToBudget(inputTokens, wallMs, limit),
    input_tokens: inputTokens,
    wall_ms: wallMs,
    limit,
    path,
    tier,
  };
}
