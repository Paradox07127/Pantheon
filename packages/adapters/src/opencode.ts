import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  DomainError,
  SessionStartError,
  type AgentEvent,
  type AgentEventSink,
  type ApprovalQuestion,
  type CancelReceipt,
  type Capability,
  type CapabilityReport,
  type DeliveryReceipt,
  type EffortLevel,
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
  nativeEnvironment,
  processIdentity,
  report,
  terminate,
  validateSessionSpec,
  versionOf,
} from './process.js';
import { notInstalled, parseVersion, readVersion, type Preflight } from './preflight.js';

type EventBody<E = AgentEvent> = E extends AgentEvent
  ? Omit<E, 'key' | 'provider_sequence'>
  : never;
interface ModelRef {
  id: string;
  providerID: string;
  variant?: string;
}
interface StructuredError {
  type?: string;
  message: string;
  status?: number;
}
interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}
interface Rule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}
interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  metadata?: unknown;
  source?: { messageID: string; id: string };
  message?: string;
}
interface FormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  hidden?: boolean;
  options?: { value: string; label: string; description?: string }[];
  custom?: boolean;
}
interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
}
interface SessionInfo {
  id: string;
  title?: string;
  model?: ModelRef;
}
interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  enabled?: boolean;
  variants?: { id: string }[];
}
type AssistantContent =
  | { type: 'text' | 'reasoning'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      state: { status: string; input?: unknown; content?: unknown; error?: StructuredError };
    };
type Message =
  | {
      id: string;
      type: 'assistant';
      content: AssistantContent[];
      time: { completed?: number };
      cost?: number;
      tokens?: Tokens;
    }
  | { id: string; type: 'idle'; outcome: Outcome; error?: StructuredError }
  | { id: string; type: 'user' | 'synthetic' | 'system' | 'shell' | 'compaction' };
type Outcome = 'succeeded' | 'failed' | 'interrupted';
/** The data of the native events the adapter reads; each type fills only its own fields. */
interface EventData {
  sessionID?: string;
  parentID?: string;
  assistantMessageID?: string;
  ordinal?: number;
  delta?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  error?: StructuredError;
  reason?: string;
  title?: string;
  slug?: string;
  agent?: string;
  cost?: number;
  tokens?: Tokens;
  attempt?: number;
  at?: number;
  requestID?: string;
  reply?: string;
  form?: FormInfo;
}
interface NativeEvent {
  type: string;
  data?: EventData;
}
interface Pending {
  write: boolean;
  /** An undefined decision withdraws the request; native false records an answer given elsewhere. */
  answer: (
    decision: PermissionDecision | undefined,
    answers?: Record<string, string>,
    reason?: string,
    native?: boolean,
  ) => void;
}
interface OpencodeTurn {
  id: string;
  readOnly: boolean;
  interrupted?: boolean;
  /** An execution started and has not ended. */
  running?: boolean;
  /** The id of the turn's input once OpenCode admitted it; undefined when it did not. */
  admitted: Promise<string | undefined>;
  steers: string[];
  /** Assistant messages whose usage the turn counted. */
  steps: Set<string>;
  usage: { input: number; output: number; reasoning: number; read: number; write: number };
  cost: number;
  pending: Map<string, Pending>;
  pauseClock: (paused: boolean) => void;
  finish: (status: 'completed' | 'failed' | 'interrupted', error?: string, code?: string) => void;
}
/** How much of one text or reasoning part the turn emitted. */
interface Part {
  emitted: number;
  /** Its deltas arrived from its start on the current stream. */
  live: boolean;
  ended: boolean;
}
interface OpencodeSession {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  base: string;
  authorization: string;
  cwd: string;
  sink: AgentEventSink;
  emit: (event: EventBody) => void;
  wallTimeMs: number;
  stopping: boolean;
  autoTitle: boolean;
  title?: string;
  stream?: AbortController;
  /** Events held while a reconnect rebuilds the turn from the message history. */
  buffered?: NativeEvent[];
  parts: Map<string, Part>;
  toolNames: Map<string, string>;
  toolsStarted: Set<string>;
  toolsEnded: Set<string>;
  /** Permission requests and forms already handled, by native id. */
  asked: Set<string>;
  /** Request rule keys the user allowed for the rest of the session. */
  allowed: Set<string>;
  mode?: PermissionMode;
  /** The rules last written to the session and its subagent sessions. */
  rules?: Rule[];
  children: Set<string>;
  /** A turn past its deadline still has an execution OpenCode has not ended. */
  stale: boolean;
  instructions?: string;
  turn?: OpencodeTurn;
}

