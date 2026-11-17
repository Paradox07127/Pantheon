import type { EffortLevel, Entity, TurnSkill } from './index.js';
import type { FlowPath, GateFailureClass, TaskKind } from './board.js';
/** Stored definition versions and the task generations enrolled in a bounded trial. */
export interface StoredWorkflowDefinition extends Entity {
  project_id: string;
  name: string;
  is_default: boolean;
  definition_version: number;
  definition: WorkflowDefinition;
  versions: Record<number, WorkflowDefinition>;
  task_versions?: Record<string, number>;
  trial?: {
    tasks: number;
    done: number;
    previous_version: number;
    slot: keyof WorkflowDefinition['slots'];
    enrolled: string[];
    started_at: number;
  };
}
/** User steps inserted into the fixed task path. */
export interface WorkflowLeafStep {
  id: string;
  title: string;
  applies_to?: { tiers?: TaskKind['tier'][]; domains?: TaskKind['domain'][] };
  when?: { changed_paths: string[] };
  kind:
    | { type: 'command'; command: string; timeout_seconds: number }
    | { type: 'approval' }
    | { type: 'prompt'; prompt: string; target?: 'task' | 'lead'; skill?: TurnSkill }
    /** Without a runtime, the first admitted reviewer other than the writer's runtime reviews. */
    | {
        type: 'review';
        runtime?: string;
        model?: string;
        effort?: EffortLevel;
        blocking?: boolean;
      };
}
export interface WorkflowStep extends Omit<WorkflowLeafStep, 'kind'> {
  kind:
    | WorkflowLeafStep['kind']
    | { type: 'parallel'; steps: WorkflowLeafStep[] }
    | { type: 'loop'; step: WorkflowLeafStep; max: number; until: 'passes' };
}
export interface WorkflowDefinition {
  slots: {
    before_dispatch: WorkflowStep[];
    before_merge: WorkflowStep[];
    after_merge: WorkflowStep[];
  };
  plan_review: { tiers: TaskKind['tier'][] };
  review: { max_rounds: number };
}
export interface StepRun extends Entity {
  project_id: string;
  lead_session_id: string;
  task_id: string;
  generation: number;
  definition_version: number;
  workflow_id?: string;
  parent_run_id?: string;
  iteration?: number;
  failure_class?: GateFailureClass;
  slot: keyof WorkflowDefinition['slots'];
  step: WorkflowStep;
  state:
    'pending' | 'running' | 'waiting' | 'passed' | 'failed' | 'rejected' | 'retired' | 'skipped';
  created_at: number;
  finished_at?: number;
  session_id?: string;
  reason?: string;
  /** The turn a prompt step queued, or the turn that carries a failed review's findings. */
  turn_id?: string;
  review_id?: string;
}

/** A workflow policy parameter an improvement may change, unless the user pinned it. */
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
/** The adjustable parts of one project's workflow; the row id is the project id. */
export interface WorkflowPolicy extends Entity {
  project_id: string;
  /** Starts at 1 and rises by 1 with each change; 0 for the defaults of a project with no row. */
  policy_version: number;
  /** Whether improvements start their trial on their own, wait for the user, or are not made. */
  improvement_mode: 'auto' | 'confirm' | 'off';
  /** Whether a lead's plan proposal applies at once or waits for the user. */
  plan_changes: 'auto' | 'confirm';
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
  /** Parameters the user pinned, which no improvement may change. */
  pinned: WorkflowParam[];
  /** The settings the project sets itself; the others follow the global values. Absent on a policy stored before global values, whose stored settings are all its own. */
  overridden?: Exclude<
    keyof WorkflowPolicy,
    keyof Entity | 'project_id' | 'policy_version' | 'project_budget' | 'overridden'
  >[];
}
/** A rule the daemon computes from project records that can lead to an improvement. */
export type ImprovementSignal =
  | 'dispatch_overhead'
  | 'direct_rework'
  | 'idle_wakeups'
  | 'queue_wait'
  | 'merge_conflicts'
  | 'over_budget'
  | 'repeat_gate_failure'
  | 'repeat_turn_failure'
  | 'handback_loop'
  | 'always_approved_command'
  | 'late_gate_failure';
/** A proposed change to a project's workflow, backed by retrospectives and tried before it stays. */
export interface Improvement extends Entity {
  project_id: string;
  /** The lead that proposed it; absent when the daemon did. */
  lead_session_id?: string;
  source: 'daemon' | 'lead';
  /** The signal that led to it; absent when a lead proposed it without one. */
  signal?: ImprovementSignal;
  /** The retrospectives it rests on, by id. */
  retrospective_ids: string[];
  status: 'candidate' | 'trial' | 'active' | 'reverted' | 'rejected';
  /** Why it reached its status, such as too few tasks in the trial; absent when nothing is to say. */
  status_reason?: string;
  /** What else to know of its status, such as a value the user changed that a revert kept; absent when nothing is. */
  status_detail?: string;
  reject_reason?: 'duplicate' | 'not_useful';
  reject_note?: string;
  change:
    | {
        type: 'policy_change';
        param: WorkflowParam;
        /** The tier whose path changes; absent for a parameter that is not per tier. */
        tier?: TaskKind['tier'];
        from: unknown;
        to: unknown;
      }
    | {
        type: 'experience';
        /** Absent applies to every domain. */
        domain?: TaskKind['domain'];
        /** Absent applies to every tier. */
        tier?: TaskKind['tier'];
        /** Absent applies to every runtime. */
        runtime?: string;
        /** What to do, at most 600 bytes. */
        procedure: string;
        /** When not to do it; absent when it always applies. */
        countercondition?: string;
      };
  /** Unix epoch milliseconds. */
  proposed_at: number;
  /** Unix epoch milliseconds; absent until its trial starts. */
  trial_started_at?: number;
  /** The evaluator's final sample, retained when a trial ends. Missing measurements stay absent. */
  trial_evaluation?: {
    comparison: {
      baseline: Record<string, number | undefined>;
      trial: Record<string, number | undefined>;
    };
    no_baseline: boolean;
  };
  /** Unix epoch milliseconds when it became active, reverted or rejected; absent before. */
  decided_at?: number;
}
