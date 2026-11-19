import type { Improvement } from '@pantheon/domain';

/** The plan tasks on one side of a change. */
export interface ChangeOutcomeWindow {
  tasks: number;
  /** Tasks whose first gate run passed. */
  first_pass: number;
  /** Input tokens spent per merged or accepted task, and how many those were; null tokens without one. */
  cost_per_accepted_task: { input_tokens: number | null; n: number };
  /** Tasks the user stopped. */
  user_interventions: number;
}

/** What the tasks after one of the user's changes did, against as many tasks before it. */
export interface ChangeOutcome {
  event_id: string;
  kind: 'policy_changed' | 'agent_created' | 'routine_enabled';
  /** Unix epoch milliseconds. */
  at: number;
  /** The workflow setting changed; only on policy_changed. */
  param?: string;
  /** The setting's value before and after the change; only on policy_changed, and absent when its event did not record them. */
  from?: unknown;
  to?: unknown;
  /** The agent created or whose routines were enabled. */
  agent_id?: string;
  /** The routines enabled; only on routine_enabled. */
  routine_ids?: string[];
  /** Tasks counted after the change. */
  n: number;
  /** The tasks each side needs before a verdict other than not_enough_evidence. */
  tasks_required: number;
  verdict: NonNullable<NonNullable<Improvement['trial_evaluation']>['verdict']>;
  before: ChangeOutcomeWindow;
  after: ChangeOutcomeWindow;
}
