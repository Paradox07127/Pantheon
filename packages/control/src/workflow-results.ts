import type { Retrospective, Review, Session, StepRun } from '@pantheon/domain';
import type { WorkflowStepResult } from '@pantheon/protocol';
import type { ControlContext } from './context.js';
import { boardTaskId } from './board-plan.js';
import { midnight } from './board-view.js';
import { gateFirstPass, latestRetrospectives } from './retrospective.js';

interface Attempt {
  at: number;
  ended: boolean;
  passed: boolean;
}

/**
 * One indexed read of durable outcomes; retry events preserve a step row's first end state. Step
 * runs count for their own workflow; those without a workflow id for the original one.
 */
export function workflowResults(
  ctx: ControlContext,
  projectId: string,
  workflowId: string,
  stepIds: Set<string>,
) {
  const now = ctx.store.now(),
    starts = Array.from({ length: 6 }, (_, index) => midnight(now, -29 + index * 5));
  const rows = ctx.store.db
    .prepare(
      `SELECT 'step' AS kind, data, json_extract(data,'$.created_at') AS at,
         (SELECT json_group_array(payload ->> '$.state' ORDER BY sequence)
          FROM events INDEXED BY events_aggregate
          WHERE aggregate_id=r.id AND kind='workflow.step_changed') AS states, NULL AS session_data
       FROM workflow_step_runs r WHERE json_extract(data,'$.project_id')=?
       UNION ALL
       SELECT 'review', r.data,
         (SELECT created_at FROM events INDEXED BY events_aggregate
          WHERE aggregate_id=r.id AND kind='review.requested' ORDER BY sequence LIMIT 1),
         NULL, s.data
       FROM reviews r LEFT JOIN sessions s ON s.id=json_extract(r.data,'$.session_id')
       WHERE json_extract(r.data,'$.project_id')=?
       UNION ALL
       SELECT 'gate', data, NULL, NULL, NULL FROM retrospectives
       WHERE json_extract(data,'$.project_id')=?`,
    )
    .all(projectId, projectId, projectId) as {
    kind: 'step' | 'review' | 'gate';
    data: string;
    at: number | null;
    states: string | null;
    session_data: string | null;
  }[];
  const steps = new Map<string, Map<string, Attempt>>(),
    reviews = new Map<string, Attempt>(),
    retrospectives: Retrospective[] = [];
  for (const row of rows) {
    if (row.kind === 'gate') {
      retrospectives.push(JSON.parse(row.data) as Retrospective);
      continue;
    }
    if (row.kind === 'step') {
      const run = JSON.parse(row.data) as StepRun;
      if (!stepIds.has(run.step.id) || (run.workflow_id ?? projectId) !== workflowId) continue;
      let state = run.state,
        previous: StepRun['state'] | undefined;
      for (const each of JSON.parse(row.states!) as StepRun['state'][]) {
        if (['passed', 'failed', 'rejected', 'retired'].includes(each)) {
          // A run retired while skipped never executed.
          state = each === 'retired' && previous === 'skipped' ? 'skipped' : each;
          break;
        }
        previous = each;
      }
      if (state === 'skipped') continue;
      const tasks = steps.get(run.step.id) ?? new Map<string, Attempt>(),
        key = boardTaskId(run.lead_session_id, run.task_id),
        first = tasks.get(key);
      steps.set(run.step.id, tasks);
      if (first && first.at <= run.created_at) continue;
      tasks.set(key, {
        at: run.created_at,
        ended: ['passed', 'failed', 'rejected', 'retired'].includes(state),
        passed: state === 'passed',
      });
    } else {
      const review = JSON.parse(row.data) as Review;
      if (!review.session_id || row.at === null) continue;
      const session = row.session_data ? (JSON.parse(row.session_data) as Session) : undefined,
        lead =
          review.requester?.lead_session_id ??
          session?.task?.lead_session_id ??
          (session?.direct_task ? session.id : undefined),
        task = review.requester?.task_id ?? session?.task?.id ?? session?.direct_task?.id,
        key = lead && task ? boardTaskId(lead, task) : review.session_id,
        first = reviews.get(key);
      if (first && first.at <= row.at) continue;
      reviews.set(key, {
        at: row.at,
        ended: review.state !== 'running',
        passed:
          review.state === 'completed' &&
          !review.incomplete &&
          !review.findings.some((finding) => finding.blocking && finding.status !== 'rejected'),
      });
    }
  }
  const result = (attempts: Iterable<Attempt>): WorkflowStepResult | undefined => {
    let counts: WorkflowStepResult | undefined;
    for (const attempt of attempts) {
      const bucket = starts.findLastIndex((start) => attempt.at >= start);
      if (!attempt.ended || bucket < 0 || attempt.at > now) continue;
      counts ??= {
        tasks: 0,
        passed: 0,
        buckets: starts.map(() => ({ tasks: 0, passed: 0 })),
      };
      counts.tasks++;
      counts.buckets[bucket]!.tasks++;
      if (attempt.passed) {
        counts.passed++;
        counts.buckets[bucket]!.passed++;
      }
    }
    return counts;
  };
  const step_results: Record<string, WorkflowStepResult> = {};
  for (const [id, tasks] of steps) {
    const counts = result(tasks.values());
    if (counts) step_results[id] = counts;
  }
  const latest = latestRetrospectives(retrospectives, projectId),
    gate = gateFirstPass(latest.values(), starts[0]!, now);
  return {
    ...(Object.keys(step_results).length ? { step_results } : {}),
    ...(gate
      ? {
          gate: {
            ...gate,
            buckets: starts.map(
              (start, index) =>
                gateFirstPass(latest.values(), start, (starts[index + 1] ?? now + 1) - 1) ?? {
                  tasks: 0,
                  passed: 0,
                },
            ),
          },
        }
      : {}),
    review: result(reviews.values()),
  };
}
