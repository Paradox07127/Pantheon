export * from './planning.js';
export * from './board.js';
export * from './workflow.js';
import type {
  BoardPlanView,
  FlowPath,
  GateFailureClass,
  LeadNote,
  LeadQuestion,
  ProjectBrief,
  TaskKind,
} from './board.js';
export type * from './change-story.js';
export type * from './trace.js';
export type * from './task-thread.js';
export type * from './playbook.js';
import { createHash, randomUUID } from 'node:crypto';

export const id = (): string => randomUUID();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
/** A role older rows may also hold worker, which reads as a plain session. */
export type Role = 'user' | 'planner' | 'writer' | 'reviewer' | 'personal' | 'conductor';
export interface Principal {
  id: string;
  role: Role;
  session_id?: string;
  project_id?: string;
  expires_at?: number;
}
export interface Entity {
  id: string;
  revision: number;
}
/** A credential the user issued to a personal agent; the token itself lives only in its file. */
export interface PersonalKey extends Entity {
  label: string;
  /** SHA-256 of the token, hex. */
  digest: string;
  created_at: number;
  revoked_at?: number;
}
/** The lucide icons a graph node may name in place of its kind's icon. */
export type GraphIcon =
  | 'monitor'
  | 'smartphone'
  | 'globe'
  | 'server'
  | 'box'
  | 'database'
  | 'hard-drive'
  | 'list-ordered'
  | 'shield'
  | 'key'
  | 'lock'
  | 'user'
  | 'users'
  | 'bot'
  | 'cpu'
  | 'cloud'
  | 'git-branch'
  | 'file'
  | 'folder'
  | 'terminal'
  | 'mail'
  | 'bell'
  | 'search'
  | 'settings'
  | 'chart-column'
  | 'clock'
  | 'zap'
  | 'package'
  | 'layers'
  | 'message-square'
  | 'credit-card'
  | 'shopping-cart'
  | 'plug'
  | 'webhook'
  | 'calendar'
  | 'map'
  | 'app-window'
  | 'code'
  | 'test-tube'
  | 'rocket';
/** In the order of the series colours they paint with. */
export type GraphColor = 'blue' | 'teal' | 'orange' | 'violet' | 'gray' | 'green';
export type GraphStatus = 'waiting' | 'running' | 'done' | 'failed' | 'blocked';
export type VisualContent =
  | { kind: 'vega-lite'; spec: Record<string, unknown> }
  | {
      kind: 'kline';
      spec: {
        candles: {
          time: string | number;
          open: number;
          high: number;
          low: number;
          close: number;
          volume?: number;
        }[];
        lines?: { name: string; points: { time: string | number; value: number }[] }[];
      };
    }
  | { kind: 'mermaid'; spec: { source: string } }
  | {
      kind: 'graph';
      spec: {
        nodes: {
          id: string;
          label: string;
          group?: string;
          kind?: 'client' | 'service' | 'store' | 'queue' | 'external' | 'policy';
          sublabel?: string;
          icon?: GraphIcon;
          color?: GraphColor;
          status?: GraphStatus;
          detail?: string[];
          sources?: string[];
        }[];
        edges: {
          from: string;
          to: string;
          label?: string;
          style?: 'main' | 'async' | 'data' | 'return';
        }[];
        groups?: { id: string; label: string; parent?: string }[];
        direction?: 'LR' | 'TB';
        colors?: Partial<Record<GraphColor, string>>;
      };
    }
  | { kind: 'html'; spec: { html: string } }
  | {
      kind: 'timeline';
      spec: {
        subtitle?: string;
        unit?: 'time' | 'ms';
        timezone?: string;
        lanes?: { id: string; label: string }[];
        groups?: { id: string; label: string }[];
        /** An item with `end` is a span, drawn as a bar; one without is an event, a point. */
        items: {
          id: string;
          label: string;
          detail?: string;
          lane?: string;
          group?: string;
          at: string | number;
          end?: string | number;
          parent?: string;
        }[];
      };
    }
  | {
      kind: 'table';
      spec: {
        columns: { key: string; title: string; type: 'text' | 'number' | 'date' }[];
        rows: Record<string, string | number | null>[];
        sort?: { key: string; direction: 'asc' | 'desc' };
      };
    };
export type Visual = Entity &
  VisualContent & {
    project_id: string;
    session_id: string | null;
    title: string;
    source?: string;
    size?: 'S' | 'M' | 'L';
    error?: { message: string; path: (string | number)[] }[];
    created_at: number;
    updated_at: number;
    pin?: { size: 'S' | 'M' | 'L'; width?: 4 | 6 | 8 | 12; position: number };
  };

export interface ProjectIntro {
  project_id: string;
  summary: string;
  sources: string[];
  features: { title: string; text: string; sources: string[] }[];
  modules: { path: string; role: string; entry?: string; lines: number; commits_30d: number }[];
  architecture?: Extract<VisualContent, { kind: 'graph' }>['spec'];
  body?: string;
  languages: { name: string; lines: number }[];
  weeks: number[];
  heads: { root: string; sha: string }[];
  session_id: string | null;
  written_at: number;
}

