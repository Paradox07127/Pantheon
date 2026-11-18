import type {
  ApprovalQuestion,
  EffortLevel,
  Entity,
  PersonalVia,
  Review,
  RuntimeChoice,
} from './index.js';
import type { WorkflowStep } from './workflow.js';
export interface ProjectBrief extends Entity {
  project_id: string;
  goal: string;
  goals: string[];
  non_goals: string[];
  created_at: number;
  updated_by: string;
}
export interface Milestone extends Entity {
  project_id: string;
  title: string;
  /** Workbench sessions of this project that must all be merged. */
  required_sessions: string[];
  criteria: string[];
  created_at: number;
  updated_by: string;
  acceptance?: {
    actor: string;
    accepted_at: number;
    evidence_refs: string[];
    commitment_hash: string;
    /** Indices into criteria the accepter checked; absent when the acceptance covers the whole milestone. */
    criteria_checked?: number[];
    /** A lead's acceptance over a current verification that had not passed, with the reason it gave. */
    override?: { reason: string; verification_id: string; state: MilestoneVerification['state'] };
  };
  /** The lead session that wrote it; absent on milestones the user created. */
  owner_session_id?: string;
  /** The id its lead gave it in update_board. */
  key?: string;
  /** Task ids in the owner's plan; when set, required sessions come from their bindings. */
  task_ids?: string[];
  /** When its lead's update_board stopped listing it. */
  removed_at?: number;
  /** Calendar day the lead or the user set for it. */
  due_on?: string;
  /** When its lead means to re-plan it. */
  replan_if?: ReplanTrigger[];
  /** The goal of the project its lead linked it to; shown as progress, never checked. */
  goal_id?: string;
}
/** `budget_ratio.at` is spent over budget tokens; `assumption_false` names a plan assumption id. */
export type ReplanTrigger =
  | { type: 'handbacks'; count: number }
  | { type: 'budget_ratio'; at: number }
  | { type: 'stall' }
  | { type: 'assumption_false'; assumption_id: string };
export interface BoardClaim {
  text: string;
  /** `decision:<id>` or `session:<id>` in this project. */
  evidence_refs: string[];
  basis: 'measured' | 'inferred' | 'estimated';
}
/** One per project, keyed by project_id; replaced whole on every update and holds no counts. */
export interface ProjectBoard extends Entity {
  project_id: string;
  headline: string;
  workstreams: {
    id: string;
    title: string;
    session_ids: string[];
    status: 'done' | 'running' | 'next' | 'blocked';
    progress: BoardClaim[];
    next: string[];
    blockers: { text: string }[];
  }[];
  findings: (BoardClaim & { severity: 'info' | 'risk' })[];
  assumptions: { text: string }[];
  updated_at: number;
  updated_by: string;
}
/** The area of work a task falls in; a task in several takes the first that matches, in this order. */
export const TASK_DOMAINS = [
  'review',
  'frontend-ui',
  'script-infra',
  'backend-logic',
  'docs-chore',
] as const;
/** How hard a task is, from mechanical (t1) to cross-module or high risk (t3). */
export const TASK_TIERS = ['t1', 't2', 't3'] as const;
export interface TaskKind {
  domain: (typeof TASK_DOMAINS)[number];
  tier: (typeof TASK_TIERS)[number];
}
/** The lead makes the task itself, dispatches a task session, or dispatches one whose work another runtime reviews until it passes. */
export const FLOW_PATHS = ['direct', 'dispatch', 'review_loop', 'parallel'] as const;
export type FlowPath = (typeof FLOW_PATHS)[number];
/** How much the lead plans a lane before its tasks start. */
export const LANE_DEPTHS = ['just_do', 'plan_first', 'spec_first'] as const;
export type LaneDepth = (typeof LANE_DEPTHS)[number];
/** Whether a failed gate failed because of the machine it ran on or because of the change. */
export type GateFailureClass = 'environment' | 'code';
/** A lead's question card and the user's eventual answer. */
export interface LeadQuestion {
  id: string;
  at: number;
  question: string;
  options: string[];
  recommended: string;
  assumption: string;
  /** Only these tasks wait for the answer before starting. */
  blocks: string[];
  answer?: {
    text: string;
    at: number;
    /** The lead's earlier answer the user replaced. */
    overruled?: { text: string; at: number };
  };
  /** The worker question this card relays. */
  source?: { session_id: string; approval_id: string };
  /** The relayed question's original questions. */
  questions?: ApprovalQuestion[];
  /** Who answered a relayed worker question; absent when the user answered before the lead. */
  answered_by?: 'user' | 'lead';
  /** Who answered for the user; absent when the user answered. */
  via?: PersonalVia;
  /**
   * What the lead's answer rests on: words of the asking task's source, a plan assumption's text, a
   * current memory id, or the id of an answered question of the plan.
   */
  citations?: { kind: 'user_words' | 'assumption' | 'memory' | 'earlier_answer'; ref: string }[];
}
/** A decision the lead made for the user; plans written before ids existed have none. */
export interface PlanAssumption {
  text: string;
  id?: string;
  /** Task ids of the plan that rest on it. */
  affects?: string[];
  /** A milestone id of the plan. */
  milestone?: string;
}
/**
 * A lane whose tasks wait until the user approves its plan; approved_at absent while it waits.
 * Without held_at it only keeps the user's depth.
 */
