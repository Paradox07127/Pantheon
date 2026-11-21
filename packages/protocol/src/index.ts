import { memoryInputSchemas, memoryDirectorySchema, memoryGraphSchema } from './memory.js';
export { memoryDirectorySchema, memoryGraphSchema } from './memory.js';
export type {
  MemoryArchiveResult,
  MemoryUndoRetractionResult,
  MemorySessionTurnsResult,
} from './memory.js';
import { z } from 'zod';
import { changeStoryInputSchemas, type LandingDiff } from './change-story.js';
import type { ProjectWaiting } from './project-waiting.js';
import { alwaysOnInputSchemas, alwaysOnToolEffects, alwaysOnTools } from './always-on-tools.js';
import { agentWakeInputSchemas, agentWakeQuerySchemas } from './agent-wakes.js';
export type { AgentRoutineRow, AgentWake, WakeOutcome } from './agent-wakes.js';
import { agentLedgerQuerySchemas } from './agent-ledger.js';
export type { AgentLedgerWeek } from './agent-ledger.js';
import { appInputSchemas, appToolEffects, appToolGroups, appTools } from './app-tools.js';
import { agentInputSchemas, agentToolEffects, agentToolGroups, agentTools } from './agent-tools.js';
import { reviewerTools, workflowInputSchemas } from './workflow-tools.js';
import { questionBatchInputSchemas } from './question-batches.js';
import type {
  AgentToolGroup,
  ApprovalQuestion,
  BaselineWorkstream,
  GraphColor,
  GraphIcon,
  GraphStatus,
  BoardPlan,
  CharterMode,
  CharterPower,
  EffortLevel,
  FlowPath,
  LaneDepth,
  McpServerStatus,
  NeedsYouItem,
  TaskRungName,
  MilestoneVerification,
  MilestoneView,
  PendingPlanEdit,
  PermissionMode,
  PlanProposalView,
  ProjectFacts,
  ProjectIntro,
  QuotaWindow,
  Retrospective,
  Review,
  CapabilityReport,
  RuntimeStatus as PreflightRuntimeStatus,
  Session,
  SessionRecap,
  SessionRole,
  SessionTask,
  StepRun,
  TaskKind,
  TestCounts,
  RuntimeDiagnostics,
  RuntimeReviewHistory,
  TraceLane,
  TraceSpan,
  WorkflowPolicy,
  WorkflowParam,
  WorkflowStep,
} from '@pantheon/domain';
export type {
  AgentFields,
  AgentProfile,
  GraphColor,
  GraphIcon,
  GraphStatus,
  AgentRoutineInput,
  AgentToolGroup,
  ApprovalQuestion,
  EffortLevel,
  Principal,
  PermissionMode,
  RuntimeModel,
  SignalIssue,
  SignalSource,
} from '@pantheon/domain';
/** Every registered, configured or ACP-profile runtime, with configuration and known preflight fields. */
export type RuntimeStatus = PreflightRuntimeStatus & {
  enabled: boolean;
  connection?: RuntimeConnection;
  binary?: string;
  args?: string[];
  artifacts?: boolean;
  unverified_isolation?: boolean;
  capabilities?: CapabilityReport['capabilities'];
  /** Latest reported windows, observed at seen_at (Unix epoch milliseconds). */
  quota?: { windows: QuotaWindow[]; seen_at: number };
};
export interface RuntimeConnection {
  connected: boolean;
  disconnected_since?: string;
  reason?: string;
  held_session_count: number;
  held_session_ids: string[];
}
export interface McpStatus {
  runtime: string;
  reconnect_available: boolean;
  /** Absent when the runtime cannot report MCP connection state. */
  servers?: McpServerStatus[];
}
/** An MCP Apps interface: its HTML and the sandbox settings its resource declares. */
export interface McpAppResource {
  html: string;
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  permissions?: {
    camera?: unknown;
    microphone?: unknown;
    geolocation?: unknown;
    clipboardWrite?: unknown;
  };
  prefers_border?: boolean;
  domain?: string;
  /** The session's runtime accepts mcp.app.tool_call. */
  tool_calls: boolean;
}
export interface ConnectionsStatus {
  github: {
    state: 'missing' | 'timeout' | 'signed_out' | 'signed_in';
    installed: boolean;
    signed_in: boolean | null;
    account?: string;
    host?: string;
    scopes?: string[];
  };
  huggingface: Omit<ConnectionsStatus['github'], 'scopes' | 'host'>;
  cloudflare: Omit<ConnectionsStatus['github'], 'scopes' | 'host'>;
}
export interface GithubItems {
  repo: string | null;
  items: {
    number: number;
    title: string;
    url: string;
    state: 'open';
    author?: string;
    updated_at: string;
    checks?: 'passing' | 'failing' | 'pending';
    /** Pull requests only, like the fields below; absent without checks. */
    checks_passed?: number;
    checks_total?: number;
    /** Absent when GitHub reports no review decision. */
    review_decision?: GithubReviewDecision;
    head?: string;
    /** The session that opened the pull request, or whose worktree is on its head branch. */
    session_id?: string;
  }[];
}
export type GithubReviewDecision = 'approved' | 'changes_requested' | 'review_required';
/** GET /v1/github.pr.detail. */
export interface GithubPullDetail {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  review_decision: GithubReviewDecision | null;
  head: string;
  base: string;
  additions: number;
  deletions: number;
  /** The session that opened the pull request, or whose worktree is on its head branch. */
  session_id?: string;
  /** duration_ms is null until the check has both started and finished. */
  checks: {
    name: string;
    state: 'passed' | 'failed' | 'running' | 'skipped';
    duration_ms: number | null;
    url: string | null;
  }[];
  /** Each thread's first comment; unresolved threads first. line is null when the thread is outdated. */
  threads: { path: string; line: number | null; author: string; body: string; resolved: boolean }[];
}
export { prettifyError, ZodError, type ZodIssue } from 'zod';
export * from './change-story.js';
export * from './project-waiting.js';
export * from './agent-chapters.js';

// Lives here, not in domain: the web bundle imports protocol at run time, and domain imports node:crypto.
export function sessionRole(
  session: Pick<Session, 'review_id' | 'baseline' | 'change_story' | 'range_story'>,
): SessionRole {
  if (session.review_id) return 'reviewer';
  if (session.baseline) return 'baseline';
  if (session.change_story || session.range_story) return 'story';
  return 'main';
}

// The values of domain's EffortLevel, kept here for the same reason as sessionRole.
export const EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly EffortLevel[];
// Fails to compile when EFFORT_LEVELS misses a level of EffortLevel.
const effortLevelsComplete: [EffortLevel] extends [(typeof EFFORT_LEVELS)[number]] ? true : false =
  true;
// The values of domain's TASK_DOMAINS and TASK_TIERS, kept here for the same reason as sessionRole.
const taskDomains = [
  'review',
  'frontend-ui',
  'script-infra',
  'backend-logic',
  'docs-chore',
] as const satisfies readonly TaskKind['domain'][];
const taskTiers = ['t1', 't2', 't3'] as const satisfies readonly TaskKind['tier'][];
// The values of domain's FLOW_PATHS, kept here for the same reason as sessionRole.
const flowPaths = [
  'direct',
  'dispatch',
  'review_loop',
  'parallel',
] as const satisfies readonly FlowPath[];
// Fails to compile when flowPaths misses a value of FlowPath.
const flowPathsComplete: [FlowPath] extends [(typeof flowPaths)[number]] ? true : false = true;
// The values of domain's LANE_DEPTHS, kept here for the same reason as sessionRole.
const laneDepths = ['just_do', 'plan_first', 'spec_first'] as const satisfies readonly LaneDepth[];
// Fails to compile when laneDepths misses a value of LaneDepth.
const laneDepthsComplete: [LaneDepth] extends [(typeof laneDepths)[number]] ? true : false = true;
// Fails to compile when either list misses a value of TaskKind.
const taskKindComplete: [TaskKind] extends [
  { domain: (typeof taskDomains)[number]; tier: (typeof taskTiers)[number] },
]
  ? true
  : false = true;

const memoryTools = {
  memory_context: 'memory.context',
  memory_search: 'memory.search',
  memory_related: 'memory.related',
  memory_get: 'memory.get',
  memory_propose: 'memory.propose',
} as const;
const browserTools = {
  browser_open: 'browser.open',
  browser_read: 'browser.read',
  browser_screenshot: 'browser.screenshot',
} as const;
export const sessionTools = {
  reviewer: { ...memoryTools, review_finding: 'review.finding', ...reviewerTools },
  planner: {
    ...memoryTools,
    project_read: 'project.read',
    draw: 'visual.draw',
    ...browserTools,
  },
  lead: {
    ...memoryTools,
    project_read: 'project.read',
    update_board: 'board.plan.update',
    edit_board: 'board.plan.edit',
    propose_board: 'board.plan.propose',
    withdraw_board_proposal: 'board.plan.proposal.withdraw',
    start_task: 'task.start',
    message_task: 'task.message',
    accept_task: 'task.accept',
    read_note: 'lead.note.read',
    ask_user: 'lead.ask',
    answer_worker_question: 'lead.worker_question.answer',
    stop_task: 'task.stop',
    report: 'task.report',
    status_line: 'task.status_line',
    interrupt_task: 'task.interrupt',
    stop_background: 'task.background.stop',
    sync_board: 'board.sync',
    rerun_baseline: 'project.baseline.start',
    request_review: 'review.request',
    merge_task: 'session.merge',
    draw: 'visual.draw',
    ...browserTools,
    ...alwaysOnTools,
    ...appTools,
    ...agentTools,
    guide: 'agent.guide',
  },
  worker: {
    ...memoryTools,
    project_read: 'project.read',
    report: 'task.report',
    status_line: 'task.status_line',
    draw: 'visual.draw',
    ...browserTools,
  },
  conductor: {
    request_review: 'conductor.review',
    report_ready: 'conductor.ready',
    spawn_session: 'conductor.spawn',
    read_state: 'conductor.state',
  },
} as const;

/** What each lead tool does; a costly one asks the user before every call. */
export const leadToolEffects = {
  memory_context: 'read',
  memory_search: 'read',
  memory_related: 'read',
  memory_get: 'read',
  memory_propose: 'write',
  project_read: 'read',
  update_board: 'write',
  edit_board: 'write',
  propose_board: 'write',
  withdraw_board_proposal: 'write',
  start_task: 'write',
  message_task: 'write',
  accept_task: 'write',
  read_note: 'read',
  ask_user: 'write',
  answer_worker_question: 'write',
  stop_task: 'write',
  report: 'write',
  status_line: 'write',
  interrupt_task: 'write',
  stop_background: 'write',
  sync_board: 'read',
  rerun_baseline: 'costly',
  request_review: 'write',
  merge_task: 'write',
  draw: 'write',
  browser_open: 'write',
  browser_read: 'read',
  browser_screenshot: 'read',
  ...alwaysOnToolEffects,
  ...appToolEffects,
  ...agentToolEffects,
  guide: 'read',
} as const satisfies Record<keyof typeof sessionTools.lead, 'read' | 'write' | 'costly'>;

const inGroup = <T extends object>(tools: T, group: AgentToolGroup) =>
  Object.fromEntries(Object.keys(tools).map((name) => [name, group])) as Record<
    keyof T,
    AgentToolGroup
  >;
/**
 * The group of each lead tool; a resident gets the tools of its profile's groups. Every lead gets
 * guide, whatever its groups.
 */
export const leadToolGroups: Record<
  Exclude<keyof typeof sessionTools.lead, 'guide'>,
  AgentToolGroup
> = {
  ...inGroup(memoryTools, 'memory'),
  ...inGroup(browserTools, 'browser'),
  ...inGroup(alwaysOnTools, 'always_on'),
  ...appToolGroups,
  ...agentToolGroups,
  project_read: 'board',
  update_board: 'board',
  edit_board: 'board',
  propose_board: 'board',
  withdraw_board_proposal: 'board',
  read_note: 'board',
  ask_user: 'board',
  answer_worker_question: 'board',
  sync_board: 'board',
  rerun_baseline: 'board',
  draw: 'board',
  status_line: 'board',
  start_task: 'dispatch',
  message_task: 'dispatch',
  accept_task: 'dispatch',
  stop_task: 'dispatch',
  report: 'dispatch',
  interrupt_task: 'dispatch',
  stop_background: 'dispatch',
  request_review: 'dispatch',
  merge_task: 'dispatch',
};

/** Extra tools exist only for daemon-created, purpose-bound project sessions. */
export const coordinationTools = {
  trace_evidence: 'trace.evidence',
  trace_report: 'trace.report',
  project_baseline_submit_folder: 'project.baseline.submit_folder',
  project_baseline_submit: 'project.baseline.submit',
  project_intro_submit: 'project.intro.submit',
  change_story_submit: 'change_story.submit',
} as const;

export type {
  BoardSnapshot,
  BrowserBounds,
  BrowserRequest,
  BrowserState,
  BridgeResult,
  DaemonInfo,
  EventFrame,
  DesktopBridge,
  FileRef,
  MenuAction,
  NotificationTarget,
  PopupMenuItem,
  WaitingSession,
  UiLocale,
  UiLocaleChoice,
  WindowContext,
  WindowRequest,
  WindowPlace,
  WindowSnapshotSource,
  ShellPrefs,
  VoiceEvent,
  AppInfo,
  RendererCrash,
  TerminalFrame,
} from './bridge.js';
export { ZOOM_FACTORS } from './bridge.js';
export const PROTOCOL_VERSION = 1;
export const USER_PRINCIPAL_ID = 'local-user';
const str = z.string().min(1).max(65536);
const findingText = str.refine((value) => value.trim().length > 0);
const strings = z.array(str).max(256);
/** The questions of an AskUserQuestion request, within the SDK limits. */
export const approvalQuestions = z
  .array(
    z.object({
      question: str,
      header: z.string().max(65536),
      options: z.array(z.object({ label: str, description: z.string().max(65536) })).max(4),
      multiSelect: z.boolean(),
      id: str.optional(),
      other: z.boolean().optional(),
      secret: z.boolean().optional(),
      recommended: str.optional(),
    }),
  )
  .min(1)
  .max(4);
const projectEnvironment = z
  .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(65536))
  .refine((env) => Object.keys(env).length <= 256, 'At most 256 environment variables');
export const commandSchema = z.strictObject({
  protocol_version: z.literal(PROTOCOL_VERSION),
  command_id: str,
  idempotency_key: str,
  actor: str,
  expected_revision: z.number().int().nonnegative().nullable(),
  type: str,
  input: z.record(z.string(), z.unknown()),
});
export type Command = z.infer<typeof commandSchema>;
/** The most characters of page text a browser read returns. */
export const BROWSER_TEXT_LIMIT = 50_000;
const browserPage = z.strictObject({
  url: z.string().max(65536),
  title: z.string().max(65536),
  text: z.string().max(BROWSER_TEXT_LIMIT).optional(),
  /** The page's text was longer than BROWSER_TEXT_LIMIT and ends there. */
  truncated: z.boolean().optional(),
  /** Base64 PNG of the page, for a screenshot. */
  png: z
    .string()
    .max(1024 * 1024)
    .optional(),
});
/** What a browser tool returns about the session's browser panel page. */
export type BrowserPage = z.infer<typeof browserPage>;
const boardText = z.string().min(1).max(400);
/** One part of a parallel task: its part number from 1, or the id of its session. */
const partSelector = z.union([z.number().int().min(1).max(4), z.string().min(1)]).optional();
const planIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const planId = z.string().regex(planIdPattern);
const RECORDED_ONLY = 'Recorded only; Pantheon does not act on it yet.';
const planAssumption = z.strictObject({
  text: boardText.describe('The decision, at most 400 characters.'),
  id: planId
    .optional()
    .describe(
      'Optional short id, unique among the assumptions; the user can refute only an assumption with an id.',
    ),
  affects: z
    .array(planId)
    .max(16)
    .optional()
    .describe(
      'Optional: up to 16 ids of the tasks that rest on it; they show a pending edit while a refute of it waits for you.',
    ),
  milestone: planId
    .optional()
    .describe(`Optional: the id of the milestone that rests on it. ${RECORDED_ONLY}`),
});
const planRisk = z.strictObject({
  text: boardText.describe('What could go wrong, and its effect, at most 400 characters.'),
  id: planId
    .optional()
    .describe(
      'Optional short id, unique among the risks; once you drop the risk from the plan, project memory records it as closed.',
    ),
  milestone: planId.optional().describe('Optional: the id of the milestone the risk threatens.'),
});
const planTitle = z.string().min(1).max(80);
const taskPriority = z.enum(['high', 'normal', 'low']);
const runtimeChoice = z.strictObject({
  runtime: str,
  model: str.optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});
const taskKind = z
  .strictObject({
    domain: z
      .enum(taskDomains)
      .describe('review, frontend-ui, script-infra, backend-logic or docs-chore.'),
    tier: z.enum(taskTiers).describe('t1, t2 or t3; Pantheon may raise it from the scope.'),
  })
  .describe(
    '`domain` (review, frontend-ui, script-infra, backend-logic, docs-chore) and `tier` (t1, t2, t3). Pantheon may raise the tier from the scope.',
  );
const calendarDay = z.iso.date();
const planIterations = z
  .array(
    z
      .strictObject({
        id: z.string().describe('Short id that tasks name in `iteration`.'),
        title: z.string().describe('The iteration name shown on the board.'),
        starts_on: calendarDay.describe('First day, YYYY-MM-DD.'),
        ends_on: calendarDay.describe('Last day, YYYY-MM-DD, not before starts_on.'),
      })
      .refine((iteration) => iteration.starts_on <= iteration.ends_on, {
        message: 'starts_on must be on or before ends_on',
      }),
  )
  .refine(
    (iterations) => new Set(iterations.map((iteration) => iteration.id)).size === iterations.length,
    { message: 'Iteration ids must be unique' },
  );
const planTask = z
  .strictObject({
    id: planId.describe(
      'Stable id (letters, digits, `_.-`, at most 40); keep it when the task stays, since sessions and history hang on it.',
    ),
    title: planTitle.describe('At most 80 characters; what the task delivers.'),
    goal: boardText.describe(
      'At most 400 characters: what to change and why, and how to tell it is done. The task session sees only this task, so put what does not fit in `brief`.',
    ),
    /** What the goal has no room for: purpose, known cause, files and limits. */
    brief: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        'Optional, up to 2000 characters: what the goal has no room for, such as the purpose, the files, symbols or symptoms you found, the known cause and what not to touch. Write your own conclusions; the session cannot read your conversation.',
      ),
    lane: planId.describe('The id of its lane.'),
    milestone: planId.optional().describe('The id of the milestone it counts toward.'),
    iteration: z.string().optional().describe('The id of an iteration in `iterations`.'),
    estimate: z
      .number()
      .int()
      .min(1)
      .max(13)
      .optional()
      .describe('Optional size estimate, 1-13, shown on the board.'),
    depends_on: z
      .array(planId)
      .max(16)
      .describe('Ids of tasks that must be done before this one opens, at most 16.'),
    /** Verbatim quotes of the user's messages to the lead, or of text the user wrote in an external event. */
    source: z
      .array(boardText)
      .max(4)
      .describe(
        "1-4 excerpts copied verbatim from the user's messages; a quote no user message contains is refused. May be empty only when `external_source` is given.",
      ),
    /** Verbatim quotes of what other people wrote in an external event. */
    external_source: z
      .array(boardText)
      .max(4)
      .optional()
      .describe(
        'Up to 4 verbatim excerpts of what other people wrote in an external request; the task session reads them as information, not instructions.',
      ),
    /** The subject key of the external request, such as github:owner/repo#12, the task was planned for. */
    external_subject: str
      .optional()
      .describe(
        'The subject key of the external request the task serves, such as github:owner/repo#12, as its board update names it.',
      ),
    /** Repository-relative paths or directories the task may change. */
    scope: z
      .array(z.string().min(1).max(200))
      .max(16)
      .describe(
        'Repository-relative paths or directories the task may change, 1-16 (may be empty for done_when report). List test, build or CI configuration files by exact path when the task must change them.',
      ),
    /** Shell commands that must pass before the task is done. */
    acceptance: z
      .array(z.string().min(1).max(400))
      .max(8)
      .describe(
        '1-8 shell commands that must pass (may be empty for done_when report). They run in a fresh clone with dependency folders but no build output; start with the build step a command needs.',
      ),
    /** The runtime, model and effort of the session Pantheon opens for the task. */
    runtime: str
      .optional()
      .describe(
        "The runtime of the task's session; absent means the project's writer default when one is set, else its default runtime.",
      ),
    model: str
      .optional()
      .describe("The model of the task's session; absent means the default for its runtime."),
    effort: z
      .enum(EFFORT_LEVELS)
      .optional()
      .describe("The reasoning effort of the task's session; absent means the default."),
    kind: taskKind.optional(),
    task_type: z
      .enum(['feature', 'fix', 'research', 'infra', 'docs'])
      .optional()
      .describe('feature, fix, research, infra or docs; shown on the board.'),
    /** Tokens; stored for display without enforcing the budget. */
    token_budget: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Tokens, shown on the board; not enforced.'),
    /** Why the runtime, model or effort differs from the project's defaults. */
    route_reason: boardText
      .optional()
      .describe("One sentence on why runtime, model or effort differ from the project's defaults."),
    /** The device id the task's session runs on; absent means this machine. */
    device: str
      .optional()
      .describe('The device id from lead.devices the session runs on; absent means this machine.'),
    /** Why the task runs on the device. */
    device_reason: boardText.optional().describe('One sentence on why it runs there.'),
    /** Labels the device must have. */
    needs: z
      .array(z.string().min(1).max(64))
      .max(8)
      .optional()
      .describe(
        'Labels the device must have: os=<system>, arch=<architecture> and device labels as lead.devices gives them; at most 8.',
      ),
    /** Named resources of the device the session holds while it runs, and how many of each. */
    uses: z
      .record(str, z.number().int().positive())
      .optional()
      .describe(
        'Resources the session holds while it runs, name to amount, such as {"postgres": 1}; only names lead.devices lists for that device, at most the listed amount.',
      ),
    /** The flow path the task takes; absent means the one the workflow policy gives its tier. */
    path: z
      .enum(flowPaths)
      .optional()
      .describe(
        'direct, dispatch, review_loop or parallel; absent means lead.workflow.path for its tier.',
      ),
    /** Retired; a stored value is accepted and ignored. */
    workflow_id: str.optional().meta({ retired: true }),
    parallel: z
      .array(
        z.strictObject({
          title: planTitle.describe('At most 80 characters; what this part delivers.'),
          goal: boardText.describe(
            "At most 400 characters: this part's own goal; its session sees only this part.",
          ),
          scope: z
            .array(z.string().min(1).max(200))
            .min(1)
            .max(16)
            .describe(
              'The paths this part may change, 1-16; keep them apart from the other parts.',
            ),
          acceptance: z
            .array(z.string().min(1).max(400))
            .min(1)
            .max(8)
            .describe('1-8 shell commands that must pass for this part.'),
        }),
      )
      .min(2)
      .max(4)
      .optional()
      .describe(
        'For path parallel: 2-4 parts, each with its own `title`, `goal`, `scope` and `acceptance`; one session opens per part.',
      ),
    /** Why the task takes a different flow path from the one its kind is given. */
    flow_reason: boardText
      .optional()
      .describe('One sentence on why `path` differs from the suggested one.'),
    /** A report task is done when the lead accepts its done report; it may have no scope or acceptance. */
    done_when: z
      .enum(['merged', 'report'])
      .optional()
      .describe(
        'merged (default): done when its session merges. report: done when you accept its done report; for research or a document reply.',
      ),
    /** Absent means normal. */
    priority: taskPriority.optional().describe('high, normal (default) or low.'),
  })
  .refine(
    (task) => task.done_when === 'report' || (task.scope.length > 0 && task.acceptance.length > 0),
    {
      message:
        'A task that is done when merged needs at least one scope path and acceptance command',
    },
  );
