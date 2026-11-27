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
import { reviewerTools, workflowInputSchemas } from './workflow-tools.js';
import type {
  GraphColor,
  GraphIcon,
  GraphStatus,
  EffortLevel,
  McpServerStatus,
  Approval,
  LandingRecord,
  SignalIssue,
  NeedsYouItem,
  PermissionMode,
  PlanItem,
  ProjectFacts,
  ProjectIntro,
  ProjectPlan,
  ProposableSettingCommand,
  QuotaWindow,
  CapabilityReport,
  Review,
  RuntimeStatus as PreflightRuntimeStatus,
  Session,
  SessionRecap,
  SessionRole,
  RoleUsage,
  SessionTask,
  TestCounts,
  RuntimeDiagnostics,
  RuntimeReviewHistory,
  SettingProposal,
  TraceLane,
  TraceSpan,
  WorkflowPolicy,
} from '@pantheon/domain';
export type {
  GraphColor,
  GraphIcon,
  GraphStatus,
  ApprovalQuestion,
  EffortLevel,
  Principal,
  PermissionMode,
  RuntimeModel,
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
  /** Enabled ACP-profile runtimes only: whether the ACP initialize of the last check answered. */
  handshake?: boolean;
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

// Lives here, not in domain: the web bundle imports protocol at run time, and domain imports node:crypto.
export function sessionRole(
  session: Pick<
    Session,
    'review_id' | 'baseline' | 'change_story' | 'range_story' | 'spawned_by' | 'conductor'
  >,
): SessionRole {
  if (session.review_id) return 'reviewer';
  if (session.baseline) return 'baseline';
  if (session.change_story || session.range_story) return 'story';
  if (session.conductor) return 'conductor';
  if (session.spawned_by) return 'spawned';
  return 'user';
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
  conductor: {
    request_review: 'conductor.review',
    report_ready: 'conductor.ready',
    spawn_session: 'conductor.spawn',
    read_state: 'conductor.state',
    message_session: 'conductor.message',
    stop_session: 'conductor.stop',
    read_needs_you: 'conductor.needs_you',
    answer_request: 'conductor.answer',
    propose_setting: 'conductor.propose_setting',
    write_plan: 'conductor.plan_set',
    project_read: 'project.read',
    ...memoryTools,
    draw: 'visual.draw',
  },
} as const;

/** Extra tools exist only for daemon-created, purpose-bound project sessions. */
export const coordinationTools = {
  trace_evidence: 'trace.evidence',
  trace_report: 'trace.report',
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
/** The commands whose change a main agent may propose for the user to approve. */
export const PROPOSABLE_SETTING_COMMANDS = [
  'project.gate.set',
  'workflow.policy.set',
  'project.sessionDefaults.set',
  'project.extensions.set',
] as const satisfies readonly ProposableSettingCommand[];
export const USER_PRINCIPAL_ID = 'local-user';
const str = z.string().min(1).max(65536);
const repoRef = str.refine((ref) => !ref.startsWith('-'), 'Revision must not start with -');
export const repoPath = str.refine(
  (path) => !path.startsWith('/') && !path.split('/').includes('..'),
  'Path must be relative to the project folder and must not contain ..',
);
// Git lists index entries with canonical relative names, including when a caller sends ./file.
const repoWritePath = repoPath
  .transform((file) =>
    file
      .split('/')
      .filter((part) => part && part !== '.')
      .join('/'),
  )
  .pipe(z.string().min(1));
const findingText = str.refine((value) => value.trim().length > 0);
const strings = z.array(str).max(256);
/** The reason a main agent gives for a session action it takes for the user. */
const actionReason = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe('Why you decide this; the user reads it under "Decided for you".');
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
/** The default number of spawned sessions that can take a turn in a project. */
export const SPAWNED_SESSION_LIMIT = 4;
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
const planTitle = z.string().min(1).max(80);
const planId = z.string().min(1).max(80);
const runtimeChoice = z.strictObject({
  runtime: str,
  model: str.optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});
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
/** `file:` sources inside a folder block are relative to that folder's root. */
const baselineFolderSchema = z.strictObject({
  root: str,
  // The model writes no numbers, so a gate timeout comes only from the user.
  gate: z.array(gateCommand.omit({ timeout_ms: true }).extend({ sources })),
  setup: z.strictObject({ argv, sources }).optional(),
});
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
});
/** A device as a configuration file may still hold it; labels, resources and max_sessions are not read. */
const storedDeviceConfigSchema = deviceConfigSchema.extend({
  labels: z.unknown().optional(),
  resources: z.unknown().optional(),
  max_sessions: z.unknown().optional(),
});
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
const spawnLimit = z.number().int().min(1).max(16);
const taskKind = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9-]+$/);
const kindRoutes = z
  .array(
    runtimeChoice.extend({
      kind: taskKind,
      fallbacks: z.array(runtimeChoice).max(3).optional(),
    }),
  )
  .max(12)
  .refine(
    (routes) => new Set(routes.map((route) => route.kind)).size === routes.length,
    'Name each kind once',
  );
