import type { EffortLevel, Entity, Project, TurnSkill } from './index.js';
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
    | {
        type: 'prompt';
        prompt: string;
        target?: 'task' | 'lead';
        skill?: TurnSkill;
        /** verdict: the step passes only on a pass the session hands in; absent means turn, which passes when the turn completes. */
        expects?: 'verdict' | 'turn';
      }
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
  /** inconclusive: a prompt step that expects a verdict ended its turn without one, and waits for the user. */
  state:
    | 'pending'
    | 'running'
    | 'waiting'
    | 'inconclusive'
    | 'passed'
    | 'failed'
    | 'rejected'
    | 'retired'
    | 'skipped';
  created_at: number;
  finished_at?: number;
  session_id?: string;
  reason?: string;
  /** The turn a prompt step queued, or the turn that carries a failed review's findings. */
  turn_id?: string;
  review_id?: string;
  /** The last verdict a prompt step's session handed in; it counts only while turn_id is the run's turn. */
  verdict?: {
    verdict: 'pass' | 'fail';
    summary: string;
    /** checked: the turn ran the command or edited the file; false when the turn recorded nothing to check against. */
    evidence: { kind: 'command' | 'file'; ref: string; checked: boolean; exit_code?: number }[];
    session_id: string;
    turn_id: string;
    /** Unix epoch milliseconds. */
    at: number;
  };
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
  /** Whether improvements start their trial on their own, wait for the user, or are not made. */
  improvement_mode: 'auto' | 'confirm' | 'off';
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
  /** Whether the user may start the requested eval of a playbook change from the app; off leaves the command to run by hand. */
  eval_runner?: 'off' | 'on';
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
      }
    | {
        type: 'gate_command';
        /** The root realpath whose gate commands change. */
        root: string;
        /** Absent until the change is applied. */
        from?: NonNullable<Project['gates']>[string];
        to: NonNullable<Project['gates']>[string];
      }
    | {
        type: 'worktree_setup';
        /** Absent until the change is applied. */
        from?: Project['worktree'];
        to: Project['worktree'];
      }
    | {
        type: 'agent_instructions';
        agent_id: string;
        /** Absent until the change is applied, and when the agent had no instructions. */
        from?: string;
        to: string;
      }
    | {
        type: 'playbook';
        /** Absent for the project's default playbook. */
        runtime?: string;
        /** The version current before; absent until the change is applied. */
        from?: number;
        /** The stored version to make current. */
        to: number;
      };
  /** What the change rests on besides the retrospectives; absent when nothing else. */
  evidence?: (
    { kind: 'retrospective' | 'signal_issue' | 'session' | 'gate_run'; id: string } | EvalReceipt
  )[];
  /** The paired eval a playbook change proposed without a receipt needs; absent for other changes. */
  eval_request?: {
    /** The playbook version in force when it was proposed, then the proposed one. */
    conditions: [number, number];
    /** The real-model runs the eval makes. */
    runs: number;
    /** The scripts/eval.mjs command line, run from the Pantheon checkout. */
    command: string;
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
    /** How the evaluator ended the trial; absent when the user ended it. */
    verdict?: 'better' | 'worse' | 'not_enough_evidence';
    /** interleaved: the baseline is the trial's tasks without the change; absent on trials ended before it was recorded. */
    design?: 'interleaved' | 'before_after';
    /** Input tokens per task of the new arm against the old arm, once each arm has its tasks; interleaved trials only. */
    paired_cost?: {
      /** The tasks of the old arm and of the new arm. */
      tasks: [number, number];
      change: number | null;
      interval: [number, number] | null;
    };
  };
  /** Unix epoch milliseconds when it became active, reverted or rejected; absent before. */
  decided_at?: number;
}
/** An eval run's runs.jsonl, its sha256, and a verdict of its report as the report gives it. */
export interface EvalReceipt {
  kind: 'eval_receipt';
  path: string;
  sha256: string;
  verdict: string;
}
