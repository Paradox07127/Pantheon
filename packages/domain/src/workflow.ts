import type { Entity } from './index.js';
/** The code review that holds the merge of a review loop task after its gates pass. */
export interface WorkflowStep {
  id: string;
  title: string;
  /** The first admitted reviewer other than the writer's runtime reviews. */
  kind: { type: 'review' };
}
export interface StepRun extends Entity {
  project_id: string;
  lead_session_id: string;
  task_id: string;
  generation: number;
  slot: 'before_merge';
  step: WorkflowStep;
  state: 'pending' | 'running' | 'passed' | 'failed' | 'retired' | 'skipped';
  created_at: number;
  finished_at?: number;
  session_id?: string;
  reason?: string;
  /** The turn that carries a failed review's findings. */
  turn_id?: string;
  review_id?: string;
}

/** A workflow policy parameter the user can pin. */
export type WorkflowParam = 'runtime_quota_threshold';
/** The adjustable parts of one project's workflow; the row id is the project id. */
export interface WorkflowPolicy extends Entity {
  project_id: string;
  /** Starts at 1 and rises by 1 with each change; 0 for the defaults of a project with no row. */
  policy_version: number;
  /** When set, a reversible question takes its recommended answer after_hours after it was asked unless the user answers first; absent is off. */
  question_defaults?: { after_hours: number };
  /** Quota use percent from 0 to 100; absent defaults to 90. */
  runtime_quota_threshold?: number;
  gate_on_fail?: 'handback' | 'retry' | 'stop';
  gate_runner?: 'daemon' | 'session';
  /**
   * The input tokens, cached ones included, the project's turns that ended since `since` (Unix
   * milliseconds, when the budget was first set) may spend; once spent, no session is woken on its
   * own until the user raises or clears it. Absent sets no limit.
   */
  project_budget?: { input_tokens: number; since: number };
  /** Parameters the user pinned. */
  pinned: WorkflowParam[];
  /** The settings the project sets itself; the others follow the global values. Absent on a policy stored before global values, whose stored settings are all its own. */
  overridden?: Exclude<
    keyof WorkflowPolicy,
    keyof Entity | 'project_id' | 'policy_version' | 'project_budget' | 'overridden'
  >[];
}
