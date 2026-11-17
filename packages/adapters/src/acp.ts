import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DomainError,
  SessionStartError,
  type AgentEvent,
  type AgentEventSink,
  type ApprovalQuestion,
  type CancelReceipt,
  type CapabilityReport,
  type CostSource,
  type DeliveryReceipt,
  type EffortLevel,
  type ExtensionInventory,
  type HarnessAdapter,
  type NativeStatus,
  type PermissionDecision,
  type PermissionMode,
  type Receipt,
  type RuntimeModel,
  type SessionHandle,
  type SessionSpec,
  type UserTurn,
} from '@pantheon/domain';
import {
  CLIENT_INFO,
  JsonRpcProcess,
  nativeEnvironment,
  processIdentity,
  report,
  validateSessionSpec,
  versionOf,
} from './process.js';
import type { AcpProfile } from './acp-profiles.js';
import { agySkillDirs, prepareNativeState } from './native-state.js';

type EventBody<E = AgentEvent> = E extends AgentEvent
  ? Omit<E, 'key' | 'provider_sequence'>
  : never;
type Frame = { id?: number | string; method: string; params?: Record<string, unknown> };
type Reply = (response: { result: unknown } | { error: { code: number; message: string } }) => void;
interface SelectChoice {
  value: string;
  name?: string | null;
  description?: string | null;
}
interface ConfigOption {
  id: string;
  category?: string | null;
  currentValue?: unknown;
  /** A select's choices, flat or in named groups. */
  options?:
    (SelectChoice | { group: string; name?: string | null; options: SelectChoice[] })[] | null;
}
interface PermissionOption {
  optionId: string;
  kind: string;
}
interface ElicitationProperty {
  type?: string;
  title?: string | null;
  description?: string | null;
  format?: string | null;
  enum?: string[] | null;
  oneOf?: { const: string; title: string }[] | null;
}
/** A form field as a question card, with the value each option label stands for. */
interface ElicitedField {
  name: string;
  type: string;
  question: ApprovalQuestion;
  values: Map<string, string | boolean>;
}
interface ToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  kind?: string | null;
  status?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}
/** The unstable PromptResponse.usage: inputTokens leaves out the cache, thoughtTokens is part of outputTokens. */
interface PromptUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedWriteTokens?: number | null;
}
interface AcpTurn {
  id: string;
  readOnly: boolean;
  interrupted?: boolean;
  /** Completion is reported, but the prompt is still open until the agent answers it. */
  ended?: boolean;
  /** Resolves once the prompt is answered or the transport ends. */
  settled: Promise<void>;
  /** The cumulative session cost when the turn started. */
  costBase: number;
  /** From the latest usage_update, kept when the prompt response adds the tokens. */
  costSource?: CostSource;
  /**
   * An undefined decision withdraws the request with the cancelled outcome. A returned reason
   * refuses the decision and leaves the request pending.
   */
  permissions: Map<
    string,
    (
      decision: PermissionDecision | undefined,
      answers?: Record<string, string>,
    ) => string | undefined
  >;
  /** The pending permission requests for write kinds. */
  writes: Set<string>;
  /** Each tool call's fields merged across its frames, which carry only what changed. */
  tools: Map<string, ToolCallUpdate>;
  pauseClock: (paused: boolean) => void;
  finish: (
    status: 'completed' | 'failed' | 'interrupted',
    error?: string,
    error_code?: string,
  ) => void;
}
interface AcpSession {
  rpc: JsonRpcProcess;
  emit: (event: EventBody) => void;
  wallTimeMs: number;
  configOptions: ConfigOption[];
  images: boolean;
  stopping: boolean;
  /** The latest cumulative session cost in USD the agent reported. */
  costUsd: number;
  /** The last model change; the next waits for it so a rollback cannot undo a later change. */
  configuring: Promise<string | undefined>;
  /** Input waiting for an ended turn's prompt to settle; interrupt and setTurnReadOnly apply to it. */
  queued?: { readOnly: boolean; interrupted?: boolean };
  /** Sent ahead of the first prompt, then cleared. */
  instructions?: string;
  /** The instructions once sent; an agent that titles the session from its first text block quotes them. */
  sentInstructions?: string;
  turn?: AcpTurn;
}

/** A JSON-RPC error's own detail (data.message, else message); other failures as they are. */
function rpcErrorText(text: string): string {
  let error: { message?: unknown; data?: { message?: unknown } };
  try {
    error = JSON.parse(text);
  } catch {
    // Timeouts and a closed transport are plain text.
    return text;
  }
  const detail = error?.data?.message ?? error?.message;
  return typeof detail === 'string' && detail ? detail : text;
}

// Tool kinds a read-only turn refuses without asking the user.
const WRITE_KINDS = ['edit', 'delete', 'move', 'execute'];
const TITLE_KINDS: Record<string, string> = {
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  multi_edit: 'edit',
  search_replace: 'edit',
  apply_patch: 'edit',
  notebookedit: 'edit',
  delete: 'delete',
  remove: 'delete',
  rm: 'delete',
  move: 'move',
  rename: 'move',
  mv: 'move',
  read: 'read',
  read_file: 'read',
  read_image: 'read',
  view: 'read',
  cat: 'read',
  grep: 'search',
  glob: 'search',
  search: 'search',
  find: 'search',
  list_dir: 'search',
  ls: 'search',
  fetch: 'fetch',
  web_fetch: 'fetch',
  webfetch: 'fetch',
  web_search: 'fetch',
};

