import type { Retrospective } from '@pantheon/domain';
import { useProjectQuery } from './project-read';

const isRetrospectives = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every((r) => !!r && typeof r === 'object' && typeof (r as Retrospective).id === 'string');

/** GET /v1/retrospective.list of the whole project: at most 200, newest first. */
export const useProjectRetrospectives = (project_id: string | null) =>
  useProjectQuery<Retrospective[]>('retrospective.list', project_id, isRetrospectives, undefined, {
    events: true,
  });