export interface LaneStop {
  held_at?: number;
  /** The plan version that held it. */
  plan_version?: number;
  approved_at?: number;
  approved_by?: 'user' | 'personal';
  via?: 'approve' | 'depth';
  /** The depth the user chose; it replaces the lead's. */
  user_depth?: LaneDepth;
  user_depth_at?: number;
}
/** One lead session's part of the project board, keyed by that session's id. */
export interface BoardPlan extends Entity {
  project_id: string;
  headline: string;
  lanes: {
    id: string;
    title: string;
    /** Why tasks of the lane run at the same time, in one sentence from the lead; absent when it gave none. */
    fanout_reason?: string;
    depth?: LaneDepth;
    /** Each `plan` or `milestone:<plan milestone id>`. */
    stops?: string[];
    depth_reason?: string;
  }[];
  iterations?: { id: string; title: string; starts_on: string; ends_on: string }[];
  /** Task ids whose relative order the user locked, in plan order. */
  order_lock?: string[];
  tasks: {
    id: string;
    title: string;
    goal: string;
    /** What the goal has no room for: purpose, known cause, files and limits. */
    brief?: string;
    lane: string;
    milestone?: string;
    iteration?: string;
    estimate?: number;
    depends_on: string[];
    /** Verbatim quotes of the user's own words. */
    source: string[];
    /** Verbatim quotes of what other people wrote in an external event; not the user's words. */
    external_source?: string[];
    /** The external subject, such as github:owner/repo#12, the task was planned for. */
    external_subject?: string;
    scope: string[];
    acceptance: string[];
    runtime?: string;
    model?: string;
    effort?: EffortLevel;
    kind?: TaskKind;
    task_type?: 'feature' | 'fix' | 'research' | 'infra' | 'docs';
    /** Tokens; stored for display without enforcing the budget. */
    token_budget?: number;
    /** Why the runtime, model or effort differs from the routing table's first choice; absent when it does not. */
    route_reason?: string;
    /** The device id the task's session runs on; absent means this machine. */
    device?: string;
    device_reason?: string;
    /** Labels the device must have. */
    needs?: string[];
    /** Named resources of the device the session holds while it runs, and how many of each. */
    uses?: Record<string, number>;
    /** The flow path the task takes; absent means the one the workflow policy gives its tier. */
    path?: FlowPath;
    workflow_id?: string;
    /** Work split by the lead for the parallel path; each part gets its own session and worktree. */
    parallel?: { title: string; goal: string; scope: string[]; acceptance: string[] }[];
    /** Why the task takes a different flow path from the one its kind is given; absent when it does not. */
    flow_reason?: string;
    /** What completes the task: its sessions merging (the default) or the lead accepting a done report. */
    done_when?: 'merged' | 'report';
    /** Absent means normal. */
    priority?: 'high' | 'normal' | 'low';
  }[];
  /** Rises only when the plan's content changes; an edit names the version it was based on. */
  plan_version: number;
  /** Edits that touch a task with an unfinished session, waiting for the lead to apply or reject them. */
  pending_edits: PendingPlanEdit[];
  /** Lead proposals waiting for the user, with resolved records retained like user edits. */
  pending_proposals?: PlanProposal[];
  risks: { text: string }[];
  assumptions: PlanAssumption[];
  questions?: LeadQuestion[];
  /** Tasks the lead asked Pantheon to open a session for, by task id, until one opens. */
  dispatch?: Record<
    string,
    {
      requested_at: number;
      /** Elevated mode explicitly selected by the user who requested dispatch. */
      permission_mode?: 'auto' | 'full_access';
      /** The causal depth of the session's first turn: one deeper than the lead turn that asked. */
      causal_depth?: number;
      /** The latest failure to open the session; the next try waits a backoff after at. */
      error?: { code: string; message: string; at: number; attempts: number };
    }
  >;
  /** The wake the lead refused because it has closed, or held after too many wakes; cleared by the next wake it takes. */
  wake_failed?: { reason: 'lead_closed' | 'wake_limit'; at: number };
  /** External subjects the user has not approved, by subject key: their tasks do not start until then. */
  external_holds?: Record<string, { at: number }>;
  /** Lanes held for the user's plan approval, by lane id; daemon-kept, lead input never writes it. */
  lane_stops?: Record<string, LaneStop>;
  /** Notes for the lead's next message. */
  inbox: LeadNote[];
  /** The last task session state the lead was told of, by session id. */
  notified: Record<
    string,
    'merged' | 'blocked' | 'failed' | 'waiting' | 'turn_failed' | 'no_changes'
  >;
  /** Each task's state when the lead last took a digest, by task id; '' holds the plan version. */
  last_told?: Record<string, string>;
  /** Task sessions, by id, whose task contract the lead changed since their last turn was queued. */
  contract_changed?: string[];
  /** The merge problems, by session id, Pantheon already handed back to the session to fix. */
  handed_back?: Record<string, string[]>;
  /**
   * The runtime Pantheon moved each task to, by task id, after its hand-backs of reason ran out on
   * runtime from; kept while the lead leaves the task's runtime, model, effort and generation alone.
   * told: the task session heard of the move, so a later change of the task is the lead's.
   */
  runtime_switches?: Record<
    string,
    { generation: number; from: string; to: RuntimeChoice; reason: string; at: number; told?: true }
  >;
  /**
   * The stall and loop alerts of a task session's turn the lead was told of, a loop that went on
   * after it and a stall it did not act on, and the stall and loop of the lead's own turn, by id of
   * a turn still running; a task session's loop across its ended turns, by session id; a task
   * session's long background task, by `<task id>:<background task id>` while it runs.
   */
  alerted?: Record<
    string,
    ('stalled' | 'looping' | 'still_looping' | 'stall_unanswered' | 'background_long')[]
  >;
  /** Report tasks the lead accepted, by task id, with the task generation accepted (absent: the first). */
  accepted?: Record<string, { at: number; evidence: string; generation?: number }>;
  /**
   * Direct tasks the lead merged from its own worktree, by task id, with the task generation merged
   * and the source branch commits before and after the merge.
   */
  direct_merged?: Record<
    string,
    { generation: number; at: number; session_id: string; from_sha: string; to_sha: string }
  >;
  /** Each task's generation and contract hash, kept by the daemon; a changed contract starts the next. */
  generations?: Record<string, { generation: number; contract: string }>;
  /** The last generation of each task id removed from the plan, so a reused id starts after it. */
  retired?: Record<string, number>;
  /** On the personal agent's inbox: the keys of the waiting items it last read, and when it read them. */
  personal_seen?: { keys: string[]; at: number };
  updated_at: number;
}
/** One change to a board plan, by task id; only the lead resolves a pending edit. */
export type PlanEditOp =
  | { type: 'lock_order'; task_ids: string[] }
  | { type: 'unlock_order' }
  | { type: 'set_iterations'; iterations: NonNullable<BoardPlan['iterations']> }
  | { type: 'add_task'; task: BoardPlan['tasks'][number] }
  | { type: 'remove_task'; task_id: string }
  | { type: 'move_task'; task_id: string; before: string | null }
  | {
      type: 'set_task';
      task_id: string;
      patch: Partial<
        Pick<
          BoardPlan['tasks'][number],
          | 'parallel'
          | 'runtime'
          | 'title'
          | 'lane'
          | 'priority'
          | 'kind'
          | 'route_reason'
          | 'device'
          | 'device_reason'
          | 'flow_reason'
          | 'needs'
          | 'uses'
          | 'goal'
          | 'brief'
          | 'scope'
          | 'acceptance'
          | 'done_when'
          | 'estimate'
        >
      > & {
        milestone?: string | null;
        iteration?: string | null;
        path?: FlowPath | null;
        /** null takes the task's model or effort away. */
        model?: string | null;
        effort?: EffortLevel | null;
        /** null takes the task's named workflow away. */
        workflow_id?: string | null;
        task_type?: BoardPlan['tasks'][number]['task_type'] | null;
        token_budget?: number | null;
      };
    }
  | { type: 'set_dependencies'; task_id: string; depends_on: string[] }
  | {
      type: 'set_milestone';
      milestone_id: string;
      patch: { title?: string; due_on?: string | null };
    }
  | { type: 'resolve_edit'; edit_id: string; decision: 'apply' | 'reject'; reason?: string };
