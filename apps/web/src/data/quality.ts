import type { ReviewMetrics } from '@pantheon/domain';
import type { ProjectGatesHistory } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

const isHistory = (value: unknown): boolean =>
  Array.isArray((value as { runs?: unknown } | null)?.runs);

const historyParams = { limit: '100' };

/** The project's newest gate runs, of its sessions and its branch landings. */
export function useGateHistory(projectId: string | null) {
  return useProjectQuery<ProjectGatesHistory>(
    'project.gates.history',
    projectId,
    isHistory,
    historyParams,
  );
}

/** One row per reviewer runtime of the project's reviews. */
export function useReviewMetrics(projectId: string | null) {
  return useProjectQuery<ReviewMetrics[]>('project.review.metrics', projectId, Array.isArray);
}
