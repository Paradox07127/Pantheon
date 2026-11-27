import type { ProjectResident } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

export type { ProjectResident };

const isResident = (value: unknown): boolean => {
  const view = value as Partial<ProjectResident> | null;
  return (
    !!view &&
    (view.session_id === null || typeof view.session_id === 'string') &&
    typeof view.turns?.pantheon === 'number' &&
    typeof view.turns.user === 'number' &&
    Array.isArray(view.wakes)
  );
};

/** Events that change the resident, its turn counts, its budget or its wakes; a closed, discarded or deleted session is no longer resident. */
export const RESIDENT_KINDS: ReadonlySet<string> = new Set([
  'project.resident_set',
  'resident.woken',
  'resident.wake_skipped',
  'session.closed',
  'session.discarded',
  'session.deleted',
  'workflow.policy_changed',
  'project.resident_instructions_set',
  'turn.running',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
]);

/** GET /v1/project.resident: the project's resident main agent, its turns, budget and wakes. */
export function useProjectResident(projectId: string | null) {
  return useProjectQuery<ProjectResident>('project.resident', projectId, isResident, undefined, {
    kinds: RESIDENT_KINDS,
  });
}