export interface PendingPlanEdit {
  edit_id: string;
  ops: Exclude<PlanEditOp, { type: 'resolve_edit' | 'lock_order' | 'unlock_order' }>[];
  base_version: number;
  /** The tasks the edit touches. */
  task_ids: string[];
  /** Plan assumptions the user says are wrong, with the text they had and what holds instead. */
  refutes?: { assumption_id: string; text: string; instead: string }[];
  created_at: number;
  /** withdrawn: the user took it back before the lead decided. */
  status: 'pending' | 'applied' | 'rejected' | 'withdrawn';
  reason?: string;
  /** When the lead applied or rejected it, or the user withdrew it. */
  resolved_at?: number;
}
export interface PlanProposal {
  proposal_id: string;
  ops: PendingPlanEdit['ops'];
  /** Lanes the proposal adds to the plan before its ops apply. */
  lanes?: BoardPlan['lanes'];
  reason: string;
  base_version: number;
  created_at: number;
  status: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
  resolution_reason?: string;
  resolved_at?: number;
}
export interface PlanProposalView {
  id: string;
  lead_session_id: string;
  reason: string;
  ops: PlanProposal['ops'];
  base_version: number;
  created_at: number;
  /** Existing tasks targeted by the proposal's ops. */
  task_ids: string[];
}
export type TaskBlockReason =
  'missing_context' | 'missing_permission' | 'environment_problem' | 'conflicting_requirements';