const MIN_VERSION = '2.0.0';
const DECLINED = 'The user declined this request.';
const READ_ONLY = 'This turn may only read files.';
const READ_ACTIONS = ['read', 'glob', 'grep', 'lsp', 'question', 'todowrite', 'task', 'skill'];
const EDIT_ACTIONS = ['edit', 'write', 'patch'];
// Actions a read-only turn refuses without asking the user.
const WRITE_ACTIONS = [...EDIT_ACTIONS, 'bash'];
const EXECUTION_ENDS = [
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
];
const EFFORTS: readonly EffortLevel[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

/** The OpenCode rules of a permission mode; the last matching rule wins. */
function permissionRules(mode: PermissionMode | undefined, readOnly: boolean): Rule[] {
  const rule = (action: string, effect: Rule['effect']): Rule => ({
    action,
    resource: '*',
    effect,
  });
  const rules =
    mode === 'full_access'
      ? [rule('*', 'allow')]
      : [
          rule('*', 'ask'),
          ...READ_ACTIONS.map((action) => rule(action, 'allow')),
          // OpenCode names MCP tools <server>_<tool>; Pantheon's server is registered as `pantheon`.
          rule('pantheon_*', 'allow'),
        ];
  if (mode === 'plan') rules.push(...WRITE_ACTIONS.map((action) => rule(action, 'deny')));
  if (mode === 'auto_edit') rules.push(...EDIT_ACTIONS.map((action) => rule(action, 'allow')));
  // ask() refuses the writes of a read-only turn, so they must reach it.
  if (readOnly && (mode === 'auto_edit' || mode === 'full_access'))
    rules.push(...WRITE_ACTIONS.map((action) => rule(action, 'ask')));
  return rules;
}

function majorVersion(version: string): number | undefined {
  const parsed = parseVersion(version);
  return parsed ? Number(parsed.split('.')[0]) : undefined;
}

function wrongVersion(version: string): string | undefined {
  if (version === 'unprobed') return undefined;
  const major = majorVersion(version);
  if (major === 2) return undefined;
  return major === undefined
    ? `Cannot read an OpenCode version from ${JSON.stringify(version)}`
    : `OpenCode ${version} is not a 2.x release; Pantheon drives only the HTTP server of OpenCode 2`;
}

function ownCapabilities(version: string): Record<string, Capability> {
  const wrong = wrongVersion(version);
  const noSandbox = 'OpenCode has no OS sandbox; its permission rules do not isolate commands';
  return {
    ...(wrong ? { text_execution: { status: 'unsupported', evidence: wrong } } : {}),
    resume: {
      status: 'supported',
      evidence: 'OpenCode keeps sessions in its database; resume reopens the session id',
    },
    reattach: {
      status: 'unsupported',
      evidence: 'Each session owns the OpenCode server it started; another daemon cannot reach it',
    },
    steer: { status: 'supported', evidence: 'steer sends a prompt with delivery steer' },
    deny_reason: { status: 'supported', evidence: 'A permission reject carries a message' },
    turn_model_change: {
      status: 'supported',
      evidence: 'setModel switches the model of later provider turns, also during a turn',
    },
    cost_reporting: {
      status: 'supported',
      evidence: 'Each OpenCode step reports its cost and tokens',
    },
    images: {
      status: 'unknown',
      evidence: 'Attachments go to OpenCode as file URIs; image input is not verified',
    },
    write_isolation: { status: 'unsupported', evidence: noSandbox },
    read_isolation: { status: 'unsupported', evidence: noSandbox },
  };
}

/** provider/model, with the effort as the model variant. */
function modelRef(model: string, effort: EffortLevel | undefined): ModelRef | undefined {
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) return undefined;
  return {
    providerID: model.slice(0, slash),
    id: model.slice(slash + 1),
    ...(effort !== undefined ? { variant: effort } : {}),
  };
}

const modelName = (ref: ModelRef | undefined): string | undefined =>
  ref ? `${ref.providerID}/${ref.id}` : undefined;

