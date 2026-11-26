import type { ProjectPlanView } from '@pantheon/protocol';
import { REPOSITORY_KINDS, useProjectQuery } from './project-read';

export type { ProjectPlanView };

const isPlanView = (value: unknown): boolean => {
  const view = value as Partial<ProjectPlanView> | null;
  return (
    !!view && (view.plan === null || typeof view.plan === 'object') && Array.isArray(view.unplanned)
  );
};

/** Events that change the plan, a change row's stage or status, or the newest landing. */
const PLAN_KINDS: ReadonlySet<string> = new Set([
  'project.plan_updated',
  'project.plan_accepted',
  'session.opened',
  'session.closed',
  'session.renamed',
  'session.gate_started',
  'session.gate_checked',
  'session.gate_run_cancelled',
  'session.merge_started',
  'session.merge_blocked',
  'session.merge_cancelled',
  'session.spawner_notified',
  'turn.queued',
  'turn.running',
  'turn.failed',
  'turn.cancelled',
  'approval.requested',
  'approval.resolved',
  'review.completed',
  'review.failed',
  'review.verdict_recorded',
  'review.finding_recorded',
  'review.finding_resolved',
  ...REPOSITORY_KINDS,
]);

/** GET /v1/project.plan: the main agent's plan, the changes outside it and the newest landing. */
export function useProjectPlan(projectId: string | null) {
  return useProjectQuery<ProjectPlanView>('project.plan', projectId, isPlanView, undefined, {
    kinds: PLAN_KINDS,
  });
}