export interface LeadNote {
  /** Absent on notes stored before notes had ids. */
  id?: string;
  at: number;
  session_id: string;
  task_id: string;
  kind:
    | 'risk'
    | 'task'
    | 'dependency'
    | 'done'
    | 'requirement'
    | 'merged'
    | 'blocked'
    | 'failed'
    | 'waiting'
    | 'wait_ended'
    | 'turn_failed'
    | 'no_changes'
    | 'stalled'
    | 'looping'
    | 'background_long'
    | 'dispatch_failed'
    | 'runtime_unavailable'
    | 'user_message'
    | 'discarded'
    | 'review_completed'
    | 'review_failed'
    | 'plan_review_completed'
    | 'plan_review_failed'
    | 'user_edit'
    | 'answer'
    | 'usage_reset'
    | 'external'
    | 'follow_up'
    | 'routine'
    | 'agent_proposal'
    | 'signal'
    /** A message another agent of the project left for the user, sent to the main agent instead. */
    | 'agent_report'
    /** Permission prompts of one task session approved for the lead since it last read its inbox; does not wake the lead. */
    | 'prompts_approved'
    /** A lead that is not a resident wrote or changed its plan; one per plan in the Assistant's inbox, and it does not wake the Assistant. */
    | 'other_plan'
    /** A task session asked a question its lead may answer; wakes the lead. */
    | 'worker_question'
    /** A verification of one of the lead's milestones ended; wakes the lead. */
    | 'milestone_verified'
    /** Pantheon moved a task whose hand-backs ran out to another runtime; wakes the lead. */
    | 'runtime_switched'
    /** A lane the lead added waits for the user to approve its plan; does not wake the lead. */
    | 'plan_held'
    /** New items wait for the user in other projects; wakes the personal agent. */
    | 'personal_attention';
  text: string;
  status?: 'done' | 'done_with_concerns';
  reason?: TaskBlockReason;
  question_id?: string;
  answer?: string;
  /** The task generation a report was sent in. */
  generation?: number;
  /** The turn of a user message to a task session, or the turn that reported a block or requirement. */
  turn_id?: string;
  /** The causal depth of the turn the note came from. */
  causal_depth?: number;
  /** A user's plan edit; applied is false while it waits for the lead. */
  edit?: {
    edit_id: string;
    ops: PlanEditOp[];
    base_version: number;
    applied: boolean;
    /** Whether this edit should wake the lead; absent on older notes. */
    wake?: boolean;
    refutes?: PendingPlanEdit['refutes'];
  };
  /** What became of the user's edit or the lead's proposal a user_edit note tells of. */
  edit_state?: 'pending' | 'applied' | 'withdrawn' | 'proposal';
  /** The user edit a withdrawn note names. */
  edit_id?: string;
  proposal_id?: string;
  decision?: 'accept' | 'reject';
  /** Who decided for the user; absent when the user decided. */
  via?: PersonalVia;
  /** The commit a merged session landed at and the branch it landed on. */
  commit?: string;
  source_branch?: string;
  /** The SHAs a review read. */
  reviewed_shas?: string;
  routine_id?: string;
  /** When the routine last ran before this run; absent when it never ran. */
  last_run_at?: number;
  /** The external request's subject key and source; source 'pantheon' marks a note Pantheon wrote itself. */
  subject_key?: string;
  source?: string;
  /** Whether a signal note is an interrupt for one issue or the periodic digest. */
  signal?: 'interrupt' | 'digest';
  /** Wakes the agent even while its contract holds its wakes: an urgent signal or the user's own act. */
  bypass_hold?: 'urgent' | 'user';
}
export interface MilestoneView {
  milestone: Milestone;
  status: 'active' | 'ready_for_acceptance' | 'completed' | 'stale';
  required_total: number;
  merged_total: number;
  /** `session:<id>:<open|discarded>` for each required session not yet merged. */
  reasons: string[];
  /** Stored on user milestones; derived from task bindings on lead milestones. */
  required_sessions: string[];
  /** Absent on milestones that name sessions. */
  tasks?: { done: number; total: number };
  /** The newest verification of the current commitment of a ready or completed lead milestone; absent when none ran. */
  verification?: Pick<
    MilestoneVerification,
    | 'id'
    | 'state'
    | 'independence'
    | 'runtime'
    | 'reason'
    | 'reason_code'
    | 'started_at'
    | 'finished_at'
  > & {
    failed: { name: string; output_tail: string }[];
    /** The commands the run went through, in order; hidden checks are left out. */
    commands: { name: string; exit_code: number }[];
  };
}
export interface BoardPlanView {
  lead_session_id: string;
  lead_title: string;
  headline: string;
  plan_version: number;
  pending_edits: { id: string; ops: PendingPlanEdit['ops']; created_at: number }[];
  /** Always set by the daemon. */
  pending_proposals?: PlanProposalView[];
  /** The 20 most recently resolved proposals, newest first; always set by the daemon. */
  recent_proposals?: (Omit<PlanProposal, 'proposal_id'> & { id: string })[];
  lanes: BoardPlan['lanes'];
  iterations?: BoardPlan['iterations'];
  tasks: (BoardPlan['tasks'][number] & {
    session_ids: string[];
    waiting_step?: { id: string; title: string; kind: WorkflowStep['kind']['type'] };
    state: 'todo' | 'active' | 'done';
    /** What a requested task waits for before its session opens. */
    dispatch_wait?:
      | 'upstream'
      | 'scope'
      | 'plan_review'
      | 'step'
      | 'retry'
      | 'budget'
      | 'capacity'
      | 'runtime_limited'
      | 'runtime_capacity'
      | 'device_offline'
      | 'device_capacity'
      | 'device_resource'
      | 'paused'
      | 'answer'
      | 'approval'
      | 'plan_approval';
  })[];
  risks: BoardPlan['risks'];
  assumptions: BoardPlan['assumptions'];
  updated_at: number;
}
/** Why a verification failed or was inconclusive. */
export type MilestoneVerificationReason =
  | 'checks_failed'
  | 'checks_environment'
  | 'check_error'
  | 'no_verifier_runtime'
  | 'review_not_started'
  | 'verifier_failed'
  | 'review_failed'
  | 'review_incomplete'
  | 'no_verdict'
  | 'daemon_restart';