const opTaskId = planId.describe('The id of the task in your plan.');
const planChangeOps = [
  z.strictObject({
    type: z.literal('set_iterations').describe('set_iterations: replace the iteration list.'),
    iterations: planIterations.describe(
      'The full list of iterations: `id`, `title`, `starts_on` and `ends_on` as YYYY-MM-DD.',
    ),
  }),
  z.strictObject({
    type: z.literal('add_task').describe('add_task: add one task.'),
    task: planTask.describe('A full task, with the same fields as a task of update_board.'),
  }),
  z.strictObject({
    type: z.literal('remove_task').describe('remove_task: remove the task `task_id`.'),
    task_id: opTaskId,
  }),
  z.strictObject({
    type: z.literal('move_task').describe('move_task: move the task `task_id` in the order.'),
    task_id: opTaskId,
    before: planId.nullable().describe('The task it goes before, or null for the end.'),
  }),
  z.strictObject({
    type: z.literal('set_task').describe('set_task: change fields of the task `task_id`.'),
    task_id: opTaskId,
    patch: z
      .strictObject({
        goal: planTask.shape.goal.optional(),
        brief: planTask.shape.brief,
        scope: planTask.shape.scope.optional(),
        acceptance: planTask.shape.acceptance.optional(),
        done_when: planTask.shape.done_when,
        milestone: planId
          .nullable()
          .optional()
          .describe('The id of the milestone it counts toward; null removes it.'),
        iteration: z
          .string()
          .nullable()
          .optional()
          .describe('The id of an iteration; null removes it.'),
        estimate: planTask.shape.estimate,
        runtime: planTask.shape.runtime,
        /** null takes the task's model or effort away, so the runtime's default applies. */
        model: str
          .nullable()
          .optional()
          .describe("The model of the task's session; null returns to the runtime's default."),
        effort: z
          .enum(EFFORT_LEVELS)
          .nullable()
          .optional()
          .describe("The reasoning effort; null returns to the runtime's default."),
        title: planTask.shape.title.optional(),
        lane: planTask.shape.lane.optional(),
        priority: planTask.shape.priority,
        kind: planTask.shape.kind,
        /** null takes the task's type or budget away. */
        task_type: planTask.shape.task_type
          .nullable()
          .describe('feature, fix, research, infra or docs; null removes it.'),
        token_budget: planTask.shape.token_budget
          .nullable()
          .describe('Tokens, shown on the board; null removes it.'),
        route_reason: planTask.shape.route_reason,
        device: planTask.shape.device,
        device_reason: planTask.shape.device_reason,
        needs: planTask.shape.needs,
        uses: planTask.shape.uses,
        /** null takes the task's own path and flow_reason away, so its tier's path applies. */
        path: z
          .enum(flowPaths)
          .nullable()
          .optional()
          .describe(
            'direct, dispatch, review_loop or parallel; null removes it and its flow_reason, so the path for its tier applies.',
          ),
        flow_reason: planTask.shape.flow_reason,
        /** Retired; a stored value is accepted and ignored. */
        workflow_id: str.nullable().optional().meta({ retired: true }),
        parallel: planTask.shape.parallel,
      })
      .describe('Only the fields that change; the others keep their value.'),
  }),
  z.strictObject({
    type: z
      .literal('set_dependencies')
      .describe('set_dependencies: replace what the task `task_id` depends on.'),
    task_id: opTaskId,
    depends_on: planTask.shape.depends_on.describe(
      'The full list of task ids it depends on, at most 16; [] for none.',
    ),
  }),
  /** due_on null takes the milestone's due day away. */
  z.strictObject({
    type: z.literal('set_milestone').describe('set_milestone: change one milestone.'),
    milestone_id: planId.describe('The id of the milestone in your plan.'),
    patch: z
      .strictObject({
        title: planTitle.optional().describe('The new title, at most 80 characters.'),
        due_on: calendarDay
          .nullable()
          .optional()
          .describe('The due day, YYYY-MM-DD; null removes the day.'),
        goal: z
          .string()
          .min(1)
          .max(64)
          .nullable()
          .optional()
          .describe(
            'Optional: the id of a goal in project_read.goals that this milestone serves; null removes the link; left out keeps it.',
          ),
      })
      .describe('`title`, `due_on` and/or `goal`.'),
  }),
] as const;
const planLane = z.strictObject({
  id: planId.describe('Short id (letters, digits, `_.-`) that tasks name in `lane`.'),
  title: planTitle.describe('At most 80 characters.'),
});
const planPatchOp = z.discriminatedUnion('type', [
  ...planChangeOps,
  /** A proposal's new lane, which its tasks may name. */
  z.strictObject({
    type: z
      .literal('add_lane')
      .describe(
        'add_lane: add a lane to your plan, so tasks this proposal adds can name it; give it before those tasks.',
      ),
    lane: planLane.describe('The new lane: `id` not used by another lane, and `title`.'),
  }),
]);
// A plan edit adds no lane; update_board writes the lanes.
const planEditOp = z.discriminatedUnion('type', [
  ...planChangeOps,
  z.strictObject({
    type: z.literal('lock_order').describe("lock_order: the user's own; a lead's call is refused."),
    task_ids: z.array(planId).describe('The task order to lock.'),
  }),
  z.strictObject({
    type: z
      .literal('unlock_order')
      .describe("unlock_order: the user's own; a lead's call is refused."),
  }),
  z.strictObject({
    type: z
      .literal('refute_assumption')
      .describe(
        "refute_assumption: the user's own; says a plan assumption is wrong and waits for the lead to resolve the edit. A lead's call is refused.",
      ),
    assumption_id: planId.describe('The id of the plan assumption that is wrong.'),
    instead: boardText.describe('What holds instead, in under 400 characters.'),
  }),
  z.strictObject({
    type: z
      .literal('resolve_edit')
      .describe('resolve_edit: answer a user edit that still waits for you.'),
    edit_id: str.describe('The edit_id the board update named.'),
    decision: z
      .enum(['apply', 'reject'])
      .describe("apply to accept the user's edit, reject to turn it down."),
    reason: boardText.optional().describe('Why, in under 400 characters.'),
  }),
]);
/** The plan version a write was based on; a write based on an older one is refused. */
const baseVersion = z.number().int().nonnegative();
const argv = z.array(str.refine((value) => !value.includes('\0'))).min(1);
const gateCommand = z.strictObject({
  name: str.describe('The name the gate shows for the command.'),
  argv: argv.describe('The program and its arguments, run without a shell.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(2147483647)
    .optional()
    .describe('Optional: the most milliseconds the command may run; 20 minutes when absent.'),
  enabled: z
    .boolean()
    .optional()
    .describe('Optional: false keeps the command in the list without running it.'),
  skippable: z
    .boolean()
    .optional()
    .describe('Optional: true reports a failure as skipped, which does not fail the gate.'),
});
const worktreePath = str.refine(
  (value) => {
    if (value.startsWith('/')) return false;
    let depth = 0;
    for (const segment of value.split('/')) {
      if (segment === '..') depth--;
      else if (segment && segment !== '.') depth++;
      if (depth < 0) return false;
    }
    return depth > 0;
  },
  { message: 'Copy paths must stay inside the project folder' },
);
const extensionOverrides = z.strictObject({
  disabled_mcp_servers: strings,
  disabled_plugins: strings,
  disabled_skills: strings,
  disable_apps: z.boolean(),
  disable_hooks: z.boolean(),
  enabled_user_mcp_servers: strings.optional(),
  enabled_user_skills: strings.optional(),
  enabled_user_connectors: strings.optional(),
});
/** `file:<relative path>`, `file:<relative path>:<line>` or `commit:<7-40 hex digits>`. */
const sourceRef = str.regex(/^(?:file:[^/\0][^\0]*|commit:[0-9a-fA-F]{7,40})$/);
const sources = z.array(sourceRef).min(1).max(16);
const baselineStage = z.enum(['empty', 'early', 'active', 'maintenance']);
const projectBrief = z.strictObject({ goal: str, goals: strings, non_goals: strings });
/** An extension suggested off for coding sessions; `name` is written as the inventory lists it. */
const baselineExtensions = z
  .array(
    z.strictObject({
      runtime: str,
      kind: z.enum(['mcp_server', 'plugin', 'skill']),
      name: str,
      reason: boardText,
    }),
  )
  .max(64);
const sessionFrom = z.union([z.strictObject({ branch: str }), z.strictObject({ session_id: str })]);
const sessionWorkspace = {
  /**
   * Absent is a worktree. auto: the project folder while no session writes there, else a worktree
   * that records the writer; a start point or a board task always gets a worktree.
   */
  workspace: z.enum(['worktree', 'in_place', 'auto']).optional(),
  from: sessionFrom.optional(),
};
const validSessionWorkspace = (input: { workspace?: string; from?: unknown }) =>
  input.workspace !== 'in_place' || input.from === undefined;
const turnExtras = {
  refs: z
    .array(
      z.union([
        z.strictObject({ kind: z.literal('session'), id: str }),
        z.strictObject({ kind: z.enum(['pr', 'issue']), number: z.number().int().positive() }),
      ]),
    )
    .max(8)
    .optional(),
  /** Ids returned by POST /v1/attachments. */
  attachments: z.array(str).max(10).optional(),
  skills: z
    .array(z.strictObject({ name: str, path: str }))
    .max(10)
    .optional(),
};
const sessionInput = z.strictObject({
  session_id: str,
  input: str,
  ...turnExtras,
  /** The MCP server whose interface sent this message. */
  app: z.strictObject({ server: str }).optional(),
});
const commandSet = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    setup: item.optional(),
    build: item.optional(),
    test: item.optional(),
    lint: item.optional(),
    dev: item.optional(),
  });
/** Paths and `file:` sources inside a folder block are relative to that folder's root. */
const baselineFolderSchema = z.strictObject({
  root: str,
  stage: baselineStage,
  stack: strings.optional(),
  context: z.strictObject({ instructions: strings, docs: strings, task_lists: strings }).optional(),
  // The model writes no numbers, so a gate timeout comes only from the user.
  gate: z.array(gateCommand.omit({ timeout_ms: true }).extend({ sources })),
  commands: commandSet(z.strictObject({ argv, sources })).optional(),
});
const baselinePreview = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('graph'),
    // visualSpecs is defined further down.
    spec: z.lazy(() =>
      visualSpecs.graph.refine((spec) => spec.nodes.length <= 40, {
        message: 'A preview graph has at most 40 nodes',
        path: ['nodes'],
      }),
    ),
  }),
  z.strictObject({
    kind: z.literal('mermaid'),
    spec: z.strictObject({ source: z.string().min(1).max(4000) }),
  }),
]);
const baselineQuestion = z
  .strictObject({
    id: str,
    header: z.string().min(1).max(12),
    question: str,
    options: z
      .array(
        z.strictObject({
          label: z.string().min(1).max(80),
          description: boardText,
          preview: baselinePreview.optional(),
        }),
      )
      .min(2)
      .max(4),
    multiSelect: z.boolean(),
    recommended: z.string().min(1).max(80).optional(),
    kind: z.literal('direction').optional(),
  })
  .refine(
    (question) =>
      question.recommended === undefined ||
      question.options.some((option) => option.label === question.recommended),
    { message: 'recommended must be the label of an option', path: ['recommended'] },
  );
/** Multi-select answers join the chosen labels with "; "; `by: 'model'` leaves the choice to the model. */
const baselineAnswers = z
  .array(
    z.strictObject({
      question_id: str,
      question: str,
      answer: z.string().max(65536),
      by: z.enum(['user', 'model']),
    }),
  )
  .max(5);