/** Workflow policy settings as a policy stores them; the project budget belongs to each project alone. */
const workflowPolicySettings = z.strictObject({
  gate_on_fail: z.enum(['retry', 'stop']).optional(),
  gate_runner: z.enum(['daemon', 'session']).optional(),
  max_spawned: spawnLimit.optional(),
  runtime_parallel: z.record(str, spawnLimit).optional(),
  task_size: z.enum(['small', 'medium', 'large']).optional(),
  verify_timing: z.enum(['each_session', 'before_landing']).optional(),
  kind_routes: kindRoutes.optional(),
});
export const workflowPolicyParams = workflowPolicySettings.keyof().options;
/** Global workflow settings a configuration file may still hold; not read. */
export const RETIRED_POLICY_SETTINGS = [
  'improvement_mode',
  'plan_changes',
  'charter',
  'must_ask_extra',
  'urgent_direct',
  'path',
  'acceptance_wake',
  'max_parallel',
  'max_parallel_limit',
  'dispatch_paused',
  'handback_limit',
  'task_size_hint',
  'budget',
  'runtime_quota_threshold',
  'pinned',
] as const;
/** A stored `handback` reads as `stop`. */
const storedWorkflowPolicySettings = workflowPolicySettings
  .extend({ gate_on_fail: z.enum(['handback', 'retry', 'stop']).optional() })
  .extend(
    Object.fromEntries(
      RETIRED_POLICY_SETTINGS.map((key) => [key, z.unknown().optional()]),
    ) as Record<(typeof RETIRED_POLICY_SETTINGS)[number], z.ZodOptional<z.ZodUnknown>>,
  );
