import type { ProjectBaseline } from '@pantheon/domain';
import { useProjectQuery } from './project-read';

/** A project never assessed reads as null. */
const isBaseline = (value: unknown): boolean => {
  if (value === null) return true;
  const baseline = value as Partial<ProjectBaseline> | undefined;
  return !!baseline && typeof baseline.state === 'string' && typeof baseline.dropped === 'number';
};

/** GET /v1/project.baseline.read: the project's newest baseline, read again whenever the board moves. */
export function useBaselineRead(project_id: string | null) {
  return useProjectQuery<ProjectBaseline>(
    'project.baseline.read',
    project_id,
    isBaseline,
    undefined,
    { events: true },
  );
}