/** Project-level `file:` sources are accepted when they resolve inside any project root. */
const baselineSubmission = {
  workstreams: z
    .array(
      z.strictObject({
        id: str,
        title: z.string().min(1).max(80),
        status: z.enum(['done', 'running', 'next', 'blocked']),
        reason: boardText,
        /** `file:<path>:<line>` of a checklist item, the path relative to its folder. */
        items: z.array(str.regex(/^file:[^/\0][^\0]*:[1-9][0-9]*$/)).max(200),
        /** `section:<path>#<heading>` of a whole checklist section, the path relative to its folder. */
        sections: z.array(str.regex(/^section:[^/\0][^#\0]*#[^\0]*$/)).max(50),
        commits: z.array(str.regex(/^commit:[0-9a-fA-F]{7,40}$/)).max(50),
        next: z.array(boardText).max(12),
        blockers: z.array(boardText).max(12),
        /** Directories or files relative to a project root. */
        modules: z.array(str).max(16).optional(),
        /** Ids of other workstreams above. */
        depends_on: z.array(str).max(12).optional(),
        risks: z.array(boardText).max(8).optional(),
      }),
    )
    .max(12),
  contradictions: z.array(z.strictObject({ text: boardText, refs: sources })).max(16),
  findings: z
    .array(z.strictObject({ text: boardText, refs: sources, severity: z.enum(['info', 'risk']) }))
    .max(16),
  brief: projectBrief.extend({ sources }).optional(),
  questions: z.array(baselineQuestion).max(5),
  extensions: baselineExtensions.optional(),
  /** `workstream` is the id of a workstream above; `scope` holds repo-relative paths, `acceptance` shell commands. */
  tasks: z
    .array(
      z.strictObject({
        id: str,
        title: planTitle,
        workstream: str,
        why: boardText,
        scope: z.array(str).min(1).max(16),
        acceptance: z.array(str).max(8),
        depends_on: z.array(str).max(12),
        sources,
      }),
    )
    .max(12)
    .default([]),
};
/** `.pantheon/config.json`, committed with the project. */
export const pantheonConfigSchema = z.strictObject({
  version: z.literal(1),
  project: z
    .strictObject({ stage: baselineStage.optional(), stack: strings.optional() })
    .optional(),
  context: z
    .strictObject({
      instructions: strings.optional(),
      docs: strings.optional(),
      task_lists: strings.optional(),
    })
    .optional(),
  brief: projectBrief.optional(),
  gate: z.array(gateCommand).optional(),
  commands: commandSet(argv).optional(),
  extensions: z.record(str, extensionOverrides).optional(),
  decisions: z.array(z.strictObject({ question: str, answer: str })).optional(),
});
/** `.pantheon/config.local.json`; unknown keys, such as retired settings, are dropped instead of rejecting the project. */
export const pantheonLocalConfigSchema = z.object(pantheonConfigSchema.shape).partial();
export const BACKEND_PROTOCOLS = [
  'anthropic',
  'openai-responses',
  'openai-chat',
  'gemini',
] as const;
export const backendProfileSchema = z.strictObject({
  id: str.regex(/^[a-z0-9-]+$/),
  protocol: z.enum(BACKEND_PROTOCOLS),
  base_url: z.url(),
  key: z.union([z.strictObject({ env: str }), z.strictObject({ keychain: str })]),
  models: strings.optional(),
});
/** `local` names this machine. */
const deviceId = str.regex(/^(?!local$)[a-z0-9][a-z0-9-]*$/);
/** An execution device reached over SSH. */
export const deviceConfigSchema = z.strictObject({
  /** The SSH target, usually a host alias of `~/.ssh/config`. */
  ssh: str,
  name: str.optional(),
  /** The user's description of the device, for the model choosing where a task runs. */
  note: str.optional(),
  labels: strings.optional(),
  /** Named resources and how many of each the device has. */
  resources: z.record(str, z.number().int().positive()).optional(),
  max_sessions: z.number().int().positive().optional(),
});
const workflowParam = z.enum([
  'path',
  'acceptance_wake',
  'max_parallel',
  'handback_limit',
  'task_size_hint',
  'runtime_quota_threshold',
  'budget',
] as const satisfies readonly WorkflowParam[]);
// Fails to compile when workflowParam misses a value of WorkflowParam.
const workflowParamComplete: [WorkflowParam] extends [z.infer<typeof workflowParam>]
  ? true
  : false = true;
const charterMode = z.enum(['on', 'ask', 'off'] as const satisfies readonly CharterMode[]);
/** The charter entries a policy stores; plan_change and start_external follow their own settings. */
const charter = z.strictObject({
  approve_worker_prompts: charterMode.optional(),
  answer_worker_questions: charterMode.optional(),
  create_agent: charterMode.optional(),
  accept_milestone: charterMode.optional(),
  merge_out_of_scope: charterMode.optional(),
} satisfies Partial<Record<CharterPower, unknown>>);
const flowPath = z.enum(flowPaths);
// A tier's tasks cannot all be parallel: a task takes that path only with lead-defined parts.
const tierPath = flowPath.exclude(['parallel']);
/** null clears the cell's budget. */
const taskBudget = z
  .strictObject({ input_tokens: z.number().int(), wall_ms: z.number().int() })
  .nullable()
  .optional();
const tierBudget = z
  .strictObject({
    direct: taskBudget,
    dispatch: taskBudget,
    review_loop: taskBudget,
    parallel: taskBudget,
  })
  .optional();
const sessionDefaults = {
  runtime: str,
  permission_mode: z.enum(['ask', 'auto_edit', 'plan', 'auto', 'full_access']),
  model: str.optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  single_model: z.boolean().optional(),
  writer: runtimeChoice.optional(),
  reviewer: runtimeChoice.optional(),
  fallbacks: z
    .strictObject({
      lead: runtimeChoice.optional(),
      writer: runtimeChoice.optional(),
      reviewer: runtimeChoice.optional(),
    })
    .optional(),
};
const storedTaskBudget = z
  .strictObject({ input_tokens: z.number().int(), wall_ms: z.number().int() })
  .optional();
const storedTierBudget = z
  .strictObject({
    direct: storedTaskBudget,
    dispatch: storedTaskBudget,
    review_loop: storedTaskBudget,
    parallel: storedTaskBudget,
  })
  .optional();
/** Workflow policy settings as a policy stores them; the project budget belongs to each project alone. */
const workflowPolicySettings = z.strictObject({
  /** No longer used; a stored value is read without error and ignored. */
  improvement_mode: z.enum(['auto', 'confirm', 'off']).optional(),
  plan_changes: z.enum(['auto', 'confirm']).optional(),
  charter: charter.optional(),
  must_ask_extra: z.array(str).optional(),
  urgent_direct: z.array(z.enum(['main_gate_failed'])).optional(),
  path: z
    .strictObject({ t1: tierPath.optional(), t2: tierPath.optional(), t3: tierPath.optional() })
    .optional(),
  acceptance_wake: z.enum(['each_merge', 'milestone']).optional(),
  max_parallel: z.number().int().optional(),
  max_parallel_limit: z.number().int().optional(),
  runtime_parallel: z.record(z.string(), z.number().int().min(1).max(8)).optional(),
  dispatch_paused: z.boolean().optional(),
  runtime_quota_threshold: z.number().optional(),
  gate_on_fail: z.enum(['handback', 'retry', 'stop']).optional(),
  gate_runner: z.enum(['daemon', 'session']).optional(),
  handback_limit: z.union([z.literal(0), z.number().int().min(2).max(5)]).optional(),
  task_size_hint: z.number().int().optional(),
  budget: z
    .strictObject({ t1: storedTierBudget, t2: storedTierBudget, t3: storedTierBudget })
    .optional(),
  pinned: z.array(workflowParam).max(7).optional(),
});
const externalEventsMode = z.enum(['off', 'approve', 'auto']);
/** The project settings that have a global value; each is stored under the same key on a project. */
export const PROJECT_SETTING_KEYS = [
  'workflow_policy',
  'session_defaults',
  'usage_targets',
  'external_events',
  'auto_merge',
] as const;
export type ProjectSettingKey = (typeof PROJECT_SETTING_KEYS)[number];
const projectSettingValues = {
  workflow_policy: workflowPolicySettings,
  session_defaults: z.strictObject(sessionDefaults),
  usage_targets: z.record(z.string(), z.number().int().nonnegative()),
  external_events: externalEventsMode,
  auto_merge: z.boolean(),
};
export type ProjectSettingValues = {
  [K in ProjectSettingKey]: z.infer<(typeof projectSettingValues)[K]>;
};
const decisionKinds = {
  plan_change: true,
  question: true,
  milestone_accept: true,
  repeated_failure: true,
  permission: true,
  budget: true,
  improvement: true,
  external: true,
  other: true,
} satisfies Record<NeedsYouItem['decision'], true>;
/** Every `NeedsYouItem.decision`. */
export const NEEDS_YOU_DECISIONS = Object.keys(decisionKinds) as NeedsYouItem['decision'][];
/** A kind the attention delivery rules name: a decision, or a notice that asks for none. */
export type AttentionKind = NeedsYouItem['decision'] | 'merged';
/** The keys of the attention delivery rules: the decisions, then the notices that ask for none. */
export const ATTENTION_KINDS: readonly AttentionKind[] = [...NEEDS_YOU_DECISIONS, 'merged'];
export type AttentionDelivery = 'now' | 'brief' | 'never';
const BRIEF_BY_DEFAULT: readonly AttentionKind[] = ['milestone_accept', 'merged'];
/** How each kind reaches the user until the user chooses: milestones to accept and merges wait for the brief. */
export const DEFAULT_ATTENTION_DELIVERY = Object.fromEntries(
  ATTENTION_KINDS.map((kind) => [kind, BRIEF_BY_DEFAULT.includes(kind) ? 'brief' : 'now']),
) as Record<AttentionKind, AttentionDelivery>;
/** A question that has waited this long reaches the user now, whatever the rules say. */
export const OVERDUE_QUESTION_MS = 4 * 3_600_000;
/** Whether the local time of `at` is inside the HH:MM range, which can cross midnight. */
export function withinHours(hours: { from: string; to: string }, at: number): boolean {
  const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const time = new Date(at),
    minutes = time.getHours() * 60 + time.getMinutes(),
    from = minutesOf(hours.from),
    to = minutesOf(hours.to);
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}
/** How the item reaches the user at `now`: an overdue question always now, else quiet hours hold now for the brief. */
export function deliveryFor(
  settings: Pick<AppSettings, 'attention_delivery' | 'quiet_hours'>,
  item: { decision: AttentionKind; created_at: number },
  now: number,
): AttentionDelivery {
  if (item.decision === 'question' && now - item.created_at > OVERDUE_QUESTION_MS) return 'now';
  const delivery = settings.attention_delivery[item.decision];
  return delivery === 'now' && settings.quiet_hours && withinHours(settings.quiet_hours, now)
    ? 'brief'
    : delivery;
}
const attentionDelivery = z.partialRecord(
  z.enum(ATTENTION_KINDS),
  z.enum(['now', 'brief', 'never']),
);
/** Retired; a stored agent_proposal rule is accepted and ignored. */
const storedAttentionDelivery = z.partialRecord(
  z.enum([...ATTENTION_KINDS, 'agent_proposal']),
  z.enum(['now', 'brief', 'never']),
);
/** The decisions the user can let the personal agent answer; none until the user turns one on. */
export const PERSONAL_ANSWER_KINDS = [
  'question',
  'plan_change',
  'milestone_accept',
] as const satisfies readonly NeedsYouItem['decision'][];
export type PersonalAnswerKind = (typeof PERSONAL_ANSWER_KINDS)[number];
const personalAnswers = z.array(z.enum(PERSONAL_ANSWER_KINDS));
const quietHours = z.strictObject({
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
/** `~/.pantheon/config.json`, the user's own backends and model families. */
export const userConfigSchema = z
  .strictObject({
    version: z.literal(1),
    backends: z.array(backendProfileSchema).default([]),
    model_families: z.record(str, str).default({}),
    /** Opening a folder that is not a git repository runs git init in it. */
    auto_git_init: z.boolean().optional(),
    auto_archive_merged: z.boolean().optional(),
    /** Sessions keep a recap of where they stand; absent is on. */
    session_recap: z.boolean().optional(),
    /** The brief of a project carries a paragraph from the side model; absent is on. */
    brief_prose: z.boolean().optional(),
    /** How each attention kind reaches the user; an absent kind is its default. */
    attention_delivery: storedAttentionDelivery.optional(),
    /** Local HH:MM range, possibly across midnight, in which now waits for the brief. */
    quiet_hours: quietHours.optional(),
    /** The most question rounds of a baseline; absent is 5. */
    baseline_rounds: z.number().int().min(1).max(5).optional(),
    /** The baseline session draws explanation charts, pinned to the board on confirm; absent is on. */
    baseline_visuals: z.boolean().optional(),
    /** Retired; a stored value is accepted and ignored. */
    baseline_range_story: z.boolean().optional(),
    /** The decisions the personal agent may answer for the user; absent is none. */
    personal_answers: personalAnswers.optional(),
    /** The binary and extra arguments each runtime starts with; absent uses the one on PATH. */
    runtimes: z
      .record(
        str,
        z.strictObject({
          binary: str.optional(),
          args: z.array(str).optional(),
          enabled: z.boolean().optional(),
          /** Claude only: subscription sessions may publish artifacts; absent is on. */
          artifacts: z.boolean().optional(),
          /** The runtime may be a writer, reviewer and text session without verified isolation; absent is off. */
          unverified_isolation: z.boolean().optional(),
        }),
      )
      .optional(),
    /** The user's execution devices besides this machine, by device id. */
    devices: z.record(deviceId, deviceConfigSchema).optional(),
    /** This machine's labels and resources besides the ones found; without max_sessions its task sessions have no limit. */
    local_device: z
      .strictObject({
        labels: deviceConfigSchema.shape.labels,
        resources: deviceConfigSchema.shape.resources,
        max_sessions: deviceConfigSchema.shape.max_sessions,
      })
      .optional(),
    /** What every project follows where it has no value of its own. */
    project_defaults: z
      .strictObject({
        workflow_policy: projectSettingValues.workflow_policy.optional(),
        session_defaults: projectSettingValues.session_defaults.optional(),
        usage_targets: projectSettingValues.usage_targets.optional(),
        external_events: projectSettingValues.external_events.optional(),
        auto_merge: projectSettingValues.auto_merge.optional(),
        /** Answer matching permission requests in every project, besides each project's own rules. */
        permission_rules: z.array(z.strictObject({ rule: str, added_at: z.number() })).optional(),
      })
      .optional(),
  })
  .refine(
    (config) =>
      new Set(config.backends.map((backend) => backend.id)).size === config.backends.length,
    { message: 'Backend ids must be unique', path: ['backends'] },
  );
export type BackendProfile = z.infer<typeof backendProfileSchema>;
export type UserConfig = z.infer<typeof userConfigSchema>;
const triggerEvent = str
  .optional()
  .describe(
    "Optional: the event of the replan note this change answers, from the note's event attribute.",
  );
// MCP tools omit bound fields; the daemon checks references on the complete plan.
export const boardPlanInputSchema = z.strictObject({
  project_id: str,
  base_version: baseVersion.describe(
    'The plan_version of your current plan from project_read; 0 before your first plan. A different number is refused with the current one.',
  ),
  trigger_event: triggerEvent,
  headline: planTitle.describe("The plan's title on the board, at most 80 characters."),
  lanes: z
    .array(
      planLane.extend({
        fanout_reason: boardText
          .optional()
          .describe('One sentence on why tasks of this lane run at the same time.'),
        depth: z
          .enum(laneDepths)
          .optional()
          .describe(
            `Optional: just_do to start its tasks at once, plan_first to plan before they start, spec_first to write a spec first. Shown to the user beside the lane; a lane with a t3 task waits for the user's plan approval whatever depth you give.`,
          ),
        stops: z
          .array(
            z
              .union([
                z.literal('plan'),
                z.string().regex(new RegExp(`^milestone:${planIdPattern.source.slice(1)}`)),
              ])
              .describe('`plan`, or `milestone:` and the id of a milestone of this plan.'),
          )
          .max(4)
          .optional()
          .describe(`Optional: up to 4 points where the lane waits for the user. ${RECORDED_ONLY}`),
        depth_reason: boardText
          .optional()
          .describe(
            `Optional: one sentence on why the lane has this depth. Shown to the user beside the lane; a lane with a t3 task waits for the user's plan approval whatever depth you give.`,
          ),
      }),
    )
    .min(1)
    .max(16)
    .describe('1-16 lanes; give each request its own lane.'),
  iterations: planIterations
    .default([])
    .describe(
      'Optional time boxes: `id`, `title`, `starts_on` and `ends_on` as YYYY-MM-DD, start not after end.',
    ),
  tasks: z
    .array(planTask)
    .max(64)
    .describe('Up to 64 tasks. Leaving out a task that exists removes it.'),
  milestones: z
    .array(
      z.strictObject({
        id: planId.describe('Short id that tasks name in `milestone`.'),
        title: planTitle.describe('At most 80 characters.'),
        criteria: z
          .array(boardText)
          .min(1)
          .max(12)
          .describe('1-12 checkable statements of what must hold.'),
        tasks: z.array(planId).min(1).max(64).describe('The ids of its tasks.'),
        due_on: calendarDay.optional().describe('Optional due day, YYYY-MM-DD.'),
        goal: z
          .string()
          .min(1)
          .max(64)
          .nullable()
          .optional()
          .describe(
            'Optional: the id of a goal in project_read.goals that this milestone serves; null removes the link; left out keeps it.',
          ),
        replan_if: z
          .array(
            z.discriminatedUnion('type', [
              z.strictObject({
                type: z
                  .literal('handbacks')
                  .describe('handbacks: after this many tasks of the milestone are handed back.'),
                count: z.number().int().min(1).max(10).describe('1-10 handbacks.'),
              }),
              z.strictObject({
                type: z
                  .literal('budget_ratio')
                  .describe(
                    "budget_ratio: once the milestone's tasks spend this share of their token budget.",
                  ),
                at: z
                  .number()
                  .gt(0)
                  .max(2)
                  .describe('Tokens spent over budgeted, above 0 and at most 2.'),
              }),
              z.strictObject({
                type: z
                  .literal('stall')
                  .describe('stall: when the milestone stops making progress.'),
              }),
              z.strictObject({
                type: z
                  .literal('assumption_false')
                  .describe('assumption_false: when the named assumption turns out false.'),
                assumption_id: planId.describe('The id of an assumption of this plan.'),
              }),
            ]),
          )
          .max(4)
          .optional()
          .describe(
            'Optional: up to 4 conditions on which you re-plan the milestone. When a task of the milestone meets handbacks, budget_ratio or stall, Pantheon sends you a replan note once per task generation; for assumption_false, once you apply an edit of the user that says the assumption is wrong.',
          ),
      }),
    )
    .max(16)
    .describe('Up to 16 milestones.'),
  risks: z
    .array(planRisk)
    .max(16)
    .describe(
      'Up to 16 `{ text }`, each at most 400 characters: what could go wrong, and its effect.',
    ),
  assumptions: z
    .array(planAssumption)
    .max(16)
    .describe(
      'Up to 16 `{ text }`: each decision you made for the user on an open point, so they can correct it.',
    ),
});

const visualSize = z.enum(['S', 'M', 'L']);
const visualTime = z.union([
  z.iso.date(),
  z.iso.datetime({ offset: true, local: true }),
  z.number(),
]);
/** The icons a graph node may name in place of its kind's icon, lucide's names. */
export const GRAPH_ICONS = [
  'monitor',
  'smartphone',
  'globe',
  'server',
  'box',
  'database',
  'hard-drive',
  'list-ordered',
  'shield',
  'key',
  'lock',
  'user',
  'users',
  'bot',
  'cpu',
  'cloud',
  'git-branch',
  'file',
  'folder',
  'terminal',
  'mail',
  'bell',
  'search',
  'settings',
  'chart-column',
  'clock',
  'zap',
  'package',
  'layers',
  'message-square',
  'credit-card',
  'shopping-cart',
  'plug',
  'webhook',
  'calendar',
  'map',
  'app-window',
  'code',
  'test-tube',
  'rocket',
] as const satisfies readonly GraphIcon[];
export const GRAPH_COLORS = [
  'blue',
  'teal',
  'orange',
  'violet',
  'gray',
  'green',
] as const satisfies readonly GraphColor[];
export const GRAPH_STATUSES = [
  'waiting',
  'running',
  'done',
  'failed',
  'blocked',
] as const satisfies readonly GraphStatus[];
const GRAPH_DETAIL = { lines: 3, length: 48 } as const;
/** A name from a list, checked by the graph's refinement so its error names the node. */
const graphName = <T extends string>(names: readonly T[]) =>
  z.string().meta({ enum: [...names] }) as unknown as z.ZodType<T>;
export const visualSpecs = {
  'vega-lite': z.record(z.string(), z.json()).superRefine((spec, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(spec)).byteLength > 512 * 1024)
      ctx.addIssue({ code: 'custom', message: 'spec JSON must be at most 512 KB' });
    // A url on a data object loads data; the inline rows in its values are plain fields.
    const visit = (value: unknown, path: (string | number)[], inData: boolean): void => {
      if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, [...path, index], inData));
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (inData && key === 'url')
            ctx.addIssue({
              code: 'custom',
              path: [...path, key],
              message: 'data.url is forbidden; use inline data',
            });
          if (!inData || key !== 'values') visit(child, [...path, key], key === 'data');
        }
      }
    };
    visit(spec, [], false);
  }),
  kline: z
    .strictObject({
      candles: z
        .array(
          z.strictObject({
            time: visualTime,
            open: z.number(),
            high: z.number(),
            low: z.number(),
            close: z.number(),
            volume: z.number().optional(),
          }),
        )
        .min(1)
        .max(5000),
      lines: z
        .array(
          z.strictObject({
            name: z.string(),
            points: z.array(z.strictObject({ time: visualTime, value: z.number() })),
          }),
        )
        .max(8)
        .optional(),
    })
    .superRefine((spec, ctx) => {
      // Zod also runs refinements after array length failures.
      if (!spec.candles.length) return;
      const first = spec.candles[0]!.time;
      const form = (time: string | number) =>
        typeof time === 'number' ? 'seconds' : time.includes('T') ? 'datetime' : 'date';
      const series = [
        { points: spec.candles, path: ['candles'] },
        ...(spec.lines ?? []).map((line, index) => ({
          points: line.points,
          path: ['lines', index, 'points'],
        })),
      ];
      for (const { points, path } of series) {
        let previous = -Infinity;
        points.forEach(({ time }, index) => {
          if (form(time) !== form(first))
            ctx.addIssue({
              code: 'custom',
              path: [...path, index, 'time'],
              message: 'time must use the same form throughout the spec',
            });
          const current = typeof time === 'number' ? time : Date.parse(time);
          if (current <= previous)
            ctx.addIssue({
              code: 'custom',
              path: [...path, index, 'time'],
              message: 'time must be strictly increasing',
            });
          previous = current;
        });
      }
    }),
  mermaid: z.strictObject({ source: z.string().min(1).max(20000) }),
  graph: z
    .strictObject({
      nodes: z
        .array(
          z.strictObject({
            id: z.string(),
            label: z.string().describe('A short name; put detail in sublabel.'),
            group: z
              .string()
              .optional()
              .describe(
                'The layer or subsystem the node belongs to: a groups id, or any name, which becomes a top-level group.',
              ),
            kind: z
              .enum(['client', 'service', 'store', 'queue', 'external', 'policy'])
              .optional()
              .describe(
                'What the node is, shown by its colour and icon: client (an interface or entry point), service (a process, module or function), store (a database, file or cache), queue (a queue, event stream or scheduler), external (a third party or a person), policy (auth, a gate or an approval).',
              ),
            sublabel: z
              .string()
              .max(80)
              .optional()
              .describe('One short detail line under the label, such as a path or a technology.'),
            icon: graphName(GRAPH_ICONS)
              .optional()
              .describe("A lucide icon drawn in place of the kind's icon."),
            color: graphName(GRAPH_COLORS)
              .optional()
              .describe(
                "Paints the node in place of its kind's colour; give its meaning in colors.",
              ),
            status: graphName(GRAPH_STATUSES)
              .optional()
              .describe(
                'A status dot named in words; it paints the node in place of color and kind.',
              ),
            detail: z
              .array(z.string())
              .optional()
              .describe(
                `Up to ${GRAPH_DETAIL.lines} short lines of at most ${GRAPH_DETAIL.length} characters under the sublabel.`,
              ),
            sources: sources
              .optional()
              .describe(
                'Where the node is in the code: file:<path>, file:<path>:<line> or commit:<sha>.',
              ),
          }),
        )
        .min(1)
        .max(200),
      edges: z
        .array(
          z.strictObject({
            from: z.string(),
            to: z.string(),
            label: z.string().optional().describe('What passes along the edge, in a few words.'),
            style: z
              .enum(['main', 'async', 'data', 'return'])
              .optional()
              .describe(
                'main for the main path, async for events and background work, data for reads and writes of data, return for replies and callbacks; absent for a plain call.',
              ),
          }),
        )
        .max(400),
      groups: z
        .array(
          z.strictObject({
            id: z.string(),
            label: z.string(),
            parent: z.string().optional().describe('The id of the group this one sits in.'),
          }),
        )
        .max(50)
        .optional()
        .describe('Named boundaries for layers or subsystems; nodes join one by its id in group.'),
      direction: z.enum(['LR', 'TB']).optional(),
      colors: z
        .partialRecord(z.enum(GRAPH_COLORS), z.string())
        .optional()
        .describe('What each node color means, shown in the legend; a color left out is not.'),
    })
    .superRefine((spec, ctx) => {
      const ids = new Set<string>();
      spec.nodes.forEach((node, index) => {
        if (ids.has(node.id))
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', index, 'id'],
            message: `Duplicate node id: ${node.id}`,
          });
        ids.add(node.id);
        for (const [field, names] of [
          ['icon', GRAPH_ICONS],
          ['color', GRAPH_COLORS],
          ['status', GRAPH_STATUSES],
        ] as const) {
          const value = node[field];
          if (value !== undefined && !(names as readonly string[]).includes(value))
            ctx.addIssue({
              code: 'custom',
              path: ['nodes', index, field],
              message: `Node ${node.id}: ${field} ${value} is not one of ${names.join(', ')}`,
            });
        }
        if ((node.detail?.length ?? 0) > GRAPH_DETAIL.lines)
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', index, 'detail'],
            message: `Node ${node.id}: detail has at most ${GRAPH_DETAIL.lines} lines`,
          });
        node.detail?.forEach((line, at) => {
          if (line.length > GRAPH_DETAIL.length)
            ctx.addIssue({
              code: 'custom',
              path: ['nodes', index, 'detail', at],
              message: `Node ${node.id}: detail line ${at + 1} is longer than ${GRAPH_DETAIL.length} characters`,
            });
        });
      });
      spec.edges.forEach((edge, index) => {
        for (const field of ['from', 'to'] as const)
          if (!ids.has(edge[field]))
            ctx.addIssue({
              code: 'custom',
              path: ['edges', index, field],
              message: `Missing node id: ${edge[field]}`,
            });
      });
      const parents = new Map<string, string | undefined>();
      spec.groups?.forEach((group, index) => {
        if (parents.has(group.id))
          ctx.addIssue({
            code: 'custom',
            path: ['groups', index, 'id'],
            message: `Duplicate group id: ${group.id}`,
          });
        parents.set(group.id, group.parent);
      });
      spec.groups?.forEach((group, index) => {
        if (group.parent === undefined) return;
        if (!parents.has(group.parent)) {
          ctx.addIssue({
            code: 'custom',
            path: ['groups', index, 'parent'],
            message: `Missing group id: ${group.parent}`,
          });
          return;
        }
        const seen = new Set([group.id]);
        for (let at: string | undefined = group.parent; at !== undefined; at = parents.get(at)) {
          if (seen.has(at)) {
            ctx.addIssue({
              code: 'custom',
              path: ['groups', index, 'parent'],
              message: `The parents of group ${group.id} form a cycle`,
            });
            return;
          }
          seen.add(at);
        }
      });
    }),
  timeline: z
    .strictObject({
      subtitle: z.string().optional().describe('One line under the title.'),
      unit: z
        .enum(['time', 'ms'])
        .optional()
        .describe(
          'time for a clock axis of ISO date-times or Unix ms; ms for durations from 0. Absent: ms when every time is a number, else time.',
        ),
      timezone: z
        .string()
        .refine((zone) => {
          try {
            new Intl.DateTimeFormat('en', { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        }, 'timezone must be an IANA time zone, such as Asia/Shanghai')
        .optional()
        .describe('The IANA time zone the clock axis reads in, such as Asia/Shanghai.'),
      lanes: z
        .array(z.strictObject({ id: z.string(), label: z.string() }))
        .max(50)
        .optional()
        .describe('Rows for events; absent puts every event on one row.'),
      groups: z
        .array(z.strictObject({ id: z.string(), label: z.string() }))
        .max(50)
        .optional()
        .describe('Legend entries; an item of a group takes its colour, in declared order.'),
      items: z
        .array(
          z.strictObject({
            id: z.string(),
            label: z.string(),
            detail: z.string().optional().describe('Up to two short lines under an event.'),
            lane: z.string().optional(),
            group: z.string().optional(),
            at: visualTime.describe('The instant of an event or the start of a span.'),
            end: visualTime.optional().describe('Present for a span, drawn as a bar.'),
            parent: z
              .string()
              .optional()
              .describe('For a span: the id of the span it is part of, drawn indented under it.'),
          }),
        )
        .min(1)
        .max(200),
    })
    .superRefine((spec, ctx) => {
      const unit =
        spec.unit ??
        (spec.items.some((item) => typeof item.at === 'string' || typeof item.end === 'string')
          ? 'time'
          : 'ms');
      const declared = (list: { id: string }[] | undefined, name: string, field: string) => {
        const ids = new Set<string>();
        list?.forEach((entry, index) => {
          if (ids.has(entry.id))
            ctx.addIssue({
              code: 'custom',
              path: [field, index, 'id'],
              message: `Duplicate ${name} id: ${entry.id}`,
            });
          ids.add(entry.id);
        });
        return ids;
      };
      const lanes = declared(spec.lanes, 'lane', 'lanes');
      const groups = declared(spec.groups, 'group', 'groups');
      const items = new Map<string, (typeof spec.items)[number]>();
      spec.items.forEach((item, index) => {
        if (items.has(item.id))
          ctx.addIssue({
            code: 'custom',
            path: ['items', index, 'id'],
            message: `Duplicate item id: ${item.id}`,
          });
        else items.set(item.id, item);
      });
      const time = (value: string | number) =>
        typeof value === 'number' ? value : Date.parse(value);
      spec.items.forEach((item, index) => {
        const issue = (field: string, message: string) =>
          ctx.addIssue({
            code: 'custom',
            path: ['items', index, field],
            message: `Item ${item.id}: ${message}`,
          });
        if (item.lane !== undefined && !lanes.has(item.lane))
          issue('lane', `missing lane id: ${item.lane}`);
        if (item.group !== undefined && !groups.has(item.group))
          issue('group', `missing group id: ${item.group}`);
        for (const field of ['at', 'end'] as const)
          if (unit === 'ms' && typeof item[field] === 'string')
            issue(field, 'unit ms takes numbers of ms');
        if (item.end !== undefined && time(item.end) < time(item.at))
          issue('end', 'end is before at');
        if (item.parent === undefined) return;
        if (item.end === undefined) {
          issue('parent', 'only a span, an item with end, takes a parent');
          return;
        }
        const parent = items.get(item.parent);
        if (!parent) issue('parent', `missing parent id: ${item.parent}`);
        else if (parent.end === undefined)
          issue('parent', `parent ${item.parent} is an event; only spans nest`);
        else {
          const seen = new Set([item.id]);
          for (
            let at = items.get(item.parent);
            at;
            at = at.parent ? items.get(at.parent) : undefined
          ) {
            if (seen.has(at.id)) {
              issue('parent', 'its parents form a cycle');
              return;
            }
            seen.add(at.id);
          }
        }
      });
    }),
  html: z.strictObject({ html: z.string().min(1).max(524288) }),
  table: z
    .strictObject({
      columns: z
        .array(
          z.strictObject({
            key: z.string().min(1).max(40),
            title: z.string().min(1).max(80),
            type: z.enum(['text', 'number', 'date']),
          }),
        )
        .min(1)
        .max(24),
      rows: z
        .array(z.record(z.string(), z.union([z.string().max(400), z.number(), z.null()])))
        .max(2000),
      sort: z.strictObject({ key: z.string(), direction: z.enum(['asc', 'desc']) }).optional(),
    })
    .superRefine((spec, ctx) => {
      if (new TextEncoder().encode(JSON.stringify(spec)).byteLength > 512 * 1024)
        ctx.addIssue({ code: 'custom', message: 'spec JSON must be at most 512 KB' });
      const columns = new Map<string, (typeof spec.columns)[number]>();
      spec.columns.forEach((column, index) => {
        if (columns.has(column.key))
          ctx.addIssue({
            code: 'custom',
            path: ['columns', index, 'key'],
            message: `Duplicate column key: ${column.key}`,
          });
        columns.set(column.key, column);
      });
      const date = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);
      spec.rows.forEach((row, index) => {
        for (const [key, cell] of Object.entries(row)) {
          const column = columns.get(key);
          if (!column)
            ctx.addIssue({
              code: 'custom',
              path: ['rows', index, key],
              message: `Missing column key: ${key}`,
            });
          else if (
            cell !== null &&
            !(column.type === 'number'
              ? typeof cell === 'number'
              : typeof cell === 'string' &&
                (column.type !== 'date' || date.safeParse(cell).success))
          )
            ctx.addIssue({
              code: 'custom',
              path: ['rows', index, key],
              message: `Cell must be ${column.type === 'date' ? 'an ISO date or date-time' : column.type} or null`,
            });
        }
      });
      if (spec.sort && !columns.has(spec.sort.key))
        ctx.addIssue({
          code: 'custom',
          path: ['sort', 'key'],
          message: `Missing column key: ${spec.sort.key}`,
        });
    }),
};

export const visualDrawInputSchema = z.strictObject({
  title: z.string().min(1).max(120).describe('1-120 characters; the question the chart answers.'),
  kind: z
    .enum(['vega-lite', 'kline', 'mermaid', 'graph', 'html', 'table', 'timeline'])
    .describe('vega-lite, graph, mermaid, table, timeline, kline or html.'),
  spec: z
    .unknown()
    .describe(
      'Depends on kind. vega-lite: a Vega-Lite JSON object, at most 512 KB, data inline (no data.url), transparent background, units labelled. graph: { nodes: [{ id, label, group?, kind?, sublabel?, icon?, color?, status?, detail?, sources? }], edges: [{ from, to, label?, style? }], groups?: [{ id, label, parent? }], direction?: "LR" or "TB", colors?: { color: meaning } }, 1-200 nodes with unique ids, at most 400 edges between existing nodes; leave direction out to let the board pick the one that fits. mermaid: { source }, 1-20000 characters. table: { columns: [{ key, title, type: text, number or date }], rows: [{ key: value }], sort?: { key, direction } }. timeline: { subtitle?, unit?: "time" or "ms", timezone?, lanes?: [{ id, label }], groups?: [{ id, label }], items: [{ id, label, detail?, lane?, group?, at, end?, parent? }] }, 1-200 items with unique ids; an item with end is a span (a bar), one without an event (a point); at and end are ISO date-times or Unix ms for unit time, ms from 0 for unit ms, which is the default when every time is a number; lane and group name declared ids; parent nests a span under another span. kline: { candles: [{ time, open, high, low, close, volume? }], lines?: [{ name, points: [{ time, value }] }] }, 1-5000 candles, at most 8 lines, time strictly increasing in one form (ISO date, ISO date-time or Unix seconds). html: { html }, one self-contained document with scripts, styles and data inline, no network; only when no other kind fits.',
    ),
  source: z
    .string()
    .max(500)
    .regex(/^[^\r\n\u2028\u2029]*$/)
    .optional()
    .describe(
      'Optional single line, at most 500 characters, naming the data file, command, URL or query.',
    ),
  size: visualSize
    .optional()
    .describe('S, M or L card height in the conversation; leave out for the default.'),
  replaces: str
    .optional()
    .describe(
      'The visual_id of an earlier chart from this session to redraw in place; its id and pin stay.',
    ),
  pin: visualSize
    .optional()
    .describe(
      'S, M or L to put the chart on the project board; only when the user asks for it there.',
    ),
});

/** Session event emitted after a visual is stored, including a failed kind spec. */
export interface VisualDrawnPayload {
  visual_id: string;
  title: string;
  kind: keyof typeof visualSpecs;
  revision: number;
  failed?: true;
}

/** visual.changed: a pin, unpin or arrange stored; the visuals it moved, in board order for an arrange. */
export interface VisualChangedPayload {
  visual_ids: string[];
}

/** visual.drawing: cumulative UTF-8 argument bytes, emitted at most every 250 ms per call. */
export interface VisualDrawingPayload {
  tool_call_id: string;
  received_bytes: number;
}

/** agent.session.recapped: a new recap of the session, with the tokens writing it took. */
export interface SessionRecappedPayload extends SessionRecap {
  usage?: { input_tokens: number; output_tokens: number };
}

export const inputSchemas = {
  ...memoryInputSchemas,
  ...changeStoryInputSchemas,
  ...alwaysOnInputSchemas,
  ...agentWakeInputSchemas,
  ...appInputSchemas,
  ...agentInputSchemas,
  ...workflowInputSchemas,
  ...questionBatchInputSchemas,
  'terminal.open': z.strictObject({
    project_id: z.string(),
    session_id: z.string().optional(),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }),
  'terminal.write': z.strictObject({
    terminal_id: z.string(),
    data: z.string().refine((data) => new TextEncoder().encode(data).byteLength <= 64 * 1024, {
      message: 'At most 64 KiB',
    }),
  }),
  'terminal.resize': z.strictObject({
    terminal_id: z.string(),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }),
  'terminal.close': z.strictObject({ terminal_id: z.string() }),
  'visual.draw': visualDrawInputSchema,
  /** The user only; returns the Visual. */
  'visual.read': z.strictObject({ visual_id: str }),
  /** The user only; at most 200 visuals, newest first or in pinned board order. */
  'visual.list': z.strictObject({
    project_id: str,
    pinned: z.boolean().optional(),
    session_id: str.optional(),
  }),
  /** The user only; pins at the end or changes the existing pin size and optional width. */
  'visual.pin': z.strictObject({
    visual_id: str,
    size: visualSize,
    width: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(12)]).optional(),
  }),
  /** The user only. */
  'visual.unpin': z.strictObject({ visual_id: str }),
  /** The user only; order contains exactly the project's pinned visual ids. */
  'visual.arrange': z.strictObject({ project_id: str, order: z.array(str) }),
  /** A session credential; opens url in the session's browser panel of the desktop window, returns BrowserPage. */
  'browser.open': z.strictObject({
    url: z
      .url({ protocol: /^https?$/ })
      .max(8192)
      .describe("The http or https address to open in the session's browser panel."),
  }),
  /** A session credential; returns the url, title and visible text of the session's browser panel page. */
  'browser.read': z.strictObject({}),
  /** A session credential; returns the url, title and a PNG of the session's browser panel page. */
  'browser.screenshot': z.strictObject({}),
  /** The user only; the desktop window's answer to the browser request named by request_id. */
  'browser.result': z
    .strictObject({
      request_id: str,
      page: browserPage.optional(),
      error: z.strictObject({ code: str, message: z.string().max(65536) }).optional(),
    })
    .refine((answer) => (answer.page === undefined) !== (answer.error === undefined), {
      message: 'Give one of page or error',
    }),
  'project.read': z.strictObject({ project_id: str }),
  'board.plan.update': boardPlanInputSchema.refine(
    (plan) =>
      plan.tasks.every(
        (task) =>
          task.iteration === undefined ||
          plan.iterations.some((iteration) => iteration.id === task.iteration),
      ),
    { message: 'Task iteration must name an iteration in the plan' },
  ),
  /** Patches a lead's plan by task id; the same command serves the lead and the user. */
  'board.plan.edit': z.strictObject({
    project_id: str,
    /** The lead whose plan the user edits; absent for a lead, which edits its own plan. */
    lead_session_id: str.optional(),
    base_version: baseVersion.describe(
      'The plan_version from your last project_read; a different one is refused with the current number.',
    ),
    trigger_event: triggerEvent,
    ops: z
      .array(planEditOp)
      .min(1)
      .max(32)
      .describe(
        "1-32 changes applied in order, each with a `type`: add_task, remove_task, move_task, set_task, set_dependencies, set_milestone or set_iterations. lock_order, unlock_order and refute_assumption are the user's own; a lead's call is refused.",
      ),
  }),
  /** Takes back a user edit that still waits for the lead; the user only. */
  'board.plan.edit.withdraw': z.strictObject({
    project_id: str,
    lead_session_id: str,
    edit_id: str,
  }),
  /** Holds a change to the calling lead's plan for the user's decision. */
  'board.plan.propose': z.strictObject({
    project_id: str,
    base_version: baseVersion.describe('The plan_version from your last project_read.'),
    trigger_event: triggerEvent,
    reason: boardText
      .max(280)
      .describe('Why the user should accept it, under 280 characters; the card shows it.'),
    ops: z
      .array(planPatchOp)
      .min(1)
      .max(32)
      .describe(
        '1-32 changes, the same types as edit_board except lock_order, unlock_order, resolve_edit and refute_assumption, and add_lane to add a lane.',
      ),
  }),
  /** Takes back a proposal that still waits for the user; the lead only. */
  'board.plan.proposal.withdraw': z.strictObject({
    project_id: str,
    proposal_id: str.describe('The id of your proposal that still waits for the user.'),
  }),
  /** Applies or rejects a pending lead proposal; the user only. */
  'board.plan.proposal.resolve': z.strictObject({
    project_id: str,
    lead_session_id: str,
    proposal_id: str,
    decision: z.enum(['accept', 'reject']),
    reason: z.string().optional(),
    ops: z.array(planPatchOp).min(1).max(32).optional(),
  }),
  'board.sync': z.strictObject({ project_id: str }),
  /** Ids of tasks in the calling lead's plan. */
  'task.start': z.strictObject({
    project_id: str,
    /** The lead whose plan the user acts on; absent for a lead, which acts on its own plan. */
    lead_session_id: str.optional(),
    task_ids: z
      .array(planId)
      .min(1)
      .max(16)
      .describe(
        '1-16 ids of tasks in your plan. Give every task you want started; a non-resident lead gives a direct task alone.',
      ),
  }),
  'task.handback': z.strictObject({
    lead_session_id: str,
    task_id: planId,
    reason: z.string(),
  }),
  /** A message to the latest open session of a task in the calling lead's plan, or to the part it names. */
  'task.message': z.strictObject({
    project_id: str,
    task_id: planId.describe('The task whose open session gets the message.'),
    part: partSelector.describe(
      'For a parallel task: the number (1-4) or title of the part to message; absent reaches the latest open session.',
    ),
    text: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        '1-2000 characters, self-contained: the session has not seen your conversation. It arrives prefixed [Lead].',
      ),
  }),
  /** Accepts the done report of a report task in the calling lead's plan. */
  'task.accept': z.strictObject({
    project_id: str,
    task_id: planId.describe('The report task whose done report you accept.'),
    evidence: z
      .string()
      .min(1)
      .max(2000)
      .describe('1-2000 characters: what in the report shows the task is done.'),
  }),
  /** Drops the start request of a task in the calling lead's plan and discards its open sessions. */
  'task.stop': z.strictObject({
    project_id: str,
    /** The lead whose plan the user acts on; absent for a lead, which acts on its own plan. */
    lead_session_id: str.optional(),
    task_id: planId.describe('The task to stop.'),
    reason: boardText.describe('Why it stops, under 400 characters; kept on the board.'),
  }),
  /** Interrupts the running turn of a task in the calling lead's plan, so a pending change takes effect now. */
  'task.interrupt': z.strictObject({
    project_id: str,
    /** The lead whose plan the user acts on; absent for a lead, which acts on its own plan. */
    lead_session_id: str.optional(),
    task_id: planId.describe('The task whose running turn is interrupted.'),
    part: partSelector.describe(
      'For a parallel task: the number (1-4) or title of the part to interrupt; absent interrupts the latest open session.',
    ),
  }),
  /** Stops one background task of the session working on a task in the calling lead's plan. */
  'task.background.stop': z.strictObject({
    project_id: str,
    /** The lead whose plan the user acts on; absent for a lead, which acts on its own plan. */
    lead_session_id: str.optional(),
    task_id: planId.describe('The task whose session runs the background task.'),
    background_id: str.describe('The id of the background task, as the session reports it.'),
  }),
  /** Removes the project's own workflow policy values, so it follows the global ones; the user only. */
  'workflow.policy.reset': z.strictObject({ project_id: str }),
  /** Changes the given workflow policy parameters of a project; the user only. */
  'workflow.policy.set': z.strictObject({
    project_id: str,
    plan_changes: z.enum(['auto', 'confirm']).optional(),
    /** Merged into the current charter by power. */
    charter: charter.optional(),
    /** Permission rules whose prompts always reach the user; replaces the current list. */
    must_ask_extra: z.array(str).optional(),
    /** A reversible lead question takes its recommended answer after_hours after it was asked; null turns it off. */
    question_defaults: z
      .strictObject({ after_hours: z.number().int().min(1).max(168) })
      .nullable()
      .optional(),
    /** The messages of agents other than the main agent that reach the user directly; replaces the current list. */
    urgent_direct: z.array(z.enum(['main_gate_failed'])).optional(),
    /** Merged into the current path by tier. */
    path: z
      .strictObject({ t1: tierPath.optional(), t2: tierPath.optional(), t3: tierPath.optional() })
      .optional(),
    acceptance_wake: z.enum(['each_merge', 'milestone']).optional(),
    max_parallel: z.number().int().optional(),
    max_parallel_limit: z.number().int().optional(),
    runtime_parallel: z.record(z.string(), z.number().int().min(1).max(8)).optional(),
    dispatch_paused: z.boolean().optional(),
    runtime_quota_threshold: z.number().optional(),
    gate_on_fail: z.enum(['handback', 'retry', 'stop']).optional(),
    gate_runner: z.enum(['daemon', 'session']).optional(),
    milestone_verify: z
      .enum(['off', 'auto'])
      .optional()
      .describe(
        'auto runs the checks and a verifier review of a lead milestone once it is ready; off runs neither.',
      ),
    recovery_switch: z
      .enum(['off', 'auto'])
      .optional()
      .describe(
        'auto moves a task session whose hand-backs of one problem ran out to the writer fallback runtime for one more hand-back; off leaves it to the lead.',
      ),
    handback_limit: z.union([z.literal(0), z.number().int().min(2).max(5)]).optional(),
    /** null clears the hint. */
    task_size_hint: z.number().int().nullable().optional(),
    /** Merged into the current budget by tier and path. */
    budget: z.strictObject({ t1: tierBudget, t2: tierBudget, t3: tierBudget }).optional(),
    /** The project's input token budget; a first one counts from now, null clears it. */
    project_budget: z
      .strictObject({ input_tokens: z.number().int().positive() })
      .nullable()
      .optional(),
    pinned: z.array(workflowParam).max(7).optional(),
  }),
  /** Sets the one line of what the calling session does now in its running turn, shown on its board row with its time. Plan task and lead sessions only; a new text waits 15 s after the last one. */
  'task.status_line': z.strictObject({
    text: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe(
        'What you are doing now in 1-80 characters, for example "Running the migration tests".',
      ),
  }),
  'task.report': z.strictObject({
    project_id: str,
    kind: z
      .enum(['risk', 'task', 'dependency', 'done', 'requirement', 'blocked'])
      .describe(
        'requirement (the task as written cannot be done; holds the merge), blocked (you cannot go on), risk, task (a suggested follow-up task), dependency (an order between tasks), or done.',
      ),
    /** Up to 4000 characters for the done report of a report task; 400 for every other report. */
    text: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        '1-400 characters; up to 4000 for the done report of a report task. For done: what changed or what you concluded, the acceptance commands you ran and their result, what is left open.',
      ),
    status: z
      .enum(['done', 'done_with_concerns'])
      .optional()
      .describe(
        'For kind done only: done (default) or done_with_concerns; name the concern in text.',
      ),
    /** Required for a blocked report. */
    reason: z
      .enum([
        'missing_context',
        'missing_permission',
        'environment_problem',
        'conflicting_requirements',
      ])
      .optional()
      .describe(
        'Required for kind blocked: missing_context, missing_permission, environment_problem or conflicting_requirements.',
      ),
  }),
  'lead.ask': z.strictObject({
    project_id: str,
    question: str.describe('One question the user can answer without reading your conversation.'),
    options: z.array(str).min(2).max(4).describe('2-4 short answers.'),
    recommended: str.describe('One of the options, the one you would choose.'),
    assumption: str.describe(
      'What you do until the user answers; the plan should already follow it.',
    ),
    blocks: z
      .array(planId)
      .describe('Ids of the tasks that must wait for the answer; [] when none.'),
    reversible: z
      .boolean()
      .optional()
      .describe(
        'true only when a different answer later costs at most redoing tasks not started; the user may let your recommendation apply after a while.',
      ),
  }),
  'lead.question.answer': z.strictObject({
    project_id: str,
    lead_session_id: str,
    question_id: str,
    answer: str,
    /** A relayed worker question only: question text to the answer, as approval.respond takes it. */
    answers: z.record(str, str).optional(),
  }),
  /** The user only; replaces the answer a lead gave a task session's question, or a recommended answer applied at its deadline, and tells the lead and that session. */
  'lead.question.overrule': z.strictObject({
    project_id: str,
    lead_session_id: str.describe('The lead whose plan holds the question.'),
    question_id: str.describe(
      "A task session's question its lead answered, or a question answered by its default.",
    ),
    answer: str.describe("The user's answer, which replaces the lead's."),
  }),
  /** The calling lead's answer to a task session's question on its own plan; the first answer wins. */
  'lead.worker_question.answer': z.strictObject({
    project_id: str,
    question_id: str.describe('The question id the worker_question board update names.'),
    answers: z
      .record(str, str.describe('Your answer to that question.'))
      .describe("Each question of the task session's request, word for word, to your answer."),
    citations: z
      .array(
        z.strictObject({
          kind: z
            .enum(['user_words', 'assumption', 'memory', 'earlier_answer'])
            .describe(
              "user_words: words of the asking task's source; assumption: a plan assumption; memory: a current memory entry; earlier_answer: a question of your plan the user answered themselves.",
            ),
          ref: str.describe(
            'For user_words, the words copied exactly; for assumption, its whole text; for memory, the memory id; for earlier_answer, the question id.',
          ),
        }),
      )
      .min(1)
      .describe('What settles the answer; at least one.'),
  }),
  /** Reads one note of the calling lead's plan in full, by the id its digest names; read-only. */
  'lead.note.read': z.strictObject({
    project_id: str,
    note_id: str.describe('The id a note digest names.'),
  }),
  'project.baseline.start': z.strictObject({
    project_id: str,
    runtime: str
      .optional()
      .describe('The runtime of the baseline session; absent uses the default.'),
    model: str.optional().describe('The model of the baseline session; absent uses the default.'),
    effort: z
      .enum(EFFORT_LEVELS)
      .optional()
      .describe('The reasoning effort of the baseline session; absent uses the default.'),
  }),
  /** The user only; starts a read-only introduction session and returns { session_id }. */
  'project.intro.start': z.strictObject({ project_id: str }),
  /** Assessment or introduction session only; project comes from its credential. Returns { written: true }. */
  'project.intro.submit': z.strictObject({
    summary: z.string().min(1).max(280),
    sources,
    features: z.array(z.strictObject({ title: planTitle, text: boardText, sources })).max(12),
    modules: z
      .array(z.strictObject({ path: str, role: boardText, entry: str.optional() }))
      .max(40)
      .superRefine((modules, ctx) => {
        const paths = new Set<string>();
        modules.forEach((module, index) => {
          if (paths.has(module.path))
            ctx.addIssue({
              code: 'custom',
              path: [index, 'path'],
              message: `Duplicate module path: ${module.path}`,
            });
          paths.add(module.path);
        });
      }),
    architecture: visualSpecs.graph.optional(),
    body: z.string().max(20000).optional(),
  }),
  'project.baseline.submit_folder': baselineFolderSchema.extend({ baseline_id: str }),
  'project.baseline.submit': z.strictObject({ baseline_id: str, ...baselineSubmission }),
  'project.facts.refresh': z.strictObject({ project_id: str }),
  'project.baseline.confirm': z.strictObject({
    baseline_id: str,
    brief: projectBrief.optional(),
    gates: z
      .array(z.strictObject({ root: str, commands: z.array(gateCommand) }))
      .max(256)
      .optional(),
    answers: baselineAnswers,
    extensions: baselineExtensions.optional(),
    plan_board: z.boolean().optional(),
  }),
  /** The user only; stores this round's answers and asks the baseline session for the next round. */
  'project.baseline.continue': z.strictObject({ baseline_id: str, answers: baselineAnswers }),
  'project.brief.set': z.strictObject({
    project_id: str,
    goal: str,
    goals: strings,
    non_goals: strings,
  }),
  'project.open': z.strictObject({
    name: str,
    roots: strings.min(1),
    env: projectEnvironment.optional(),
  }),
  'project.environment.set': z.strictObject({
    project_id: str,
    name: str,
    roots: strings.min(1),
    env: projectEnvironment,
  }),
  'project.remove': z.strictObject({ project_id: str }),
  'project.gate.set': z.strictObject({
    project_id: str,
    root: str,
    commands: z.array(gateCommand),
  }),
  /** The user only; runs the enabled gate of each root, or of the named root, in a fresh worktree and returns the started EnvironmentCheck rows. With baseline_id it runs the submitted baseline's proposed commands of each folder instead. */
  'project.environment.verify': z.strictObject({
    project_id: str,
    root: str.optional(),
    baseline_id: str.optional(),
  }),
  /** The user only; lands branch onto the branch checked out in root through the root's gate, and returns the started Landing. */
  'project.land': z.strictObject({
    root: str,
    branch: str,
    message: str
      .optional()
      .describe('When present, the commits land as one commit with this message.'),
  }),
  'project.worktree.set': z.strictObject({
    project_id: str,
    copy_paths: z.array(worktreePath),
    command: gateCommand.omit({ name: true }).optional(),
  }),
  'permission.rule.add': z.strictObject({ project_id: str, rule: str, session_id: str }),
  'permission.rule.remove': z.strictObject({ project_id: str, rule: str }),
  /** A rule every project's matching permission requests are answered by; the user only. */
  'permission.globalRule.add': z.strictObject({ rule: str }),
  'permission.globalRule.remove': z.strictObject({ rule: str }),
  'workspace.prune_stale': z.strictObject({ project_id: str }),
  'project.extensions.set': z.strictObject({
    project_id: str,
    runtime: str,
    overrides: extensionOverrides,
  }),
  /** Removes the project's own session defaults, so it follows the global ones. */
  'project.sessionDefaults.clear': z.strictObject({ project_id: str }),
  /** Merges runtime token targets; null removes the project's own target, so the global one applies. */
  'project.usageTargets.set': z.strictObject({
    project_id: str,
    targets: z.record(z.string(), z.number().int().nonnegative().nullable()),
  }),
  'project.sessionDefaults.set': z.strictObject({ project_id: str, ...sessionDefaults }),
  'project.autoMerge.set': z.strictObject({ project_id: str, enabled: z.boolean() }),
  /** The user only; lets the project's gate commands on macOS open the GPU, its kernel driver included. */
  'project.gateGpu.set': z.strictObject({ project_id: str, enabled: z.boolean() }),
  'project.externalEvents.set': z.strictObject({ project_id: str, mode: externalEventsMode }),
  /** Sets the value of one setting that every project follows where it has none of its own; the user only. */
  'project.defaults.set': z.discriminatedUnion('key', [
    z.strictObject({
      key: z.literal('workflow_policy'),
      value: projectSettingValues.workflow_policy,
    }),
    z.strictObject({
      key: z.literal('session_defaults'),
      value: projectSettingValues.session_defaults,
    }),
    z.strictObject({ key: z.literal('usage_targets'), value: projectSettingValues.usage_targets }),
    z.strictObject({
      key: z.literal('external_events'),
      value: projectSettingValues.external_events,
    }),
    z.strictObject({ key: z.literal('auto_merge'), value: projectSettingValues.auto_merge }),
  ]),
  /** Removes a global value, so projects without their own follow the built-in default; the user only. */
  'project.defaults.clear': z.strictObject({ key: z.enum(PROJECT_SETTING_KEYS) }),
  /** Removes the project's own value, so it follows the global one; the revision is the workflow policy's for workflow_policy, the project's otherwise. param names the one workflow setting to remove. */
  'project.override.clear': z.strictObject({
    project_id: str,
    key: z.enum(PROJECT_SETTING_KEYS),
    param: workflowPolicySettings.keyof().exclude(['improvement_mode']).optional(),
  }),
  /** {project_id, at}; moves the caller's seen cursor of the project to at, now by default. project.brief lists what happened after it. */
  'project.seen': z.strictObject({ project_id: str, at: z.number().int().min(0).optional() }),
  /** The user only; asks the side model for the paragraph of the caller's project.brief, at most once per brief, and returns {started}. */
  'project.brief.prose.write': z.strictObject({ project_id: str }),
  /** The user only; issues a personal agent key named label and returns {key_id, token_file}. The token is only in that file, readable by the user alone. */
  'personal.key.create': z.strictObject({ label: z.string().trim().min(1).max(80) }),
  /** The user only; revokes the personal agent key at once, and it stays revoked after a restart. */
  'personal.key.revoke': z.strictObject({ key_id: str }),
  'external.approve': z.strictObject({ project_id: str, subject_key: str }),
  /** The user only; returns the open session of the agent, by agent_id, by the kind of a built-in one or as the personal agent, opening one when there is none. */
  'resident.open': z.union([
    z.strictObject({ project_id: str, kind: z.enum(['assistant', 'triage']) }),
    z.strictObject({ agent_id: str }),
    z.strictObject({ kind: z.literal('personal') }),
  ]),
  /** The user only; sends the user's request to the project's Assistant, or to the target session, steering it while it runs; returns {session_id, turn_id}. */
  'request.send': z.strictObject({
    project_id: str,
    input: str,
    attachments: turnExtras.attachments,
    target: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('assistant') }),
        z.strictObject({ kind: z.literal('session'), session_id: str }),
      ])
      .optional(),
  }),
  'github.pr.create': z.strictObject({
    session_id: str,
    title: str.optional(),
    draft: z.boolean().optional(),
  }),
  'session.create': z
    .strictObject({
      project_id: str,
      ...sessionWorkspace,
      runtime: str.optional(),
      backend: str.optional(),
      model: str.optional(),
      effort: z.enum(EFFORT_LEVELS).optional(),
      permission_mode: z.enum(['ask', 'auto_edit', 'plan', 'auto', 'full_access']).default('ask'),
      fast: z.boolean().optional(),
      ultracode: z.boolean().optional(),
      input: str,
      ...turnExtras,
      /** The board task the session works on, `<lead session id>:<task id>`. */
      task_id: str.optional(),
      /** The device the session runs on; absent is this machine. */
      device_id: str.optional(),
      /**
       * project_setup: the first message starts with the guide for a project built from nothing.
       * lead: the session plans on the board with the Pantheon tools; without a purpose or task it runs as the bare runtime.
       * conductor: the native session with only the four conductor tools.
       */
      purpose: z.enum(['project_setup', 'lead', 'conductor']).optional(),
    })
    .refine(validSessionWorkspace, { message: 'An in-place session cannot have a start point' }),
  /** Opens a new worktree session with the source's files and a text handoff. */
  'session.fork': z
    .strictObject({
      session_id: str,
      runtime: str.optional(),
      model: str.optional(),
      effort: z.enum(EFFORT_LEVELS).optional(),
      before_turn_id: str.optional(),
      before_span_id: str.optional(),
      input: str,
      ...turnExtras,
    })
    .refine((input) => !(input.before_turn_id && input.before_span_id), {
      message: 'Choose a turn or a span fork point',
    }),
  /** Takes over a native session the runtime already has, working in the user's own folder; the user only. */
  'session.adopt': z.strictObject({
    project_id: str,
    runtime: z.enum(['claude', 'codex']),
    native_session_id: str,
    title: str.optional(),
    permission_mode: z.enum(['ask', 'auto_edit', 'plan', 'auto', 'full_access']).optional(),
  }),
  'session.rename': z.strictObject({
    session_id: str,
    title: z.string().trim().min(1).max(80),
  }),
  'session.resolve': z.strictObject({
    session_id: str,
    choice: z.enum(['resume_session', 'close']),
  }),
  'session.send': sessionInput,
  'session.compact': z.strictObject({
    session_id: str,
    // At most 2000 code points, on one line.
    instructions: z
      .string()
      .max(2000)
      .refine((line) => !/[\r\n]/.test(line))
      .optional(),
  }),
  'session.comment.add': z.strictObject({
    session_id: str,
    path: str,
    line: z.number().int().positive(),
    side: z.enum(['old', 'new']),
    // At most 10,000 Unicode code points after trimming.
    text: z.string().trim().min(1).max(10_000),
    /** The commented line's text as the diff showed it, without the diff sign. */
    line_text: z.string().max(10_000).optional(),
    /** The turn whose diff the comment was made on; absent for the branch diff. */
    turn_id: str.optional(),
  }),
  'session.comment.resolve': z.strictObject({
    comment_id: str,
    state: z.enum(['sent', 'kept']),
  }),
  'session.comment.delete': z.strictObject({ comment_id: str }),
  'trace.reflect': z.strictObject({
    project_id: str,
    lead_session_id: str.optional(),
    runtime: z.string().max(80).optional(),
    from: z.number().int().nonnegative().max(8_640_000_000_000_000),
    to: z.number().int().nonnegative().max(8_640_000_000_000_000),
  }),
  'trace.evidence': z.strictObject({
    project_id: str,
    view: z.enum(['summary', 'findings', 'workflow']).default('summary'),
    kind: z
      .enum([
        'turn_queue',
        'turn_prepare',
        'dispatch_queue',
        'approval',
        'permission_delivery',
        'gate',
        'slow_tool',
        'tool_failure',
        'turn_failure',
        'context_compaction',
        'background_task',
        'workflow_step',
      ])
      .optional(),
    offset: z.number().int().min(0).max(120).default(0),
    limit: z.number().int().min(1).max(6).default(4),
  }),
  'trace.report': z.strictObject({
    project_id: str,
    summary: z.string().trim().min(1).max(280),
    finding_ids: z.array(z.string().min(1).max(512)).max(6),
    disposition: z.enum(['experiment', 'measure', 'none']),
    change: z.string().trim().max(420),
    baseline: z.string().trim().max(260),
    metric: z.string().trim().max(180),
    rollback: z.string().trim().max(240),
  }),
  'trace.share': z.strictObject({ session_id: str, lead_session_id: str.optional() }),
  'trace.remember': z.strictObject({ session_id: str }),
  'trace.verify': z.strictObject({
    session_id: str,
    outcome: z.enum(['improved', 'unchanged', 'regressed']),
    baseline: z.number().finite(),
    trial: z.number().finite(),
    evidence: z.string().trim().min(1).max(512),
  }),
  'session.steer': sessionInput,
  /** Retries a failed remote workspace pull; returns SessionReconnectResult. */
  'session.reconnect': z.strictObject({ session_id: str }),
  'session.interrupt': z.strictObject({ session_id: str }),
  /** Stops one background task of the session, by the id its background list gives. */
  'session.background.stop': z.strictObject({ session_id: str, background_id: str }),
  /** Restores files before the turn by default; conversation keeps the turn and discards later history. */
  'session.rollback': z.strictObject({
    session_id: str,
    turn_id: str,
    scope: z.enum(['files', 'conversation', 'both']).optional(),
  }),
  'session.setConnectors': z.strictObject({ session_id: str, enabled: strings }),
  'session.setPermissionMode': z.strictObject({
    session_id: str,
    permission_mode: z.enum(['ask', 'auto_edit', 'plan', 'auto', 'full_access']),
  }),
  'session.setFastMode': z.strictObject({ session_id: str, fast: z.boolean() }),
  /** Claude only: standing dynamic-workflow orchestration for the session's later turns. */
  'session.setUltracode': z.strictObject({ session_id: str, ultracode: z.boolean() }),
  'session.setModel': z.strictObject({
    session_id: str,
    model: str,
    effort: z.enum(EFFORT_LEVELS).optional(),
  }),
  'session.setBackend': z.strictObject({
    session_id: str,
    backend: str.nullable(),
    model: str.optional(),
    /** Absent keeps the session's effort. */
    effort: z.enum(EFFORT_LEVELS).optional(),
  }),
  'session.discard': z.strictObject({ session_id: str }),
  'session.pin': z.strictObject({ session_id: str, pinned: z.boolean() }),
  /** An archived session cannot be snoozed; news from the session brings it back. */
  'session.snooze': z.strictObject({ session_id: str, snoozed: z.boolean() }),
  'session.archive': z.strictObject({ session_id: str }),
  'session.unarchive': z.strictObject({ session_id: str }),
  /** Also discards a session that has not ended; a merged session can only be archived. */
  'session.delete': z.strictObject({ session_id: str }),
  /** The user names the session; a lead names a task of its plan, with project_id and reason. */
  'session.merge': z.strictObject({
    session_id: str.optional(),
    project_id: str.optional(),
    task_id: planId
      .optional()
      .describe("The task whose session's merge stopped on files outside its scope."),
    /** Lands files outside the scope of the session's board task. */
    allow_out_of_scope: z.boolean().optional().describe('true to merge those files anyway.'),
    /** Why a lead lands files outside the task's scope; kept on the merge event. */
    reason: boardText
      .optional()
      .describe('Why the task needs those files, under 400 characters; kept on the merge record.'),
  }),
  'session.gates.run': z.strictObject({ session_id: str, only_failed: z.boolean().optional() }),
  'session.gates.cancel': z.strictObject({ session_id: str }),
  'session.merge.cancel': z.strictObject({ session_id: str }),
  'review.request': z.strictObject({
    session_id: str.describe(
      'The task session to review, from project_read; it must have commits.',
    ),
    runtimes: strings
      .min(1)
      .describe(
        "The reviewing runtimes, at least one; choose runtimes other than the writer's when available.",
      ),
  }),
  /** The user only; reviews the commits from the merge base of base and head up to head, and returns the started Review. */
  'review.range': z.strictObject({
    root: str.describe('A project root; its repository is reviewed.'),
    base: str.describe('The ref the changes start from; the merge base with head is used.'),
    head: str.optional().describe('The ref with the changes; absent means HEAD.'),
    runtimes: strings
      .min(1)
      .optional()
      .describe("The reviewing runtimes; absent means the project's reviewer."),
  }),
  'review.finding': z
    .strictObject({
      location: findingText,
      quote: findingText,
      evidence: findingText,
      impact: findingText,
      blocking: z.boolean(),
      reproduction: z.unknown().optional(),
    })
    .refine((finding) => !finding.blocking || finding.reproduction !== undefined, {
      path: ['reproduction'],
      message: 'Blocking findings require a reproduction or failing test evidence in reproduction',
    }),
  'review.finding.resolve': z.strictObject({
    review_id: str,
    finding_id: str,
    outcome: z.enum(['adopted', 'dismissed']),
    note: str.optional(),
  }),
  /** A conductor session only; its project and its own session come from its credential. */
  'conductor.review': z.strictObject({
    runtimes: strings.min(1).max(2).describe('The reviewing runtimes, one or two.'),
    session_id: str
      .optional()
      .describe('A session you spawned whose changes to review; absent means your own.'),
  }),
  'conductor.ready': z.strictObject({
    session_id: str
      .optional()
      .describe(
        'An idle session you spawned whose committed changes to land; absent means your own.',
      ),
  }),
  'conductor.spawn': z.strictObject({
    runtime: str.describe('The runtime of the new session.'),
    input: str.describe('The first message of the new session.'),
    model: str.optional(),
    effort: z.enum(EFFORT_LEVELS).optional(),
  }),
  'conductor.state': z.strictObject({}),
  /** The user only. */
  'runtime.reconnect': z.strictObject({ runtime: str }),
  /** Reconnects a server of a live native session; the user only. */
  'mcp.reconnect': z.strictObject({ session_id: str, server: str }),
  /**
   * Context an MCP interface gives the model; the user only. The session's next send or steer
   * carries the latest one ahead of its input.
   */
  'session.app_context': z.strictObject({
    session_id: str,
    server: str,
    content: z.string().max(65536),
  }),
  /**
   * An MCP interface calls a tool of its own server through the live session; the user only.
   * Returns the tools/call result; a tool whose _meta.ui.visibility lacks "app" is refused.
   */
  'mcp.app.tool_call': z.strictObject({
    session_id: str,
    server: str,
    tool: str,
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
  /** The user only. */
  'runtime.config.set': z.strictObject({
    runtime: str,
    enabled: z.boolean().optional(),
    binary: str.optional(),
    args: z.array(str).optional(),
    artifacts: z.boolean().optional(),
    unverified_isolation: z.boolean().optional(),
  }),
  'app.settings.set': z.strictObject({
    auto_git_init: z.boolean().optional(),
    auto_archive_merged: z.boolean().optional(),
    session_recap: z.boolean().optional(),
    brief_prose: z.boolean().optional(),
    /** Merges into the stored rules kind by kind. */
    attention_delivery: attentionDelivery.optional(),
    /** Null clears them. */
    quiet_hours: quietHours.nullable().optional(),
    baseline_rounds: z.number().int().min(1).max(5).optional(),
    baseline_visuals: z.boolean().optional(),
    /** Replaces the decisions the personal agent may answer. */
    personal_answers: personalAnswers.optional(),
  }),
  /** The user only; replaces the device of this id in `~/.pantheon/config.json`. */
  'device.save': z.strictObject({ id: deviceId, ...deviceConfigSchema.shape }),
  /** The user only. */
  'device.remove': z.strictObject({ id: str }),
  'approval.respond': z.strictObject({
    approval_id: str,
    decision: z.enum(['approve', 'approve_session', 'approve_project', 'reject']),
    reason: z.string().min(1).max(300).optional(),
    /** AskUserQuestion only: question text to the chosen labels joined by ", " or free text. */
    answers: z.record(str, str).optional(),
  }),
} as const;
export type CommandType = keyof typeof inputSchemas;
/** Read-only queries at GET /v1/<method>; params arrive as URL query strings. */
export const querySchemas = {
  'memory.read': memoryDirectorySchema,
  'memory.item': z.strictObject({ project_id: str, memory_id: str }),
  'memory.graph': memoryGraphSchema,
  'memory.document': z.strictObject({ project_id: str }),
  'memory.turn': z.strictObject({ session_id: str, turn_id: str }),
  'memory.session_turns': z.strictObject({ session_id: str }),
  'memory.recent': z.strictObject({
    project_id: str,
    limit: z.coerce.number().int().min(1).max(50).default(10),
  }),
  'project.baseline.read': z.strictObject({ project_id: str }),
  /** The user only; returns the project's EnvironmentCheck rows, newest first. */
  'project.environment.checks': z.strictObject({
    project_id: str,
    baseline_id: str.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  /** The user only; returns one Landing. */
  'project.landing.read': z.strictObject({ landing_id: str }),
  /** The user only; returns ProjectIntroRead. */
  'project.intro.read': z.strictObject({ project_id: str }),
  'project.facts.read': z.strictObject({ project_id: str }),
  'project.read': z.strictObject({ project_id: str }),
  /** The user only; returns the project's AgentProfile records, each with role_prompt, the built-in role prompt of its template. */
  'agent.list': z.strictObject({ project_id: str }),
  /** The user only; returns the defaults of the ideas, goals and custom templates a new agent starts from. */
  'agent.templates': z.strictObject({}),
  ...agentWakeQuerySchemas,
  ...agentLedgerQuerySchemas,
  'project.usage.read': z.strictObject({ project_id: str }),
  'project.review.metrics': z.strictObject({ project_id: str }),
  'extensions.inventory': z.strictObject({ project_id: str, runtime: str }),
  'runtime.models': z.strictObject({ project_id: str, runtime: str }),
  'permission.rules': z.strictObject({ project_id: str }),
  'project.branches': z.strictObject({ project_id: str, root: str.optional() }),
  'workspace.stale': z.strictObject({ project_id: str }),
  'project.head': z.strictObject({ project_id: str }),
  /** Without session_id the project's first folder is searched. */
  'files.search': z.strictObject({
    project_id: str,
    session_id: str.optional(),
    q: z.string().max(200),
  }),
  'files.read': z.strictObject({
    project_id: str,
    session_id: str.optional(),
    path: z.string(),
  }),
  'symbols.search': z.strictObject({
    project_id: str,
    session_id: str.optional(),
    q: z.string(),
  }),
  'needs_you.list': z.strictObject({ project_id: str.optional() }),
  /** The user only; returns ExternalRead. */
  'external.read': z.strictObject({ project_id: str }),
  'projects.summary': z.strictObject({}),
  /** ProjectBrief; what happened in the project after since, by default after the caller's seen cursor. */
  'project.brief': z.strictObject({
    project_id: str,
    since: z.coerce.number().int().min(0).optional(),
  }),
  /** DecisionsForUser; what a lead or a stored rule decided without the user from since on, Unix milliseconds, newest first. */
  'project.decisions': z.strictObject({
    project_id: str,
    since: z.coerce.number().int().min(0).optional(),
  }),
  'session.reviews': z.strictObject({ session_id: str }),
  /** The user only; returns one Review. */
  'review.read': z.strictObject({ review_id: str }),
  'change_story.list': z.strictObject({ project_id: str }),
  'change_story.diff': z.strictObject({ story_id: str }),
  'session.create.preview': z
    .strictObject({
      project_id: str,
      ...sessionWorkspace,
      from: z.preprocess((value) => {
        if (typeof value !== 'string') return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }, sessionFrom.optional()),
    })
    .refine(validSessionWorkspace, { message: 'An in-place session cannot have a start point' }),
  'session.list': z.strictObject({ project_id: str }),
  /** The user only; returns SessionSearchResult, including archived sessions across projects. */
  'session.search': z.strictObject({
    text: z.string().trim(),
    project_id: str.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  'session.diff': z.strictObject({ session_id: str }),
  'session.comments': z.strictObject({ session_id: str }),
  'session.turn_diff': z.strictObject({ session_id: str, turn_id: str }),
  'session.gates': z.strictObject({ session_id: str }),
  /** SessionTasks. */
  'session.tasks': z.strictObject({ session_id: str }),
  'session.gates.history': z.strictObject({
    session_id: str,
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  'project.gates.history': z.strictObject({
    project_id: str,
    since: z.coerce.number().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(30),
  }),
  'project.timeline': z.strictObject({
    project_id: str,
    since: z.iso.datetime({ offset: true }).optional(),
  }),
  'session.preflight': z.strictObject({ session_id: str }),
  'session.activity': z.strictObject({ session_id: str }),
  'board.view': z.strictObject({
    project_id: str,
    days: z.enum(['1', '3', '7', '14', '30', 'all']),
    until: calendarDay.optional(),
  }),
  'project.trace': z.strictObject({
    project_id: str,
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    bucket_ms: z.coerce.number().int().min(1000).max(86_400_000).default(60_000),
  }),
  'session.trace': z.strictObject({ project_id: str, lane_key: str, turn: str.optional() }),
  'session.step_diff': z.strictObject({ session_id: str, turn_id: str, span_id: str }),
  'project.collab': z
    .strictObject({ project_id: str, since: z.coerce.number(), until: z.coerce.number() })
    .refine((input) => input.since <= input.until, {
      message: 'The time range starts after it ends',
    }),
  'tool.calls': z.strictObject({
    project_id: str,
    command: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  'project.trace.stats': z
    .strictObject({
      project_id: str,
      since: z.coerce.number(),
      until: z.coerce.number(),
    })
    .refine((input) => input.since <= input.until, {
      message: 'The time range starts after it ends',
    }),
  'trace.time': z.strictObject({
    project_id: str,
    lane_key: str.optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  }),
  'project.heatmap': z.strictObject({
    project_id: str,
    days: z.enum(['7', '30', '90', 'all']).default('30'),
  }),
  'workflow.policy': z.strictObject({ project_id: str }),
  'task.trace': z.strictObject({ project_id: str, lead_session_id: str, task_id: str }),
  /** TaskThreadEntry[] of the task in event order. */
  'task.thread': z.strictObject({ project_id: str, lead_session_id: str, task_id: str }),
  /** RuntimeStatus[]; refresh checks again instead of answering from the last check. */
  'runtime.status': z.strictObject({ refresh: z.stringbool().optional() }),
  /** McpStatus; a project reads the runtime's project setup, a session reads its live setup. */
  'mcp.status': z.union([
    z.strictObject({ project_id: str, runtime: str }),
    z.strictObject({ session_id: str }),
  ]),
  /** McpServerStatus[]; the servers the session's recorded events name, empty when they name none. */
  'session.mcp_servers': z.strictObject({ session_id: str }),
  /** McpAppResource; the HTML of a ui:// interface, read through the live session. */
  'mcp.app.resource': z.strictObject({ session_id: str, server: str, uri: str }),
  /** GithubItems; at most 30 open items, newest update first, cached for sixty seconds. */
  'github.items': z.strictObject({ project_id: str, kind: z.enum(['pr', 'issue']) }),
  /** GithubPullDetail; one pull request with its checks and review threads, cached for sixty seconds. */
  'github.pr.detail': z.strictObject({ project_id: str, number: z.coerce.number().int().min(1) }),
  /** ConnectionsStatus; refresh bypasses the daemon's cached connection checks. */
  'connections.status': z.strictObject({ refresh: z.stringbool().optional() }),
  /** DeviceListItem[], this machine first; refresh probes the devices again instead of answering from the last probe. */
  'device.list': z.strictObject({ refresh: z.stringbool().optional() }),
  /** DeviceListItem; probes only this configured device again, then answers with it. */
  'device.probe': z.strictObject({ id: str }),
  /** SshHost[]; the named hosts of the user's `~/.ssh/config`, in file order. */
  'device.ssh_hosts': z.strictObject({}),
  /** AppSettings. */
  'app.settings': z.strictObject({}),
  /** ProjectDefaultsRead; the user only. */
  'project.defaults': z.strictObject({}),
  /** The user only; returns {id, label, created_at, revoked_at?}[], every personal agent key in creation order. */
  'personal.key.list': z.strictObject({}),
  /** BackendSummary[]. */
  'backend.list': z.strictObject({}),
  /** ImportCandidates. */
  'import.candidates': z.strictObject({}),
  /** ImportableSession[]: the native sessions under the project's folders not yet in Pantheon. */
  'session.importable': z.strictObject({ project_id: str }),
  /** SessionToolImage; an image a tool call of the session returned, by the hash its event names. */
  'session.tool_image': z.strictObject({
    session_id: str,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
} as const;
export type QueryMethod = keyof typeof querySchemas;
/** GET /v1/app.settings; the user's own settings across projects. */
export interface AppSettings {
  auto_git_init: boolean;
  auto_archive_merged: boolean;
  /** Absent is on. */
  session_recap?: boolean;
  /** Absent is on. */
  brief_prose?: boolean;
  /** Every attention kind; absent in the config is its default. */
  attention_delivery: Record<AttentionKind, AttentionDelivery>;
  /** Local HH:MM; inside it now waits for the brief. */
  quiet_hours?: { from: string; to: string };
  baseline_rounds: number;
  baseline_visuals: boolean;
  /** The decisions the personal agent may answer for the user; empty unless the user turned one on. */
  personal_answers: PersonalAnswerKind[];
}
/** GET /v1/device.list; this machine (id `local`) or a configured device, with what its last probe found. */
export interface DeviceStatus {
  id: string;
  name: string;
  /** Absent for this machine. */
  ssh?: string;
  note?: string;
  /** The configured labels, then the ones the probe found. */
  labels: string[];
  resources: Record<string, number>;
  max_sessions: number;
  online: boolean;
  error?: string;
  /** ISO time of the probe. */
  checked_at: string;
  /** ISO time of the last successful probe; absent before a device was reached. */
  last_online_at?: string;
  os?: 'macos' | 'linux';
  os_version?: string;
  arch?: string;
  cpus?: number;
  memory_bytes?: number;
  load_1m?: number;
  home?: string;
  /** PATH as the probe extended it. */
  path?: string;
  /**
   * Runtime name to its absolute binary, the first line of its --version and its login as a
   * process started over SSH sees it; Claude on macOS reads false there, its login is in the keychain.
   */
  runtimes: Record<string, { binary: string; version: string; logged_in: boolean }>;
  /** Tool name to the first line of its --version. */
  tools: Record<string, string>;
}
/** GET /v1/device.list; a device with its entry of the user configuration and what holds it now. */
export interface DeviceListItem extends DeviceStatus {
  /** The device's entry of `~/.pantheon/config.json` as written; absent for this machine. */
  config?: z.infer<typeof deviceConfigSchema>;
  /** The task sessions holding a place on the device and the resources unfinished tasks use there, of every project. */
  load: {
    sessions: number;
    uses: Record<string, number>;
    /** Open sessions on this device, including idle native sessions, across projects. */
    active_sessions: { id: string; title: string; runtime: string; started_at: string }[];
    /** Resource name to occupying session ids; absent for resources whose occupants are unknown. */
    resource_sessions?: Record<string, string[]>;
  };
}
/** GET /v1/device.ssh_hosts; a Host of `~/.ssh/config` without wildcards, with its own HostName and User. */
export interface SshHost {
  host: string;
  hostname?: string;
  user?: string;
  /** The configured device whose ssh is this host; absent when none is. */
  device_id?: string;
}
/** GET /v1/backend.list; one backend of `~/.pantheon/config.json`, naming where its key is kept. */
export interface BackendSummary {
  id: string;
  protocol: BackendProfile['protocol'];
  base_url: string;
  models: string[];
  /** The registered runtimes that can send to this protocol. */
  runtimes: string[];
  key: { env: string } | { keychain: string };
  /** Whether the environment variable is set in the daemon; absent for a keychain key, which is not read. */
  key_present?: boolean;
}
/** A folder with native session history that could become a project. */
export interface ImportCandidate {
  root: string;
  name: string;
  git: boolean;
  remote: { host: string; owner: string; name: string } | null;
  sessions: number;
  runtimes: ('claude' | 'codex')[];
  /** ISO time of the newest session; null when none has a time. */
  last_active_at: string | null;
  preselected: boolean;
  /** Why the folder cannot be imported; absent when it can. */
  excluded?: 'nested_project' | 'pantheon_data' | 'temporary' | 'nested_repo' | 'missing';
}
/** GET /v1/import.candidates; indexing is null once the native transcripts are fully indexed. */
export interface ImportCandidates {
  indexing: { done_files: number; total_files: number } | null;
  candidates: ImportCandidate[];
}
/** A native session the user can adopt into a project. */
export interface ImportableSession {
  native_session_id: string;
  runtime: 'claude' | 'codex';
  title: string;
  cwd: string;
  /** ISO time; null when unknown. */
  updated_at: string | null;
}
/** GET /v1/projects.summary; the counts and progress of each project. */
export interface ProjectSummary {
  project_id: string;
  name: string;
  counts: { running: number; waiting: number; ready: number; failed: number; queued: number };
  /** Sessions merged since the start of the current local calendar day. */
  merged_today: number;
  needs_you: number;
  /** The first milestone not yet accepted, in board order. */
  milestone: {
    id: string;
    title: string;
    done: number;
    total: number;
    running: number;
    failed: number;
  } | null;
  /** Lead plan tasks done at the end of each of the last 14 local calendar days, oldest first. */
  done_daily: { date: string; done: number }[];
  /** Newest session last_activity_at, as an ISO time; null without sessions. */
  last_activity_at: string | null;
  /** The first sentence of the caller's project.brief prose; absent without prose. */
  brief?: string;
  /** Absent when nothing waits for the user. */
  waiting?: ProjectWaiting;
}
/** What a brief item links to; a merge is the merged session's id, decided the project's id. */
export interface ProjectBriefRef {
  kind: 'task' | 'milestone' | 'merge' | 'approval' | 'event' | 'decided';
  id: string;
}
/** One thing that happened after the brief's since; times are Unix milliseconds. */
export type ProjectBriefItem =
  /** Listed when a decision arrived after since; count and top are those of needs_you.list. */
  | {
      kind: 'decisions';
      ref: ProjectBriefRef;
      count: number;
      /** The decisions that arrived after since. */
      new: number;
      top: NeedsYouItem;
    }
  | { kind: 'failure'; ref: ProjectBriefRef; at: number; reason: NeedsYouItem['reason'] }
  | { kind: 'milestone'; ref: ProjectBriefRef; title: string; done: number; total: number }
  | { kind: 'merge'; ref: ProjectBriefRef; at: number }
  | { kind: 'assumption'; ref: ProjectBriefRef; at: number; text: string }
  /** Listed when something was decided for the user after since; count is all of project.decisions. */
  | { kind: 'decided'; ref: ProjectBriefRef; count: number; types: Record<DecisionType, number> };
/** The side model's paragraph about a brief; each sentence cites the items it is about. */
export interface ProjectBriefProse {
  sentences: { text: string; refs: ProjectBriefRef[] }[];
  at: number;
}
/** GET /v1/project.brief. */
export interface ProjectBrief {
  since: number;
  items: ProjectBriefItem[];
  /** Present when it was written for these items after this since. */
  prose?: ProjectBriefProse;
}
/** One thing decided without the user; at is Unix milliseconds. */
export type DecisionForUser =
  /** A worker prompt approved on the lead's behalf; decided_by is session:<lead id>, session_id the worker's. */
  | {
      kind: 'prompt_approved';
      at: number;
      approval_id: string;
      session_id?: string;
      decided_by: string;
      tool?: string;
      input_summary?: string;
    }
  /** A prompt answered by the stored permission rule. */
  | {
      kind: 'prompt_by_rule';
      at: number;
      approval_id: string;
      session_id?: string;
      /** Absent for a personal principal: a stored rule can be a whole command line. */
      rule?: string;
      tool?: string;
      input_summary?: string;
    }
  /** A power the lead used on its own; subject is the id of the plan, milestone or session it acted on, session_id the lead's. */
  | {
      kind: 'power_used';
      at: number;
      power: Extract<
        CharterPower,
        'plan_change' | 'accept_milestone' | 'merge_out_of_scope' | 'create_agent'
      >;
      subject: string;
      session_id: string;
      /** The reason the lead gave when it used the power; absent when it gave none. */
      reason?: string;
      /** The current verification of the milestone a lead accepted although it had not passed. */
      verification?: { id: string; state: MilestoneVerification['state'] };
    }
  /**
   * A task session's question the lead answered; answer is the lead's, session_id the asking session's
   * while it exists, overruled the answer the user replaced it with.
   */
  | {
      kind: 'question_answered';
      at: number;
      lead_session_id: string;
      question_id: string;
      session_id?: string;
      question: string;
      answer: string;
      citations: NonNullable<NonNullable<BoardPlan['questions']>[number]['citations']>;
      /** Set on the lead's own question no one answered before its deadline: answer is the lead's recommendation, applied then; citations is empty. */
      answered_by?: 'default';
      overruled?: { answer: string; at: number };
    }
  /** A decision a personal agent key answered for the user. */
  | {
      kind: 'personal_answer';
      at: number;
      key_id: string;
      command: 'lead.question.answer' | 'board.plan.proposal.resolve' | 'milestone.accept';
      /** The id of the question, plan proposal or milestone. */
      subject: string;
      /** The lead session whose question or proposal it was, or that owns the milestone. */
      lead_session_id?: string;
      /** The question, the reason the lead gave for the proposal, or the milestone's title. */
      text: string;
      /** The answer, or the proposal's status once resolved; absent for a milestone. */
      decision?: string;
      /** The reason given when resolving the proposal. */
      reason?: string;
    };
/** GET /v1/project.decisions. */
export interface DecisionsForUser {
  items: DecisionForUser[];
}
/** The type the approved-for-you list is filtered by. */
export type DecisionType = 'permission' | 'answer' | 'plan_change';
/** A decision's type; a power other than a plan change, and a milestone a key accepted, have none. */
export function decisionType(item: DecisionForUser): DecisionType | null {
  if (item.kind === 'prompt_approved' || item.kind === 'prompt_by_rule') return 'permission';
  if (item.kind === 'question_answered') return 'answer';
  if (item.kind === 'personal_answer')
    return item.command === 'lead.question.answer'
      ? 'answer'
      : item.command === 'board.plan.proposal.resolve'
        ? 'plan_change'
        : null;
  return item.power === 'plan_change' ? 'plan_change' : null;
}
/** GET /v1/session.search; metadata first, then messages, newest first in each group. */
export interface SessionSearchResult {
  hits: SessionSearchHit[];
  /** False while stored sessions or changes are still being indexed in the background. */
  indexing_complete: boolean;
}
export type SessionSearchHit = {
  session_id: string;
  project_id: string;
  title: string;
  archived: boolean;
  /** ISO time of the message, or the session's last activity for metadata. */
  at: string;
  /** About 120 UTF-16 code units surrounding the first match; longer for a longer query. */
  excerpt: string;
  /** UTF-16 offsets into excerpt, for String.slice and browser highlighting. */
  match: { start: number; length: number };
} & (
  { kind: 'title' | 'branch' } | { kind: 'message'; turn_id: string; speaker: 'user' | 'agent' }
);
export interface SessionReconnectResult {
  session_id: string;
  succeeded: true;
}

/** GET /v1/session.list; one native session working in its own linked worktree, or a baseline session. */
export interface WorkbenchSession {
  id: string;
  /** Current pull state; session.list supplies not_needed before the first pull. */
  remote_pull?: NonNullable<Session['remote_pull']>;
  runtime_review?: true;
  forked_from?: { session_id: string; before_turn_id?: string; before_span_id?: string };
  /** ISO time of the session.opened event. */
  created_at: string;
  /** Empty for a baseline session without a title, which baseline_started_at names. */
  title: string;
  /** Epoch milliseconds the baseline of a baseline session without a title started. */
  baseline_started_at?: number;
  runtime: string;
  device_id?: string;
  /** The worktree's branch; null for detached HEAD, absent without a worktree. */
  branch?: string | null;
  ahead?: number;
  behind?: number;
  /** Merge preview against the target head; absent until computed or without commits ahead. */
  predicted_conflicts?: { files: string[]; total: number };
  /** The task goal or first user input, with its ISO time. */
  goal?: { text: string; at: string };
  model: string | null;
  effort: EffortLevel | null;
  permission_mode: PermissionMode;
  fast_mode?: { on: boolean; state?: 'on' | 'off' | 'cooldown'; reason?: string };
  /** Whether ultracode is on; absent outside a Claude worktree session. */
  ultracode?: boolean;
  /** The configured backend the session sends to; absent when it uses the runtime's own. */
  backend_id?: string;
  /** null for a baseline session, which reads the project without a worktree. */
  workspace_id: string | null;
  workspace_kind: 'linked_worktree' | 'in_place';
  /** A session the user opened in the project folder: it runs its gates there and lands on the current branch. */
  lands?: true;
  /** The session writes in the project folder, so a new session without a choice gets a worktree. */
  holds_folder?: true;
  /** Why the session got a worktree though the user chose none. */
  worktree_reason?: { holder_session_id: string; holder_title: string };
  /**
   * ready: idle with no uncommitted changes and commits past the worktree's base commit;
   * merging: its merge is running;
   * waiting: a permission request is unanswered, or the project's newest baseline awaits review;
   * done: a baseline session whose baseline is no longer running or awaiting review.
   */
  state:
    | 'starting'
    | 'running'
    | 'waiting'
    | 'idle'
    | 'ready'
    | 'merging'
    | 'failed'
    | 'merged'
    | 'discarded'
    | 'done';
  /** Unanswered permission requests of this session. */
  waiting: number;
  /** Total context compactions recorded for this session. */
  compaction_count?: number;
  /** Runtime-reported automatic compaction threshold for the current model, in tokens. */
  auto_compact_at_tokens?: number;
  /** Present only when this session overrides the project connector list. */
  enabled_user_connectors?: string[];
  /**
   * Present only while waiting. question: every unanswered request is an AskUserQuestion;
   * baseline_review: the project's newest baseline awaits review; approval otherwise.
   */
  waiting_kind?: 'approval' | 'question' | 'baseline_review';
  /** The oldest unanswered permission request; absent when waiting is zero. */
  waiting_request?: { tool: string; detail?: string };
  /** The newest turn reporting context tokens, only when it also reports the window. */
  context?: { used_tokens: number; window_tokens: number };
  /** The session is reconciling its native process after a restart; state shows its listed state. */
  reconciling: boolean;
  /** A stop was requested and its termination is not yet confirmed. */
  stopping: boolean;
  /** The newest send turn that has not been rolled back, independent of session lifecycle. */
  last_turn?: {
    id: string;
    state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
    error?: string;
    error_code?: string;
  };
  /**
   * The newest turn whose files session.rollback can restore: not rolled back, its checkpoint
   * stored, and queued after the session's newest merge; absent when there is none.
   */
  checkpoint_turn_id?: string;
  /** The newest pull request opened from the session's worktree. */
  pull_request?: { number: number; url: string };
  /**
   * The newest gate run of the session; absent without gate commands or without a run. stale: a
   * turn of the session ended after the run, so the worktree head may have moved since.
   */
  gate?: {
    state: 'running' | 'cancelling' | 'cancelled' | 'passed' | 'failed' | 'stale';
    passed: number;
    failed: number;
    /** Steps that failed and were allowed to be skipped, neither passed nor failed; absent is 0. */
    skipped?: number;
    running: number;
    /** Steps an ended run never reached after a failure; absent is 0. */
    not_run?: number;
    /** ISO time the run ended; absent while it runs. */
    finished_at?: string;
  };
  /** ISO time of the newest turn start or end, request, merge end or the session's opening. */
  last_activity_at: string;
  /** Changed files and lines against the base commit; null when the worktree is not in use. */
  changes: { files: number; additions: number; deletions: number } | null;
  /** The running or blocked merge into the source; null when none. */
  merge: {
    state: 'running' | 'blocked';
    cancel_requested?: boolean;
    reason?: string;
    conflicts?: string[];
    /** Titles of the source's commits that changed the conflicting files since the session forked. */
    conflict_commits?: string[];
    gate?: { name: string; output: string; tests?: TestCounts };
    /** Why the gate that blocks the merge failed. */
    failure_class?: 'environment' | 'code';
  } | null;
  /** The lead session of the board task this session was opened from; absent for other sessions. */
  lead?: string;
  /** The plan task this session was opened from, with the title of its lane. */
  task?: { id: string; title: string; lane: string; lane_title: string; milestone?: string };
  resident?: NonNullable<Session['resident']>;
  /** ISO time the user pinned the session; absent when it is not pinned. */
  pinned_at?: string;
  /** ISO time the user archived the session; absent when it is not archived. */
  archived_at?: string;
  /** ISO time the user snoozed the session; absent when it is not snoozed. */
  snoozed_at?: string;
  /** What the runtime is doing now, and what it waits on since when. */
  run?: {
    phase: BoardActivity['phase'] | 'compacting' | 'retrying';
    since: number;
    tool?: BoardActivity['tool'];
    wait?: {
      reason:
        | 'approval'
        | 'question'
        | 'baseline_review'
        | 'upstream'
        | 'merge_blocked'
        | 'gate_failed'
        | 'reconciling'
        | 'long_background';
      since: number;
    };
  };
  recap?: SessionRecap;
  tasks?: { running: number };
}
/** GET /v1/project.head; the branch and commit checked out in the project's first folder. */
export interface ProjectHead {
  /** null when HEAD is detached. */
  branch: string | null;
  sha: string;
  subject: string;
  committed_at: number;
  ahead_upstream?: number;
  uncommitted: number;
}
export interface SessionCreatePreview {
  /** null for a detached HEAD. */
  branch: string | null;
  base_sha: string;
  base_ref: string;
}
/** POST /v1/attachments; a file uploaded for a later session turn. */
export interface AttachmentMeta {
  id: string;
  name: string;
  mime: string;
  /** Bytes. */
  size: number;
}
export type BoardTaskStatus =
  'running' | 'waiting' | 'idle' | 'ready' | 'done' | 'failed' | 'todo' | 'discarded';
/** Where a plan task stands, computed by the daemon so the board only shows it. */
export type BoardTaskState =
  | 'todo'
  | 'waiting_upstream'
  | 'claimed'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'needs_attention'
  | 'gating'
  | 'awaiting_acceptance'
  | 'awaiting_merge'
  | 'merged'
  | 'failed';
/** One session's share of a board task. */
export interface BoardSegment {
  id: string;
  session_id: string | null;
  /** The session's title. */
  title: string;
  runtime: string | null;
  model: string | null;
  status: BoardTaskStatus;
  /** Epoch milliseconds; null before the session started. */
  started_at: number | null;
  /** Epoch milliseconds; null while the session is still open. */
  ended_at: number | null;
  tokens: number;
  additions?: number;
  deletions?: number;
}
/** A pending permission request; input is an AskUserQuestion request. */
export interface BoardWaiting {
  kind: 'approval' | 'input';
  /** At most 6 single-select labels of at most 60 characters, for one question. */
  options?: string[];
  /** The request input, at most 140 characters. */
  summary: string;
  approval_id: string;
  /** Epoch milliseconds. */
  since: number;
  /** The full questions of an AskUserQuestion request. */
  questions?: ApprovalQuestion[];
}
/** What a board task's newest session not discarded is doing now. */
export interface BoardActivity {
  phase:
    | 'queued'
    | 'starting'
    | 'thinking'
    | 'tool'
    | 'waiting_approval'
    | 'waiting_input'
    | 'gate'
    | 'merging'
    | 'idle';
  /** When the phase began, epoch milliseconds. */
  since: number;
  /** The newest tool call under way, in the tool phase. */
  tool?: {
    name: string;
    /** A command, path or the like from its input, at most 80 characters. */
    target?: string;
  };
  waiting?: BoardWaiting;
  /** The error of the newest turn when it failed, at most 200 characters. */
  turn_error?: string;
  /** The newest failed attempt has the same failed gate steps or turn error code as its predecessor. */
  repeated_failure?: boolean;
  /**
   * quiet: the running turn made no progress for 2 minutes and has no tool call under way;
   * stalled and looping: the task tracker told the lead so of the running turn.
   */
  health: 'fresh' | 'quiet' | 'stalled' | 'looping';
  /** The task's sessions, discarded ones included; at least 1. */
  attempt: number;
  /** The merge problems Pantheon handed back to the session to fix. */
  handed_back?: string[];
  /** Daemon turns in a row since the task's last verified progress that led to the session's newest turn; absent: 0. */
  causal_depth?: number;
}
/**
 * Who acts next on a board task with a problem. retry: Pantheon gives the session another turn
 * with the failure, or opens it again; switch: the task moved to another runtime; lead: the lead
 * was told and owns the next move; user: it waits for the user.
 */
export interface BoardTaskRung {
  rung: TaskRungName;
  by: 'pantheon' | 'lead' | 'user';
  /** A merge problem, review_findings, dispatch_failed, a needs-you reason such as workflow_approval, a tracked state, stalled, looping or runtime_changed. */
  reason: string;
  /** Tries of reason used so far: hand-backs, review rounds or attempts to open the session. */
  used?: number;
  limit?: number;
  /** The retry waits for the usage limit to reset or for the user to raise the project budget. */
  held?: 'usage_limit' | 'project_budget';
  /** When the fact behind the rung was recorded, epoch milliseconds. */
  since: number;
  /** The runtime changes of the task's current sessions, oldest first. */
  switches: { from: string; to: string; at: number; by: 'pantheon' | 'lead' }[];
}
/**
 * One board blocker: queued waits for the task's dispatch_wait, error is why its session did not
 * open; upstream names an unmet dependency by title; merge_blocked and turn_failed are the
 * newest session's.
 */
export type BoardBlocker =
  | { code: 'queued'; error?: string }
  | { code: 'upstream'; title: string }
  | { code: 'merge_blocked'; reason?: string; conflicts: number }
  | { code: 'turn_failed'; error?: string };
/** GET /v1/board.view; the project board, computed from sessions, merges, usage and the written board. */
/**
 * The tasks whose newest retrospective was recorded within a range, and how many of them passed
 * their first gate run; absent without such tasks.
 */
export interface GateFirstPass {
  tasks: number;
  passed: number;
}
export interface BoardSessionTime {
  sessions: number;
  working_ms: number;
  waiting_ms: number;
  gate_ms: number;
  queue_ms: number;
}

/** Fields of a plan task's board row that packages/control/src/board-view-task-extras.ts fills. */
export interface BoardTaskExtras {
  /**
   * What backs a merged task: only the agent's report, a gate with a passed step and none failed,
   * or a pass handed in by a reviewer on another runtime than its writers; absent before merge.
   */
  evidence_level?: 'report' | 'gate' | 'reviewed';
  /** The most independent reviewer that passed it; set only when `evidence_level` is `reviewed`. */
  evidence_reviewer?: 'other_vendor' | 'other_runtime';
  /** The line the task's session last set in its newest turn; `at` is epoch milliseconds. */
  status_line?: { text: string; at: number };
}
/** Fields of a milestone's board row that packages/control/src/board-view-task-extras.ts fills. */
export interface BoardMilestoneExtras {
  /**
   * What backs a ready or completed milestone: the user's acceptance, a passed verification, or
   * else the weakest level of its merged plan tasks; absent otherwise.
   */
  evidence_level?: 'report' | 'gate' | 'reviewed' | 'verified' | 'accepted';
  /** The milestone's current verification; absent when none ran. */
  verification?: MilestoneView['verification'];
  /** The goal its lead linked it to; it may name a goal archived since. */
  goal_id?: string;
  /** The owner plan's assumptions with an id that name this milestone, in plan order; absent when none. */
  assumptions?: {
    id: string;
    text: string;
    /** Board task ids of the tasks that rest on it. */
    affects: string[];
    /** The newest user edit that refuted it; absent when none did. */
    refuted?: {
      edit_id: string;
      /** The user's words. */
      instead: string;
      state: 'pending' | 'applied' | 'rejected' | 'withdrawn';
      /** The lead's reason when it resolved the edit with one. */
      reason?: string;
    };
  }[];
}
/** What the unfinished tasks of a lane are expected to take, each number with its source. */
export interface BoardLaneEstimate {
  tasks: number;
  /** Plan milestones of those tasks. */
  milestones: number;
  /**
   * tasks: one per task, one per part of a parallel task, none for a direct task; reviews: the
   * review round limit of each review-loop task; plan_review: one when a task's tier gets a plan
   * review; milestone_verify: one per milestone when verification is on.
   */
  sessions: {
    total: number;
    by_part: { tasks: number; reviews: number; plan_review: number; milestone_verify: number };
  };
  tokens: {
    /** Median input plus output tokens of gated tasks of the same kind on the same model; min_n is the fewest such tasks behind one median, 0 without any. */
    history: { total: number; tasks: number; min_n: number };
    /** Input tokens of the policy budget, for the tasks without history. */
    budget: { total: number; tasks: number };
    unknown_tasks: number;
  };
  /** The policy budget's wall time, for the tasks whose budget has one; absent when none has. */
  wall_ms?: { total: number; tasks: number };
  runtimes: { role: 'writer' | 'reviewer' | 'verifier'; runtime: string; count: number }[];
}

export interface BoardModel {
  /** Commands failing at least twice in the range, ordered by failed runs then name, at most ten. */
  gate_failures?: { name: string; failed_runs: number; runs: number; flaky: boolean }[];
  /** Start of the chosen range, epoch milliseconds. */
  since: number;
  /** When the model was computed, epoch milliseconds. */
  now: number;
  headline: {
    text: string;
    updated_at: number;
    by_session: string | null;
  } | null;
  counts: {
    running: number;
    waiting: number;
    ready: number;
    failed: number;
    /** Merges within the range. */
    merged: number;
    /** Merged sessions in the range whose landed commits were later reverted on the target branch. */
    reverted: number;
    /** Median time from session creation to merge within the range; null without merges. */
    median_ms: number | null;
    /** Input plus output tokens within the range. */
    tokens: number;
    tokens_by_runtime: Record<string, number>;
    /** Sessions with an ended turn within the range that reported no tokens; absent: 0. */
    sessions_without_usage?: number;
    /** The same per runtime the turns ran on; absent with sessions_without_usage. */
    sessions_without_usage_by_runtime?: Record<string, number>;
    /** Sessions with a context compaction within the range; absent: 0. */
    compacted_sessions?: number;
    /** The same number of local days immediately before the range; absent for all time. */
    previous?: {
      tokens: number;
      cost_usd: number | null;
      merged: number;
      median_ms: number | null;
      /** Cache reads / input tokens, using only turns that report cache reads; absent with no such input. */
      cache_read_share?: number;
      gate_first_pass?: GateFirstPass;
      session_time?: BoardSessionTime;
    };
    /** Cache reads / input tokens, using only turns that report cache reads; absent with no such input. */
    cache_read_share?: number;
    gate_first_pass?: GateFirstPass;
    /** Per-session median parts of creation-to-merge time, in ms; absent without merged sessions. */
    session_time?: BoardSessionTime;
    /** User wait within the range, in ms; zero reasons and an empty object are omitted. */
    wait_by_reason_ms?: { approval?: number; review?: number; question?: number };
    /** null when no turn in the range reported a cost. */
    cost_usd: number | null;
  };
  /** fanout_reason is absent when the lead gave none. */
  lanes: {
    id: string;
    title: string;
    fanout_reason?: string;
    /** The user's depth, else the lead's, else plan_first once Pantheon held the lane; absent with none. */
    depth?: LaneDepth;
    depth_by?: 'user' | 'lead' | 'pantheon';
    /** The lead's reason for its depth; absent when it gave none. */
    depth_reason?: string;
    /** Absent for a lane never held for the user's plan approval. */
    stop?: { state: 'waiting' | 'approved'; at: number; by?: 'user' | 'personal' };
    /** Present only while the lane waits for the user's plan approval. */
    estimate?: BoardLaneEstimate;
  }[];
  iterations?: {
    id: string;
    title: string;
    starts_on: string;
    ends_on: string;
    planned: number;
    done: number;
    /** Epoch milliseconds; absent without open work or when any open task lacks an estimate. */
    forecast_done_at?: number;
    /** Additional median-duration tasks that fit before the iteration ends; never negative. */
    capacity?: number;
    days: { date: string; done: number; scope: number }[];
  }[];
  slots?: { limit: number; used: number; queued: number };
  tasks: ({
    /** `<lead session id>:<task id>` for a plan task; the session id for a session without a task. */
    id: string;
    forked_from?: { session_id: string; before_turn_id?: string };
    /** The lead whose plan holds the task; absent on rows of sessions not opened from a task. */
    owner_session_id?: string;
    title: string;
    goal: string;
    lane_id: string | null;
    priority?: 'high' | 'normal' | 'low';
    kind?: TaskKind;
    task_type?: BoardPlan['tasks'][number]['task_type'];
    scope: string[];
    token_budget?: number;
    /**
     * What an unfinished started task spent so far of its tier and path's budget, counted as its
     * retrospective counts it; tokens of a running turn count once it ends. ratio is the larger of
     * the token and wall-time shares. Absent when that cell has no budget.
     */
    budget?: {
      ratio: number;
      input_tokens: number;
      wall_ms: number;
      limit: { input_tokens: number; wall_ms: number };
    };
    /** Who acts next on an unmerged task with a problem; absent without one. */
    rung?: BoardTaskRung;
    subagents?: number;
    route_reason?: string;
    device?: string;
    device_reason?: string;
    needs?: string[];
    uses?: Record<string, number>;
    /** The flow path the task takes in effect, not only one the task names; absent off plan tasks. */
    path?: FlowPath;
    /** Index in the owner's plan; absent on standalone session rows. */
    order?: number;
    milestone_id: string | null;
    iteration_id?: string | null;
    estimate?: number;
    /** Median first-dispatch-to-merge duration in milliseconds, from the last 90 days. */
    estimate_ms?: number;
    order_locked?: true;
    pr?: { number: number; url: string };
    /** The parts of a parallel task in plan order, each with its session once one is open. */
    parallel?: { title: string; session_id?: string; status?: BoardTaskStatus }[];
    status: BoardTaskStatus;
    /** Why the task is blocked, written on the board; empty when it is not. */
    blockers: string[];
    /** What each of blockers is, in the same order, so the interface words it; always set by the daemon. */
    blocker_codes?: BoardBlocker[];
    segments: BoardSegment[];
    additions: number | null;
    deletions: number | null;
    checks: 'pass' | 'fail' | 'running' | 'none';
    context?: { used_tokens: number; window_tokens: number };
    acceptance_checks?: { text: string; state: 'pending' | 'passed' | 'failed' }[];
    gate_steps?: {
      name: string;
      state: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
      tests?: TestCounts;
      carried?: boolean;
    }[];
    successors?: number;
    external_review?: {
      rounds: number;
      verdict: 'pending' | 'passed' | 'failed';
      /** Newest round request and completion times, epoch milliseconds. */
      started_at?: number;
      ended_at?: number;
      /** Open findings of the newest round; absent while that round runs. */
      findings?: { blocking: number; other: number };
    };
    /** Evidence for the newest attempt only; older sessions never imply coverage of a retry. */
    evidence?: {
      session_id: string;
      gate?: WorkbenchSession['gate'];
      review?: Pick<Review, 'id' | 'state' | 'executions' | 'range'>;
    };
    started_at: number | null;
    ended_at: number | null;
    /**
     * Newest turn start or end, completed tool call, merge or gate result of its sessions; null
     * without one.
     */
    last_progress_at: number | null;
    /** Since when an upstream plan task has stayed not done; null when none is, or the task is done. */
    blocked_since: number | null;
    /** A session of the task has a turn running or queued and no request waiting for the user. */
    turn_running: boolean;
    /** Absent on a plan task without a session not discarded, unless it is queued. */
    activity?: BoardActivity;
    /** The recap of the session activity describes; absent before one is written. */
    recap?: SessionRecap;
    /**
     * todo: no session and not queued, or queued for anything but upstream; claimed: dispatched,
     * its first turn not yet running; needs_attention: no turn queued or running and the turns that
     * ended left nothing to merge (no commit, uncommitted changes only, or a failed turn);
     * awaiting_acceptance: a report task its lead has yet to accept, with a done report and no turn
     * queued or running; awaiting_merge: its checks passed and its change waits to be merged;
     * merged also covers a report task its lead accepted; failed: every session closed unmerged and
     * no start queued. Absent on rows of sessions not opened from a task.
     */
    state?: BoardTaskState;
    /** Present only with state merged: whether a merge or the lead's acceptance completed the task. */
    done_by?: 'merged' | 'accepted';
    /** What a queued task waits for; absent when it is not queued or waits for nothing. */
    waiting_step?: { id: string; title: string; kind: WorkflowStep['kind']['type'] };
    /**
     * The step runs of the task's current generation, retired ones left out, oldest first; times are
     * epoch milliseconds. Absent without a run.
     */
    step_runs?: {
      id: string;
      slot: StepRun['slot'];
      step_id: string;
      title: string;
      kind: WorkflowStep['kind']['type'];
      state: Exclude<StepRun['state'], 'retired'>;
      reason?: string;
      /** The session the run belongs to; absent on a run of the task before it has one. */
      session_id?: string;
      created_at: number;
      /** Absent until the run passed or failed. */
      finished_at?: number;
      /** On a review step that started its review: each reviewer runtime and the verdict it handed in, if any. */
      reviewers?: { runtime: string; verdict?: 'pass' | 'fail'; summary?: string }[];
    }[];
    dispatch_wait?:
      | 'upstream'
      | 'scope'
      | 'plan_review'
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
    /**
     * Plan ids of the tasks the plan makes it wait for, the ones the range leaves out of `tasks`
     * included. Absent on rows of sessions not opened from a task.
     */
    depends_on?: string[];
    /** The routing the plan wrote; a field the plan left out is absent. Absent on rows of sessions not opened from a task. */
    planned?: {
      runtime?: string;
      model?: string;
      effort?: EffortLevel;
      kind?: TaskKind;
      route_reason?: string;
      priority?: 'high' | 'normal' | 'low';
      device?: string;
      device_reason?: string;
      needs?: string[];
      uses?: Record<string, number>;
    };
    /**
     * The newest session not discarded of the task's current generation; absent without one. model:
     * the one the runtime reported, else the one requested, else null; effort: absent when none was requested.
     */
    claim?: { session_id: string; runtime: string; model: string | null; effort?: EffortLevel };
    /** True while a pending user edit names the task. Absent on rows of sessions not opened from a task. */
    pending_edit?: boolean;
    /** The task's newest retrospective; absent before one is recorded. */
    retrospective?: {
      /** The retrospective record's id. Always set by the daemon. */
      id?: string;
      outcome: Retrospective['outcome'];
      /** Unix epoch milliseconds. Always set by the daemon. */
      recorded_at?: number;
      runtime_findings?: number;
      /** Absent when no gate run passed. */
      gate_passed_on_attempt?: number;
      /** Times the task was handed back. */
      handbacks: number;
      /** Absent when the record has no count. */
      lead_wakes?: number;
      /** Input plus output tokens of the task sessions; absent when the task had no session. */
      tokens?: number;
      /** The recorded ratio to the task's budget; absent when its cell has none. */
      budget_ratio?: number;
    };
  } & BoardTaskExtras)[];
  /** Each lead session that wrote a plan. */
  leads?: {
    session_id: string;
    title: string;
    state: 'running' | 'idle' | 'waiting' | 'failed' | 'closed';
    context?: { used_tokens: number; window_tokens: number };
    /** Unread notes. */
    inbox: number;
    /** The line the lead session last set in its newest turn; `at` is epoch milliseconds. */
    status_line?: { text: string; at: number };
    messages_today?: {
      session_id: string;
      lead: number;
      tracker: number;
      handbacks: number;
      subagents?: number;
      reviews?: number;
      gates?: number;
      in_flight?: ('lead' | 'subagent' | 'review' | 'gate')[];
    }[];
    /** Today's handbacks and model changes, oldest first, keeping the newest 200. */
    events_today?: { at: number; kind: 'handback' | 'model_change'; session_id: string }[];
    waiting?: BoardWaiting;
    /** When the plan last changed, epoch milliseconds. */
    updated_at: number;
    /** The plan's content version, which an edit names as its base; always set by the daemon. */
    plan_version?: number;
    /**
     * The plan's assumptions in plan order; id is absent on assumptions written without one. affects:
     * board task ids; milestone: the board id of its milestone. Always set by the daemon.
     */
    assumptions?: { id?: string; text: string; affects: string[]; milestone?: string }[];
    /**
     * User edits waiting for the lead, oldest first; empty when none waits, and an edit leaves once the
     * lead applies or rejects it. summary: each op's type and target task id. Always set by the daemon.
     */
    pending_edits?: {
      id: string;
      task_ids: string[];
      summary: string;
      state: 'pending';
      /** The edit's ops as the user sent them; the old values are the task's current ones. Always set by the daemon. */
      ops?: PendingPlanEdit['ops'];
      /** The plan version the edit was made against. Always set by the daemon. */
      base_version?: number;
      /** Epoch milliseconds. Always set by the daemon. */
      created_at?: number;
      /** The assumptions the edit says are wrong, with the user's words; absent when it refutes none. */
      refutes?: PendingPlanEdit['refutes'];
    }[];
    /** Lead proposals waiting for the user; always set by the daemon. */
    pending_proposals?: PlanProposalView[];
    recent_edits?: {
      id: string;
      created_at: number;
      plan_written_at: number | null;
      lead_read_at: number | null;
      sessions_notified_at: number | null;
    }[];
    /**
     * User edits the lead rejected that no later user edit of any of their tasks followed, the 20
     * newest first; empty when there are none. Always set by the daemon.
     */
    rejected_edits?: {
      id: string;
      task_ids: string[];
      ops: PendingPlanEdit['ops'];
      /** Absent when the lead gave none. */
      reason?: string;
      /** Epoch milliseconds. */
      resolved_at: number;
    }[];
    /** What the lead session is doing now; absent when the lead is not in the project's session list. */
    activity?: BoardActivity;
  }[];
  /**
   * The project's task places: used, the task sessions holding one as dispatch counts them; limit,
   * the workflow policy's max_parallel. Always set by the daemon.
   */
  task_places?: { used: number; limit: number };
  /** The project's needs-you items in the order of needs_you.list. */
  needs?: (NeedsYouItem & {
    /** The plan task the item's session was opened from. */
    task_id?: string;
    /** The item's blocks. */
    unblocks: number;
  })[];
  edges: {
    from: string;
    to: string;
    state: 'met' | 'pending' | 'active';
  }[];
  /**
   * Dependencies between two plan tasks that only a pending lead proposal adds, with the state the
   * edge would have; always set by the daemon.
   */
  proposed_edges?: BoardModel['edges'];
  milestones: ({
    id: string;
    title: string;
    /** The required workbench sessions. */
    session_ids: string[];
    /** How many of session_ids are merged. */
    merged: number;
    status: 'active' | 'ready_for_acceptance' | 'completed' | 'stale';
    /** accepted while the milestone is completed and its acceptance checked that criterion or covered the whole milestone. */
    criteria: { text: string; accepted: boolean }[];
    /** Only on milestones a lead wrote. */
    owner_session_id?: string;
    /** Only on milestones a lead wrote. */
    tasks?: { done: number; total: number };
    /** Calendar day; only on lead milestones that have one. */
    due_on?: string;
  } & BoardMilestoneExtras)[];
  /** The project's active goals by order; progress only. */
  goals: {
    id: string;
    text: string;
    order: number;
    revision: number;
    milestone_ids: string[];
    milestones: { done: number; ready: number; total: number };
    tasks: { done: number; total: number };
    /** Items of needs on a task of one of its milestones or on one of its milestones. */
    needs: number;
  }[];
  burnup: { day: string; scope: number; done: number }[];
  /** Lead plan tasks, each counted once however many sessions it had; a task is done once a session merged. */
  task_progress: {
    /** Every task of the current lead plans, outside the range too, by the state of its newest session. */
    totals: {
      done: number;
      running: number;
      waiting: number;
      idle: number;
      ready: number;
      failed: number;
      discarded: number;
      not_started: number;
    };
    /**
     * Each day of the range. scope is the plan's task count at the end of the day, added and removed
     * the change against the end of the day before; null where the stored plan history does not reach.
     */
    daily: {
      day: string;
      scope: number | null;
      /** Tasks of the plan at the end of the day that had merged by then; of any plan where scope is null. */
      done: number;
      added: number | null;
      removed: number | null;
    }[];
    /** From a task's first session opened to its first merge, over current plan tasks merged within the range. */
    cycle: {
      median_ms: number | null;
      p90_ms: number | null;
      sample_count: number;
      /** Cycles up to upper_ms and above the bucket before; null bounds the last bucket. */
      buckets: { upper_ms: number | null; count: number }[];
    };
  };
  usage: {
    day: string;
    runtime: string;
    model: string | null;
    tokens: number;
    cost_usd: number | null;
    /** Sessions with an ended turn that day on this runtime and model that reported no tokens; absent: 0. */
    sessions_without_usage?: number;
  }[];
  /** Models in first-seen order per runtime; fixes the solid and hatched fills. */
  models: { runtime: string; model: string | null; first_seen: number }[];
  merges: {
    session_id: string;
    title: string;
    merged_at: number;
    /** The source branch head the session's commits were merged onto; null when not recorded. */
    from_sha: string | null;
    sha: string;
    additions: number;
    deletions: number;
    story_id: string | null;
  }[];
  findings: {
    id: string;
    review_id: string;
    /** review.finding.resolve expects this revision. */
    review_revision: number;
    severity: 'blocker' | 'major' | 'minor';
    text: string;
    path: string | null;
    line: number | null;
    reviewer: string;
    session_id: string;
    state: 'open' | 'adopted' | 'dismissed';
  }[];
  risks: { text: string; kind: 'risk' | 'assumption' }[];
}
/** GET /v1/project.intro.read; the saved introduction and current writing session. */
export interface ProjectIntroRead {
  intro: ProjectIntro | null;
  behind: number | null;
  writing_session_id: string | null;
}

/** GET /v1/project.facts.read; each workstream's items counted in the newest facts snapshot. */
export interface ProjectFactsRead {
  facts: ProjectFacts | null;
  collected_at: number | null;
  /** Every project folder holds no code yet, as a baseline start judges it now. */
  empty: boolean;
  workstreams: (Pick<
    BaselineWorkstream,
    'id' | 'title' | 'status' | 'modules' | 'depends_on' | 'risks'
  > &
    Partial<Pick<BaselineWorkstream, 'next' | 'blockers'>> & {
      done: number;
      open: number;
      /** Items whose text is no longer found in the folder's checklists. */
      missing: number;
    })[];
}
export interface FilesReadResult {
  path: string;
  text?: string;
  binary?: true;
  /** An image or PDF by its extension; past the preview limit it comes without data and truncated. */
  mime?: string;
  /** The whole image or PDF, base64. */
  data?: string;
  size: number;
  truncated: boolean;
}
export interface SessionToolImage {
  mime: string;
  /** The whole image, base64. */
  data: string;
  size: number;
}
export interface SymbolsSearchResult {
  symbols: { name: string; kind: string; path: string; line: number }[];
}
/** GET /v1/session.diff; the worktree's committed, uncommitted and untracked changes. */
export interface SessionDiff {
  session_id: string;
  base_sha: string;
  head_sha: string;
  files: {
    path: string;
    additions: number | null;
    deletions: number | null;
    untracked: boolean;
  }[];
  /** null when the patch exceeds its output bound; files are still listed. */
  patch: string | null;
  truncated: boolean;
}
/**
 * GET /v1/session.turn_diff; what changed from the turn's checkpoint to the next turn's, or to the
 * worktree for the last turn. Fields mean what they mean in SessionDiff.
 */
export interface SessionTurnDiff {
  session_id: string;
  turn_id: string;
  files: SessionDiff['files'];
  patch: string | null;
  truncated: boolean;
}
/** GET /v1/session.tasks; cursor is the newest event sequence when the tasks were read. */
export interface SessionTasks {
  cursor: number;
  tasks: SessionTask[];
}
/** GET /v1/session.gates; the newest project gate result recorded for the session. */
export interface SessionGates {
  /** The project folder the worktree came from has gate commands. */
  configured: boolean;
  /** Names of the commands a run checks, in order; absent without any. */
  commands?: string[];
  /** A session.gates.run is still checking. */
  running: boolean;
  /** The latest explicit gate operation; merge gates have their own merge lifecycle. */
  operation?: {
    id: string;
    state: 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
    error?: string;
  };
  last: {
    commit: string;
    /** Epoch milliseconds. */
    checked_at: number;
    results: {
      name: string;
      exit_code: number | null;
      timed_out: boolean;
      output_tail: string;
      state?: 'passed' | 'failed' | 'skipped';
      reason?: string;
      tests?: TestCounts;
      carried?: boolean;
    }[];
  } | null;
}
export interface SessionGateRunResult {
  state?: 'passed' | 'failed' | 'skipped';
  reason?: string;
  name: string;
  command: string[];
  exit_code?: number | null;
  timed_out?: boolean;
  duration_ms?: number;
  skipped?: boolean;
  tests?: TestCounts;
  carried?: boolean;
}
export interface SessionGateRun {
  run_id: string;
  commit: string;
  /** ISO time; without a gate_started event, the check time minus the summed command durations. */
  started_at: string;
  /** ISO time of the session.gate_checked event. */
  finished_at: string;
  results: SessionGateRunResult[];
}
/** GET /v1/session.gates.history; the session's recorded gate runs, newest first. */
export interface SessionGatesHistory {
  runs: SessionGateRun[];
}
/** GET /v1/project.gates.history; recorded gate runs across the project's worktree sessions, newest first. */
export interface ProjectGatesHistory {
  runs: (SessionGateRun & { session_id: string; session_title: string })[];
}
/** GET /v1/project.timeline; event-derived state intervals of the project's worktree sessions. */
export interface ProjectTimeline {
  /** ISO time of the window's start; defaults to seven days before the query time. */
  from: string;
  /** ISO time at which the query was made. */
  to: string;
  /** Sessions with an event at or after from, ordered by their first event. */
  sessions: {
    session_id: string;
    title: string;
    runtime: string;
    /** Contiguous intervals, oldest first; a terminal outcome is a zero-duration final interval. */
    intervals: {
      state:
        | 'starting'
        | 'queued'
        | 'running'
        | 'waiting'
        | 'ready'
        | 'idle'
        | 'merging'
        | 'merged'
        | 'discarded'
        | 'failed';
      /** ISO time of the interval's start, clipped to the window's start. */
      from: string;
      /** ISO time of the interval's end; null only for the last interval of an ongoing session. */
      to: string | null;
    }[];
  }[];
}
/** Totals over a set of trace lanes. */
export interface TraceStats {
  sessions: number;
  turns: number;
  llm: number;
  /** Spans of kind tool or subagent. */
  tool: number;
  /** Spans with status error, turns included. */
  error: number;
  /** A turn's own tokens, else the sum of its model calls. */
  tokens: { input: number; output: number; cache_read?: number };
  /** Turns with no tokens of their own or from their model calls, so tokens is a known part only; absent at zero. */
  turns_without_usage?: number;
  /** Tool and subagent durations in ms; absent without timed calls. Median averages the middle pair; p95 uses nearest rank. */
  tool_duration_p50_ms?: number;
  tool_duration_p95_ms?: number;
  /** Length of the union of turn intervals in the window, ms; an open turn ends at to. */
  active_ms: number;
  /**
   * Spans in the window whose Bash output in a native transcript names a commit; the web counts
   * commits from project.heatmap instead.
   */
  commits: number;
}
/** A trace lane with its listed title, which baseline_started_at names as on WorkbenchSession. */
export type TitledTraceLane = TraceLane & { title: string; baseline_started_at?: number };
/** GET /v1/project.trace; one lane per session with its turns as colored bars, without steps. */
export interface ProjectTrace {
  /** Changes when the native transcript cache was rebuilt; null without a cache. */
  epoch: string | null;
  /** ISO window start; defaults to seven days before to. */
  from: string;
  /** ISO window end; defaults to the query time. */
  to: string;
  /** null without a cache; the query returns what was indexed within its budget. */
  indexing: { done_files: number; total_files: number } | null;
  stats: TraceStats;
  diagnostics?: RuntimeDiagnostics;
  reflection_leads?: { id: string; title: string }[];
  reflection_runtimes?: string[];
  runtime_reviews?: RuntimeReviewHistory[];
  /** Lanes with a turn in the window, ordered by their first such turn. */
  lanes: {
    lane: TitledTraceLane;
    stats: TraceStats;
    /** The lane's turns that intersect the window, oldest first. */
    turns: {
      id: string;
      start: number | null;
      end: number | null;
      status: TraceSpan['status'];
      tokens?: TraceSpan['tokens'];
      cost_usd?: number;
      /** Parts of the turn in time order, each the highest priority active then: error > subagent > llm > tool > wait. */
      segments: {
        from: number;
        to: number;
        kind: 'error' | 'subagent' | 'llm' | 'tool' | 'wait';
      }[];
    }[];
  }[];
  /** From from, one bucket per bucket_ms, at most 2000; each span counts in the bucket of its start. */
  buckets: { at: number; llm: number; tool: number; error: number }[];
}
/** GET /v1/session.trace; a lane's merged spans, or one turn's spans and the turn itself. */
export interface SessionTrace {
  lane: TitledTraceLane;
  spans: TraceSpan[];
}

/** GET /v1/session.step_diff; recorded tool input only, independent of today's files. */
export interface SessionStepDiff {
  session_id: string;
  turn_id: string;
  span_id: string;
  files: { path: string; patch: string | null; truncated: boolean }[];
}

/** GET /v1/project.collab; inclusive epoch-ms range, except in_flight which is current. */
export interface ProjectCollab {
  messages: {
    sender: string;
    receiver: string;
    direction: 'lead_to_worker' | 'worker_to_lead';
    count: number;
  }[];
  in_flight: { sender: string; receiver: string; sent_at: number }[];
  subagents: {
    session_id: string;
    span_id: string;
    name: string;
    start: number;
    duration_ms?: number;
    status: TraceSpan['status'];
  }[];
  model_changes: {
    session_id: string;
    at: number;
    /** Absent when no earlier model record survives; null selects the runtime default. */
    before?: string | null;
    after: string | null;
  }[];
}

/** Tool inputs are outside data even after their event envelope has been recorded. */
export const editToolInputSchemas = {
  Edit: z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    truncated: z.boolean().optional(),
  }),
  MultiEdit: z.object({
    file_path: z.string(),
    edits: z.array(z.object({ old_string: z.string(), new_string: z.string() })),
    truncated: z.boolean().optional(),
  }),
  Write: z.object({
    file_path: z.string(),
    content: z.string(),
    truncated: z.boolean().optional(),
  }),
  fileChange: z.object({
    changes: z.array(z.object({ path: z.string(), diff: z.string() })),
    truncated: z.boolean().optional(),
  }),
  file_change: z.object({
    changes: z.record(
      z.string(),
      z.object({ unified_diff: z.string(), move_path: z.string().nullable().optional() }),
    ),
  }),
  apply_patch: z.union([
    z.string(),
    z.object({ value: z.string(), truncated: z.boolean().optional() }),
  ]),
};

/** GET /v1/tool.calls; newest tool and subagent calls across the project's trace lanes. */
export interface ToolCall {
  /** External sessions use their native trace lane key. */
  session_id: string;
  session_title: string;
  turn_id: string;
  span_id: string;
  tool_name: string;
  input_summary?: string;
  start: number | null;
  duration_ms?: number;
  status: TraceSpan['status'];
  exit_code?: number;
  retry_count?: number;
}

/** GET /v1/project.trace.stats; calls and turns starting in the inclusive epoch-ms window. */
export interface ProjectTraceStats {
  /** Percentiles require at least five completed, timed samples. Median averages the middle pair; p95 uses nearest rank. */
  turn_duration_p50_ms?: number;
  turn_duration_p95_ms?: number;
  tool_duration_p50_ms?: number;
  tool_duration_p95_ms?: number;
  /** Cache reads / input tokens, using only turns that report cache reads; absent with no such input. */
  cache_read_share?: number;
  failed_tool_calls: number;
}
/** GET /v1/project.heatmap; spans and commits per lane and local day. */
export interface ProjectHeatmap {
  /** Local dates YYYY-MM-DD, oldest first, ending today. */
  days: string[];
  /** Lanes with a span in these days; one cell per day. */
  lanes: {
    key: string;
    title: string;
    baseline_started_at?: number;
    cells: {
      day: string;
      llm: number;
      tool: number;
      error: number;
      /** Input plus output tokens. */
      tokens: number;
      /** Commits attributed to the lane. */
      commits: number;
    }[];
  }[];
  /** The project's calls per local hour, one entry per day in days order. */
  hours: {
    day: string;
    /** 24 counts of model plus tool calls, index = local hour. */
    calls: number[];
    /** 24 counts of failed spans, index = local hour. */
    errors: number[];
  }[];
  /** Commits of the project's repositories in these days, oldest first. */
  commits: {
    sha: string;
    /** Commit time, epoch ms. */
    at: number;
    day: string;
    /** null when no session is known to have made it. */
    lane_key: string | null;
    via: 'merge' | 'bash_output' | null;
    added: number;
    removed: number;
    subject: string;
  }[];
  /** Merges recorded in these days, oldest first; id is the merge event's, so one session's merges stay apart. */
  merges: { id: string; session_id: string; at: number; day: string }[];
}
/** GET /v1/session.preflight; the current merge destination, changes and admission checks. */
export interface SessionPreflight {
  /** Open user diff comments; absent at zero and does not block merging. */
  open_comments?: number;
  /** null when the source repository has a detached HEAD. */
  target_branch: string | null;
  source_root: string;
  commit_count: number;
  files_changed: number;
  worktree_clean: boolean;
  source_clean: boolean;
  conflicts: { state: 'none' | 'conflicts' | 'unknown'; files?: string[] };
  gate: {
    /** All configured commands, including those skipped after the first failure. */
    configured_total: number;
    last: 'none' | 'passed' | 'failed' | 'stale';
  };
  can_merge: boolean;
  blocked_reason?: string;
}
/** GET /v1/session.activity; tool completion counts in 5-minute buckets of the last hour. */
export interface SessionActivity {
  bucket_ms: 300000;
  /** ISO time of the start of the first bucket. */
  from: string;
  /** 12 buckets, oldest first; the last bucket ends at the query time. */
  tools_completed: number[];
}
/**
 * What a task timeline entry records: lead_message is a task.messaged turn, report a
 * task.reported note, handback a turn the tracker queued on a task session, gate_passed and
 * gate_failed a session.gate_checked run, merge_blocked a blocked, skipped or cancelled merge,
 * user_edit a user's plan edit note, merge_retried a merge started again after a user's gate
 * run passed.
 */
export type TaskTraceKind =
  | 'start_requested'
  | 'dispatched'
  | 'lead_message'
  | 'report'
  | 'handback'
  | 'accepted'
  | 'gate_passed'
  | 'gate_failed'
  | 'merge_started'
  | 'merge_retried'
  | 'merge_blocked'
  | 'merged'
  | 'discarded'
  | 'user_edit';
/** GET /v1/task.trace returns these in event order; text is cut at 2000 characters. */
export interface TaskTraceEntry {
  /** Unix epoch milliseconds. */
  at: number;
  kind: TaskTraceKind;
  session_id?: string;
  text?: string;
}
/** GET /v1/project.defaults: one entry per setting, the projects with their own value in project order. */
export type ProjectSettingOverview = {
  [K in ProjectSettingKey]: {
    key: K;
    /** Absent when the user set no global value. */
    global?: ProjectSettingValues[K];
    /** Absent when there is none, as for session defaults. */
    builtin?: ProjectSettingValues[K];
    /** A project's workflow_policy value holds only the settings it sets itself. */
    overrides: { project_id: string; name: string; value: ProjectSettingValues[K] }[];
  };
}[ProjectSettingKey];
export interface ProjectDefaultsRead {
  settings: ProjectSettingOverview[];
  /** Each project that is not removed, with how many of the settings it sets itself. */
  projects: { project_id: string; name: string; overridden: number }[];
  /** The global permission rules, oldest first. */
  permission_rules: { rule: string; added_at: number }[];
}
/** GET /v1/workflow.policy includes the settings a new project starts with. */
export interface WorkflowPolicyView extends WorkflowPolicy {
  defaults: Omit<WorkflowPolicy, 'id' | 'revision' | 'project_id' | 'policy_version'>;
}
export const command = (
  actor: string,
  type: CommandType,
  input: Record<string, unknown>,
  expected_revision: number | null = null,
  idempotency_key: string = crypto.randomUUID(),
): Command => ({
  protocol_version: PROTOCOL_VERSION,
  command_id: crypto.randomUUID(),
  idempotency_key,
  actor,
  expected_revision,
  type,
  input,
});

/** GET /v1/permission.rules; newest first, with titles of sessions that still exist. */
export interface ProjectPermissionRule {
  rule: string;
  session_id: string;
  session_title?: string;
  added_at: number;
}

/** GET /v1/project.branches; local branches, newest commit first, at most 200. */
export interface ProjectBranch {
  name: string;
  sha: string;
  /** Unix milliseconds. */
  commit_time: number;
  checked_out: boolean;
}

/** GET /v1/workspace.stale; size is absent until the background measurement completes. */
export interface StaleWorkspaces {
  count: number;
  size_bytes?: number;
  /** Existing linked worktrees, absent without one; unmeasured worktrees contribute no bytes. */
  worktree_disk?: { count: number; size_bytes: number; unmeasured: number };
  /** Paths changed by multiple unfinished sessions, at most fifty; absent until computed. */
  shared_files?: { files: { path: string; session_ids: string[] }[]; total: number };
  /** Managed worktree folder; absent when the daemon has none configured. */
  worktree_root?: string;
}