/** The call's declared kind unless it is other or unset; then one inferred from its input or title. */
function toolKind(call: Partial<ToolCallUpdate>): string | undefined {
  if (call.kind && call.kind !== 'other') return call.kind;
  const input = call.rawInput as { command?: unknown; cmd?: unknown } | null | undefined;
  if (typeof input?.command === 'string' || typeof input?.cmd === 'string') return 'execute';
  const word = (call.title ?? '')
    .trim()
    .toLowerCase()
    .split(/[\s:(]/)[0]!;
  return (
    (Object.hasOwn(TITLE_KINDS, word) ? TITLE_KINDS[word] : undefined) ?? call.kind ?? undefined
  );
}

interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean };
  sessionCapabilities?: { resume?: unknown; close?: unknown };
}

/** Resume first: agy's session/load also succeeds for ids that do not exist. */
function resumeMethod(capabilities: AgentCapabilities | undefined): 'resume' | 'load' | undefined {
  if (capabilities?.sessionCapabilities?.resume != null) return 'resume';
  if (capabilities?.loadSession === true) return 'load';
  return undefined;
}
/** How long a send waits for an agent to answer a prompt cancelled at its deadline. */
const CANCEL_GRACE_MS = 10_000;
const DECISION_OPTIONS: Record<PermissionDecision, string[]> = {
  allow: ['allow_once'],
  allow_session: ['allow_always', 'allow_once'],
  deny: ['reject_once', 'reject_always'],
};

function chooseOption(options: PermissionOption[], kinds: string[]): string | undefined {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) return option.optionId;
  }
  return undefined;
}

function fieldChoices(property: ElicitationProperty): [string, string | boolean][] | undefined {
  switch (property.type) {
    case 'boolean':
      return [
        ['Yes', true],
        ['No', false],
      ];
    case 'number':
    case 'integer':
      return [];
    case 'string':
      return property.oneOf
        ? property.oneOf.map((option) => [option.title, option.const])
        : (property.enum ?? []).map((value) => [value, value]);
    default:
      return undefined;
  }
}

/** A form's fields as question cards; undefined when one has no card or they exceed a card's limits. */
function elicitedFields(
  properties: Record<string, ElicitationProperty>,
): ElicitedField[] | undefined {
  const fields: ElicitedField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const choices = fieldChoices(property);
    if (!choices || choices.length > 4 || choices.some(([label]) => !label)) return undefined;
    fields.push({
      name,
      type: property.type!,
      values: new Map(choices),
      question: {
        question: property.title || property.description || name,
        header: name,
        options: choices.map(([label]) => ({ label, description: '' })),
        multiSelect: false,
        other: choices.length === 0,
        ...(property.format === 'password' ? { secret: true } : {}),
      },
    });
  }
  // Answers come back keyed by question text.
  const distinct = new Set(fields.map((field) => field.question.question)).size;
  return fields.length && fields.length <= 4 && distinct === fields.length ? fields : undefined;
}

const choices = (option: ConfigOption | undefined): SelectChoice[] =>
  (option?.options ?? []).flatMap((entry) => ('group' in entry ? entry.options : [entry]));

