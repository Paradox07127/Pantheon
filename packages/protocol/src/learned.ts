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
  /** The setting, agent name, gate root, playbook runtime or "default", memory title or key, or an experience's first sentence; absent for a worktree setup or workflow definition. */
  title?: string;
  /** The memory record's revision; only on a memory_note or runtime_review. */
  revision?: number;
  grade: LearnedGrade;
  /** The status of the record it came from. */
  status: string;
  group: 'needs_you' | 'on_trial' | 'in_force' | 'reverted';
  /** Plain text; from is empty when nothing was there before or the earlier value was not kept. */
  diff: { from: string; to: string };
  /** title is the task's for a retrospective, the session's for a session and the verdict for an eval receipt, whose id is its path; absent otherwise or when it has none. */
  evidence: { kind: string; id: string; title?: string }[];
  /** Absent while a trial runs and when the user ended it. */
  verdict?: NonNullable<Improvement['trial_evaluation']>['verdict'];
  /** The tasks the trial has seen so far. */
  n?: number;
  /** The tasks the trial needs before it is judged; only while a trial runs. */
  tasks_required?: number;
  /** The commands that act on it now, with the decision each takes. */
  actions: { command: string; decision?: string }[];
  /** Unix epoch milliseconds when it was proposed or written. */
  at: number;
}
