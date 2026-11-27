import type { ProjectLandingsRead, ProjectPlanHistory } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

export type { ProjectLandingsRead, ProjectPlanHistory };

const isHistory = (value: unknown): boolean =>
  !!value && Array.isArray((value as ProjectPlanHistory).revisions);
const isLandings = (value: unknown): boolean =>
  !!value && Array.isArray((value as ProjectLandingsRead).landings);

/** Events after which a plan revision may have been written. */
const PLAN_KINDS: ReadonlySet<string> = new Set(['project.plan_updated', 'project.plan_accepted']);

/**
 * Events after which a landing record may have been written. A branch landing writes no event of
 * its own; removing its worktree follows its end.
 */
const LANDING_KINDS: ReadonlySet<string> = new Set([
  'session.merged',
  'session.merge_blocked',
  'session.merge_cancelled',
  'session.merge_dropped',
  'workspace.removed',
]);

/** GET /v1/project.plan.history: every revision of the plan, newest first. */
export const usePlanHistory = (projectId: string | null) =>
  useProjectQuery<ProjectPlanHistory>('project.plan.history', projectId, isHistory, undefined, {
    kinds: PLAN_KINDS,
  });

/** GET /v1/project.landings.read: every landing attempt of the project, newest first. */
export const useLandingRecords = (projectId: string | null) =>
  useProjectQuery<ProjectLandingsRead>('project.landings.read', projectId, isLandings, undefined, {
    kinds: LANDING_KINDS,
  });
