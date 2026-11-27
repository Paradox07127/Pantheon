import type { ProjectRoutines } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

export type { ProjectRoutines };
export type Routine = ProjectRoutines['routines'][number];

/** What `project.routine.save` takes as its routine. */
export type RoutineInput = Pick<
  Routine,
  'name' | 'prompt' | 'active_hours' | 'enabled' | 'precheck'
> & {
  id?: string;
} & ({ every_minutes: number } | { at: string });

const isRoutines = (value: unknown): boolean =>
  Array.isArray((value as Partial<ProjectRoutines> | null)?.routines);

/** Events that change the routines, their last runs or their state; budget and resident set the state, and turns spend the budget while sessions closing end the resident. */
export const ROUTINE_KINDS: ReadonlySet<string> = new Set([
  'routine.saved',
  'routine.removed',
  'routine.ran',
  'project.resident_set',
  'workflow.policy_changed',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'session.closed',
  'session.discarded',
  'session.deleted',
]);

/** GET /v1/project.routines: the project's timed routines, each with its next run, state and last run. */
export function useProjectRoutines(projectId: string | null) {
  return useProjectQuery<ProjectRoutines>('project.routines', projectId, isRoutines, undefined, {
    kinds: ROUTINE_KINDS,
  });
}