/** Each choice's name by value; a name that more than one group uses carries its group's name. */
function choiceLabels(option: ConfigOption | undefined): Map<string, string> {
  const named = (option?.options ?? []).flatMap(
    (entry): { choice: SelectChoice; group?: string }[] =>
      'group' in entry
        ? entry.options.map((choice) => ({ choice, group: entry.name || entry.group }))
        : [{ choice: entry }],
  );
  const uses = new Map<string, number>();
  for (const { choice } of named) {
    const name = choice.name || choice.value;
    uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  return new Map(
    named.map(({ choice, group }) => {
      const name = choice.name || choice.value;
      return [choice.value, group && uses.get(name)! > 1 ? `${name} (${group})` : name];
    }),
  );
}

const EFFORTS: readonly EffortLevel[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
/** The effort level a thought level value names; ACP agents call none off. */
const effortLevel = (value: unknown): EffortLevel | undefined =>
  value === 'off' ? 'none' : EFFORTS.find((level) => level === value);

/** The current model by its option name, since the value may be an encoding only the agent reads. */
function reportedModel(options: ConfigOption[]): string | undefined {
  const model = options.find((option) => option.category === 'model');
  const value = model?.currentValue;
  if (typeof value !== 'string' || !value) return undefined;
  return choiceLabels(model).get(value) ?? value;
}

/** The agent's model choices, each with the thought levels that name an effort level. */
function listedModels(options: ConfigOption[], permission_modes: PermissionMode[]): RuntimeModel[] {
  const model = options.find((option) => option.category === 'model');
  const thought = options.find((option) => option.category === 'thought_level');
  const efforts = choices(thought).flatMap((choice) => effortLevel(choice.value) ?? []);
  const default_effort = effortLevel(thought?.currentValue) ?? null;
  const labels = choiceLabels(model);
  return choices(model).map((choice) => ({
    id: choice.value,
    label: labels.get(choice.value)!,
    ...(choice.description ? { description: choice.description } : {}),
    // The adapter sets no ACP mode; only a profile's launch environment picks one.
    permission_modes,
    efforts,
    default_effort,
    default: choice.value === model?.currentValue,
    // What reportedModel gives for this choice.
    ...(labels.get(choice.value) !== choice.value ? { resolved: labels.get(choice.value) } : {}),
  }));
}

/** The user-level MCP servers and skills agy reads from its configuration files. */
function agyInventory(home: string): ExtensionInventory {
  const servers = path.join(home, '.gemini', 'config', 'mcp_config.json');
  const mcpServers = existsSync(servers)
    ? ((JSON.parse(readFileSync(servers, 'utf8')) as { mcpServers?: object }).mcpServers ?? {})
    : {};
  const skills = new Set<string>();
  for (const dir of agySkillDirs(home))
    if (existsSync(dir))
      for (const name of readdirSync(dir))
        if (
          !name.startsWith('.') &&
          statSync(path.join(dir, name), { throwIfNoEntry: false })?.isDirectory()
        )
          skills.add(name);
  return {
    runtime: 'agy',
    mcp_servers: Object.keys(mcpServers).map((name) => ({ name, enabled: true, user: true })),
    plugins: [],
    skills: [...skills].map((name) => ({ id: name, name, enabled: true, user: true })),
    apps: false,
    connectors: [],
    hooks: [],
  };
}

interface GrokInspection {
  mcpServers?: {
    name: string;
    source: { path: string };
    compatibilityStatus?: string;
    disabledReason?: string;
  }[];
  skills?: { name: string; source: { path: string }; disabled?: boolean }[];
  plugins?: { name: string; enabled: boolean }[];
}

/** The MCP servers, skills and plugins `grok inspect` finds for a folder, the user's own marked. */
async function grokInventory(
  binary: string,
  home: string,
  cwd: string,
  timeout: number,
): Promise<ExtensionInventory> {
  const output = await new Promise<string>((resolve, reject) =>
    execFile(
      binary,
      ['inspect', '--json'],
      { cwd, env: nativeEnvironment(), timeout, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  const found = JSON.parse(output) as GrokInspection;
  const userFiles = [path.join(home, '.claude.json'), path.join(home, '.grok', 'config.toml')];
  // A managed session links only the skill folders directly inside these.
  const userSkills = [
    path.join(home, '.grok', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.agents', 'skills'),
  ];
  return {
    runtime: 'grok',
    mcp_servers: (found.mcpServers ?? []).map((server) => ({
      name: server.name,
      enabled: !server.disabledReason && server.compatibilityStatus !== 'disabled',
      ...(userFiles.includes(server.source.path) ? { user: true } : {}),
    })),
    plugins: (found.plugins ?? []).map((plugin) => ({ id: plugin.name, enabled: plugin.enabled })),
    skills: (found.skills ?? []).map((skill) => {
      const folder = path.dirname(skill.source.path);
      return {
        id: path.basename(folder),
        name: skill.name,
        enabled: skill.disabled !== true,
        ...(userSkills.includes(path.dirname(folder)) ? { user: true } : {}),
      };
    }),
    apps: false,
    connectors: [],
    hooks: [],
  };
}

/** A runtime that speaks the Agent Client Protocol on stdio, one agent process per session. */
export class AcpAdapter implements HarnessAdapter {
  readonly name: string;
  readonly binary: string;
  readonly args: string[];
  report: CapabilityReport;
  inventory?: (cwd: string) => Promise<ExtensionInventory>;
  private readonly requestTimeoutMs: number | undefined;
  private readonly profile: AcpProfile;
  private readonly home: string;
  private sessions = new WeakMap<SessionHandle, AcpSession>();
  constructor(options: {
    name: string;
    profile: AcpProfile;
    binary?: string;
    args?: string[];
    version?: string;
    requestTimeoutMs?: number;
    home?: string;
  }) {
    this.name = options.name;
    this.profile = options.profile;
    this.binary = options.binary ?? options.profile.binary;
    this.args = [...options.profile.args, ...(options.args ?? [])];
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.home = options.home ?? os.homedir();
    if (this.name === 'agy') this.inventory = async () => agyInventory(this.home);
    // An unset request timeout means the 5 seconds a JSON-RPC request waits by default.
    if (this.name === 'grok')
      this.inventory = (cwd) =>
        grokInventory(this.binary, this.home, cwd, this.requestTimeoutMs ?? 5000);
    this.report = report(this.name, options.version ?? 'unprobed', false, {
      images: { status: 'unknown', evidence: 'Awaiting ACP initialize promptCapabilities.image' },
      // Control resumes only a supported runtime, possibly before any handshake; open checks the declaration.
      resume: {
        status: 'supported',
        evidence: 'Awaiting ACP initialize; resume picks session/resume or session/load from it',
      },
      deny_reason: { status: 'unsupported', evidence: 'ACP permission options carry no reason' },
      steer: { status: 'unsupported', evidence: 'The ACP adapter cannot steer a running turn' },
      turn_model_change: {
        status: 'supported',
        evidence: 'setModel sends session/set_config_option, also during a turn',
      },
      // A profile that picks the sandbox at launch keeps the verdict its runtime was verified with.
      ...(this.profile.permissionEnv
        ? {}
        : {
            write_isolation: {
              status: 'unsupported',
              evidence: 'ACP runtimes have no verified write isolation',
            },
          }),
    });
  }
  async probe(): Promise<CapabilityReport> {
    this.report = {
      ...this.report,
      version: versionOf(this.binary),
      checked_at: new Date().toISOString(),
    };
    return this.report;
  }
  async reconnect(): Promise<void> {
    const rpc = new JsonRpcProcess(
      this.binary,
      this.args,
      undefined,
      undefined,
      {},
      {
        jsonrpc: true,
      },
    );
    try {
      const initialized = (await rpc.initialize(
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: CLIENT_INFO,
        },
        null,
        this.requestTimeoutMs,
      )) as { agentCapabilities?: AgentCapabilities };
      this.declaredResume(initialized.agentCapabilities);
    } finally {
      await rpc.close();
    }
  }
  /** Records the resume method initialize declares and returns it. */
  private declaredResume(
    capabilities: AgentCapabilities | undefined,
  ): 'resume' | 'load' | undefined {
    const method = resumeMethod(capabilities);
    this.report.capabilities.resume = method
      ? {
          status: 'supported',
          method,
          evidence: `ACP initialize declares ${method === 'resume' ? 'sessionCapabilities.resume' : 'loadSession'}`,
        }
      : {
          status: 'unsupported',
          evidence: 'ACP initialize declares neither sessionCapabilities.resume nor loadSession',
        };
    return method;
  }
  /** Keeps verified evidence; otherwise a session the agent opened is evidence of text execution. */
  private openedSession(method: string): void {
    if (this.report.capabilities.text_execution?.status === 'supported') return;
    this.report.capabilities.text_execution = {
      status: 'supported',
      evidence: `ACP initialize and ${method} succeeded with ${this.binary} ${this.report.version} on ${new Date().toISOString()}`,
    };
  }
  /** The models the agent's config options offer in a probe session opened in cwd. */
  async models(cwd: string): Promise<RuntimeModel[]> {
    const rpc = new JsonRpcProcess(
      this.binary,
      [...this.args, ...(this.profile.listArgs ?? [])],
      cwd,
      undefined,
      {},
      { jsonrpc: true },
    );
    try {
      const initialized = (await rpc.initialize(
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: CLIENT_INFO,
        },
        null,
        this.requestTimeoutMs,
      )) as { agentCapabilities?: AgentCapabilities };
      this.declaredResume(initialized.agentCapabilities);
      const created = await rpc.request<{
        sessionId?: string;
        configOptions?: ConfigOption[] | null;
      }>('session/new', { cwd, mcpServers: [] }, this.requestTimeoutMs);
      if (created?.sessionId) this.openedSession('session/new');
      if (created?.sessionId && initialized.agentCapabilities?.sessionCapabilities?.close)
        await rpc.request('session/close', { sessionId: created.sessionId }, this.requestTimeoutMs);
      return listedModels(created?.configOptions ?? [], this.profile.permissionModes ?? []);
    } finally {
      await rpc.close();
    }
  }
  async start(spec: SessionSpec, emit: AgentEventSink): Promise<SessionHandle> {
    return this.open(spec, undefined, emit);
  }
  async resume(
    spec: SessionSpec,
    native_session_id: string,
    emit: AgentEventSink,
  ): Promise<SessionHandle> {
    return this.open(spec, native_session_id, emit);
  }
  private async open(
    spec: SessionSpec,
    native_session_id: string | undefined,
    sink: AgentEventSink,
  ): Promise<SessionHandle> {
    validateSessionSpec(spec, this.report.version);
    // Native state lives on this machine, so a session on another device runs without it.
    const state =
      (this.name === 'agy' || this.name === 'grok') && !spec.remote
        ? prepareNativeState(this.name, spec, this.home)
        : { env: {}, args: [] };
    const permissionEnv = this.profile.permissionEnv?.(spec.permission_mode ?? 'ask') ?? {};
    const sandboxPatch =
      spec.sandbox && !spec.remote
        ? this.profile.sandboxPatch?.(spec.permission_mode ?? 'ask', spec.sandbox.writable_roots)
        : undefined;
    // The agent may write temporary folders, so the patch lives only until the agent has read it.
    const patchDir = sandboxPatch
      ? mkdtempSync(path.join(os.tmpdir(), 'pantheon-acp-patch-'))
      : undefined;
    if (patchDir) writeFileSync(path.join(patchDir, 'sandbox.yml'), sandboxPatch!, { mode: 0o600 });
    const rpc = new JsonRpcProcess(
      spec.remote?.binary ?? this.binary,
      [
        ...this.args,
        ...state.args,
        ...(patchDir ? ['--patch', path.join(patchDir, 'sandbox.yml')] : []),
      ],
      spec.cwd,
      spec.env_allowlist,
      spec.remote
        ? { ...spec.env, ...permissionEnv }
        : {
            ...spec.env,
            ...nativeEnvironment(spec.env_allowlist),
            ...state.env,
            ...permissionEnv,
          },
      { jsonrpc: true, remote: spec.remote },
    );
    const handle: SessionHandle = {
      platform_session_id: spec.platform_session_id,
      native_session_id: native_session_id ?? '',
      adapter_version: this.report.version,
      device_id: spec.device_id,
      requested_model: spec.model,
      requested_effort: spec.effort,
      process_identity: rpc.child.pid ? processIdentity(rpc.child.pid) : undefined,
    };
    let sequence = 0;
    const session: AcpSession = {
      rpc,
      emit: (event) =>
        sink({ key: String(++sequence), provider_sequence: sequence, ...event } as AgentEvent),
      wallTimeMs: spec.budget.wall_time_ms,
      configOptions: [],
      images: false,
      stopping: false,
      costUsd: 0,
      configuring: Promise.resolve(undefined),
      ...((spec.role === 'writer' || spec.runtime_analysis) && spec.control_instructions
        ? { instructions: spec.control_instructions }
        : {}),
    };
    let ready = false;
    const early: Frame[] = [];
    const update = (frame: Frame): void => {
      const params = frame.params ?? {};
      if (params.sessionId !== handle.native_session_id) return;
      const value = (params.update ?? {}) as Record<string, unknown> & { sessionUpdate?: string };
      const native_type = String(value.sessionUpdate);
      const current = session.turn?.ended ? undefined : session.turn;
      const turn_id = current?.id;
      const tool = value as unknown as ToolCallUpdate;
      if (native_type === 'agent_message_chunk') {
        const content = value.content as { type?: string; text?: unknown } | undefined;
        if (current && content?.type === 'text')
          session.emit({ turn_id, native_type, kind: 'message.delta', text: String(content.text) });
        return;
      }
      if (native_type === 'tool_call' || native_type === 'tool_call_update') {
        const known = current?.tools.get(tool.toolCallId);
        const merged: ToolCallUpdate = { ...known, toolCallId: tool.toolCallId };
        for (const [field, change] of Object.entries(tool))
          if (change != null) Object.assign(merged, { [field]: change });
        const ended = (call?: ToolCallUpdate) =>
          call?.status === 'completed' || call?.status === 'failed';
        current?.tools.set(tool.toolCallId, merged);
        if (current && native_type === 'tool_call')
          session.emit({
            turn_id,
            native_type,
            kind: 'tool.started',
            tool_call_id: tool.toolCallId,
            name: merged.title || merged.kind || 'tool',
            input: merged.rawInput,
          });
        if (current && ended(merged) && !ended(known))
          session.emit({
            turn_id,
            native_type,
            kind: 'tool.completed',
            tool_call_id: tool.toolCallId,
            ok: merged.status === 'completed',
            output: merged.rawOutput ?? merged.content,
          });
        if (native_type === 'tool_call' || ended(merged)) return;
      }
      if (native_type === 'usage_update') {
        // A turn past its deadline still owns what its open prompt spends.
        const owner = session.turn;
        const cost = value.cost as { amount?: number; currency?: string } | null | undefined;
        const usd = cost?.currency === 'USD' && typeof cost.amount === 'number';
        if (owner) owner.costSource = usd ? 'provider_reported' : 'unknown';
        // The agent reports the session's cumulative cost; a turn shows what it added.
        const base = owner?.costBase ?? session.costUsd;
        if (usd) session.costUsd = cost.amount!;
        session.emit({
          turn_id: owner?.id,
          native_type,
          kind: 'usage.updated',
          context_tokens: value.used as number,
          context_window: value.size as number,
          ...(usd ? { cost_usd: cost.amount! - base } : {}),
          cost_source: usd ? 'provider_reported' : 'unknown',
        });
        return;
      }
      if (native_type === 'session_info_update' && typeof value.title === 'string' && value.title) {
        if (session.sentInstructions?.startsWith(value.title.trim())) return;
        session.emit({ turn_id, native_type, kind: 'title.generated', title: value.title });
        return;
      }
      // Before ready the options were taken as the frame came, ahead of the responses after it.
      if (ready && native_type === 'config_option_update' && Array.isArray(value.configOptions)) {
        session.configOptions = value.configOptions as ConfigOption[];
        const reported = reportedModel(session.configOptions);
        if (reported !== handle.reported_model) {
          // The agent changed the model itself, for a fallback or its own model command.
          handle.reported_model = reported;
          session.emit({
            turn_id,
            native_type,
            kind: 'session.started',
            native_session_id: handle.native_session_id,
            reported_model: reported,
            native: value,
          });
          return;
        }
      }
      session.emit({ turn_id, native_type, kind: 'native', native: value });
    };
    rpc.on('notification', (frame: Frame) => {
      // Vendor notifications (methods starting with _) carry nothing the contract maps.
      if (frame.method !== 'session/update') return;
      if (ready) {
        update(frame);
        return;
      }
      early.push(frame);
      const value = frame.params?.update as
        { sessionUpdate?: string; configOptions?: unknown } | undefined;
      if (value?.sessionUpdate === 'config_option_update' && Array.isArray(value.configOptions))
        session.configOptions = value.configOptions as ConfigOption[];
    });
    const hold = (
      current: AcpTurn,
      native_type: string,
      tool: string | undefined,
      detail: unknown,
      answer: (decision: PermissionDecision | undefined, answers?: Record<string, string>) => void,
      write = false,
      refusal?: (decision: PermissionDecision) => string | undefined,
    ): void => {
      const request_id = randomUUID();
      if (write) current.writes.add(request_id);
      current.permissions.set(request_id, (choice, answers) => {
        if (!current.permissions.has(request_id)) return undefined;
        const decision = write && current.readOnly && choice !== undefined ? 'deny' : choice;
        const refused = decision === undefined ? undefined : refusal?.(decision);
        if (refused) return refused;
        current.permissions.delete(request_id);
        current.writes.delete(request_id);
        if (!current.permissions.size) current.pauseClock(false);
        session.emit({
          turn_id: current.id,
          kind: 'permission.resolved',
          request_id,
          decision: decision ?? 'deny',
          ...(decision === undefined ? { cancelled: true as const } : {}),
        });
        answer(decision, answers);
        return undefined;
      });
      if (current.permissions.size === 1) current.pauseClock(true);
      session.emit({
        turn_id: current.id,
        native_type,
        kind: 'permission.requested',
        request_id,
        project_rule_supported: false,
        tool,
        detail,
      });
    };
    const elicit = (frame: Frame, reply: Reply): void => {
      const params = (frame.params ?? {}) as {
        sessionId?: string;
        toolCallId?: string | null;
        mode?: string;
        message?: string;
        requestedSchema?: { properties?: Record<string, ElicitationProperty> };
      };
      const current = session.turn?.ended ? undefined : session.turn;
      const respond = (action: 'accept' | 'decline' | 'cancel', content?: object): void =>
        reply({ result: { action, ...(content ? { content } : {}) } });
      if (
        !current ||
        current.interrupted ||
        session.stopping ||
        params.sessionId !== handle.native_session_id
      ) {
        respond('cancel');
        return;
      }
      const fields =
        params.mode === 'form'
          ? elicitedFields(params.requestedSchema?.properties ?? {})
          : undefined;
      if (!fields) {
        respond('decline');
        return;
      }
      hold(
        current,
        frame.method,
        'AskUserQuestion',
        {
          ...(params.toolCallId ? { tool_call_id: params.toolCallId } : {}),
          input: { message: params.message, requestedSchema: params.requestedSchema },
          questions: fields.map((field) => field.question),
        },
        (decision, answers = {}) => {
          if (decision === undefined) respond('cancel');
          else if (decision === 'deny') respond('decline');
          else
            respond(
              'accept',
              Object.fromEntries(
                fields.flatMap(({ name, type, question, values }): [string, unknown][] => {
                  const text = answers[question.question];
                  if (text === undefined) return [];
                  if (values.size) return [[name, values.get(text) ?? text]];
                  return [[name, type === 'string' ? text : Number(text)]];
                }),
              ),
            );
        },
      );
    };
    rpc.on('request', (frame: Frame, reply: Reply) => {
      if (frame.method === 'elicitation/create') {
        elicit(frame, reply);
        return;
      }
      if (frame.method !== 'session/request_permission') {
        reply(
          this.profile.handleRequest?.(frame) ?? {
            error: { code: -32601, message: 'Method not found' },
          },
        );
        return;
      }
      const params = (frame.params ?? {}) as {
        sessionId?: string;
        toolCall?: ToolCallUpdate;
        options?: PermissionOption[];
      };
      const options = params.options ?? [];
      const current = session.turn?.ended ? undefined : session.turn;
      const answer = (optionId: string | undefined): void =>
        reply({
          result: {
            outcome:
              optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
          },
        });
      if (
        !current ||
        current.interrupted ||
        session.stopping ||
        params.sessionId !== handle.native_session_id
      ) {
        answer(undefined);
        return;
      }
      // A request may name only the call, whose fields came in its tool_call frames.
      const call: Partial<ToolCallUpdate> = {
        ...current.tools.get(params.toolCall?.toolCallId ?? ''),
      };
      for (const [field, value] of Object.entries(params.toolCall ?? {}))
        if (value != null) Object.assign(call, { [field]: value });
      const kind = toolKind(call);
      const write = WRITE_KINDS.includes(kind ?? '');
      if (current.readOnly && write) {
        answer(chooseOption(options, DECISION_OPTIONS.deny));
        return;
      }
      hold(
        current,
        frame.method,
        call.title || kind || undefined,
        {
          tool_call_id: call.toolCallId,
          kind,
          input: call.rawInput,
        },
        (decision) =>
          answer(
            decision === undefined ? undefined : chooseOption(options, DECISION_OPTIONS[decision]),
          ),
        write,
        // A deny with no reject option still ends the request as cancelled.
        (decision) =>
          decision !== 'deny' && !chooseOption(options, DECISION_OPTIONS[decision])
            ? `The agent offers no ${decision === 'allow' ? 'allow-once' : 'allow'} option for this request`
            : undefined,
      );
    });
    let exit: { code: number | null; signal: string | null } | undefined;
    rpc.child.once(
      'close',
      (code: number | null, signal: string | null) => (exit = { code, signal }),
    );
    let disconnected = false;
    const lost = (reason: string) => {
      if (session.stopping || disconnected || !ready) return;
      disconnected = true;
      session.emit({
        kind: 'runtime.disconnected',
        reason: `${this.name} runtime connection lost: ${reason}`,
      });
    };
    rpc.on('protocolError', (error: Error) => {
      lost(error.message);
      session.turn?.finish(
        session.stopping ? 'interrupted' : 'failed',
        session.stopping ? undefined : `${this.name} runtime connection lost: ${error.message}`,
      );
      if (!session.stopping) void rpc.close();
    });
    rpc.on('closed', () => {
      delete handle.process_identity;
      lost('ACP agent exited');
      session.turn?.finish(
        session.stopping ? 'interrupted' : 'failed',
        session.stopping
          ? undefined
          : `${this.name} runtime connection lost: ACP agent exited before the turn completed`,
      );
      if (!session.stopping && ready)
        session.emit({ kind: 'session.exited', code: exit?.code, signal: exit?.signal });
    });
    // ACP stdio MCP servers take env as name/value pairs.
    const mcpServers = [
      ...(spec.pantheon_mcp ? [{ name: 'pantheon', ...spec.pantheon_mcp }] : []),
      ...spec.mcp_servers,
    ].map(({ name, command, args, env }) => ({
      name,
      command,
      args,
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    }));
    try {
      const initialized = (await rpc
        .initialize(
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
              elicitation: { form: {} },
            },
            clientInfo: CLIENT_INFO,
          },
          null,
          this.requestTimeoutMs,
        )
        .finally(() => {
          // The agent composes its configuration before it answers initialize.
          if (patchDir) rmSync(patchDir, { recursive: true, force: true });
        })) as { agentCapabilities?: AgentCapabilities };
      session.images = initialized.agentCapabilities?.promptCapabilities?.image === true;
      this.report.capabilities.images = {
        status: session.images ? 'supported' : 'unsupported',
        evidence: `ACP initialize promptCapabilities.image is ${session.images}`,
      };
      const resume = this.declaredResume(initialized.agentCapabilities);
      if (native_session_id !== undefined && !resume)
        throw new Error('The ACP agent declares neither session/resume nor loadSession');
      const method = native_session_id === undefined ? 'session/new' : `session/${resume}`;
      const result = await rpc.request<{
        sessionId?: string;
        configOptions?: ConfigOption[] | null;
      }>(
        method,
        native_session_id === undefined
          ? { cwd: spec.cwd, mcpServers }
          : { sessionId: native_session_id, cwd: spec.cwd, mcpServers },
        this.requestTimeoutMs,
      );
      const id = native_session_id ?? result?.sessionId;
      if (typeof id !== 'string' || !id) throw new Error('ACP agent returned no session id');
      handle.native_session_id = id;
      this.openedSession(method);
      session.configOptions = result?.configOptions ?? session.configOptions;
      if (spec.model !== undefined || spec.effort !== undefined) {
        const reason = await this.applyModel(session, handle, spec.model, spec.effort);
        if (reason) throw new Error(reason);
      }
      handle.reported_model = reportedModel(session.configOptions);
      this.sessions.set(handle, session);
      session.emit({
        kind: 'session.started',
        native_session_id: id,
        reported_model: handle.reported_model,
      });
      for (const frame of early.splice(0)) update(frame);
      ready = true;
      return handle;
    } catch (error) {
      session.stopping = true;
      const stop = await rpc.close();
      if (!rpc.child.pid) throw error;
      throw new SessionStartError(error instanceof Error ? error.message : String(error), stop);
    }
  }
  async send(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> {
    const session = this.sessions.get(handle);
    const open = session?.turn;
    const queued = { readOnly: turn.read_only === true, interrupted: false };
    if (session && open?.ended) {
      // Input queued behind a turn past its deadline waits for the agent to answer the cancel.
      session.queued = queued;
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([
        open.settled,
        new Promise((resolve) => (wait = setTimeout(resolve, CANCEL_GRACE_MS))),
      ]);
      clearTimeout(wait);
      if (session.queued === queued) delete session.queued;
      if (queued.interrupted) {
        session.emit({ turn_id: turn.turn_id, kind: 'turn.started' });
        session.emit({ turn_id: turn.turn_id, kind: 'turn.completed', status: 'interrupted' });
        return { turn_id: turn.turn_id, status: 'delivered' };
      }
    }
    if (!session || session.stopping || session.turn || !this.alive(session))
      return { turn_id: turn.turn_id, status: 'unsupported', reason: 'Session is not idle' };
    const images = (turn.attachments ?? []).filter((attachment) =>
      attachment.mime.startsWith('image/'),
    );
    if (images.length && !session.images)
      throw new DomainError(
        'unsupported_images',
        `${this.name}: ACP agent does not support image input`,
      );
    const prompt = [
      ...(session.instructions ? [{ type: 'text', text: session.instructions }] : []),
      { type: 'text', text: turn.input },
      ...images.map((image) => ({
        type: 'image',
        data: readFileSync(image.source ?? image.path).toString('base64'),
        mimeType: image.mime,
      })),
      ...(turn.attachments ?? [])
        .filter((attachment) => !images.includes(attachment))
        .map((attachment) => ({
          type: 'resource_link',
          uri: pathToFileURL(attachment.path).href,
          name: attachment.name,
          mimeType: attachment.mime,
        })),
      ...(turn.skills ?? []).map((skill) => ({
        type: 'resource_link',
        uri: pathToFileURL(skill.path).href,
        name: skill.name,
      })),
    ];
    if (session.instructions) session.sentInstructions = session.instructions;
    delete session.instructions;
    let timer: NodeJS.Timeout | undefined,
      left = session.wallTimeMs,
      since = Date.now();
    const end = (
      status: 'completed' | 'failed' | 'interrupted',
      error?: string,
      error_code?: string,
    ) => {
      if (current.ended) return;
      current.ended = true;
      for (const answer of current.permissions.values()) answer(undefined);
      clearTimeout(timer);
      session.emit({
        turn_id: current.id,
        kind: 'turn.completed',
        status,
        error,
        ...(error_code ? { error_code } : {}),
      });
    };
    const expire = () => {
      if (session.stopping) return;
      session.rpc.notify('session/cancel', { sessionId: handle.native_session_id });
      // The turn holds the session until the agent answers the cancelled prompt or exits.
      end('failed', 'ACP turn deadline exceeded', 'turn_deadline');
    };
    let settle!: () => void;
    const current: AcpTurn = {
      id: turn.turn_id,
      settled: new Promise((resolve) => (settle = resolve)),
      readOnly: queued.readOnly,
      costBase: session.costUsd,
      permissions: new Map(),
      writes: new Set(),
      tools: new Map(),
      pauseClock: (paused) => {
        if (session.turn !== current || current.ended) return;
        clearTimeout(timer);
        if (paused) left -= Date.now() - since;
        else {
          since = Date.now();
          timer = setTimeout(expire, left);
        }
      },
      finish: (status, error, error_code) => {
        if (session.turn !== current) return;
        session.turn = undefined;
        settle();
        end(status, error, error_code);
      },
    };
    session.turn = current;
    timer = setTimeout(expire, left);
    session.emit({ turn_id: current.id, kind: 'turn.started' });
    session.rpc
      .request<{ stopReason?: string; usage?: PromptUsage | null }>(
        'session/prompt',
        { sessionId: handle.native_session_id, prompt },
        // The prompt spans the whole turn, so only its response or the transport ends it.
        null,
      )
      .then(
        (result) => {
          const usage = result?.usage;
          // The response names its own turn, so a late answer past the deadline still counts there.
          if (usage)
            session.emit({
              turn_id: current.id,
              kind: 'usage.updated',
              input_tokens:
                usage.inputTokens + (usage.cachedReadTokens ?? 0) + (usage.cachedWriteTokens ?? 0),
              ...(usage.cachedReadTokens != null && {
                cached_input_tokens: usage.cachedReadTokens,
              }),
              ...(usage.cachedWriteTokens != null && {
                cache_write_input_tokens: usage.cachedWriteTokens,
              }),
              output_tokens: usage.outputTokens,
              ...(usage.thoughtTokens != null && {
                reasoning_output_tokens: usage.thoughtTokens,
              }),
              cost_source: current.costSource ?? 'unknown',
            });
          const stopReason = result?.stopReason;
          if (stopReason === 'end_turn') current.finish('completed');
          else if (stopReason === 'cancelled') current.finish('interrupted');
          else current.finish('failed', `ACP turn stopped: ${String(stopReason)}`);
        },
        (error: Error) =>
          current.finish('failed', `ACP session/prompt failed: ${rpcErrorText(error.message)}`),
      );
    return { turn_id: turn.turn_id, status: 'delivered' };
  }
  setTurnReadOnly(handle: SessionHandle, readOnly: boolean): void {
    const session = this.sessions.get(handle);
    if (session?.queued) session.queued.readOnly = readOnly;
    const turn = session?.turn;
    if (!turn) return;
    turn.readOnly = readOnly;
    if (readOnly) for (const id of [...turn.writes]) turn.permissions.get(id)?.('deny');
  }
  async setModel(
    handle: SessionHandle,
    model: string,
    effort: EffortLevel | undefined,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown ACP session' };
    const applied = session.configuring.then(async () => {
      const reported = handle.reported_model;
      const reason = await this.applyModel(session, handle, model, effort);
      // A refused change the agent could not undo leaves it on a model control does not record.
      if (reason && handle.reported_model !== reported)
        session.emit({
          kind: 'session.started',
          native_session_id: handle.native_session_id,
          reported_model: handle.reported_model,
        });
      return reason;
    });
    session.configuring = applied;
    const reason = await applied;
    return reason ? { ok: false, reason } : { ok: true };
  }
  /** Returns why the agent did not take the model or effort, or undefined once both are set. */
  private async applyModel(
    session: AcpSession,
    handle: SessionHandle,
    model: string | undefined,
    effort: EffortLevel | undefined,
  ): Promise<string | undefined> {
    const modelOption = session.configOptions.find((option) => option.category === 'model');
    if (model !== undefined && !modelOption) return 'The ACP agent offers no model config option';
    const effortOption = session.configOptions.find(
      (option) => option.category === 'thought_level',
    );
    if (effort !== undefined && !effortOption)
      return 'The ACP agent offers no thought level config option';
    const thought =
      effort === undefined
        ? undefined
        : (choices(effortOption).find((choice) => effortLevel(choice.value) === effort)?.value ??
          effort);
    const set = async (option: ConfigOption, value: unknown): Promise<void> => {
      const result = await session.rpc.request<{ configOptions?: ConfigOption[] | null }>(
        'session/set_config_option',
        { sessionId: handle.native_session_id, configId: option.id, value },
        this.requestTimeoutMs,
      );
      if (result?.configOptions) session.configOptions = result.configOptions;
    };
    const previous = modelOption?.currentValue;
    let modelSet = false;
    try {
      if (model !== undefined) {
        await set(modelOption!, model);
        modelSet = true;
      }
      if (thought !== undefined) await set(effortOption!, thought);
    } catch (error) {
      const failed = `ACP session/set_config_option failed: ${(error as Error).message}`;
      // A refused effort leaves the session on the model it had, as control records it.
      if (modelSet)
        try {
          await set(modelOption!, previous);
        } catch (refused) {
          handle.reported_model = reportedModel(session.configOptions);
          return `${failed}; setting the model back failed too: ${(refused as Error).message}`;
        }
      return failed;
    }
    handle.requested_model = model;
    handle.requested_effort = effort;
    handle.reported_model = reportedModel(session.configOptions);
    return undefined;
  }
  async interrupt(handle: SessionHandle): Promise<Receipt> {
    const session = this.sessions.get(handle);
    const current = session?.turn;
    if (session?.queued && !session.stopping) {
      session.queued.interrupted = true;
      return { ok: true };
    }
    if (!session || !current || session.stopping)
      return { ok: false, reason: 'No ACP turn is running' };
    if (current.interrupted) return { ok: true, reason: 'The turn is already interrupting' };
    current.interrupted = true;
    // The agent answers the open prompt with stopReason cancelled.
    session.rpc.notify('session/cancel', { sessionId: handle.native_session_id });
    for (const answer of current.permissions.values()) answer(undefined);
    return { ok: true };
  }
  async inspect(handle: SessionHandle): Promise<NativeStatus> {
    const session = this.sessions.get(handle);
    return {
      state: !session
        ? 'unknown'
        : !this.alive(session)
          ? 'exited'
          : session.turn
            ? 'running'
            : 'idle',
      native_session_id: handle.native_session_id,
      process_identity: session ? handle.process_identity : undefined,
      observed_at: new Date().toISOString(),
    };
  }
  async answerPermission(
    handle: SessionHandle,
    request_id: string,
    decision: PermissionDecision,
    answers?: Record<string, string>,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle),
      answer = session?.turn?.permissions.get(request_id);
    if (!answer)
      return {
        ok: false,
        reason: 'Unknown permission request',
        ...(session ? { unknown_request: true } : {}),
      };
    const refused = answer(decision, answers);
    return refused ? { ok: false, reason: refused, refused: true } : { ok: true };
  }
  async cancel(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    const session = this.sessions.get(handle);
    if (!session)
      return {
        stopped: false,
        deadline,
        finished_at: new Date().toISOString(),
        evidence: { method: 'none', members: [] },
        reason: 'Unknown handle',
      };
    session.stopping = true;
    const current = session.turn;
    if (current) {
      if (this.alive(session))
        session.rpc.notify('session/cancel', { sessionId: handle.native_session_id });
      for (const answer of current.permissions.values()) answer(undefined);
    }
    const receipt = await session.rpc.close(deadline);
    current?.finish('interrupted');
    return receipt;
  }
  async close(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    return this.cancel(handle, deadline);
  }
  private alive(session: AcpSession): boolean {
    return session.rpc.child.exitCode === null && session.rpc.child.signalCode === null;
  }
}