export interface ExtensionOverrides {
  disabled_mcp_servers: string[];
  disabled_plugins: string[];
  disabled_skills: string[];
  disable_apps: boolean;
  disable_hooks: boolean;
  /** User-level MCP servers the project opens; when set, every other user-level server is off. */
  enabled_user_mcp_servers?: string[];
  /** User-level skill ids the project opens; when set, every other user-level skill is off. */
  enabled_user_skills?: string[];
  /** Account connectors the project opens; when set, every other one is off. */
  enabled_user_connectors?: string[];
}
export interface ExtensionInventory {
  runtime: string;
  /** `user` marks an item from the user's own configuration rather than the project's. */
  mcp_servers: { name: string; enabled: boolean; plugin?: string; user?: boolean }[];
  plugins: { id: string; enabled: boolean }[];
  skills: {
    id: string;
    name: string;
    enabled: boolean;
    path?: string;
    plugin?: string;
    user?: boolean;
  }[];
  apps: boolean;
  /** Account connectors by the runtime's own key: a Claude server name or a Codex app id. */
  connectors: { name: string; enabled: boolean; title?: string }[];
  hooks: { event: string; plugin?: string }[];
  hooks_enabled?: boolean;
}
/** The overrides with the user-level MCP servers and skills the project has not opened disabled too. */
export function closeUserExtensions(
  overrides: ExtensionOverrides,
  listed: {
    mcp_servers: { name: string; user?: boolean }[];
    skills: { id: string; user?: boolean }[];
  },
): ExtensionOverrides {
  const closed = (disabled: string[], user: string[], opened: string[] | undefined) =>
    opened
      ? [...new Set([...disabled, ...user.filter((item) => !opened.includes(item))])]
      : disabled;
  return {
    ...overrides,
    disabled_mcp_servers: closed(
      overrides.disabled_mcp_servers,
      listed.mcp_servers.filter((server) => server.user).map((server) => server.name),
      overrides.enabled_user_mcp_servers,
    ),
    disabled_skills: closed(
      overrides.disabled_skills,
      listed.skills.filter((skill) => skill.user).map((skill) => skill.id),
      overrides.enabled_user_skills,
    ),
  };
}
export type EffortLevel =
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type PermissionMode = 'ask' | 'auto_edit' | 'plan' | 'auto' | 'full_access';
export interface RuntimeModel {
  id: string;
  label: string;
  description?: string;
  permission_modes: PermissionMode[];
  fast?: true;
  /** Effort levels this model accepts; empty when it has no effort setting. */
  efforts: EffortLevel[];
  default_effort: EffortLevel | null;
  default: boolean;
  /** The full model id this entry resolves to, when the runtime reports one. */
  resolved?: string;
}
export interface RuntimeChoice {
  runtime: string;
  model?: string;
  effort?: EffortLevel;
}
export interface SessionDefaults extends RuntimeChoice {
  permission_mode: PermissionMode;
  /** Task and review sessions also run on this runtime, model and effort; absent is off. */
  single_model?: boolean;
  /** Absent runs task sessions on the lead's runtime, model and effort. */
  writer?: RuntimeChoice;
  /** Absent follows reviewer selection. */
  reviewer?: RuntimeChoice;
  fallbacks?: Partial<Record<'lead' | 'writer' | 'reviewer', RuntimeChoice>>;
}
export interface Project extends Entity {
  name: string;
  /** Real, pairwise non-nested folders of equal standing; the order is the user's and carries no priority. */
  roots: string[];
  permission_rules?: { rule: string; session_id: string; added_at: number }[];
  worktree?: { copy_paths: string[]; command?: { argv: string[]; timeout_ms?: number } };
  extension_overrides?: Record<string, ExtensionOverrides>;
  extension_auto?: import('./planning.js').AutoClosedExtension[];
  /** Gate commands keyed by root realpath; a root without commands has no key. */
  gates?: Record<
    string,
    { name: string; argv: string[]; timeout_ms?: number; enabled?: boolean; skippable?: boolean }[]
  >;
  /** Set on every native session process and gate command; Pantheon's own variables win. */
  env?: Record<string, string>;
  /** What a new session starts on; absent follows the global value, else the composer's own default. */
  session_defaults?: SessionDefaults;
  /** Token targets by runtime; a runtime without one follows the global target. */
  usage_targets?: Record<string, number>;
  /** Not read. */
  auto_merge?: boolean;
  /** Takes events from outside the app: approve starts no task before the user agrees, auto also starts work on an issue the user alone wrote; absent follows the global value, else off. */
  external_events?: 'off' | 'approve' | 'auto';
  /** Hidden from project lists while its history is kept; reopening the root clears it. */
  removed_at?: number;
  /** The personal agent's home: no roots, in no project list, refuses project commands. */
  kind?: 'personal';
}
export interface Approval extends Entity {
  project_id: string;
  kind: 'permission';
  session_id?: string;
  /** The turn that raised the request; absent on approvals recorded before this field existed. */
  turn_id?: string;
  request_id?: string;
  /** Runtime's tool call ID, when the approval is bound to one operation. */
  tool_call_id?: string;
  tool?: string;
  input_hash: string;
  /** Request input as one line of at most 300 characters; absent when the request has no input. */
  input_summary?: string;
  /** lead: approved on the lead's behalf by the project's charter, without a model turn. */
  decider: 'user' | 'lead';
  state: 'pending' | 'approved' | 'rejected' | 'void';
  reason?: 'session_lost' | 'input_replaced';
  created_at: number;
  decided_by?: string;
  resolved_at?: number;
  /** The rule a session-wide approval adds to Session.allowed_rules. */
  rule?: string;
  /** Whether this request offers the project-wide answer. */
  project_rule_supported?: boolean;
  /** The stored project rule that answered this request. */
  answered_by_rule?: string;
  project_wide?: boolean;
  /** Approved for the rest of the session. */
  session_wide?: boolean;
  /** The user's reason, sent back with a denial. */
  decision_reason?: string;
  /** The full questions of an AskUserQuestion request. */
  questions?: ApprovalQuestion[];
  /** Question text to the chosen labels joined by ", ", or to the user's own words. */
  answers?: Record<string, string>;
  /** Why the latest attempt to deliver the answer to the runtime failed; cleared once it arrives. */
  delivery_error?: string;
  /** A decision the runtime refused for this still pending request, and its reason. */
  refused?: { decision: PermissionDecision; reason: string };
}
export interface ApprovalQuestion {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
  /** The runtime's id of the question. */
  id?: string;
  /** Whether the user may answer in their own words; absent allows it. */
  other?: boolean;
  /** The answer is entered like a password. */
  secret?: boolean;
  /** The label of the recommended option. */
  recommended?: string;
}
/**
 * The allowed-rule key of a tool call: the tool name; for Bash, Bash(<word1> <word2>) when the
 * second word is not an option, Bash(<word1>) otherwise, or Bash(<whole command>) when it has shell syntax.
 */