/** The project settings that have a global value; each is stored under the same key on a project. */
export const PROJECT_SETTING_KEYS = ['workflow_policy', 'session_defaults'] as const;
export type ProjectSettingKey = (typeof PROJECT_SETTING_KEYS)[number];
const projectSettingValues = {
  workflow_policy: workflowPolicySettings,
  session_defaults: z.strictObject(sessionDefaults),
};
export type ProjectSettingValues = {
  [K in ProjectSettingKey]: z.infer<(typeof projectSettingValues)[K]>;
};
const decisionKinds = {
  question: true,
  permission: true,
  budget: true,
  other: true,
} satisfies Record<NeedsYouItem['decision'], true>;
/** Every `NeedsYouItem.decision`. */
export const NEEDS_YOU_DECISIONS = Object.keys(decisionKinds) as NeedsYouItem['decision'][];
/** A kind the attention delivery rules name: a decision, or a notice that asks for none. */
export type AttentionKind = NeedsYouItem['decision'] | 'merged';
/** The keys of the attention delivery rules: the decisions, then the notices that ask for none. */
export const ATTENTION_KINDS: readonly AttentionKind[] = [...NEEDS_YOU_DECISIONS, 'merged'];
export type AttentionDelivery = 'now' | 'brief' | 'never';
const BRIEF_BY_DEFAULT: readonly AttentionKind[] = ['merged'];
/** How each kind reaches the user until the user chooses: merges wait for the brief. */
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
/** Retired kinds' stored rules are accepted and not read. */
const storedAttentionDelivery = z.partialRecord(
  z.enum([
    ...ATTENTION_KINDS,
    'agent_proposal',
    'plan_change',
    'milestone_accept',
    'external',
    'repeated_failure',
    'improvement',
  ]),
  z.enum(['now', 'brief', 'never']),
);
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const quietHours = z.strictObject({ from: clockTime, to: clockTime });
const residentInstructions = z.string().max(4000);
const routineFields = {
  id: str.optional(),
  name: z.string().regex(/\S/),
  prompt: z.string().regex(/\S/),
  // Equal ends would be a window no time falls in.
  active_hours: quietHours
    .refine((h) => h.from !== h.to, 'Active hours must not start where they end')
    .optional(),
  enabled: z.boolean(),
  precheck: z
    .strictObject({
      argv: z.array(z.string()).min(1),
      timeout_seconds: z.number().int().min(1).max(3600).optional(),
    })
    .optional(),
};
const routineInput = z.union([
  z.strictObject({ ...routineFields, every_minutes: z.number().int().min(5) }),
  z.strictObject({ ...routineFields, at: clockTime }),
]);
const routineRef = z.strictObject({ project_id: str, routine_id: str });
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
    /** Retired; a stored value is accepted and ignored. */
    baseline_rounds: z.number().optional(),
    /** Retired; a stored value is accepted and ignored. */
    baseline_visuals: z.boolean().optional(),
    /** Retired; a stored value is accepted and ignored. */
    baseline_range_story: z.boolean().optional(),
    /** Not read. */
    personal_answers: z.array(str).optional(),
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
    devices: z.record(deviceId, storedDeviceConfigSchema).optional(),
    /** Not read. */
    local_device: z.unknown().optional(),
    /** What every project follows where it has no value of its own. */
    project_defaults: z
      .strictObject({
        workflow_policy: storedWorkflowPolicySettings.optional(),
        session_defaults: projectSettingValues.session_defaults.optional(),
        /** Not read. */
        usage_targets: z.unknown().optional(),
        /** Not read. */
        external_events: z.unknown().optional(),
        /** Not read. */
        auto_merge: z.boolean().optional(),
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

const timezone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, 'timezone must be an IANA time zone, such as Asia/Shanghai');

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
      timezone: timezone
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
  ...workflowInputSchemas,
  /** Restores tracked files in the index and the worktree to HEAD and deletes untracked ones; returns { undo_id }. */
  'repo.discard': z.strictObject({ project_id: str, paths: z.array(repoWritePath).min(1) }),
  /** Applies patch, taken from repo.working_diff, in reverse to the worktree; returns { undo_id }. */
  'repo.discard_patch': z.strictObject({ project_id: str, patch: z.string().min(1) }),
  /** Writes back what a discard within the last 10 minutes changed; returns {}. */
  'repo.discard_undo': z.strictObject({ project_id: str, undo_id: str }),
  /** Commits only paths with the user's own git identity, configuration and hooks; returns { sha }. */
  'repo.commit': z.strictObject({
    project_id: str,
    paths: z.array(repoWritePath).min(1),
    message: z.string().max(10000).regex(/\S/, 'Enter a commit message'),
  }),
  /** Pushes the checked-out branch to its upstream, or to origin setting it as the upstream, never forced; returns {}. */
  'repo.push': z.strictObject({ project_id: str }),
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
  /** Removes the project's own workflow policy values, so it follows the global ones; the user only. */
  'workflow.policy.reset': z.strictObject({ project_id: str }),
  /** Changes the given workflow policy parameters of a project; the user only. */
  'workflow.policy.set': z.strictObject({
    project_id: str,
    gate_on_fail: workflowPolicySettings.shape.gate_on_fail.nullable(),
    gate_runner: workflowPolicySettings.shape.gate_runner.nullable(),
    max_spawned: workflowPolicySettings.shape.max_spawned.nullable(),
    runtime_parallel: workflowPolicySettings.shape.runtime_parallel.nullable(),
    task_size: workflowPolicySettings.shape.task_size.nullable(),
    verify_timing: workflowPolicySettings.shape.verify_timing.nullable(),
    kind_routes: workflowPolicySettings.shape.kind_routes.nullable(),
    /** The project's input token budget; a first one counts from now, null clears it. */
    project_budget: z
      .strictObject({ input_tokens: z.number().int().positive() })
      .nullable()
      .optional(),
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
  'project.baseline.submit': z.strictObject({
    baseline_id: str,
    folders: z.array(baselineFolderSchema).min(1).max(256),
  }),
  'project.facts.refresh': z.strictObject({ project_id: str }),
  'project.baseline.confirm': z.strictObject({
    baseline_id: str,
    gates: z
      .array(z.strictObject({ root: str, commands: z.array(gateCommand) }))
      .max(256)
      .optional(),
  }),
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
    protected_paths: strings
      .optional()
      .describe(
        'Optional: repository paths or globs a landing may change only when the user allows it, besides the files the gate argv names; absent keeps the current list.',
      ),
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
    allow_gate_change: z
      .boolean()
      .optional()
      .describe('Optional: true lands a branch that changes protected paths.'),
  }),
  /** The user only; stops a queued or running landing, which ends blocked with the reason `cancelled`, and returns the Landing. */
  'project.landing.cancel': z.strictObject({ landing_id: str }),
  'project.resident.set': z.strictObject({ project_id: str, session_id: str.nullable() }),
  'project.resident.instructions.set': z.strictObject({
    project_id: str,
    instructions: residentInstructions,
  }),
  'project.routine.save': z.strictObject({ project_id: str, routine: routineInput }),
  'project.routine.remove': routineRef,
  'project.routine.run': routineRef,
  'project.signal.resolve': z.strictObject({ project_id: str, issue_id: str }),
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
  'project.sessionDefaults.set': z.strictObject({ project_id: str, ...sessionDefaults }),
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
  ]),
  /** Removes a global value, so projects without their own follow the built-in default; the user only. */
  'project.defaults.clear': z.strictObject({ key: z.enum(PROJECT_SETTING_KEYS) }),
  /** Removes the project's own value, so it follows the global one; the revision is the workflow policy's for workflow_policy, the project's otherwise. param names the one workflow setting to remove. */
  'project.override.clear': z.strictObject({
    project_id: str,
    key: z.enum(PROJECT_SETTING_KEYS),
    param: workflowPolicySettings.keyof().optional(),
  }),
  /** {project_id, at}; moves the caller's seen cursor of the project to at, now by default. project.brief lists what happened after it. */
  'project.seen': z.strictObject({ project_id: str, at: z.number().int().min(0).optional() }),
  /** The user only; asks the side model for the paragraph of the caller's project.brief, at most once per brief, and returns {started}. */
  'project.brief.prose.write': z.strictObject({ project_id: str }),
  /** The user only; issues a personal agent key named label and returns {key_id, token_file}. The token is only in that file, readable by the user alone. */
  'personal.key.create': z.strictObject({ label: z.string().trim().min(1).max(80) }),
  /** The user only; revokes the personal agent key at once, and it stays revoked after a restart. */
  'personal.key.revoke': z.strictObject({ key_id: str }),
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
      /** The device the session runs on; absent is this machine. */
      device_id: str.optional(),
      /**
       * project_setup: the first message starts with the guide for a project built from nothing.
       * conductor: the native session with only the conductor tools.
       * Without a purpose the session runs as the bare runtime.
       */
      purpose: z.enum(['project_setup', 'conductor']).optional(),
      resident: z
        .strictObject({
          instructions: residentInstructions.optional(),
          routines: z.array(routineInput).optional(),
        })
        .optional(),
    })
    .refine(validSessionWorkspace, { message: 'An in-place session cannot have a start point' })
    .refine((input) => !input.resident || input.purpose === 'conductor', {
      path: ['resident'],
      message: 'Only a conductor can be the resident main agent',
    }),
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
        'approval',
        'permission_delivery',
        'gate',
        'slow_tool',
        'tool_failure',
        'turn_failure',
        'context_compaction',
        'background_task',
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
    allow_gate_change: z
      .boolean()
      .optional()
      .describe('Optional: true lands a session that changes protected paths.'),
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
    fallback: strings
      .min(1)
      .optional()
      .describe(
        "Runtimes that take over, in order, from a reviewer whose turn ends on its usage limit; one already reviewing or the writer's is skipped.",
      ),
  }),
  /** The user only; reviews the commits from the merge base of base and head up to head, and returns the started Review. */
  'review.range': z.strictObject({
    root: str.describe('A project root; its repository is reviewed.'),
    base: str.describe('The ref the changes start from; the merge base with head is used.'),
    head: str.optional().describe('The ref with the changes; absent means HEAD.'),
    paths: z
      .array(str)
      .min(1)
      .max(500)
      .optional()
      .describe('Repository-relative paths; only their changes are reviewed. Absent means all.'),
    exclude_deleted: z
      .boolean()
      .optional()
      .describe('True leaves deleted files out of the reviewed diff.'),
    focus: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe("What to look at closely; it goes into the reviewer's input after the goal."),
    runtimes: strings
      .min(1)
      .optional()
      .describe("The reviewing runtimes; absent means the project's reviewer."),
    fallback: strings
      .min(1)
      .optional()
      .describe(
        "Runtimes that take over, in order, from a reviewer whose turn ends on its usage limit; one already reviewing or the writer's is skipped.",
      ),
  }),
  'review.finding': z
    .strictObject({
      location: findingText.describe('The file and line, as path:line.'),
      quote: findingText.describe(
        'Text copied exactly from your first message, such as one whole line of the diff.',
      ),
      evidence: findingText.describe('What you saw.'),
      impact: findingText.describe('What goes wrong, and for whom.'),
      blocking: z.boolean().describe('True when it must be fixed before merge.'),
      reproduction: z
        .unknown()
        .optional()
        .describe(
          'Required when blocking: the steps, input and wrong output, or a failing test with its command.',
        ),
    })
    .refine((finding) => !finding.blocking || finding.reproduction !== undefined, {
      path: ['reproduction'],
      message: 'Blocking findings require a reproduction or failing test evidence in reproduction',
    }),
  'review.finding.resolve': z.strictObject({
    review_id: str,
    finding_id: str,
    outcome: z.enum(['fixed', 'intentional', 'not_worth_it', 'wrong']),
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
    reason: actionReason,
  }),
  'conductor.spawn': z.strictObject({
    kind: taskKind
      .optional()
      .describe('A configured task kind. Its route selects the runtime, model and effort.'),
    runtime: str
      .optional()
      .describe('The runtime of the new session; give one of kind, runtime or runtimes.'),
    runtimes: strings
      .min(2)
      .max(3)
      .optional()
      .describe(
        'Two or three distinct runtimes; one session starts on each with the same first message, each on the model a new session of that runtime gets.',
      ),
    input: str.describe('The first message of the new session.'),
    acceptance: z
      .array(z.string().min(1).max(500))
      .min(1)
      .max(12)
      .optional()
      .describe(
        'What done means, one check per item; the first message ends with them and a review of the session checks each.',
      ),
    owns: strings
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Path globs relative to the repository root that the session may change; read_state lists its changed files outside them.',
      ),
    model: str
      .optional()
      .describe(
        "The model of the new session, only with runtime; absent uses the runtime's default.",
      ),
    effort: z
      .enum(EFFORT_LEVELS)
      .optional()
      .describe("The reasoning effort of the new session; absent uses the runtime's default."),
    permission_mode: z
      .enum(['ask', 'auto_edit'])
      .optional()
      .describe(
        'ask (default): the user approves the requests of the new session; auto_edit: its file edits need no approval.',
      ),
    reason: actionReason,
  }),
  'conductor.state': z.strictObject({}),
  'conductor.message': z.strictObject({
    session_id: str.describe('A session you spawned.'),
    text: str.describe('The message.'),
    mode: z
      .enum(['send', 'steer'])
      .default('send')
      .describe('send (default): a new turn of an idle session; steer: into its running turn.'),
  }),
  'conductor.stop': z.strictObject({
    session_id: str.describe('A session you spawned.'),
    close: z
      .boolean()
      .optional()
      .describe(
        'Absent or false: interrupt its running turn and keep the session; true: close the session and discard its worktree.',
      ),
    reason: actionReason,
  }),
  'conductor.needs_you': z.strictObject({}),
  'conductor.answer': z.strictObject({
    session_id: str.describe('A session you spawned.'),
    approval_id: str.describe('Its question to answer, as read_needs_you lists it.'),
    decision: z
      .enum(['approve', 'reject'])
      .describe('approve: answer the question with answers; reject: decline the question.'),
    answers: z
      .record(str, str)
      .optional()
      .describe(
        'With approve: each question text to the chosen option labels joined by ", ", or to your own words where the question allows them.',
      ),
    reason: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => value.trim().length > 0)
      .describe('Why you answer so; the user reads it among the decisions made for them.'),
  }),
  'conductor.propose_setting': z.strictObject({
    command: z
      .enum(PROPOSABLE_SETTING_COMMANDS)
      .describe('The command the user runs once they approve the change.'),
    input: z
      .record(z.string(), z.unknown())
      .describe(
        "That command's input without project_id; for workflow.policy.set only project_budget.",
      ),
    reason: z.string().min(1).max(500).describe('Why the project needs the change.'),
  }),
  'conductor.plan_set': z.strictObject({
    milestones: z
      .array(
        z.strictObject({
          id: planId.describe('A stable id of the milestone.'),
          title: z.string().min(1).max(120).describe('What the milestone delivers.'),
        }),
      )
      .max(8)
      .describe('The milestones of the plan, at most 8.'),
    items: z
      .array(
        z.strictObject({
          id: planId.describe('A stable id of the item; keep it across writes.'),
          title: z.string().min(1).max(120).describe('What the item delivers, 1-120 characters.'),
          milestone: planId.optional().describe('The id of the milestone the item belongs to.'),
          depends_on: z
            .array(planId)
            .max(40)
            .optional()
            .describe('The ids of the items this one waits for, without a cycle.'),
          session_ids: z
            .array(str)
            .max(40)
            .optional()
            .describe(
              'The sessions working on the item: you, another main agent, or a session a main agent spawned.',
            ),
          acceptance: z
            .array(z.string().min(1).max(500))
            .max(12)
            .optional()
            .describe(
              "What done means, one check per entry; absent reads the sessions' acceptance.",
            ),
          dropped: z.literal(true).optional().describe('true: you gave the item up.'),
        }),
      )
      .max(40)
      .describe('The items of the plan, at most 40.'),
  }),
  /** The user only. */
  'project.plan.accept': z.strictObject({
    project_id: str,
    item_id: str,
    accepted: z.boolean(),
  }),
  /** The user only; approve runs the proposed command as the user's own, reject drops it. */
  'setting.proposal.respond': z.strictObject({
    proposal_id: str,
    decision: z.enum(['approve', 'reject']),
  }),
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
  /** The user only; returns the queued or running Landing of branch at root. */
  'project.landing.find': z.strictObject({ root: str, branch: str }),
  /** The user only; returns ProjectIntroRead. */
  'project.intro.read': z.strictObject({ project_id: str }),
  'project.facts.read': z.strictObject({ project_id: str }),
  'project.read': z.strictObject({ project_id: str }),
  'project.overlap': z.strictObject({ project_id: str }),
  'session.thread': z.strictObject({ session_id: str }),
  'project.usage.daily': z.strictObject({
    project_id: str,
    days: z.coerce.number().int().min(1).max(90),
    timezone,
  }),
  'project.usage.read': z.strictObject({ project_id: str }),
  'project.review.metrics': z.strictObject({ project_id: str }),
  'extensions.inventory': z.strictObject({ project_id: str, runtime: str }),
  'runtime.models': z.strictObject({ project_id: str, runtime: str }),
  'permission.rules': z.strictObject({ project_id: str }),
  'project.branches': z.strictObject({ project_id: str, root: str.optional() }),
  'repo.working_diff': z.strictObject({ project_id: str }),
  'repo.log': z.strictObject({
    project_id: str,
    ref: repoRef.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    skip: z.coerce.number().int().min(0).default(0),
  }),
  'repo.commit_diff': z.strictObject({ project_id: str, sha: repoRef }),
  'repo.compare': z.strictObject({ project_id: str, base: repoRef, head: repoRef }),
  'repo.commit_after': z.strictObject({ project_id: str, sha: repoRef }),
  'repo.blame': z.strictObject({ project_id: str, path: repoPath, ref: repoRef.optional() }),
  'repo.file_history': z.strictObject({ project_id: str, path: repoPath }),
  'workspace.stale': z.strictObject({ project_id: str }),
  'project.head': z.strictObject({ project_id: str }),
  /** Without session_id the project's first folder is searched. */
  'files.search': z.strictObject({
    project_id: str,
    session_id: str.optional(),
    q: z.string().max(200),
  }),
  'files.list': z.strictObject({
    project_id: str,
    session_id: str.optional(),
    path: z.string().optional(),
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
  'projects.summary': z.strictObject({}),
  /** ProjectBrief; what happened in the project after since, by default after the caller's seen cursor. */
  'project.brief': z.strictObject({
    project_id: str,
    since: z.coerce.number().int().min(0).optional(),
  }),
  /** ProjectChanges; every change row of the project, unsorted and uncapped; read_state lists the newest 30 of the same rows. */
  'project.changes': z.strictObject({ project_id: str }),
  /** ProjectPlanView; the stored plan, each item with where its sessions stand now. */
  'project.plan': z.strictObject({ project_id: str }),
  'project.plan.history': z.strictObject({
    project_id: str,
    limit: z.coerce.number().int().positive().optional(),
  }),
  /** Inclusive end-time bounds in Unix milliseconds. */
  'project.landings.read': z.strictObject({
    project_id: str,
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
    limit: z.coerce.number().int().positive().optional(),
  }),
  /** ProjectStatusRead over [from, to) in Unix milliseconds, up to 92 days. */
  'project.status.read': z.strictObject({
    project_id: str,
    from: z.coerce.number().int(),
    to: z.coerce.number().int(),
  }),
  'project.landings.compare': z.strictObject({
    project_id: str,
    proposal_id: str,
    count: z.coerce.number().int().positive(),
  }),
  'project.resident': z.strictObject({ project_id: str }),
  'project.routines': z.strictObject({ project_id: str }),
  'project.signals': z.strictObject({ project_id: str }),
  'app.signals': z.strictObject({}),
  /** ProjectSettingProposals; the approved setting proposals, latest approval first. */
  'project.setting_proposals': z.strictObject({ project_id: str }),
  /** DecisionsForUser; what a stored rule decided without the user from since on, Unix milliseconds, newest first. */
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
  /** GithubItems; at most 30 open items, newest update first, cached for sixty seconds; assigned me keeps those assigned to the gh user. */
  'github.items': z.strictObject({
    project_id: str,
    kind: z.enum(['pr', 'issue']),
    assigned: z.enum(['me']).optional(),
  }),
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
}
/** GET /v1/device.list; this machine (id `local`) or a configured device, with what its last probe found. */
export interface DeviceStatus {
  id: string;
  name: string;
  /** Absent for this machine. */
  ssh?: string;
  note?: string;
  /** The labels the probe found. */
  labels: string[];
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
  load: {
    /** Open sessions on this device, including idle native sessions, across projects. */
    active_sessions: { id: string; title: string; runtime: string; started_at: string }[];
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
  counts: { running: number; waiting: number; ready: number; failed: number };
  /** Sessions merged since the start of the current local calendar day. */
  merged_today: number;
  needs_you: number;
  /** Newest session last_activity_at, as an ISO time; null without sessions. */
  last_activity_at: string | null;
  /** The first sentence of the caller's project.brief prose; absent without prose. */
  brief?: string;
  /** Absent when nothing waits for the user. */
  waiting?: ProjectWaiting;
}
/** What a brief item links to; a merge is the merged session's id, a landing the `pantheon land` row's id, decided the project's id. */
export interface ProjectBriefRef {
  kind: 'merge' | 'landing' | 'approval' | 'event' | 'decided';
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
  | { kind: 'merge'; ref: ProjectBriefRef; at: number }
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
/** One change of a project: a worktree session with work to show, or a branch landing no session owns. */
export interface ChangeRow {
  /** `session:<session id>`, or `landing:<landing id>` for a branch no session owns. */
  id: string;
  kind: 'session' | 'branch';
  title: string;
  branch?: string | null;
  runtime?: string;
  spawned_by?: string;
  status: 'running' | 'needs_you' | 'ready' | 'merged' | 'failed';
  /** The caller's running row at the commit it last landed, nothing changed; conductor.state sets it. */
  landed?: true;
  ahead?: number;
  behind?: number;
  gate: { state: 'running' | 'passed' | 'failed' | 'stale' | 'none'; failed?: string[] };
  review?: {
    id: string;
    state: Review['state'];
    /** The review completed without a full result from every reviewer. */
    incomplete?: true;
    verdicts: { runtime: string; verdict: 'pass' | 'fail' }[];
    blocking_open: number;
    to_sha?: string;
  };
  landing?: 'queued' | 'running';
  /** The worktree's changes not landed yet. */
  changes?: { files: number; additions: number; deletions: number };
  /** ISO time. */
  updated_at: string;
}
/** GET /v1/project.changes. */
export interface ProjectChanges {
  changes: ChangeRow[];
}
/** One plan item with where its sessions stand, read from them at query time. */
export interface PlanItemView extends PlanItem {
  stage: 'plan' | 'write' | 'checks' | 'review' | 'merge' | 'landed' | 'abandoned' | 'dropped';
  status: ChangeRow['status'] | 'not_started' | 'abandoned';
  /** The session the row describes, the one furthest along of those the item names; absent without one. */
  session_id?: string;
  change?: ChangeRow;
  diff?: { files: number; additions: number; deletions: number };
  /** The newest 5 gate runs, oldest first. */
  gate_runs: ('passed' | 'failed' | 'skipped')[];
  evidence?: {
    level: 'report' | 'gate' | 'reviewed' | 'accepted';
    reviewer?: 'other_vendor' | 'other_runtime';
  };
  /** at is ISO time. */
  failure?: { reason: string; at: string; handled_by: 'main_agent' | 'you' };
  /** ISO time. */
  stuck_since?: string;
}
export type PlanItemStatus = 'open' | 'accepted' | 'dropped';
export interface PlanRevision extends Pick<
  ProjectPlan,
  'revision' | 'milestones' | 'items' | 'updated_at'
> {
  /** The writing session id, or user for an acceptance. */
  author: string;
  changes: {
    added: string[];
    removed: string[];
    status_changed: { id: string; from: PlanItemStatus; to: PlanItemStatus }[];
    moved: { id: string; from: string | null; to: string | null }[];
  };
  replan: boolean;
}
export interface ProjectPlanHistory {
  revisions: PlanRevision[];
}
export interface ProjectLandingsRead {
  landings: LandingRecord[];
}
export interface LandingStatistics {
  count: number;
  landed: number;
  blocked: number;
  no_changes: number;
  first_gate_pass_rate: number | null;
  mean_review_rounds: number | null;
  median_wall_ms: number | null;
  mean_tokens: number | null;
}
export interface ProjectStatusRead {
  landings: Pick<
    LandingStatistics,
    'first_gate_pass_rate' | 'mean_review_rounds' | 'median_wall_ms'
  > & {
    landed: number;
    blocked: number;
    no_changes: number;
    records: LandingRecord[];
  };
  /** User waits run from request to decision, clipped to the window. Unanswered waits accrue through now. */
  waiting: {
    count: number;
    total_ms: number;
    /** Longest clipped waits first. Open is evaluated at the end of the window. */
    longest: {
      session_id: string | null;
      kind: Approval['kind'];
      wait_ms: number;
      open: boolean;
    }[];
  };
  time: {
    roles: Pick<RoleUsage, 'role' | 'turn_ms'>[];
    /** Branch landings retain timing for their latest gate run. */
    gate_ms: number;
    /** Subtotal of reviewer turns, already included in roles. */
    review_ms: number;
  };
  /** Turns and their reported tokens follow project.usage.daily attribution. */
  usage: Pick<
    RoleUsage,
    'role' | 'turns' | 'input_tokens' | 'cached_input_tokens' | 'output_tokens'
  >[];
}
export interface ProjectLandingsCompare {
  before: LandingStatistics;
  after: LandingStatistics;
}
export interface ProjectResident {
  instructions: string | null;
  session_id: string | null;
  since: number | null;
  turns: { pantheon: number; user: number };
  budget: { used_input_tokens: number; input_tokens: number; reached_at?: number } | null;
  wakes: (
    | { at: number; kind: 'woken'; cause: string; turn_id: string; preview?: string }
    | { at: number; kind: 'skipped'; cause: string; reason: 'budget' | 'not_accepting' }
  )[];
}
export interface RoutineRun {
  at: number;
  outcome: 'woken' | 'skipped';
  reason?:
    | 'no_resident'
    | 'budget'
    | 'precheck'
    | 'not_accepting'
    | 'prechecking'
    | 'changed'
    | 'inactive_hours';
  exit_code?: number | null;
}
export interface SignalIssues {
  issues: SignalIssue[];
}
export interface ProjectRoutines {
  routines: (z.infer<typeof routineInput> & {
    id: string;
    next_at: number | null;
    state: 'active' | 'paused' | 'paused_budget' | 'no_resident';
    last_run: RoutineRun | null;
  })[];
}
export interface ProjectSettingProposals {
  proposals: SettingProposal[];
}
/** GET /v1/project.plan. */
export interface ProjectPlanView {
  plan: null | {
    session_id: string;
    conductor_open: boolean;
    revision: number;
    updated_at: string;
    milestones: { id: string; title: string }[];
    items: PlanItemView[];
  };
  /** Change rows no plan item names, the sessions the user opened among them. */
  unplanned: ChangeRow[];
  /** at is ISO time. */
  latest_landing?: { sha: string; title: string; at: string };
}
/**
 * A prompt answered by the stored permission rule, a question the main agent that spawned the
 * session answered or declined, or a session the main agent started, stopped or declared ready to
 * land; at is Unix milliseconds.
 */
export type DecisionForUser =
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
  | {
      kind: 'answered_by_main_agent';
      at: number;
      approval_id: string;
      session_id?: string;
      tool?: string;
      decision: 'approve' | 'reject';
      main_agent_session_id: string;
      /** Absent for a personal principal, as are input_summary, question and answers: each can quote tool input. */
      reason?: string;
      input_summary?: string;
      /** The first question of an AskUserQuestion request. */
      question?: string;
      /** Question text to the main agent's answer. */
      answers?: Record<string, string>;
    }
  | {
      kind: 'main_agent_action';
      at: number;
      event_id: string;
      /** Absent once the session was deleted. */
      session_id?: string;
      action: 'spawn' | 'interrupt' | 'close' | 'ready';
      main_agent_session_id: string;
      /** Absent for a personal principal, and when the main agent gave none. */
      reason?: string;
    };
/**
 * GET /v1/project.overlap. refresh_events includes session.write_detected, agent.tool.completed,
 * turn.completed, turn.failed, turn.cancelled, session.merged, session.closed and session.discarded.
 * Pairs share a repository. Paths are relative to its root.
 */
export interface ProjectOverlap {
  pairs: { session_ids: [string, string]; paths: string[] }[];
  refresh_events: string[];
}

/** GET /v1/session.thread. Entries run oldest first. at is Unix milliseconds. */
export interface SessionThread {
  entries: SessionThreadEntry[];
}
export type SessionThreadEntry = { id: string; at: number } & (
  | { kind: 'started'; by: 'user' | 'main_agent'; main_agent_session_id?: string; reason?: string }
  | { kind: 'message'; main_agent_session_id: string; turn_id: string; text?: string }
  | {
      kind: 'turn_ended';
      turn_id: string;
      state: 'completed' | 'failed' | 'cancelled';
      error?: string;
    }
  | {
      kind: 'spawner_notified';
      main_agent_session_id: string;
      turn_id?: string;
      approval_id?: string;
    }
  | {
      kind: 'question';
      state: 'pending' | 'approved' | 'rejected' | 'void';
      answered_by?: 'user' | 'main_agent';
      questions?: string[];
      answers?: Record<string, string>;
    }
  | {
      kind: 'review';
      round: number;
      state: Review['state'];
      verdicts: { runtime: string; verdict: 'pass' | 'fail' }[];
      blocking: { id: string; location?: string; impact?: string }[];
    }
  | { kind: 'gate'; state: 'passed' | 'failed' | 'cancelled'; failed_steps: string[] }
  | { kind: 'landing'; state: 'landed'; commit: string }
  | { kind: 'landing'; state: 'blocked'; reason?: string }
  | {
      kind: 'main_agent_action';
      action: 'interrupt' | 'close' | 'ready';
      main_agent_session_id: string;
      reason?: string;
    }
);

/**
 * GET /v1/project.usage.daily. Local YYYY-MM-DD dates, oldest first, including today and every role.
 * Sessions count on opening, tool calls on start, and turns on ending (or on start/queue while live).
 */
export interface ProjectUsageDaily {
  days: { date: string; roles: RoleUsage[] }[];
}

/** GET /v1/project.decisions. */
export interface DecisionsForUser {
  items: DecisionForUser[];
}
/** The type the approved-for-you list is filtered by. */
/**
 * permission: a stored rule allowed a request; question: the main agent answered one; action: the
 * main agent started, stopped or declared ready a session.
 */
export type DecisionType = 'permission' | 'question' | 'action';
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
/** The receipt of conductor.plan_set and project.plan.accept. */
export interface ProjectPlanResult {
  revision: number;
  plan: ProjectPlan;
}

/** GET /v1/session.list; one native session working in its own linked worktree, or a baseline session. */
export interface WorkbenchSession {
  id: string;
  /** Current pull state; session.list supplies not_needed before the first pull. */
  remote_pull?: NonNullable<Session['remote_pull']>;
  runtime_review?: true;
  forked_from?: { session_id: string; before_turn_id?: string; before_span_id?: string };
  /** The conductor session that spawned this one. */
  spawned_by?: NonNullable<Session['spawned_by']>;
  /** A main agent: the session was opened with purpose conductor. */
  conductor?: true;
  /** ISO time of the session.opened event. */
  created_at: string;
  /** ISO time the session's running turn started running; absent while no turn runs. */
  turn_started_at?: string;
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
  /** The first user input, with its ISO time. */
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
  /** The oldest unanswered permission request, id and revision its approval's; absent when waiting is zero. */
  waiting_request?: { id: string; revision: number; tool: string; detail?: string };
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
    /** A spawned session's turn whose end its main agent was told of. */
    told_main_agent?: true;
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
  /** The error of the newest turn when it failed, at most 200 characters. */
  turn_error?: string;
  /** The newest failed attempt has the same failed gate steps or turn error code as its predecessor. */
  repeated_failure?: boolean;
  /**
   * quiet: the running turn made no progress for 2 minutes and has no tool call under way;
   * stalled and looping: the running turn is stuck or repeating calls.
   */
  health: 'fresh' | 'quiet' | 'stalled' | 'looping';
  /** The task's sessions, discarded ones included; at least 1. */
  attempt: number;
  /** The merge problems Pantheon handed back to the session to fix. */
  handed_back?: string[];
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
}
export interface FilesListResult {
  entries: { name: string; kind: 'file' | 'dir'; size?: number }[];
  truncated: boolean;
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
/** A gate run of a worktree session, or of a branch landing (`pantheon land`) that no session owns. */
export interface ProjectGateRun extends SessionGateRun {
  /** Absent on a branch landing's run. */
  session_id?: string;
  session_title?: string;
  /** Set on a branch landing's run, whose run_id is the landing id; it keeps only its last gate run. */
  landing_id?: string;
  branch?: string;
  /** Set on the owner's first recorded run: a session's earliest, and a landing's only run. */
  first?: true;
}
/**
 * GET /v1/project.gates.history; recorded gate runs across the project's worktree sessions and
 * branch landings whose gate reached a verdict, newest finish first, or newest start first when
 * since is given.
 */
export interface ProjectGatesHistory {
  runs: ProjectGateRun[];
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

/** GET /v1/project.collab; inclusive epoch-ms range. */
export interface ProjectCollab {
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
  defaults: Pick<WorkflowPolicy, (typeof workflowPolicyParams)[number]>;
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

export interface RepoCommit {
  sha: string;
  /** Empty for a root commit; the first parent first. */
  parents: string[];
  /** Branch and tag names pointing here, as git log --decorate prints them. */
  refs: string[];
  author: string;
  author_email: string;
  /** Unix milliseconds of the commit time. */
  committed_at: number;
  subject: string;
  /** The message after the subject line; empty when there is none. */
  body: string;
  /** The session whose merge included this commit. */
  session_id?: string;
  /** The branch landing that included this commit. */
  landing_id?: string;
}
/** GET /v1/repo.log; commits reachable from ref, newest first. */
export interface RepoLog {
  commits: RepoCommit[];
  /** True when commits beyond skip + limit exist. */
  has_more: boolean;
}
/** GET /v1/repo.compare; head against base, diffed from their merge base, or from base when they share no history, to head. */
export interface RepoCompare extends LandingDiff {
  /** null when base and head share no history. */
  merge_base: string | null;
  /** Commits in head that base lacks. */
  ahead: number;
  /** Commits in base that head lacks. */
  behind: number;
  /** Files that would conflict merging head into base, at most 20; absent when this git has no merge preview or the two share no history. */
  conflicts?: RepoConflict[];
  /** Unix milliseconds when the merge preview ran. Present whenever conflicts is present. */
  previewed_at?: number;
  /** Changed files of head that no other session's worktree changes against the first folder's HEAD. */
  single_owner_files: number;
}
/** The first conflict in one file of a merge preview. */
export interface RepoConflict {
  path: string;
  /** Line of the merged result where the conflict starts; null when the file has no conflict markers, as when one side deleted it or it is binary. */
  line: number | null;
  /** Up to 5 of base's lines in that conflict. */
  base_lines: string[];
  /** Up to 5 of head's lines in that conflict. */
  head_lines: string[];
}
export interface RepoCommitAfter {
  /** The next commit on HEAD's first-parent line, or null if the commit has no successor there. */
  next: RepoCommit | null;
}
/** GET /v1/repo.blame; line numbers start at 1. */
export interface RepoBlame {
  path: string;
  /** The commit blamed. */
  sha: string;
  /** The file as the blamed commit has it, the lines chunks number; absent for a binary file. */
  text?: string;
  /** True when text stops at the read bound. */
  truncated: boolean;
  /** Runs of lines whose last change came from one commit; at is Unix milliseconds of its author time. */
  chunks: {
    start: number;
    count: number;
    sha: string;
    author: string;
    at: number;
    /** The session whose merge included this commit. */
    session_id?: string;
    /** The branch landing that included this commit. */
    landing_id?: string;
  }[];
  /** Committed changes of each session worktree since its merge base with the first folder's HEAD, moved onto the lines of the blamed commit's file; count 0 is an insertion after line start. */
  pending: { session_id: string; ranges: { start: number; count: number }[] }[];
}
/** GET /v1/repo.file_history; read from the first folder's HEAD. */
export interface RepoFileHistory {
  /** The latest 50 commits that changed the file, following renames, newest first. */
  changes: RepoCommit[];
  /** The last 26 weeks, oldest first, the current week last; count is commits that changed the file. */
  weekly: { start: number; count: number }[];
  /** The 10 files changed most often in the same commit, among the scanned commits; most first. */
  cochange: { path: string; together: number }[];
  /** Commits scanned for cochange: the latest 500, or fewer when the history is shorter. */
  scanned: number;
}
export interface RepoWorkingDiffFile {
  /** Relative to the project's first folder. */
  path: string;
  /** The path before a rename; absent otherwise. */
  old_path?: string;
  /** untracked: not known to git; the others compare the worktree and index with HEAD. */
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  /** null for a binary file. */
  additions: number | null;
  /** null for a binary file. */
  deletions: number | null;
}
/** GET /v1/repo.working_diff; the first folder's staged, unstaged and untracked changes against HEAD. */
export interface RepoWorkingDiff {
  /** The commit the changes are against. */
  head_sha: string;
  /** null when HEAD is detached. */
  branch: string | null;
  /** The branch's upstream and the commits HEAD has that it lacks (ahead) and it has that HEAD lacks (behind); null without one or when it no longer exists. */
  upstream: { name: string; ahead: number; behind: number } | null;
  /** Tracked changes first, then untracked files. */
  files: RepoWorkingDiffFile[];
  /** Every change as one patch, untracked files as new-file diffs; null when truncated. */
  patch: string | null;
  /** True when the patch exceeded its output bound. */
  truncated: boolean;
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
  /** Managed worktree folder; absent when the daemon has none configured. */
  worktree_root?: string;
}
