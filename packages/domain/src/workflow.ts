import type { Entity } from './index.js';
import type { FlowPath, TaskKind } from './board.js';
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
export type WorkflowParam =
  | 'path'
  | 'acceptance_wake'
  | 'max_parallel'
  | 'handback_limit'
  | 'task_size_hint'
  | 'runtime_quota_threshold'
  | 'budget';
/** What one task of a cell may spend before its retrospective counts it over budget. */
export interface TaskBudget {
  /** The lead's and the task sessions' input tokens, cached ones included, in tokens. */
  input_tokens: number;
  /** The sum of the task's wall-clock stages, in milliseconds. */
  wall_ms: number;
}
/** A power of a coordinating lead that the project's charter governs. */
export type CharterPower =
  | 'approve_worker_prompts'
  | 'answer_worker_questions'
  | 'plan_change'
  | 'create_agent'
  | 'accept_milestone'
  | 'merge_out_of_scope'
  | 'start_external';
/** Whether the lead uses a power on its own, asks the user first, or may not use it. */
export type CharterMode = 'on' | 'ask' | 'off';
/** The adjustable parts of one project's workflow; the row id is the project id. */
export interface WorkflowPolicy extends Entity {
  project_id: string;
  /** Starts at 1 and rises by 1 with each change; 0 for the defaults of a project with no row. */
  policy_version: number;
  /** Whether a lead's plan proposal applies at once or waits for the user. */
  plan_changes: 'auto' | 'confirm';
  /** What the lead may do without asking, by power; plan_change and start_external are not stored here but follow plan_changes and the project's external events. */
  charter?: Partial<Record<CharterPower, CharterMode>>;
  /** Permission rules, in the syntax of Project.permission_rules, whose prompts always reach the user beside the built-in must-ask kinds. */
  must_ask_extra?: string[];
  /** When set, a reversible question the lead asked takes its recommended answer after_hours after it was asked unless the user answers first; absent is off. */
  question_defaults?: { after_hours: number };
  /** The messages of agents other than the main agent that reach the user directly: main_gate_failed cites a check that failed on the default branch. */
  urgent_direct?: 'main_gate_failed'[];
  /** Whether the lead makes a task of each tier itself or dispatches a task session, reviewed or not; an absent tier takes its default. */
  path: Partial<Record<TaskKind['tier'], Exclude<FlowPath, 'parallel'>>>;
  /** Whether the lead wakes after each merge or once every task of a milestone has ended. */
  acceptance_wake: 'each_merge' | 'milestone';
  /** How many task sessions run at once in the project, from 1 to max_parallel_limit. */
  max_parallel: number;
  /** The user's ceiling on max_parallel, from 1 to 8. */
  max_parallel_limit: number;
  runtime_parallel?: Record<string, number>;
  dispatch_paused?: boolean;
  /** Quota use percent at which new task sessions wait, from 0 to 100; absent defaults to 90. */
  runtime_quota_threshold?: number;
  /** How many times one problem is handed back to a session before it fails: 0 disables, otherwise 2 to 5. */
  handback_limit: number;
  gate_on_fail?: 'handback' | 'retry' | 'stop';
  gate_runner?: 'daemon' | 'session';
  /** Whether a lead milestone that becomes ready has its checks and verifier review run on their own. */
  milestone_verify?: 'off' | 'auto';
  /** Whether a task session whose hand-backs of one problem ran out moves once to an alternate runtime for one more, before the lead takes over. */
  recovery_switch?: 'off' | 'auto';
  /** The most files a task should change, as a hint to the lead; absent gives no hint. */
  task_size_hint?: number;
  /** The budget of a task by tier and path; a cell without one has no budget. Exceeding it only flags the task. */
  budget: Partial<Record<TaskKind['tier'], Partial<Record<FlowPath, TaskBudget>>>>;
  /**
   * The input tokens, cached ones included, the project's turns that ended since `since` (Unix
   * milliseconds, when the budget was first set) may spend; once spent, no task session opens and no
   * lead wakes until the user raises or clears it. Absent sets no limit.
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