export function permissionRule(tool: string, input: unknown): string {
  const command =
    tool === 'Bash' && input && typeof input === 'object'
      ? (input as { command?: unknown }).command
      : undefined;
  if (typeof command !== 'string' || !command.trim()) return tool;
  const [first = '', second] = command.trim().split(/\s+/);
  // Chaining, substitution, redirection, globs, expansions, env prefixes and paths key on the whole
  // text, so a rule for a plain command never covers what they add.
  if (/[;&|`\n<>{}*?[~$]/.test(command) || /[=/]/.test(first)) return `Bash(${command.trim()})`;
  return second && !second.startsWith('-') ? `Bash(${first} ${second})` : `Bash(${first})`;
}
/** Who acts next on a failing task: retry it, switch its runtime, its lead, or the user. */
export type TaskRungName = 'retry' | 'switch' | 'lead' | 'user';

export interface NeedsYouItem {
  source: {
    table: 'approvals' | 'sessions' | 'workflow_policies' | 'memory_records';
    id: string;
    revision: number;
  };
  kind:
    | Approval['kind']
    | 'session.reconciling'
    | 'session.failed'
    | 'session.gate_failed'
    | 'session.merge_blocked'
    | 'project.over_budget'
    | 'memory.decision_budget';
  project_id: string;
  /**
   * The approval's session, or the lead of a plan or milestone item; absent on session items,
   * whose source is the session.
   */
  session_id?: string;
  /** The plan task, `<lead session id>:<task id>`, of a task item. */
  task_id?: string;
  /** The turn and native request of a lost request or an undelivered answer. */
  turn_id?: string;
  request_id?: string;
  status: string;
  created_at: number;
  reason:
    | 'permission_requested'
    | 'permission_voided'
    | 'answer_undelivered'
    | 'reconciliation_required'
    | 'session_failed'
    | 'non_writer_write_detected'
    | 'outside_worktree_write_detected'
    | 'gate_failed'
    | 'merge_blocked'
    | 'merge_stuck'
    | 'workspace_reconciling'
    | 'stop_unconfirmed'
    | 'usage_limit_reached'
    | 'session_turn_stalled'
    | 'background_task_long'
    | 'project_over_budget'
    | 'plan_decisions_over_budget';
  /** What the user decides. */
  decision: 'question' | 'repeated_failure' | 'permission' | 'budget' | 'improvement' | 'other';
  /** The command of the item's one primary action. */
  primary?: string;
  actions: {
    command: string;
    allowed: boolean;
    disabled_reason?: string;
    decision?: 'approve' | 'reject' | 'keep' | 'revert';
  }[];
  task_title?: string;
  /** The title of the lane a `board.lane.approval` item holds; no other item has it. */
  lane_title?: string;
  question?: LeadQuestion;
  /** The headline of the plan a `lead.question` item belongs to; session_id is its lead. */
  plan_title?: string;
  /** When the recommended answer of a `lead.question` item applies unless the user answers first, in Unix milliseconds. */
  default_at?: number;
  blocked?: LeadNote;
  /** When a session that waits for its used-up usage limit resumes, in Unix milliseconds. */
  resets_at?: number;
  /** The background task that has run too long; session.background.stop takes its id. */
  background?: BackgroundTask;
  /** The input tokens a project over its budget spent since the budget was set, and the budget. */
  project_budget?: { used_input_tokens: number; input_tokens: number };
  /** The current plan decisions kept as notes because the decisions did not fit the memory budget. */
  memory_notes?: { count: number; memory_ids: string[] };
  /** The upstream task, `<lead session id>:<task id>`, that keeps a queued task waiting, and why it does not go on. */
  upstream?: { task_id: string; stuck: 'merge_blocked' | 'stopped' | 'never_started' };
  /** How long a permission request has waited for an answer, in milliseconds; set once it is escalated. */
  waited_ms?: number;
  /** Set on a permission request that stayed unanswered past the escalation window, so the user and the lead were reminded. */
  escalated?: true;
  /** Why the gate of a failed gate or a merge blocked by its gate failed, when that is known. */
  failure_class?: GateFailureClass;
  /** The questions of a pending AskUserQuestion request, as it asked them. */
  questions?: ApprovalQuestion[];
  /** The lead's re-assessment of a paused plan; only a `board.plan.reassessment` item has it. */
  reassessment?: { done: string; blocked: string; change: string; at: number };
  /** On a lane waiting for plan approval: whether the automatic plan review of its tasks still runs. */
  plan_review_running?: boolean;
  binding?: {
    action?: string;
    input_hash?: string;
    /** Request input as one line of at most 300 characters; absent when the request has no input. */
    input_summary?: string;
    /** What an allow for the session adds; absent when the request cannot be allowed for the session. */
    rule?: string;
    project_rule_supported?: boolean;
  };
  /** Who acts next and how. */
  next_step?: string;
}
export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
}
export interface LandingItem {
  workspace_id: string;
  source: string;
  state: 'landed' | 'no_changes' | 'blocked';
  branch?: string;
  from_sha?: string;
  to_sha?: string;
  rebased_from?: string;
  reason?: string;
  gate_results?: {
    state?: 'passed' | 'failed' | 'skipped';
    reason?: string;
    name: string;
    argv: string[];
    exit_code: number | null;
    duration_ms: number;
    timed_out: boolean;
    output: string;
    tests?: TestCounts;
    carried?: boolean;
    /** Set on a failed result. */
    failure_class?: GateFailureClass;
  }[];
}
/** One landing of a branch that no Pantheon session owns. */
export interface Landing extends Entity {
  project_id: string;
  /** The project root whose repository holds the branch. */
  root: string;
  /** The ref the user named. */
  branch: string;
  /** The branch checked out in root when the landing was requested; the landing fast-forwards it. */
  target_branch: string;
  workspace_id: string;
  /** When present, the branch's commits land as one commit with this message. */
  message?: string;
  state: 'queued' | 'running' | 'landed' | 'no_changes' | 'blocked';
  reason?: string;
  conflicts?: string[];
  conflict_commits?: string[];
  gate_results?: LandingItem['gate_results'];
  landing?: NonNullable<Session['merge']>['landing'];
  from_sha?: string;
  to_sha?: string;
  started_at?: number;
  finished_at?: number;
}
export interface Workspace extends Entity {
  provisioning?: {
    state: 'queued' | 'running' | 'ready' | 'failed' | 'cancelled' | 'reconciling';
    base_ref: string;
    checkpoint?: string;
    directory_identity?: { dev: number; ino: number };
    phase?: string;
    process_identity?: ProcessIdentity;
    error?: string;
    cancel_requested?: boolean;
    started_at?: number;
    finished_at?: number;
    progress?: string;
    /** Last 4000 characters of preparation command output, stdout and stderr combined. */
    output?: string;
    stop?: CancelReceipt;
    /** Runs in place of the project's worktree preparation command. */
    command?: { argv: string[]; timeout_ms?: number };
  };
  project_id: string;
  path: string;
  /**
   * linked_worktree: a worktree Pantheon provisions for the session;
   * in_place: the user's own folder, path its realpath and source the project root holding it, without provisioning.
   */
  kind: 'linked_worktree' | 'in_place';
  source?: string;
  /** The branch the source repository had checked out when the session opened; merges land only on it. */
  source_branch?: string;
  base_sha?: string;
  owner: string;
  ownership_epoch: number;
  removed_at?: number;
}
export interface ContextBreakdown {
  /** Rows in the runtime's order. */
  categories: { id: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }[];
  memory_files: { path: string; tokens: number }[];
  mcp_tools: { name: string; server: string; tokens: number; loaded: boolean }[];
  agents: { type: string; source: string; tokens: number }[];
}
export interface Usage {
  /** Total input tokens, including cached tokens, in tokens. */
  input_tokens: number;
  /** Part of input_tokens served from cache reads, in tokens; absent when the runtime did not report it. */
  cached_input_tokens?: number;
  /** Input tokens written to the cache, in tokens; absent when the runtime did not report it. */
  cache_write_input_tokens?: number;
  /** Total output tokens, in tokens. */
  output_tokens: number;
  /** Part of output_tokens spent on reasoning, in tokens; absent when the runtime did not report it. */
  reasoning_output_tokens?: number;
  /** Model requests made in this turn, a count; absent when the runtime did not report it. */
  model_requests?: number;
  /** Total reported cost, in USD; absent when no cost was reported. */
  cost_usd?: number;
  /** Source of the last reported cost classification. */
  cost_source?: CostSource;
  /** Approximate context occupancy after the latest model request, in tokens. */
  context_tokens?: number;
  /** Context window of the model after the latest model request, in tokens. */
  context_window?: number;
  context_breakdown?: ContextBreakdown;
  /**
   * The runtime reported no input or output tokens: input_tokens and output_tokens are 0 and mean
   * unknown. On a session, none of its turns reported them.
   */
  tokens_unreported?: true;
}
export interface SessionComment extends Entity {
  session_id: string;
  path: string;
  line: number;
  side: 'old' | 'new';
  text: string;
  /** The commented line's text as the diff showed it, without the diff sign. */
  line_text?: string;
  /** The turn whose diff the comment was made on; absent for the branch diff. */
  turn_id?: string;
  /** Unix epoch milliseconds. */
  created_at: number;
  state: 'open' | 'sent' | 'kept';
}

export interface Session extends Entity {
  runtime_review?: import('./trace.js').RuntimeReview;
  memory_observed_signature?: string;
  memory_delivery?: {
    prepared_signature: string;
    prepared_epoch: number;
    context_hash: string;
    turn_id: string;
    delivered_signature?: string;
    delivered_epoch?: number;
  };
  forked_from?: { session_id: string; before_turn_id?: string; before_span_id?: string };
  /** A session starting a project from an empty folder with the setup guide. */
  project_setup?: true;
  /** Not read. */
  lead?: unknown;
  /** A native session with only the four conductor tools. */
  conductor?: true;
  /** The conductor's turn that declared its work ready, by command command_id; it merges once that turn completes. */
  ready?: { turn_id: string; command_id: string };
  /** The conductor session that started this one; it gets no Pantheon tools. */
  spawned_by?: { session_id: string };
  /** Native history fork applied before the next input; after is a runtime message or turn id. */
  native_fork?: { session_id: string; after: string };
  baseline?: import('./planning.js').BaselineTag;
  change_story?: import('./change-story.js').StoryTag;
  /** Retired; only present on rows an older version stored. */
  range_story?: unknown;
  intro?: true;
  /** Managed durable native history location; absent on legacy native sessions. */
  native_state_dir?: string;
  /** Human-readable provider session title, never the serialized control prompt. */
  native_title?: string;
  project_id: string;
  runtime: string;
  /** Backend id in the user's configuration; absent uses the runtime's own login. */
  backend_id?: string;
  requested_model?: string;
  requested_effort?: EffortLevel;
  reported_model?: string;
  profile_version?: number;
  account_ref?: string;
  device_id?: string;
  /** The device's changes of the last turn are not yet back in the local worktree. */
  remote_pull_pending?: boolean;
  remote_pull?: { changed_at: string } & (
    { status: 'not_needed' | 'running' | 'done' } | { status: 'failed'; reason: string }
  );
  native_id?: string;
  adapter_version?: string;
  last_cursor?: string;
  event_namespace?: string;
  process_identity?: ProcessIdentity;
  review_id?: string;
  state: 'open' | 'running' | 'closed' | 'reconciling';
  turn_count: number;
  /** Usage across all turns of this session, in tokens and USD. */
  usage?: Usage;
  /** Keeps a concurrency slot until termination is confirmed, including after restart. */
  stop_pending?: boolean;
  /** A discard waiting for the native process to stop; recovery finishes it after a restart. */
  stop_requested?: { reason: string; at: number; by: 'user' | 'lead' };
  /** The linked worktree a workbench session writes in. */
  workspace_id?: string;
  /**
   * A session the user opened in the project folder, not one adopted there; base_sha is the
   * folder's HEAD when it opened, absent outside a Git checkout.
   */
  in_place?: { base_sha?: string };
  /** Why the session opened a worktree though the user chose none: the session writing the project folder. */
  worktree_reason?: { holder_session_id: string };
  permission_mode?: PermissionMode;
  enabled_user_connectors?: string[];
  auto_compact_at_tokens?: number;
  fast?: true;
  fast_mode?: { state: 'on' | 'off' | 'cooldown'; reason?: string };
  /** Claude's standing dynamic-workflow orchestration. */
  ultracode?: true;
  /** Rule keys (see permissionRule) the user allowed for the rest of the session. */
  allowed_rules?: string[];
  title?: string;
  /** 'user' once the user renamed the session; absent means the title is automatic. */
  title_source?: 'user';
  /** How the user ended a workbench session's worktree. */
  outcome?: 'merged' | 'discarded';
  /** The newest pull request opened from the session's worktree. */
  pull_request?: { number: number; url: string };
  /** The latest explicit gate run, including a durable request to stop it. */
  gate_run?: {
    id: string;
    state: 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
    started_at: number;
    finished_at?: number;
    error?: string;
  };
  /** The user's merge of the worktree into its source; cleared when the next turn starts. */
  merge?: {
    state: 'running' | 'blocked';
    cancel_requested?: boolean;
    reason?: string;
    conflicts?: string[];
    /** Titles of the target branch's commits that changed the conflicting files since the session forked. */
    conflict_commits?: string[];
    /** Board task ids (lead:task) whose merges landed those commits; commits no task merged name none. */
    conflict_tasks?: string[];
    gate?: { name: string; output: string; tests?: TestCounts };
    failure_class?: GateFailureClass;
    /** Not read. */
    allow_out_of_scope?: boolean;
    /** Files outside the task's scope the lead let this merge land; others are still checked. */
    allowed_files?: string[];
    /** How far a running merge got, saved before the source moves; a rerun resumes from it. */
    landing?: {
      stage: 'gated' | 'fast_forwarded';
      candidate: string;
      branch: string;
      from_sha: string;
      /** The gate commands and settings that passed, as JSON. */
      gate_argv?: string;
    };
  };
  /** The turn the user rolled back to; the next input starts with the record before it, then clears it. */
  handoff_before_turn_id?: string;
  /** Original queued inputs held while changing native runtime; never replaces their turn ids. */
  queued_handoff?: {
    first_turn_id: string;
    retry_at?: number;
    attempts?: number;
    blocked?: 'delivery_unknown' | 'retry_limit';
  };
  /** A rollback whose files may have moved but whose record is not written yet; input waits for it. */
  rollback_pending?: { checkpoint: string; turn_id: string; scope?: 'files' | 'both' };
  /** Not read. */
  task?: unknown;
  /** Not read. */
  resident?: unknown;
  /** Not read. */
  rotation?: unknown;
  /** Not read. */
  direct_task?: unknown;
  /** ISO time the user pinned the session in the session list. */
  pinned_at?: string;
  /** ISO time the user archived the ended session. */
  archived_at?: string;
  /** ISO time the user snoozed the session; news from the session clears it. */
  snoozed_at?: string;
  recap?: SessionRecap;
  /** The line the session last set in turn turn_id of what it does now; at is Unix ms. */
  status_line?: { text: string; at: number; turn_id: string };
}
/** A short account of where a session stands, refreshed after its turns. */
export interface SessionRecap {
  /** At most 64 characters. */
  headline: string;
  /** What the session waits on the user for, at most 140 characters; only while it waits. */
  needs_you?: string;
  /** At most 140 characters. */
  happened: string;
  turn_id?: string;
  at: number;
  model?: string;
}
/** A group of lead tools an agent profile turns on as a whole. */
export type AgentToolGroup =
  | 'board'
  | 'dispatch'
  | 'memory'
  | 'browser'
  | 'app'
  | 'sessions'
  | 'github'
  | 'always_on'
  | 'agents'
  | 'signals';
/** A prompt an agent runs on its own, every every_ms or daily at at (HH:MM local time). */
export interface AgentRoutine {
  id: string;
  prompt: string;
  every_ms?: number;
  at?: string;
  /** Local HH:MM times the routine may run between. */
  active_hours?: { from: string; to: string };
  enabled: boolean;
  /** A command that must exit 0 in the project folder before each run wakes the agent. */
  precheck?: { argv: string[]; timeout_ms?: number };
}
/** The lasting record behind a resident session: its role prompt, tools and model. */
export interface AgentProfile extends Entity {
  project_id: string;
  /** assistant and triage are one per project; the others may repeat; personal lives only in the personal home. */
  template: 'assistant' | 'triage' | 'ideas' | 'goals' | 'custom' | 'personal';
  name: string;
  /** A label of two to four characters. */
  role: string;
  /** The user's own instructions for this agent; its turns get them after its template's built-in role prompt. */
  instructions?: string;
  /** Why it was created. */
  brief?: string;
  runtime?: string;
  model?: string;
  effort?: EffortLevel;
  /** Absent: the groups of its template, which gains groups as tools are added. */
  tools?: AgentToolGroup[];
  routines: AgentRoutine[];
  /** Absent: the event sources of its template. */
  listens?: ('github' | SignalSource)[];
  /** Limits on when its wakes may reach the user; absent: none. */
  contract?: AgentContract;
  /** The personal key the personal agent reads with. */
  personal_key_id?: string;
  created_by: { kind: 'user' } | { kind: 'agent'; session_id: string };
  created_at: number;
  archived_at?: number;
}
/** An agent's limits: input tokens a week, the loudest way it may reach the user, local HH:MM quiet hours. */
export interface AgentContract {
  weekly_input_tokens?: number;
  loudest?: 'feed' | 'notify' | 'ask';
  quiet_hours?: { from: string; to: string };
}
/** A routine as agent.create and agent.update take it: every_minutes or daily at a local HH:MM. */
export interface AgentRoutineInput {
  id?: string;
  prompt: string;
  every_minutes?: number;
  at?: string;
  active_hours?: { from: string; to: string };
  enabled: boolean;
  precheck?: { argv: string[]; timeout_seconds?: number };
}
/** The fields agent.create takes besides the project. */
export interface AgentFields {
  template: AgentProfile['template'];
  name: string;
  role: string;
  /** Required for a custom agent, which has no built-in role. */
  instructions?: string;
  brief?: string;
  tools?: AgentToolGroup[];
  listens?: NonNullable<AgentProfile['listens']>;
  runtime?: string;
  model?: string;
  effort?: EffortLevel;
  routines?: AgentRoutineInput[];
  contract?: AgentContract;
}
/** A message an agent leaves for the user. */
export interface AgentMessage extends Entity {
  project_id: string;
  agent_id: string;
  session_id: string;
  text: string;
  urgency: 'normal' | 'high';
  at: number;
  read_at?: number;
  /** The main agent the message went to instead of the user. */
  routed_to?: string;
  /** How a message to the user reaches them: feed without a notification; absent: notify. */
  delivery?: 'feed' | 'notify';
}
/**
 * The Pantheon MCP role a session's credential carries; undefined for a session the user opened
 * or imported, which runs without a credential. A project setup session reads and draws like a planner.
 */
export function credentialRole(
  session: Pick<
    Session,
    | 'review_id'
    | 'baseline'
    | 'change_story'
    | 'intro'
    | 'workspace_id'
    | 'conductor'
    | 'project_setup'
  >,
): Role | undefined {
  if (session.review_id) return 'reviewer';
  if (session.conductor) return 'conductor';
  if (
    session.baseline ||
    session.change_story ||
    session.intro ||
    session.project_setup ||
    !session.workspace_id
  )
    return 'planner';
}
export interface TurnAttachment {
  id: string;
  name: string;
  mime: string;
  /** Absolute path of the copy the session can read. */
  path: string;
  /** The copy on this machine when `path` names a file on a device. */
  source?: string;
}
export interface TurnSkill {
  name: string;
  path: string;
}
/** The user's personal agent acted for the user with the key of this id. */
export type PersonalVia = { kind: 'personal'; key_id: string };
export interface SessionTurn extends Entity {
  project_id: string;
  session_id: string;
  /**
   * The model the session was set to when the turn started running; a steer, or a turn that never
   * ran, keeps the one from when it was created. null means the runtime default.
   * Absent on turns recorded before this field existed.
   */
  model?: string | null;
  /** The full model id the runtime reported for the turn; absent when it reported none. */
  reported_model?: string;
  input: string;
  /** An earlier record the runtime receives before input; not the user's words. */
  handoff?: string;
  /** A rollback put the session back to before this turn or an earlier one. */
  rolled_back?: boolean;
  /** Runtime message or turn id at the end of this turn, for native history forks. */
  native_history_end?: string;
  attachments?: TurnAttachment[];
  skills?: TurnSkill[];
  refs?: ({ kind: 'session'; id: string } | { kind: 'pr' | 'issue'; number: number })[];
  reference_context?: string;
  kind: 'send' | 'steer';
  delivery: 'pending' | 'delivered' | 'queued' | 'failed';
  delivery_reason?: string;
  state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Inbox notes carried by this turn, including notes folded into its digest. */
  lead_note_ids?: string[];
  /** Set only on a turn Pantheon queued to deliver notes: their kinds and routine ids; absent on a user turn. */
  wake?: { causes: LeadNote['kind'][]; routine_ids?: string[] };
  /** The MCP server whose interface sent this input. */
  app?: { server: string };
  /** The user's personal agent sent this request with the key of this id; the words are still the user's. */
  via?: PersonalVia;
  /** Latest reported usage totals for this turn, in tokens and USD. */
  usage?: Usage;
  /**
   * Set on a turn the task tracker, a board sync or a confirmed baseline wrote to a lead session;
   * lead marks a turn that carries a lead's message or changed contract to a task session.
   * continuation marks a turn the daemon queued to continue a session it drives.
   * compaction marks a user-requested maintenance turn, whose input is compaction instructions.
   */
  origin?:
    | 'tracker'
    | 'sync'
    | 'baseline'
    | 'lead'
    | 'continuation'
    | 'reflection'
    | 'external'
    | 'compaction';
  /**
   * On a turn the daemon queued: the depth of the turn or event it follows from plus 1, counted
   * from the task's last verified progress. Absent on a person's turn, which is depth 0.
   */
  causal_depth?: number;
  /** The turn started read-only, as its UserTurn told the runtime; absent when it could write. */
  read_only?: boolean;
  /** What a resident did with the user's turn, from the events it caused on its plan; set when the turn completed. */
  routing?: {
    kind: 'answered' | 'new_plan' | 'added' | 'sent' | 'asked';
    lane_id?: string;
    task_ids?: string[];
    /** The title lane_id had when the receipt was written. */
    lane_title?: string;
    /** The titles task_ids had when the receipt was written, in the same order. */
    task_titles?: string[];
    agent_id?: string;
  };
}
export type SessionRole = 'reviewer' | 'baseline' | 'story' | 'main';
export interface RoleUsage {
  role: SessionRole;
  sessions: number;
  turns: number;
  tool_calls: number;
  /** Total input tokens, including cached tokens, in tokens. */
  input_tokens: number;
  /** Part of input_tokens served from cache reads, in tokens; null when no turn reported it. */
  cached_input_tokens: number | null;
  /** Total output tokens, in tokens. */
  output_tokens: number;
  /** Wall-clock time of model turns from running to their end, in ms. */
  turn_ms: number;
  turns_without_usage: number;
}
export interface ReviewFinding {
  id: string;
  review_id: string;
  runtime: string;
  round: number;
  location: string;
  quote: string;
  evidence: string;
  impact: string;
  reproduction?: unknown;
  /** stale: a later commit of the reviewed session no longer has the quote; it never reopens. */
  status: 'open' | 'rejected' | 'stale';
  reason?: 'quote_not_in_artifact' | 'incomplete_finding';
  artifact_error?: 'artifact_unavailable';
  blocking: boolean;
  /** Set on a range review's finding whose location is not `path:line`; such a finding never blocks. */
  unlocated?: true;
  resolution?: {
    /** Every outcome ends the finding: fixed, true but intended, true but not worth changing, or not true. */
    outcome: 'fixed' | 'intentional' | 'not_worth_it' | 'wrong';
    note?: string;
    resolved_at: number;
    resolved_by: string;
  };
}
export interface Review extends Entity {
  project_id: string;
  /** The workbench session whose changes are reviewed; absent on a plan review. */
  session_id?: string;
  /**
   * The owning lead and task generation that requested this review through MCP; a plan review
   * names only the lead whose plan it reviews.
   */
  requester?: {
    lead_session_id: string;
    task_id?: string;
    generation?: number;
    /** The workflow step run that started this review; its result goes to that step, not the lead. */
    step_run_id?: string;
    /** The milestone row whose verification started this review; its result goes to that verification. */
    milestone_id?: string;
  };
  /** The session told when this review ends. */
  notify_session_id?: string;
  /** On a plan review of older rows, the task generations it reviewed; nothing reads it. */
  plan?: { tasks: { task_id: string; generation: number }[] };
  /** Frozen committed range supplied to every reviewer. */
  range?: { source: string; from_sha: string; to_sha: string };
  /** The refs the user named for a range review; absent on every other review. */
  refs?: { base: string; head: string };
  /** Artifact-store SHA-256 of the full reviewer input, when supplied. */
  input_hash?: string;
  round: number;
  runtimes: string[];
  /** Runtimes that take over, in order, from a reviewer whose turn ends on its usage limit. */
  fallback?: string[];
  /** Each reviewer session a fallback runtime took over from; the taking runtime is also in runtimes. */
  replacements?: { runtime: string; session_id: string; by: string; reason: 'usage_limit' }[];
  state: 'running' | 'completed' | 'failed';
  /** Set on a completed review that does not pass: why a reviewer gave no full result. */
  incomplete?: string;
  findings: ReviewFinding[];
  /** The verdict each reviewer session handed in last; `at` is epoch milliseconds. A row without `session_id` belongs to its runtime. */
  verdicts?: {
    session_id?: string;
    runtime: string;
    verdict: 'pass' | 'fail';
    summary: string;
    at: number;
  }[];
  session_ids: string[];
  /** Review request and completion times, epoch milliseconds; read from review events. */
  started_at?: number;
  ended_at?: number;
  /** Read projection from session.reviews; execution failures are not clean reviews. */
  executions?: {
    runtime: string;
    session_id?: string;
    state: SessionTurn['state'] | 'unknown';
    error?: string;
  }[];
}
/** One row per reviewer runtime; a finding is valid when its status is not 'rejected'. */
export interface ReviewMetrics {
  runtime: string;
  /** Reviews this runtime took part in. */
  reviews: number;
  /** Reviews in which this runtime recorded no valid finding. */
  reviews_without_findings: number;
  /** All findings this runtime recorded, including rejected ones. */
  findings: number;
  /** Findings the user marked fixed, intentional, not worth it and wrong. */
  fixed: number;
  intentional: number;
  not_worth_it: number;
  wrong: number;
  /** Open findings with no resolution yet; a stale one is not counted. */
  unresolved: number;
  /** Findings rejected on recording, such as a quote not found in the artifact. */
  invalid: number;
}
export interface Timer {
  id: string;
  revision: number;
  project_id: string;
  kind: string;
  subject_id: string;
  due_at: number;
  state: 'pending' | 'fired' | 'cancelled';
  fired_at?: number;
  /** The text an agent follow-up wakes its resident with. */
  note?: string;
}
/** One thing that happened outside the app, as a source adapter reports it. */
export interface ExternalEvent {
  /** The project id and the source's key for this one occurrence; a second report of it has the same id. */
  id: string;
  revision: number;
  project_id: string;
  /** The adapter that reported it, such as github. */
  source: string;
  /** What the event is about, with its full namespace, such as github:owner/repo#123. */
  subject_key: string;
  kind: string;
  actor: string;
  /** Who caused the event: the user, someone who may write to the repository, anyone else, or a bot. */
  actor_trust: 'self' | 'write' | 'other' | 'bot';
  title: string;
  /** The page a person opens to see the subject. */
  url: string;
  /** What the subject says, oldest first; own marks text the user wrote. */
  texts: { author: string; own: boolean; text: string }[];
  /** The lead session the event was handed to. */
  session_id?: string;
  received_at: number;
  /** dropped: its actor may not start work. handled: a lead session has it. failed: no lead could start. */
  state: 'pending' | 'dropped' | 'handled' | 'failed';
  /** Why no lead could start for a failed event. */
  error?: string;
}
/** A kind of system signal the app records and an agent may listen to. */
export type SignalSource =
  'gate_failures' | 'flaky_tests' | 'app_errors' | 'session_failures' | 'trace_findings';
/** Disused: a signal_issues row of an older database; nothing records issues any more. */
export interface SignalIssue extends Entity {
  project_id: string;
  source: SignalSource;
  /** Unique per project and source. */
  fingerprint: string;
  /** At most 200 characters. */
  title: string;
  /** holding: a new issue waits to see whether it resolves on its own. */
  state: 'new' | 'ongoing' | 'escalating' | 'regressed' | 'holding' | 'resolved' | 'muted';
  /** interrupt wakes its listeners soon, digest comes in their hourly digest, record is only kept. */
  priority: 'interrupt' | 'digest' | 'record';
  count: number;
  first_seen: number;
  last_seen: number;
  /** The newest samples, at most 3, each at most 2000 characters. */
  samples: string[];
  /** Times of the newest signals, as many as the source's escalation threshold. */
  recent: number[];
  /** The open issue that mutes this one. */
  muted_by?: string;
  muted_by_user?: boolean;
  /** The issues this one mutes while it is open. */
  inhibits?: { source: SignalSource; fingerprint_prefix: string }[];
  /** Deliveries to agents, the newest 20; via says whether it woke the agent or came in its digest. */
  routed: {
    agent_id: string;
    at: number;
    state: SignalIssue['state'];
    via: 'interrupt' | 'digest';
  }[];
  /** State changes, the newest 20. */
  history: { at: number; state: SignalIssue['state']; text: string }[];
  resolved_at?: number;
  /** default_branch: a check failed on the branch tasks merge into; kept once set. */
  scope?: 'default_branch';
}
/** One place events come from, such as github, as the settings show it. */
export interface ExternalSourceStatus {
  id: string;
  /** When the source last answered; absent before its first answer. */
  polled_at?: number;
  /** Why the latest poll failed; absent after a poll that worked. */
  error?: string;
}
/** GET /v1/external.read: how the project takes events, each source, and the project's 50 latest events, newest first. */
export interface ExternalRead {
  mode?: Project['external_events'];
  sources: ExternalSourceStatus[];
  events: ExternalEvent[];
}
export interface Event {
  sequence: number;
  event_id: string;
  kind: string;
  aggregate_id: string;
  aggregate_revision: number;
  project_id: string;
  causation_id: string;
  created_at: number;
  payload: unknown;
}
export interface Capability {
  status: 'supported' | 'unsupported' | 'unknown';
  evidence: string;
  /** ACP resume request method the agent declared in initialize. */
  method?: 'resume' | 'load';
}
export interface CapabilityReport {
  runtime: string;
  version: string;
  checked_at: string;
  capabilities: Record<string, Capability>;
}
export const NATIVE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  // Gate sandboxes point it at /dev/null; Homebrew Node cannot read its default config there.
  'OPENSSL_CONF',
  // Gate sandboxes set it; git aborts when it cannot read the system config there.
  'GIT_CONFIG_NOSYSTEM',
];
/** Daemon variables a session the user opened does not inherit; a name ending in `*` is a prefix. */
export const INHERITED_ENV_DENYLIST: readonly string[] = [
  // Sessions run only on the subscription the CLI is logged in to, never on a key or another endpoint.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'PANTHEON_*',
  'DYLD_*',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'ELECTRON_*',
  // Set by an outer Claude Code process the daemon runs under; a session that inherits them talks to it.
  'CLAUDECODE',
  'CLAUDE_CODE_*',
  'CLAUDE_AGENT_SDK_*',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];
export interface ProcessIdentity {
  pid: number;
  /** Microseconds since the Unix epoch. */
  start_time_us?: number;
  /** macOS p_uniqueid as a decimal string (uint64). */
  unique_id?: string;
  launchd_label?: string;
  /** Decimal string (uint64). */
  coalition_id?: string;
}
export interface SessionHandle {
  native_state_dir?: string;
  native_title?: string;
  platform_session_id: string;
  /** '' until the runtime reports it. The adapter updates the returned object in place. */
  native_session_id: string;
  requested_model?: string;
  requested_effort?: EffortLevel;
  /** Only a model identity reported by the runtime; absent means unknown. */
  reported_model?: string;
  adapter_version: string;
  device_id: string;
  process_identity?: ProcessIdentity;
  last_cursor?: string;
}
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface RemoteLaunch {
  /** Runs one POSIX shell command line on the device; the line is appended as the last argument. */
  transport: string[];
  /** As transport, without the session tools forward: for a command that ends before the runtime starts. */
  plain_transport?: string[];
  /** The runtime executable on the device. */
  binary: string;
  /** Set on the device before the runtime starts. */
  env?: Record<string, string>;
}
export interface SessionSpec {
  native_fork?: { session_id: string; after: string };
  native_state_dir?: string;
  /** The user-level ~/.pantheon directory; when absent no user instructions or skills are projected. */
  user_config_dir?: string;
  native_title?: string;
  /** The runtime names a new session itself; the adapter reports the name with title.generated. */
  auto_title?: boolean;
  platform_session_id: string;
  project_id: string;
  runtime: string;
  model?: string;
  effort?: EffortLevel;
  /** Resolved at launch; api_key lives only in memory. */
  backend?: { id: string; protocol: string; base_url: string; api_key: string };
  profile_version?: number;
  account_ref?: string;
  device_id: string;
  /** Present when device_id names another machine. */
  remote?: RemoteLaunch;
  locked_version?: string;
  role: Role;
  workspace?: { id: string; path: string };
  /** A session the user opened directly, without Pantheon tools: it runs as the bare runtime would. */
  user_session?: true;
  /** A runtime analyst receives evidence only through its bound MCP tools. */
  runtime_analysis?: true;
  /** A planner may also run the Bash commands readOnlyBash judges read-only. */
  read_only_shell?: true;
  sandbox?: {
    writable_roots: string[];
    protected_entries: { path: string; deny: 'read_write' | 'write' }[];
  };
  cwd: string;
  /** Every project folder for a planning session; cwd is only its launch directory. */
  project_roots?: { path: string; git: boolean }[];
  /** Daemon-owned instructions for a finite, purpose-bound planner session. */
  control_instructions?: string;
  env_allowlist: readonly string[];
  /** Project variables for the native process; allowlisted and native state variables win. */
  env?: Record<string, string>;
  skills: string[];
  mcp_servers: McpServerSpec[];
  pantheon_mcp?: {
    command: string;
    args: string[];
    env: Record<string, string>;
    /** MCP names of Pantheon tools that need the user's approval for every call. */
    ask_tools?: string[];
  };
  extensions?: { mode: 'inherit'; overrides: ExtensionOverrides } | { mode: 'none' };
  budget: {
    /** Native agentic turns allowed within one user turn. */
    max_turns: number;
    /** Per user turn, counted from send(). */
    wall_time_ms: number;
  };
  /** Set only for a workbench session; other sessions keep their role's tool rights. */
  permission_mode?: PermissionMode;
  fast?: true;
  ultracode?: true;
  /** Calls matching these rule keys (see permissionRule) run without asking. */
  allowed_rules?: string[];
}
export const PLAN_MODE_INSTRUCTION =
  'Plan mode is on: read and plan only, then call ExitPlanMode with the plan.';
export interface UserTurn {
  turn_id: string;
  input: string;
  /** Requests manual compaction; input holds only its optional instructions. */
  compact?: true;
  attachments?: TurnAttachment[];
  skills?: TurnSkill[];
  /** The session's plan has an unfinished task; the runtime allows only reads and Pantheon tools. */
  read_only?: boolean;
}
export interface DeliveryReceipt {
  turn_id: string;
  status: 'delivered' | 'queued' | 'unsupported';
  reason?: string;
}
export interface Receipt {
  ok: boolean;
  reason?: string;
  /** The session process is running but holds no pending permission request with this id. */
  unknown_request?: boolean;
  /** The runtime still holds the request but cannot take this decision. */
  refused?: boolean;
}
export interface NativeStatus {
  state: 'idle' | 'running' | 'exited' | 'unknown';
  native_session_id: string;
  process_identity?: ProcessIdentity;
  observed_at: string;
}
export interface StopEvidence {
  method: 'process_group' | 'coalition' | 'none';
  members: ProcessIdentity[];
  exits?: { pid: number; code: number | null; signal: string | null }[];
  /** Members alive after the last signal, observed on the whole group, not its leader; 0 confirms the stop. */
  live_count?: number;
  /** The coalition was already reaped (ESRCH). */
  reaped?: boolean;
  signals?: { pid: number; signal: string; at: string }[];
}
export interface CancelReceipt {
  stopped: boolean;
  /** Epoch milliseconds. */
  deadline: number;
  finished_at: string;
  evidence: StopEvidence;
  reason?: string;
}
/** A start/resume failure after a process was spawned; stop tells whether it was confirmed stopped. */
export class SessionStartError extends DomainError {
  constructor(
    message: string,
    public readonly stop: CancelReceipt,
  ) {
    super('session_start_failed', message);
    this.name = 'SessionStartError';
  }
}
/** allow_session also allows later calls with the same rule key for the rest of the session. */
export type PermissionDecision = 'allow' | 'allow_session' | 'deny';
export type CostSource = 'provider_reported' | 'estimated' | 'unknown';
/** A command or agent the model started in the background, which runs on after its tool call returned. */
export interface BackgroundTask {
  id: string;
  kind: 'shell' | 'agent' | 'other';
  description: string;
  /** Epoch milliseconds when the adapter first saw the task; the runtimes report no start time. */
  started_at: number;
}
/** A subagent, shell or workflow a session's runtime started, keyed by the runtime's task id. */
export interface SessionTask {
  id: string;
  session_id: string;
  kind: 'agent' | 'shell' | 'workflow' | 'other';
  /** The tool call that dispatched the task. */
  tool_call_id?: string;
  parent_task_id?: string;
  depth?: number;
  description: string;
  agent_type?: string;
  background: boolean;
  state: 'running' | 'completed' | 'failed' | 'stopped';
  end_reason?: 'ended_in_background' | 'process_restarted';
  started_at: number;
  ended_at?: number;
  usage?: { tokens: number; tool_uses: number; duration_ms: number };
  last_tool?: string;
  summary?: string;
  output_file?: string;
}
/** A subscription quota window; reset times are Unix epoch milliseconds when reported. */
export interface QuotaWindow {
  window: string;
  used_percent: number;
  resets_at?: number;
}
export type AgentEvent = {
  /** Unique within one handle; the caller deduplicates on it. */
  key: string;
  /** 1, 2, 3… in the order one handle emits its events. */
  provider_sequence: number;
  turn_id?: string;
  native_type?: string;
  parent_tool_use_id?: string;
  native_payload_ref?: string;
  native?: unknown;
  /** Exact native resume point before the reported span, when available. */
  native_history_before?: string;
} & (
  | {
      kind: 'session.started';
      native_session_id: string;
      requested_model?: string;
      reported_model?: string;
      raw_tool_events?: 'enabled' | 'unavailable_on_resume';
    }
  | {
      kind: 'auth.checked';
      channel: 'subscription';
      method: 'chatgpt' | 'claude.ai';
      plan?: string;
    }
  /** The extension inventory could not be read; the session started without its adjustments. */
  | { kind: 'extensions.unread'; reason: string }
  | {
      kind: 'extensions.applied';
      mode: 'inherit' | 'none';
      disabled: {
        mcp_servers: string[];
        plugins: string[];
        skills: string[];
        apps: boolean;
        hooks: boolean;
      };
      loaded: {
        mcp_servers: string[];
        plugins: string[];
        skills: string[];
        apps: boolean;
        hooks: boolean;
      };
      /** Submitted native skill policy; a configuration projection, not an invocation receipt. */
      configured_skills?: {
        allowlist: string[];
        /** Exact native permission deny rules, e.g. Skill(name). */
        denied: string[];
        source: 'sdk_options_and_permission_rules';
      };
      not_applied?: { item: string; reason: string }[];
    }
  | { kind: 'quota.updated'; windows: QuotaWindow[] }
  | { kind: 'runtime.disconnected'; reason: string }
  | { kind: 'turn.started' }
  | {
      kind: 'turn.retrying';
      attempt: number;
      retry_at?: number;
      reason: 'rate_limit' | 'overloaded' | 'network';
    }
  | { kind: 'message.delta'; text: string }
  /** Readable reasoning of the model; summary marks the runtime's summary of it. */
  | { kind: 'reasoning'; text: string; summary?: true }
  | {
      kind: 'tool.started';
      tool_call_id: string;
      name: string;
      input?: unknown;
      /** The MCP tool declares a ui:// interface on this server. */
      app?: { server: string; resource_uri: string };
    }
  | { kind: 'visual.drawing'; tool_call_id: string; received_bytes: number }
  | {
      kind: 'tool.completed';
      tool_call_id: string;
      ok: boolean;
      output?: unknown;
      duration_ms?: number;
      /** The MCP CallToolResult of a call whose tool.started carried app. */
      app_result?: {
        content: unknown[];
        structuredContent?: unknown;
        isError?: boolean;
        _meta?: Record<string, unknown>;
      };
      /**
       * Images the call returned, base64, whole, which the traced output cuts short. The recorded
       * event keeps only `{ mime, hash, size }`; the bytes go to the artifact files.
       */
      images?: { mime: string; data: string }[];
      /** The claude.ai page a Claude Artifact call published from the local file at `path`. */
      artifact?: { url: string; path: string; title?: string; version?: string };
    }
  | {
      kind: 'permission.requested';
      request_id: string;
      tool?: string;
      /** Allowed-rule key computed from the complete input; detail may be truncated. */
      rule?: string;
      /** The adapter has a reusable rule key for this request. */
      project_rule_supported?: boolean;
      detail?: unknown;
    }
  | {
      kind: 'permission.resolved';
      request_id: string;
      decision: PermissionDecision;
      /** The adapter withdrew the request without an answer: the turn ended or the session closed. */
      cancelled?: true;
    }
  | {
      kind: 'usage.updated';
      auto_compact_at_tokens?: number;
      cost_usd?: number;
      cost_source: CostSource;
      input_tokens?: number;
      /** Part of input_tokens served from cache reads. */
      cached_input_tokens?: number;
      cache_write_input_tokens?: number;
      output_tokens?: number;
      /** Part of output_tokens spent on reasoning. */
      reasoning_output_tokens?: number;
      /** Approximate context occupancy after the latest model request. */
      context_tokens?: number;
      context_window?: number;
      context_breakdown?: ContextBreakdown;
    }
  | { kind: 'context.compacting'; trigger: 'auto' | 'manual'; pre_tokens?: number }
  | {
      kind: 'context.compacted';
      trigger?: 'auto' | 'manual';
      /** Context occupancy before the compaction, in tokens. */
      pre_tokens?: number;
    }
  /** The title the runtime generated for the session. */
  | { kind: 'title.generated'; title: string }
  /** Every background task running now; it replaces the list of the previous event. */
  | { kind: 'background.changed'; tasks: BackgroundTask[] }
  | { kind: 'fast_mode.changed'; state: 'on' | 'off' | 'cooldown'; reason?: string }
  | {
      kind: 'turn.completed';
      native_history_end?: string;
      status: 'completed' | 'failed' | 'interrupted';
      error?: string;
      error_code?: string;
      /** Unix epoch milliseconds when the used-up limit resets; absent when unknown. */
      resets_at?: number;
    }
  | { kind: 'session.exited'; code?: number | null; signal?: string | null }
  | {
      kind: 'task.started';
      task: Omit<
        SessionTask,
        | 'session_id'
        | 'state'
        | 'ended_at'
        | 'end_reason'
        | 'usage'
        | 'last_tool'
        | 'summary'
        | 'output_file'
      >;
    }
  | {
      kind: 'task.progress';
      task_id: string;
      usage?: SessionTask['usage'];
      last_tool?: string;
      summary?: string;
    }
  | {
      kind: 'task.ended';
      task_id: string;
      state: 'completed' | 'failed' | 'stopped';
      summary?: string;
      usage?: SessionTask['usage'];
      output_file?: string;
    }
  | { kind: 'error'; message: string }
  | { kind: 'native' }
);
export type AgentEventSink = (event: AgentEvent) => void;
/** Whether a runtime is installed, recent enough and logged in on this machine. */
export interface RuntimeStatus {
  runtime: string;
  installed: boolean;
  version: string | null;
  min_version: string | null;
  /** null when the version or the minimum is unknown. */
  version_ok: boolean | null;
  auth: {
    state: 'ok' | 'logged_out' | 'unsupported_channel' | 'unknown';
    email?: string;
    plan?: string;
    reason?: string;
  };
  /** ISO time of the check. */
  checked_at: string;
  error?: string;
}
export interface HarnessAdapter {
  name: string;
  report: CapabilityReport;
  /** Backend protocols this runtime can send to; absent means only its own login. */
  backendProtocols?: readonly string[];
  /** The tool the agent asks the user a question with; absent means it has none. */
  questionTool?: string;
  /** The runtime names a session given auto_title and reports the name with title.generated. */
  generatesTitles?: boolean;
  probe(): Promise<CapabilityReport>;
  inventory?(cwd: string): Promise<ExtensionInventory>;
  models?(cwd: string): Promise<RuntimeModel[]>;
  /** Checks a fresh native connection without sending a model turn. */
  reconnect?(): Promise<void>;
  mcpStatus?(cwd: string, handle?: SessionHandle): Promise<McpServerStatus[]>;
  reconnectMcp?(server: string, handle: SessionHandle): Promise<void>;
  /** Reads an MCP resource through the live session's runtime; returns the resources/read result. */
  readMcpResource?(
    handle: SessionHandle,
    server: string,
    uri: string,
  ): Promise<McpResourceContents>;
  /** Calls an MCP tool through the live session's runtime without a model turn; returns the tools/call result. */
  callMcpTool?(
    handle: SessionHandle,
    server: string,
    tool: string,
    args: Record<string, unknown> | undefined,
  ): Promise<McpToolResult>;
  /** A tool the live session's server lists, with its declared _meta.ui.visibility; undefined when not listed. */
  findMcpTool?(
    handle: SessionHandle,
    server: string,
    tool: string,
  ): Promise<{ visibility?: string[] } | undefined>;
  /** Checks the installed binary, its version and its login. */
  preflight?(): Promise<Omit<RuntimeStatus, 'runtime' | 'checked_at'>>;
  /** After spawning a process it rejects only with SessionStartError; resume follows the same rule. */
  start(spec: SessionSpec, sink: AgentEventSink): Promise<SessionHandle>;
  resume?(
    spec: SessionSpec,
    native_session_id: string,
    sink: AgentEventSink,
  ): Promise<SessionHandle>;
  /** For a handle this adapter did not return: state unknown and no process_identity. */
  inspect(handle: SessionHandle): Promise<NativeStatus>;
  attach?(
    handle: SessionHandle,
    cursor: string | undefined,
    sink: AgentEventSink,
  ): Promise<Receipt>;
  /** Every delivered turn ends with exactly one turn.completed event, also on failure, deadline and cancel; nothing of that turn follows it. */
  send(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt>;
  steer?(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt>;
  /** Ends the running turn with turn.completed status interrupted, keeps the native session for the next send and drops that turn's undelivered steers. */
  interrupt?(handle: SessionHandle): Promise<Receipt>;
  /** Stops one background task of the last background.changed; rejects when the runtime refuses. */
  stopBackground?(handle: SessionHandle, taskId: string): Promise<void>;
  /** Applies the mode to the running native session and to every later one of the handle. */
  setPermissionMode?(
    handle: SessionHandle,
    mode: NonNullable<SessionSpec['permission_mode']>,
  ): Promise<Receipt>;
  setFastMode?(handle: SessionHandle, fast: boolean): Promise<Receipt>;
  setUltracode?(handle: SessionHandle, ultracode: boolean): Promise<Receipt>;
  /** Sets the read-only flag of the running turn for its later tool calls; a later turn takes it from its UserTurn. */
  setTurnReadOnly?(handle: SessionHandle, readOnly: boolean): void;
  /** Applies the model and effort to the running native session and to every later one of the handle. */
  setModel?(
    handle: SessionHandle,
    model: string,
    effort: EffortLevel | undefined,
    fast?: boolean,
  ): Promise<Receipt>;
  /** answers fill an AskUserQuestion request; reason explains a denial to the agent. */
  answerPermission(
    handle: SessionHandle,
    request_id: string,
    decision: PermissionDecision,
    answers?: Record<string, string>,
    reason?: string,
  ): Promise<Receipt>;
  /**
   * Resolves by the deadline, after the in-flight turn has emitted its turn.completed.
   * stopped is true only with evidence that no member is alive, or when the handle never spawned a process;
   * without whole-tree observation (Windows today) it is never true for a spawned process.
   */
  cancel(handle: SessionHandle, deadline: number): Promise<CancelReceipt>;
  /** Ends the session and interrupts a turn still in flight; receipt rules as for cancel. */
  close(handle: SessionHandle, deadline: number): Promise<CancelReceipt>;
}

export interface McpServerStatus {
  name: string;
  state: 'connected' | 'failed' | 'needs_sign_in' | 'pending' | 'disabled' | 'unknown';
  reason?: string;
}

/** An MCP resources/read result; blob is base64. */
export interface McpResourceContents {
  contents: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    _meta?: Record<string, unknown>;
  }[];
}

/** An MCP tools/call result. */
export interface McpToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

type RetrospectiveTokens = Pick<
  Usage,
  'input_tokens' | 'cached_input_tokens' | 'cache_write_input_tokens' | 'output_tokens'
>;
/** What the daemon recorded about one task when it merged, was accepted, failed or was removed. */
export interface Retrospective extends Entity {
  project_id: string;
  lead_session_id: string;
  task_id: string;
  session_ids: string[];
  outcome: 'merged' | 'accepted' | 'failed' | 'removed';
  /** Who stopped the last session; only on a failed row, and absent when no one stopped it. */
  stopped_by?: 'user' | 'lead';
  /** Unix epoch milliseconds. */
  recorded_at: number;
  /** The kind the plan gave the task; absent when it gave none. */
  planned_kind?: TaskKind;
  path?: FlowPath;
  runtime?: string;
  /** The full model id the runtime reported. */
  model?: string;
  effort?: EffortLevel;
  /** Each time the task was handed back, in order. */
  handbacks?: { reason: string }[];
  /** Which gate run passed, counting from 1; absent when none passed. */
  gate_passed_on_attempt?: number;
  /** The class of each failed gate run, in order. */
  gate_failures?: GateFailureClass[];
  /** The name of the first failed check of each failed gate run, in order. */
  gate_failed_checks?: string[];
  scope_violations?: number;
  stalls?: number;
  loops?: number;
  /** Runtime evidence captured when this retrospective was recorded. */
  runtime_findings?: import('./trace.js').RuntimeFinding[];
  /** Total time spent waiting for approvals, in milliseconds. */
  approval_wait_ms?: number;
  /** The error code of each failed turn, such as modelNotFound. */
  turn_failure_codes?: string[];
  /** How many times the lead was woken for the task. */
  lead_wakes?: number;
  /** How many of those wakes ended without a decision written. */
  lead_wakes_without_decision?: number;
  /** Tokens the lead session spent on the task, in tokens. */
  lead_usage?: RetrospectiveTokens;
  /** Tokens the task sessions spent, in tokens. */
  task_usage?: RetrospectiveTokens;
  /** Wall-clock time in each stage, in milliseconds; a stage the task never reached is absent. */
  stage_ms?: {
    planning?: number;
    dispatch_wait?: number;
    execution?: number;
    gate_and_merge?: number;
    merge_to_acceptance?: number;
    /** Waiting for the user on workflow approval steps, taken out of the stage it fell in. */
    step_approval?: number;
  };
  /** The larger of the task's input token and wall-clock ratios to its cell's budget; absent without a budget. */
  budget_ratio?: number;
  /** When this generation of the task was first dispatched or claimed, Unix epoch milliseconds; absent when it never was. */
  started_at?: number;
  /** The policy version in force when the task started. */
  policy_version?: number;
  /**
   * What the row records: a task of a lead's plan, or a session the user opened that landed its
   * work, whose lead_session_id is the session's own id and task_id 'session'. Absent means plan_task.
   */
  origin?: 'plan_task' | 'session';
}
export interface ProjectRead {
  memory?: import('./memory.js').MemoryContext;
  project: Project;
  brief?: ProjectBrief;
  cursor: number;
  /** The calling session; absent for the user. */
  you?: { session_id: string; role: Role };
}

export * from './memory.js';