/** One run of a milestone's checks against one commitment. */
export interface MilestoneVerification extends Entity {
  project_id: string;
  /** The milestone row id. */
  milestone_id: string;
  commitment_hash: string;
  state: 'pending' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'skipped';
  commands: {
    name: string;
    exit_code: number;
    output_tail: string;
    hidden: boolean;
    failure_class?: GateFailureClass;
  }[];
  review_id?: string;
  runtime?: string;
  /** How the verifier's runtime relates to the writers': another vendor, another runtime, or a writer's own. */
  independence?: 'other_vendor' | 'other_runtime' | 'same_runtime';
  /** Why the run ended as it did, when its state and commands do not say. */
  reason?: string;
  /** Set on every failed or inconclusive run; absent on a passed one. */
  reason_code?: MilestoneVerificationReason;
  /** The commit of each source root the checks ran on. */
  commits?: { source: string; commit: string }[];
  /** The verdict the verifier handed in, as its review records it. */
  verdict?: NonNullable<Review['verdicts']>[number];
  started_at: number;
  finished_at?: number;
}
export interface ProjectGoal extends Entity {
  project_id: string;
  /** The user's own words. */
  text: string;
  order: number;
  created_at: number;
  archived_at?: number;
}
export interface ProjectGoalView {
  goal: ProjectGoal;
  /** Row ids of the lead milestones linked to it that are not removed, in plan order. */
  milestone_ids: string[];
  milestones: { done: number; ready: number; total: number };
  /** Summed over those milestones. */
  tasks: { done: number; total: number };
}