const locationQuery = (directory: string): string =>
  `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;

/** A form's fields as question cards; undefined when one has no card or they exceed a card's limits. */
function formQuestions(
  fields: FormField[],
): { field: FormField; question: ApprovalQuestion; values: Map<string, unknown> }[] | undefined {
  const shown = fields.filter((field) => !field.hidden);
  const questions = [];
  for (const field of shown) {
    const choices: [string, unknown][] =
      field.type === 'boolean'
        ? [
            ['Yes', true],
            ['No', false],
          ]
        : field.type === 'string' || field.type === 'multiselect'
          ? (field.options ?? []).map((option) => [option.label, option.value])
          : field.type === 'number' || field.type === 'integer'
            ? []
            : [['', undefined]];
    if (choices.length > 4 || choices.some(([label]) => !label)) return undefined;
    questions.push({
      field,
      values: new Map(choices),
      question: {
        question: field.title || field.description || field.key,
        header: field.key,
        options: choices.map(([label]) => ({ label, description: '' })),
        multiSelect: field.type === 'multiselect',
        other: choices.length === 0 || field.custom === true,
      },
    });
  }
  // Answers come back keyed by question text.
  const distinct = new Set(questions.map(({ question }) => question.question)).size;
  return questions.length && questions.length <= 4 && distinct === questions.length
    ? questions
    : undefined;
}

/** The value OpenCode takes for an answer text of a field. */
function formValue(field: FormField, values: Map<string, unknown>, text: string): unknown {
  if (field.type === 'multiselect')
    return text.split(', ').map((label) => (values.get(label) as string | undefined) ?? label);
  if (field.type === 'number' || field.type === 'integer') return Number(text);
  return values.has(text) ? values.get(text) : text;
}

/** SSE frames of an event stream; ends when the stream does. */
async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        event = undefined;
        data = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const text = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = text;
      else if (field === 'data') data.push(text);
    }
  }
}

interface Server {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  /** The base URL from the listening line; rejects when the server exits first or stays silent. */
  listening: Promise<string>;
  authorization: string;
}

/** Starts `opencode serve` on a free loopback port with a fresh password, in its own process group. */
function serve(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  config: object,
  timeoutMs: number,
): Server {
  const password = randomBytes(32).toString('base64url');
  const child = spawn(binary, [...args, 'serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd,
    env: {
      ...env,
      OPENCODE_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  exited.catch(() => {});
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
  const listening = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`OpenCode server did not report its address within ${timeoutMs} ms`)),
      timeoutMs,
    );
    let out = '';
    child.stdout.setEncoding('utf8');
    // Stdout stays drained after the address: a full pipe would stall the server.
    child.stdout.on('data', (chunk: string) => {
      out = (out + chunk).slice(-4096);
      const found = /server listening on (https?:\/\/\S+)/.exec(out);
      if (!found) return;
      clearTimeout(timer);
      resolve(found[1]!.replace(/\/$/, ''));
    });
    exited.then(
      () => {
        clearTimeout(timer);
        reject(new Error(`OpenCode server exited before it listened: ${stderr.trim()}`));
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
  listening.catch(() => {});
  return {
    child,
    exited,
    listening,
    authorization: `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`,
  };
}

/** One request to an OpenCode server; rejects on an error status with the server's message. */
async function call<T>(
  server: { base: string; authorization: string },
  method: string,
  route: string,
  timeoutMs: number,
  body?: unknown,
): Promise<T> {
  const response = await fetch(server.base + route, {
    method,
    headers: {
      authorization: server.authorization,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (response.status === 401) throw new Error('OpenCode rejected the server password');
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      // A plain text error body.
    }
    throw new Error(
      `OpenCode ${method} ${route.split('?')[0]} failed (${response.status}): ${message}`,
    );
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** OpenCode 2 through the HTTP server of `opencode serve`, one server process per session. */
export class OpencodeAdapter implements HarnessAdapter {
  readonly name = 'opencode';
  readonly generatesTitles = true;
  readonly args: string[];
  report: CapabilityReport;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private sessions = new WeakMap<SessionHandle, OpencodeSession>();
  constructor(
    readonly binary = 'opencode',
    version = 'unprobed',
    options: { args?: string[]; requestTimeoutMs?: number; startupTimeoutMs?: number } = {},
  ) {
    this.args = options.args ?? [];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.report = report(this.name, version, false, ownCapabilities(version));
  }
  async probe(): Promise<CapabilityReport> {
    const version = versionOf(this.binary);
    this.report = report(this.name, version, false, ownCapabilities(version));
    return this.report;
  }
  async preflight(): Promise<Preflight> {
    let version: string;
    try {
      version = await readVersion(this.binary);
    } catch (error) {
      this.report = report(this.name, 'unprobed', false, ownCapabilities('unprobed'));
      return notInstalled(MIN_VERSION, error);
    }
    this.report = report(this.name, version, false, ownCapabilities(version));
    const wrong = wrongVersion(version);
    return {
      installed: true,
      version,
      min_version: MIN_VERSION,
      version_ok: majorVersion(version) === undefined ? null : !wrong,
      auth: { state: 'unknown' },
      ...(wrong ? { error: wrong } : {}),
    };
  }
  /** Runs fn against a short-lived server in cwd, then stops it. */
  private async withServer<T>(
    cwd: string,
    fn: (server: { base: string; authorization: string }) => Promise<T>,
  ): Promise<T> {
    const server = serve(
      this.binary,
      this.args,
      cwd,
      nativeEnvironment(),
      {},
      this.startupTimeoutMs,
    );
    try {
      const base = await server.listening;
      return await fn({ base, authorization: server.authorization });
    } finally {
      await terminate(server.child, server.exited, Date.now() + 5000);
    }
  }
  async reconnect(): Promise<void> {
    await this.withServer(os.tmpdir(), (server) =>
      call(server, 'GET', '/api/info', this.requestTimeoutMs),
    );
  }
  async models(cwd: string): Promise<RuntimeModel[]> {
    return this.withServer(cwd, async (server) => {
      const listed = await call<{ data: ModelInfo[] }>(
        server,
        'GET',
        `/api/model?${locationQuery(cwd)}`,
        this.requestTimeoutMs,
      );
      const fallback = await call<{ data: ModelInfo | null }>(
        server,
        'GET',
        `/api/model/default?${locationQuery(cwd)}`,
        this.requestTimeoutMs,
      );
      return listed.data
        .filter((model) => model.enabled !== false)
        .map((model) => ({
          id: `${model.providerID}/${model.id}`,
          label: model.name,
          permission_modes: ['plan', 'ask', 'auto_edit', 'full_access'],
          efforts: EFFORTS.filter((effort) =>
            (model.variants ?? []).some((variant) => variant.id === effort),
          ),
          default_effort: null,
          default: model.id === fallback.data?.id && model.providerID === fallback.data?.providerID,
        }));
    });
  }
  async start(spec: SessionSpec, sink: AgentEventSink): Promise<SessionHandle> {
    return this.open(spec, undefined, sink);
  }
  async resume(
    spec: SessionSpec,
    native_session_id: string,
    sink: AgentEventSink,
  ): Promise<SessionHandle> {
    return this.open(spec, native_session_id, sink);
  }
  private async open(
    spec: SessionSpec,
    native_session_id: string | undefined,
    sink: AgentEventSink,
  ): Promise<SessionHandle> {
    validateSessionSpec(spec, this.report.version);
    // The server listens on this machine's loopback only.
    if (spec.remote)
      throw new DomainError('unsupported_capability', 'Cannot honor remote device for OpenCode');
    const requested = spec.model === undefined ? undefined : modelRef(spec.model, spec.effort);
    if (spec.model !== undefined && !requested)
      throw new DomainError(
        'invalid_input',
        `OpenCode model ids take the form provider/model, not ${spec.model}`,
      );
    const servers = Object.fromEntries(
      [
        ...(spec.pantheon_mcp ? [{ name: 'pantheon', ...spec.pantheon_mcp }] : []),
        ...spec.mcp_servers,
      ].map(({ name, command, args, env }) => [
        name,
        { type: 'local', command: [command, ...args], environment: env },
      ]),
    );
    const server = serve(
      this.binary,
      this.args,
      spec.cwd,
      { ...spec.env, ...nativeEnvironment(spec.env_allowlist) },
      Object.keys(servers).length ? { mcp: { servers } } : {},
      this.startupTimeoutMs,
    );
    const handle: SessionHandle = {
      platform_session_id: spec.platform_session_id,
      native_session_id: native_session_id ?? '',
      adapter_version: this.report.version,
      device_id: spec.device_id,
      requested_model: spec.model,
      requested_effort: spec.effort,
      process_identity: server.child.pid ? processIdentity(server.child.pid) : undefined,
    };
    let sequence = 0;
    const session: OpencodeSession = {
      child: server.child,
      exited: server.exited,
      base: '',
      authorization: server.authorization,
      cwd: spec.cwd,
      sink,
      emit: (event) =>
        session.sink({
          key: String(++sequence),
          provider_sequence: sequence,
          ...event,
        } as AgentEvent),
      wallTimeMs: spec.budget.wall_time_ms,
      stopping: false,
      autoTitle: spec.auto_title === true,
      parts: new Map(),
      toolNames: new Map(),
      toolsStarted: new Set(),
      toolsEnded: new Set(),
      asked: new Set(),
      allowed: new Set(spec.allowed_rules),
      ...(spec.permission_mode ? { mode: spec.permission_mode } : {}),
      children: new Set(),
      stale: false,
      ...((spec.role === 'writer' || spec.runtime_analysis) && spec.control_instructions
        ? { instructions: spec.control_instructions }
        : {}),
    };
    let ready = false;
    let exit: { code: number | null; signal: string | null } | undefined;
    server.child.once('exit', (code, signal) => (exit = { code, signal }));
    server.child.once('close', () => {
      delete handle.process_identity;
      session.stream?.abort();
      if (session.stopping || !ready) return;
      session.emit({
        kind: 'runtime.disconnected',
        reason: `${this.name} runtime connection lost: OpenCode server exited`,
      });
      session.turn?.finish(
        'failed',
        `${this.name} runtime connection lost: OpenCode server exited before the turn completed`,
      );
      session.emit({ kind: 'session.exited', code: exit?.code, signal: exit?.signal });
    });
    const timeout = this.requestTimeoutMs;
    try {
      session.base = await server.listening;
      // The stream opens before the session so none of its events are missed.
      const stream = await this.subscribe(session);
      void this.pump(session, handle, stream);
      let info: SessionInfo;
      let model = requested;
      if (!model && spec.effort !== undefined) {
        const fallback = await call<{ data: ModelInfo | null }>(
          session,
          'GET',
          `/api/model/default?${locationQuery(spec.cwd)}`,
          timeout,
        );
        if (fallback.data)
          model = {
            id: fallback.data.id,
            providerID: fallback.data.providerID,
            variant: spec.effort,
          };
      }
      if (native_session_id === undefined) {
        session.rules = permissionRules(session.mode, false);
        info = (
          await call<{ data: SessionInfo }>(session, 'POST', '/api/session', timeout, {
            location: { directory: spec.cwd },
            permissions: session.rules,
            ...(model ? { model } : {}),
            ...(spec.native_title !== undefined && !spec.auto_title
              ? { title: spec.native_title }
              : {}),
          })
        ).data;
      } else {
        info = (
          await call<{ data: SessionInfo }>(
            session,
            'GET',
            `/api/session/${encodeURIComponent(native_session_id)}`,
            timeout,
          )
        ).data;
        // The saved rules may come from another mode or from a session OpenCode created.
        await this.writeRules(session, handle);
        if (model) {
          await call(
            session,
            'POST',
            `/api/session/${encodeURIComponent(info.id)}/model`,
            timeout,
            { model },
          );
          info.model = model;
        }
      }
      if (typeof info?.id !== 'string' || !info.id)
        throw new Error('OpenCode returned no session id');
      handle.native_session_id = info.id;
      handle.reported_model = modelName(info.model);
      session.title = info.title;
      this.sessions.set(handle, session);
      session.emit({
        kind: 'session.started',
        native_session_id: info.id,
        reported_model: handle.reported_model,
      });
      ready = true;
      return handle;
    } catch (error) {
      session.stopping = true;
      session.stream?.abort();
      const stop = await terminate(server.child, server.exited, Date.now() + 10_000);
      if (!server.child.pid) throw error;
      throw new SessionStartError(error instanceof Error ? error.message : String(error), stop);
    }
  }
  /** Writes the rules of the mode and the running turn to the session and its subagent sessions when they changed. */
  private async writeRules(session: OpencodeSession, handle: SessionHandle): Promise<void> {
    const rules = permissionRules(session.mode, session.turn?.readOnly === true);
    if (JSON.stringify(rules) === JSON.stringify(session.rules)) return;
    session.rules = rules;
    const write = (id: string) =>
      call(session, 'PATCH', `/api/session/${encodeURIComponent(id)}`, this.requestTimeoutMs, {
        permissions: rules,
      });
    for (const child of session.children) void write(child).catch(() => {});
    try {
      await write(handle.native_session_id);
    } catch (error) {
      // The next write sends the rules again.
      delete session.rules;
      throw error;
    }
  }
  /** Opens the event stream; rejects when the server refuses it. */
  private async subscribe(session: OpencodeSession): Promise<ReadableStream<Uint8Array>> {
    const controller = new AbortController();
    session.stream = controller;
    const response = await fetch(`${session.base}/api/event`, {
      headers: { authorization: session.authorization, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error('OpenCode rejected the server password');
    if (!response.ok || !response.body)
      throw new Error(`OpenCode event stream failed (${response.status})`);
    return response.body;
  }
  /** Reads the stream until it ends, then reconnects and rebuilds what the gap lost. */
  private async pump(
    session: OpencodeSession,
    handle: SessionHandle,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    try {
      for await (const frame of sseFrames(stream)) {
        let event: NativeEvent;
        try {
          event = JSON.parse(frame.data) as NativeEvent;
        } catch {
          continue;
        }
        if (typeof event?.type !== 'string' && frame.event) event = { ...event, type: frame.event };
        this.dispatch(session, handle, event);
      }
    } catch {
      // An aborted or broken stream ends like a closed one.
    }
    // Deltas after the gap no longer extend what the turn emitted.
    for (const part of session.parts.values()) part.live = false;
    while (!session.stopping && this.alive(session)) {
      try {
        const next = await this.subscribe(session);
        session.buffered = [];
        void this.pump(session, handle, next);
        await this.resync(session, handle).catch(() => {});
        const held = session.buffered;
        delete session.buffered;
        for (const event of held) this.dispatch(session, handle, event);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  /** Emits what the message history holds of the running turn and the requests still pending. */
  private async resync(session: OpencodeSession, handle: SessionHandle): Promise<void> {
    const id = handle.native_session_id;
    const timeout = this.requestTimeoutMs;
    const turn = session.turn;
    const admitted = turn && (await turn.admitted);
    if (turn && admitted) {
      const messages: Message[] = [];
      let cursor: string | null | undefined;
      let found = false;
      do {
        const page = await call<{ data: Message[]; cursor?: { next?: string | null } }>(
          session,
          'GET',
          `/api/session/${encodeURIComponent(id)}/message?order=desc&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          timeout,
        );
        for (const message of page.data) {
          if (message.id === admitted) {
            found = true;
            break;
          }
          messages.push(message);
        }
        cursor = found ? undefined : page.cursor?.next;
      } while (cursor);
      // An input still in the inbox has nothing of the turn after it.
      if (found)
        for (const message of messages.reverse()) {
          if (session.turn !== turn) break;
          this.replay(session, turn, message);
        }
      for (const owner of [id, ...session.children]) {
        if (session.turn !== turn) break;
        const permissions = await call<{ data: PermissionRequest[] }>(
          session,
          'GET',
          `/api/session/${encodeURIComponent(owner)}/permission`,
          timeout,
        );
        for (const request of permissions.data) this.ask(session, request);
        const forms = await call<{ data: FormInfo[] }>(
          session,
          'GET',
          `/api/session/${encodeURIComponent(owner)}/form`,
          timeout,
        );
        for (const form of forms.data) this.form(session, form);
      }
    }
    if (session.autoTitle) {
      const info = await call<{ data: SessionInfo }>(
        session,
        'GET',
        `/api/session/${encodeURIComponent(id)}`,
        timeout,
      );
      this.title(session, info.data.title);
    }
  }
  private replay(session: OpencodeSession, turn: OpencodeTurn, message: Message): void {
    if (message.type === 'idle') {
      this.settle(turn, message.outcome, message.error);
      return;
    }
    if (message.type !== 'assistant') return;
    const complete = message.time.completed !== undefined;
    const counts = { text: 0, reasoning: 0 };
    message.content.forEach((item) => {
      if (item.type === 'tool') {
        if (item.state.status === 'streaming') return;
        session.toolNames.set(item.id, item.name);
        this.toolStarted(session, turn, item.id, item.state.input);
        if (item.state.status === 'completed')
          this.toolEnded(session, turn, item.id, true, item.state.content);
        if (item.state.status === 'error')
          this.toolEnded(session, turn, item.id, false, item.state.error?.message);
        return;
      }
      const ordinal = counts[item.type]++;
      this.text(
        session,
        turn,
        item.type,
        `${message.id}:${item.type}:${ordinal}`,
        item.text,
        complete,
      );
    });
    if (complete && message.tokens)
      this.step(session, turn, message.id, message.cost ?? 0, message.tokens);
  }
  private dispatch(session: OpencodeSession, handle: SessionHandle, event: NativeEvent): void {
    if (session.buffered) {
      session.buffered.push(event);
      return;
    }
    const data = event.data ?? {};
    const own = handle.native_session_id;
    const owner = data.sessionID ?? data.form?.sessionID;
    if (!own || owner === undefined) return;
    const turn = session.turn;
    if (owner !== own) {
      if (event.type === 'session.created' && data.parentID === own) {
        session.children.add(owner);
        // The child's own agent may bring rules of its own.
        if (session.rules)
          void call(
            session,
            'PATCH',
            `/api/session/${encodeURIComponent(owner)}`,
            this.requestTimeoutMs,
            {
              permissions: session.rules,
            },
          ).catch(() => {});
        session.emit({
          turn_id: turn?.id,
          native_type: event.type,
          kind: 'task.started',
          task: {
            id: owner,
            kind: 'agent',
            description: data.title || data.slug || 'OpenCode subagent',
            ...(data.agent ? { agent_type: data.agent } : {}),
            background: false,
            started_at: Date.now(),
          },
        });
      } else if (session.children.has(owner)) {
        if (EXECUTION_ENDS.includes(event.type))
          session.emit({
            turn_id: turn?.id,
            native_type: event.type,
            kind: 'task.ended',
            task_id: owner,
            state:
              event.type === 'session.execution.succeeded'
                ? 'completed'
                : event.type === 'session.execution.failed'
                  ? 'failed'
                  : 'stopped',
            ...(data.error ? { summary: data.error.message } : {}),
          });
        else this.request(session, event);
      }
      return;
    }
    if (session.stale) {
      if (EXECUTION_ENDS.includes(event.type)) session.stale = false;
      return;
    }
    if (event.type === 'session.renamed') {
      this.title(session, data.title);
      return;
    }
    if (!turn) {
      // OpenCode waits on a request no turn can answer.
      this.request(session, event);
      return;
    }
    const kind = event.type.startsWith('session.reasoning.') ? 'reasoning' : 'text';
    // OpenCode numbers text and reasoning parts separately, so one message has both at ordinal 0.
    const key = `${data.assistantMessageID}:${kind}:${data.ordinal}`;
    switch (event.type) {
      case 'session.execution.started':
        turn.running = true;
        return;
      case 'session.execution.succeeded':
        this.settle(turn, 'succeeded');
        return;
      case 'session.execution.failed':
        this.settle(turn, 'failed', data.error);
        return;
      case 'session.execution.interrupted':
        // A steer supersedes the execution with one that carries on the turn.
        if (data.reason === 'superseded') return;
        if (data.reason === 'user' || turn.interrupted) this.settle(turn, 'interrupted');
        else turn.finish('failed', `OpenCode interrupted the execution: ${data.reason}`);
        return;
      case 'session.idle':
        // The outcome is in the message history; the end event may have been lost.
        void this.resync(session, handle).catch(() => {});
        return;
      case 'session.text.started':
      case 'session.reasoning.started':
        if (!session.parts.has(key))
          session.parts.set(key, { emitted: 0, live: true, ended: false });
        return;
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const part = session.parts.get(key);
        if (!part) session.parts.set(key, { emitted: 0, live: false, ended: false });
        if (!part?.live || part.ended || !data.delta) return;
        part.emitted += data.delta.length;
        this.emitText(session, turn, kind, data.delta);
        return;
      }
      case 'session.text.ended':
      case 'session.reasoning.ended':
        this.text(session, turn, kind, key, data.text ?? '', true);
        return;
      case 'session.tool.input.started':
        if (data.id && data.name) session.toolNames.set(data.id, data.name);
        return;
      case 'session.tool.called':
        if (data.id) this.toolStarted(session, turn, data.id, data.input);
        return;
      case 'session.tool.success':
        if (data.id) this.toolEnded(session, turn, data.id, true, data.content);
        return;
      case 'session.tool.failed':
        if (data.id)
          this.toolEnded(session, turn, data.id, false, data.error?.message ?? data.content);
        return;
      case 'session.step.ended':
        if (data.assistantMessageID && data.tokens)
          this.step(session, turn, data.assistantMessageID, data.cost ?? 0, data.tokens);
        return;
      case 'session.retry.scheduled': {
        const status = data.error?.status;
        session.emit({
          turn_id: turn.id,
          native_type: event.type,
          kind: 'turn.retrying',
          attempt: data.attempt ?? 1,
          ...(data.at !== undefined ? { retry_at: data.at } : {}),
          reason:
            status === 429
              ? 'rate_limit'
              : status === 503 || status === 529
                ? 'overloaded'
                : 'network',
        });
        return;
      }
      default:
        this.request(session, event);
    }
  }
  /** Permission requests and forms, and their answers given outside Pantheon. */
  private request(session: OpencodeSession, event: NativeEvent): void {
    const data = event.data ?? {};
    if (event.type === 'permission.asked') this.ask(session, data as unknown as PermissionRequest);
    else if (event.type === 'form.created' && data.form) this.form(session, data.form);
    else if (event.type === 'permission.replied' && data.requestID)
      session.turn?.pending
        .get(data.requestID)
        ?.answer(
          data.reply === 'reject' ? 'deny' : data.reply === 'always' ? 'allow_session' : 'allow',
          undefined,
          undefined,
          false,
        );
    else if ((event.type === 'form.replied' || event.type === 'form.cancelled') && data.id)
      session.turn?.pending
        .get(data.id)
        ?.answer(event.type === 'form.replied' ? 'allow' : 'deny', undefined, undefined, false);
  }
  private emitText(
    session: OpencodeSession,
    turn: OpencodeTurn,
    kind: 'text' | 'reasoning',
    text: string,
  ): void {
    session.emit(
      kind === 'text'
        ? { turn_id: turn.id, kind: 'message.delta', text }
        : { turn_id: turn.id, kind: 'reasoning', text },
    );
  }
  /** Emits what text holds past what the part emitted; text grows only at its end. */
  private text(
    session: OpencodeSession,
    turn: OpencodeTurn,
    kind: 'text' | 'reasoning',
    key: string,
    text: string,
    ended: boolean,
  ): void {
    let part = session.parts.get(key);
    if (!part) session.parts.set(key, (part = { emitted: 0, live: false, ended: false }));
    if (part.ended) return;
    if (text.length > part.emitted) {
      this.emitText(session, turn, kind, text.slice(part.emitted));
      part.emitted = text.length;
    }
    if (ended) part.ended = true;
  }
  private toolStarted(
    session: OpencodeSession,
    turn: OpencodeTurn,
    id: string,
    input: unknown,
  ): void {
    if (session.toolsStarted.has(id)) return;
    session.toolsStarted.add(id);
    session.emit({
      turn_id: turn.id,
      kind: 'tool.started',
      tool_call_id: id,
      name: session.toolNames.get(id) ?? 'tool',
      input,
    });
  }
  private toolEnded(
    session: OpencodeSession,
    turn: OpencodeTurn,
    id: string,
    ok: boolean,
    output: unknown,
  ): void {
    if (session.toolsEnded.has(id)) return;
    this.toolStarted(session, turn, id, undefined);
    session.toolsEnded.add(id);
    session.emit({ turn_id: turn.id, kind: 'tool.completed', tool_call_id: id, ok, output });
  }
  /** Adds a step's usage to the turn and reports the turn's totals. */
  private step(
    session: OpencodeSession,
    turn: OpencodeTurn,
    message: string,
    cost: number,
    tokens: Tokens,
  ): void {
    if (turn.steps.has(message)) return;
    turn.steps.add(message);
    const usage = turn.usage;
    usage.input += tokens.input;
    usage.output += tokens.output;
    usage.reasoning += tokens.reasoning;
    usage.read += tokens.cache.read;
    usage.write += tokens.cache.write;
    turn.cost += cost;
    // OpenCode counts cache and reasoning tokens apart from input and output.
    session.emit({
      turn_id: turn.id,
      kind: 'usage.updated',
      input_tokens: usage.input + usage.read + usage.write,
      cached_input_tokens: usage.read,
      cache_write_input_tokens: usage.write,
      output_tokens: usage.output + usage.reasoning,
      reasoning_output_tokens: usage.reasoning,
      cost_usd: turn.cost,
      cost_source: 'provider_reported',
      context_tokens: tokens.input + tokens.cache.read + tokens.cache.write,
    });
  }
  private title(session: OpencodeSession, title: string | undefined): void {
    if (!session.autoTitle || !title || title === session.title) return;
    session.title = title;
    session.emit({ turn_id: session.turn?.id, kind: 'title.generated', title });
  }
  private settle(turn: OpencodeTurn, outcome: Outcome, error?: StructuredError): void {
    if (outcome === 'succeeded') turn.finish('completed');
    else if (outcome === 'interrupted') turn.finish('interrupted');
    else turn.finish('failed', error?.message ?? 'OpenCode execution failed');
  }
  private ask(session: OpencodeSession, request: PermissionRequest): void {
    if (session.asked.has(request.id)) return;
    session.asked.add(request.id);
    const reply = (decision: 'once' | 'reject', message?: string): void =>
      void call(
        session,
        'POST',
        `/api/session/${encodeURIComponent(request.sessionID)}/permission/${encodeURIComponent(request.id)}/reply`,
        this.requestTimeoutMs,
        { decision, ...(message ? { message } : {}) },
      ).catch(() => {});
    const turn = session.turn;
    if (!turn || turn.interrupted || session.stopping) {
      reply('reject');
      return;
    }
    const resources = request.resources ?? [];
    const rule = resources.length ? `${request.action}(${resources.join(' ')})` : request.action;
    const write = WRITE_ACTIONS.includes(request.action);
    if (write && turn.readOnly) {
      reply('reject', READ_ONLY);
      return;
    }
    // Allowed rules stay dormant in plan mode, as in the Claude and Codex adapters.
    if (session.mode !== 'plan' && session.allowed.has(rule)) {
      reply('once');
      return;
    }
    this.hold(
      session,
      turn,
      request.id,
      'permission.asked',
      request.action,
      {
        ...(request.source ? { tool_call_id: request.source.id } : {}),
        kind: request.action,
        input: { resources: request.resources, metadata: request.metadata },
        ...(request.message ? { message: request.message } : {}),
      },
      write,
      (decision, _answers, reason) => {
        // Always grants persist for the whole project in OpenCode, so a session grant stays here.
        if (decision === 'allow_session') session.allowed.add(rule);
        if (decision === undefined) reply('reject');
        // A reject without a message ends the whole execution.
        else if (decision === 'deny') reply('reject', reason || DECLINED);
        else reply('once');
      },
      rule,
    );
  }
  private form(session: OpencodeSession, form: FormInfo): void {
    if (session.asked.has(form.id)) return;
    session.asked.add(form.id);
    const route = `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(form.id)}`;
    const cancel = (message?: string): void =>
      void call(
        session,
        'DELETE',
        message ? `${route}?message=${encodeURIComponent(message)}` : route,
        this.requestTimeoutMs,
      ).catch(() => {});
    const turn = session.turn;
    if (!turn || turn.interrupted || session.stopping) {
      cancel();
      return;
    }
    const questions = formQuestions(form.fields ?? []);
    if (!questions) {
      cancel('Pantheon cannot show this form');
      return;
    }
    this.hold(
      session,
      turn,
      form.id,
      'form.created',
      'AskUserQuestion',
      {
        input: { title: form.title, fields: form.fields },
        questions: questions.map(({ question }) => question),
      },
      false,
      (decision, answers = {}, reason) => {
        if (decision === undefined) cancel();
        else if (decision === 'deny') cancel(reason || DECLINED);
        else
          void call(session, 'POST', `${route}/reply`, this.requestTimeoutMs, {
            answer: Object.fromEntries(
              questions.flatMap(({ field, question, values }): [string, unknown][] => {
                const text = answers[question.question];
                return text === undefined ? [] : [[field.key, formValue(field, values, text)]];
              }),
            ),
          }).catch(() => {});
      },
    );
  }
  private hold(
    session: OpencodeSession,
    turn: OpencodeTurn,
    request_id: string,
    native_type: string,
    tool: string,
    detail: unknown,
    write: boolean,
    reply: (
      decision: PermissionDecision | undefined,
      answers?: Record<string, string>,
      reason?: string,
    ) => void,
    rule?: string,
  ): void {
    turn.pending.set(request_id, {
      write,
      answer: (choice, answers, reason, native = true) => {
        if (!turn.pending.delete(request_id)) return;
        const refused = write && turn.readOnly && choice !== undefined && native;
        const decision = refused ? 'deny' : choice;
        if (!turn.pending.size) turn.pauseClock(false);
        session.emit({
          turn_id: turn.id,
          kind: 'permission.resolved',
          request_id,
          decision: decision ?? 'deny',
          ...(decision === undefined ? { cancelled: true as const } : {}),
        });
        if (native) reply(decision, answers, refused ? READ_ONLY : reason);
      },
    });
    if (turn.pending.size === 1) turn.pauseClock(true);
    session.emit({
      turn_id: turn.id,
      native_type,
      kind: 'permission.requested',
      request_id,
      project_rule_supported: false,
      tool,
      ...(rule ? { rule } : {}),
      detail,
    });
  }
  private promptFiles(turn: UserTurn): { uri: string; name: string }[] {
    return [...(turn.attachments ?? []), ...(turn.skills ?? [])].map((file) => ({
      uri: pathToFileURL(file.path).href,
      name: file.name,
    }));
  }
  async send(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> {
    const session = this.sessions.get(handle);
    if (!session || session.stopping || session.turn || !this.alive(session))
      return { turn_id: turn.turn_id, status: 'unsupported', reason: 'Session is not idle' };
    if (turn.compact)
      return {
        turn_id: turn.turn_id,
        status: 'unsupported',
        reason: 'This adapter does not implement manual context compaction',
      };
    const files = this.promptFiles(turn);
    const text = session.instructions ? `${session.instructions}\n\n${turn.input}` : turn.input;
    delete session.instructions;
    session.parts.clear();
    session.toolsStarted.clear();
    session.toolsEnded.clear();
    let timer: NodeJS.Timeout | undefined,
      left = session.wallTimeMs,
      since = Date.now();
    let admit!: (id: string | undefined) => void;
    const current: OpencodeTurn = {
      id: turn.turn_id,
      readOnly: turn.read_only === true,
      admitted: new Promise((resolve) => (admit = resolve)),
      steers: [],
      steps: new Set(),
      usage: { input: 0, output: 0, reasoning: 0, read: 0, write: 0 },
      cost: 0,
      pending: new Map(),
      pauseClock: (paused) => {
        if (session.turn !== current) return;
        clearTimeout(timer);
        if (paused) left -= Date.now() - since;
        else {
          since = Date.now();
          timer = setTimeout(expire, left);
        }
      },
      finish: (status, error, code) => {
        if (session.turn !== current) return;
        session.turn = undefined;
        clearTimeout(timer);
        for (const pending of current.pending.values()) pending.answer(undefined);
        void this.writeRules(session, handle).catch(() => {});
        session.emit({
          turn_id: current.id,
          kind: 'turn.completed',
          status,
          ...(error ? { error } : {}),
          ...(code ? { error_code: code } : {}),
        });
      },
    };
    const expire = () => {
      if (session.stopping) return;
      void this.interruptNative(session, handle);
      if (current.running) session.stale = true;
      current.finish('failed', 'OpenCode turn deadline exceeded', 'turn_deadline');
    };
    session.turn = current;
    timer = setTimeout(expire, left);
    session.emit({ turn_id: current.id, kind: 'turn.started' });
    this.writeRules(session, handle)
      .then(() =>
        call<{ data: { id: string } }>(
          session,
          'POST',
          `/api/session/${encodeURIComponent(handle.native_session_id)}/prompt`,
          this.requestTimeoutMs,
          { text, ...(files.length ? { files } : {}) },
        ),
      )
      .then(
        (result) => admit(result.data.id),
        (error: Error) => {
          admit(undefined);
          current.finish('failed', `OpenCode prompt failed: ${error.message}`);
        },
      );
    return { turn_id: turn.turn_id, status: 'delivered' };
  }
  async steer(handle: SessionHandle, turn: UserTurn): Promise<DeliveryReceipt> {
    const session = this.sessions.get(handle);
    const current = session?.turn;
    // Queued input is sent by the control layer once the running turn ends.
    if (!session || !current || session.stopping)
      return { turn_id: turn.turn_id, status: 'queued', reason: 'No OpenCode turn to steer' };
    if (current.interrupted)
      return {
        turn_id: turn.turn_id,
        status: 'queued',
        reason: 'The OpenCode turn is interrupting',
      };
    const files = this.promptFiles(turn);
    const result = await call<{ data: { id: string } }>(
      session,
      'POST',
      `/api/session/${encodeURIComponent(handle.native_session_id)}/prompt`,
      this.requestTimeoutMs,
      { text: turn.input, ...(files.length ? { files } : {}), delivery: 'steer' },
    );
    current.steers.push(result.data.id);
    return { turn_id: turn.turn_id, status: 'delivered' };
  }
  private interruptNative(
    session: OpencodeSession,
    handle: SessionHandle,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<{ interrupted: boolean } | undefined> {
    return call<{ interrupted: boolean }>(
      session,
      'POST',
      `/api/session/${encodeURIComponent(handle.native_session_id)}/interrupt`,
      timeoutMs,
    ).catch(() => undefined);
  }
  async interrupt(handle: SessionHandle): Promise<Receipt> {
    const session = this.sessions.get(handle);
    const current = session?.turn;
    if (!session || !current || session.stopping)
      return { ok: false, reason: 'No OpenCode turn is running' };
    if (current.interrupted) return { ok: true, reason: 'The turn is already interrupting' };
    current.interrupted = true;
    for (const pending of current.pending.values()) pending.answer(undefined);
    // Inputs still in the inbox would start a new execution after the interrupt.
    const admitted = await current.admitted;
    await Promise.all(
      [...(admitted ? [admitted] : []), ...current.steers].map((id) =>
        call(
          session,
          'DELETE',
          `/api/session/${encodeURIComponent(handle.native_session_id)}/inbox/${encodeURIComponent(id)}`,
          this.requestTimeoutMs,
        ).catch(() => {}),
      ),
    );
    let result: { interrupted: boolean };
    try {
      result = await call<{ interrupted: boolean }>(
        session,
        'POST',
        `/api/session/${encodeURIComponent(handle.native_session_id)}/interrupt`,
        this.requestTimeoutMs,
      );
    } catch (error) {
      current.interrupted = false;
      return { ok: false, reason: (error as Error).message };
    }
    // Nothing was executing, so no interrupted event will end the turn.
    if (!result.interrupted) current.finish('interrupted');
    return { ok: true };
  }
  async setPermissionMode(handle: SessionHandle, mode: PermissionMode): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown OpenCode session' };
    const previous = session.mode;
    session.mode = mode;
    try {
      await this.writeRules(session, handle);
    } catch (error) {
      session.mode = previous;
      return { ok: false, reason: (error as Error).message };
    }
    return { ok: true };
  }
  setTurnReadOnly(handle: SessionHandle, readOnly: boolean): void {
    const session = this.sessions.get(handle);
    const turn = session?.turn;
    if (!session || !turn) return;
    turn.readOnly = readOnly;
    void this.writeRules(session, handle).catch(() => {});
    if (readOnly)
      for (const pending of [...turn.pending.values()]) if (pending.write) pending.answer('deny');
  }
  async setModel(
    handle: SessionHandle,
    model: string,
    effort: EffortLevel | undefined,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session) return { ok: false, reason: 'Unknown OpenCode session' };
    const ref = modelRef(model, effort);
    if (!ref)
      return { ok: false, reason: `OpenCode model ids take the form provider/model, not ${model}` };
    try {
      await call(
        session,
        'POST',
        `/api/session/${encodeURIComponent(handle.native_session_id)}/model`,
        this.requestTimeoutMs,
        { model: ref },
      );
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    handle.requested_model = model;
    handle.requested_effort = effort;
    handle.reported_model = modelName(ref);
    return { ok: true };
  }
  async attach(
    handle: SessionHandle,
    _cursor: string | undefined,
    sink: AgentEventSink,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle);
    if (!session || session.stopping || !this.alive(session))
      return { ok: false, reason: 'No live OpenCode session for this handle' };
    session.sink = sink;
    try {
      await this.resync(session, handle);
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
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
    reason?: string,
  ): Promise<Receipt> {
    const session = this.sessions.get(handle);
    const pending = session?.turn?.pending.get(request_id);
    if (!pending)
      return {
        ok: false,
        reason: 'Unknown permission request',
        ...(session ? { unknown_request: true } : {}),
      };
    pending.answer(decision, answers, reason);
    return { ok: true };
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
      for (const pending of current.pending.values()) pending.answer(undefined);
      // The session's database keeps an execution the server did not end as running.
      if (this.alive(session))
        await this.interruptNative(
          session,
          handle,
          Math.max(1, Math.min(1000, (deadline - Date.now()) / 2)),
        );
    }
    session.stream?.abort();
    const receipt = await terminate(session.child, session.exited, deadline);
    current?.finish('interrupted');
    return receipt;
  }
  async close(handle: SessionHandle, deadline: number): Promise<CancelReceipt> {
    return this.cancel(handle, deadline);
  }
  private alive(session: OpencodeSession): boolean {
    return session.child.exitCode === null && session.child.signalCode === null;
  }
}
