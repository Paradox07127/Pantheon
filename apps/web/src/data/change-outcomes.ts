import type { ChangeOutcome } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

export type { ChangeOutcome };

/** The project's events after which change.outcomes can answer otherwise. */
const OUTCOME_KINDS: ReadonlySet<string> = new Set([
  'workflow.policy_changed',
  'agent_profile.created',
  'agent_profile.updated',
  'retrospective.recorded',
]);

/** GET /v1/change.outcomes: the project's measurable changes with the tasks before and after each, newest first. */
export const useChangeOutcomes = (project_id: string | null) =>
  useProjectQuery<ChangeOutcome[]>('change.outcomes', project_id, Array.isArray, undefined, {
    kinds: OUTCOME_KINDS,
  });
