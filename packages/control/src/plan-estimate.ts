import type { BoardPlan, Session } from '@pantheon/domain';
import type { BoardLaneEstimate } from '@pantheon/protocol';
import { taskSessions, taskState } from './board-plan.js';
import type { ControlContext } from './context.js';
import { reviewerRuntime } from './review.js';
import { verifierRuntime } from './runtime-vendor.js';
import { taskChoice, taskPath } from './task-dispatch.js';
import { taskWorkflow } from './workflow-engine.js';
import { workflowPolicy } from './workflow-policy.js';

type Role = BoardLaneEstimate['runtimes'][number]['role'];

/** The sessions, tokens and time of the lane's unfinished tasks. */
export function estimateLane(
  ctx: ControlContext,
  plan: BoardPlan,
  laneId: string,
): BoardLaneEstimate {
  const policy = workflowPolicy(ctx, plan.project_id),
    lead = ctx.store.must<Session>('sessions', plan.id);
  const tasks = plan.tasks.filter(
    (task) =>
      task.lane === laneId &&
      taskState(plan, task.id, taskSessions(ctx, plan.id, task.id), lead) !== 'done',
  );
  const byPart = { tasks: 0, reviews: 0, plan_review: 0, milestone_verify: 0 },
    budget = { total: 0, tasks: 0 },
    wall = { total: 0, tasks: 0 };
  let unknown = 0;
  const runtimes = new Map<string, BoardLaneEstimate['runtimes'][number]>();
  const count = (role: Role, runtime: string | undefined, sessions: number) => {
    if (!runtime || !sessions) return;
    const key = JSON.stringify([role, runtime]),
      entry = runtimes.get(key) ?? { role, runtime, count: 0 };
    entry.count += sessions;
    runtimes.set(key, entry);
  };
  // The writer runtimes of each plan milestone's tasks, which its verifier differs from.
  const milestoneWriters = new Map<string, Set<string>>();
  for (const task of tasks) {
    const path = taskPath(ctx, plan.project_id, task),
      definition = taskWorkflow(ctx, plan, task.id).definition,
      choice = taskChoice(ctx, plan, task);
    const writers = path === 'direct' ? 0 : path === 'parallel' ? task.parallel!.length : 1;
    byPart.tasks += writers;
    count('writer', choice.runtime, writers);
    if (path === 'review_loop') {
      byPart.reviews += definition.review.max_rounds;
      count(
        'reviewer',
        reviewerRuntime(ctx, plan.project_id, choice.runtime),
        definition.review.max_rounds,
      );
    }
    if (task.kind && definition.plan_review.tiers.includes(task.kind.tier)) byPart.plan_review = 1;
    if (task.milestone)
      milestoneWriters.set(
        task.milestone,
        (milestoneWriters.get(task.milestone) ?? new Set()).add(
          path === 'direct' ? lead.runtime : choice.runtime,
        ),
      );
    const limit = task.kind ? policy.budget[task.kind.tier]?.[path] : undefined;
    if (limit) {
      budget.total += limit.input_tokens;
      budget.tasks++;
    } else unknown++;
    if (limit) {
      wall.total += limit.wall_ms;
      wall.tasks++;
    }
  }
  if (byPart.plan_review)
    count('reviewer', reviewerRuntime(ctx, plan.project_id, lead.runtime), byPart.plan_review);
  if (policy.milestone_verify === 'auto')
    for (const writers of milestoneWriters.values()) {
      byPart.milestone_verify++;
      count('verifier', verifierRuntime(ctx, plan.project_id, [...writers])?.runtime, 1);
    }
  return {
    tasks: tasks.length,
    milestones: milestoneWriters.size,
    sessions: {
      total: byPart.tasks + byPart.reviews + byPart.plan_review + byPart.milestone_verify,
      by_part: byPart,
    },
    tokens: { history: { total: 0, tasks: 0, min_n: 0 }, budget, unknown_tasks: unknown },
    ...(wall.tasks ? { wall_ms: wall } : {}),
    runtimes: [...runtimes.values()],
  };
}
