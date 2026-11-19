import type { Improvement, LearnedGrade } from '@pantheon/domain';

/** One learned change of a project, from whichever record holds it. */
export interface LearnedItem {
  /** An improvement's change type, or the record it came from. */
  kind:
    | Improvement['change']['type']
    | 'agent_change'
    | 'workflow_definition'
    | 'memory_note'
    | 'runtime_review';
  /** The id of the improvement, agent proposal, workflow definition or memory record. */
  id: string;
  grade: LearnedGrade;
  /** The status of the record it came from. */
  status: string;
  group: 'needs_you' | 'on_trial' | 'in_force' | 'reverted';
  /** Plain text; from is empty when nothing was there before or the earlier value was not kept. */
  diff: { from: string; to: string };
  evidence: { kind: string; id: string }[];
  /** Absent while a trial runs and when the user ended it. */
  verdict?: NonNullable<Improvement['trial_evaluation']>['verdict'];
  /** The tasks the trial has seen so far. */
  n?: number;
  /** The commands that act on it now, with the decision each takes. */
  actions: { command: string; decision?: string }[];
  /** Unix epoch milliseconds when it was proposed or written. */
  at: number;
}
