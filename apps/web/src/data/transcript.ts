import type { BoardSnapshot, RuntimeModel } from '@pantheon/protocol';
import { t } from '../i18n';
import { durationText } from '../lib/time-text';
import { shortId } from './format';
import { mergeEvents } from './logs';
import type { Availability } from './needs-you';
import type { DaemonEvent } from './sync';
import { orchestrationLabel } from './tool-calls';

export type Session = BoardSnapshot['sessions'][number];
export type SessionTurn = BoardSnapshot['session_turns'][number];

/** What a session is for: the user's own project conversation or one of the daemon's roles. */
export type SessionPurpose = 'conversation' | 'reviewer';

// Labels are getters, so each is read in the language loaded by then.
export const PURPOSE: Record<SessionPurpose, string> = {
  get conversation() {
    return t({
      id: 'data.transcript.purpose.conversation',
      defaultMessage: 'Project conversation',
    });
  },
  get reviewer() {
    return t({ id: 'data.transcript.purpose.reviewer', defaultMessage: 'Review' });
  },
};

/** Sessions the daemon created for a review are its own. */
export function sessionPurpose(session: Pick<Session, 'review_id'>): SessionPurpose {
  return session.review_id ? 'reviewer' : 'conversation';
}

/** Board tables that give a session a readable title; each is optional. */
export interface TitleContext {
  projects?: readonly Pick<BoardSnapshot['projects'][number], 'id' | 'name'>[];
  session_turns?: readonly Pick<SessionTurn, 'session_id' | 'input' | 'origin'>[];
}

const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// Serialized control input is not a title.
const readable = (text: string | undefined, max = 80): string | undefined => {
  const line = text === undefined ? '' : oneLine(text, max);
  return line && !/^[[{]/.test(line) ? line : undefined;
};

/**
 * The first of: saved title, baseline kind, native title without its project prefix, a
 * conversation's first message, purpose and short id.
 */
export function sessionTitle(session: Session, context: TitleContext = {}): string {
  const saved = oneLine(session.title ?? '', 80);
  if (saved) return saved;
  // The daemon gives a baseline session an English native title.
  if (session.baseline) return t({ id: 'data.transcript.baseline', defaultMessage: 'Baseline' });
  const projectName = context.projects?.find((p) => p.id === session.project_id)?.name;
  const native = readable(session.native_title, Infinity);
  if (native) {
    const prefix = projectName ? `${oneLine(projectName, Infinity)} · ` : null;
    return oneLine(
      prefix && native.startsWith(prefix) && native.length > prefix.length
        ? native.slice(prefix.length)
        : native,
      80,
    );
  }
  const purpose = sessionPurpose(session);
  const goal =
    purpose === 'conversation'
      ? readable(
          context.session_turns?.find(
            (t) => t.session_id === session.id && t.origin !== 'compaction',
          )?.input,
        )
      : undefined;
  if (goal)
    return t(
      { id: 'data.transcript.purposeGoal', defaultMessage: '{purpose}: {goal}' },
      { purpose: PURPOSE[purpose], goal },
    );
  return purpose === 'conversation'
    ? t(
        { id: 'data.transcript.sessionId', defaultMessage: 'Session {id}' },
        { id: shortId(session.id) },
      )
    : t(
        { id: 'data.transcript.purposeId', defaultMessage: '{purpose} {id}' },
        { purpose: PURPOSE[purpose], id: shortId(session.id) },
      );
}

/**
 * The model the session asked for and the one the runtime reported, when they differ; a requested
 * id the runtime's model list holds is named by its label.
 */
export function modelText(
  session: Pick<Session, 'requested_model' | 'reported_model'>,
  models: readonly RuntimeModel[] = [],
): string {
  const { requested_model: id, reported_model: reported } = session;
  const listed = models.find((m) => m.id === id || m.resolved === id);
  const requested = listed?.label ?? id;
  if (!requested && !reported)
    return t({ id: 'data.transcript.model.none', defaultMessage: 'Model not given' });
  if (!reported)
    return t(
      {
        id: 'data.transcript.model.unreported',
        defaultMessage: 'Requested {requested}, actual not reported',
      },
      { requested },
    );
  if (!id || id === reported || listed?.resolved === reported)
    return t(
      { id: 'data.transcript.model.reported', defaultMessage: 'Model {model}' },
      { model: reported },
    );
  return t(
    {
      id: 'data.transcript.model.differs',
      defaultMessage: 'Requested {requested}, actual {reported}',
    },
    { requested, reported },
  );
}

/** Whether an event belongs to the session: its agent events and its turns' events. */
export function isSessionEvent(
  event: DaemonEvent,
  session_id: string,
  turnIds: ReadonlySet<string>,
): boolean {
  return event.aggregate_id === session_id || turnIds.has(event.aggregate_id);
}

const field = (payload: unknown, key: string): unknown =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export interface TurnEnd {
  state: string;
  error: string | null;
}

/** A tool call: its agent.tool.started and agent.tool.completed paired by tool_call_id. */
export interface ToolItem {
  kind: 'tool';
  id: string;
  /** '' when only the completion arrived. */
  name: string;
  input: unknown;
  output?: unknown;
  /** Absent until the call completes. */
  ok?: boolean;
  /** The call whose subagent made this one. */
  parent?: string;
  /** created_at of agent.tool.started. */
  started_at?: number;
  /** created_at of agent.tool.completed. */
  completed_at?: number;
  /** The MCP tool's ui:// interface on its server. */
  app?: { server: string; resource_uri: string };
  /** The CallToolResult the interface receives. */
  app_result?: { content: unknown[]; structuredContent?: unknown; isError?: boolean };
  /** Images the call returned: by the hash of their stored bytes, or base64 in older events. */
  images?: ToolImage[];
  /** The claude.ai page an Artifact call published from the local file at `path`. */
  artifact?: { url: string; path: string; title?: string; version?: string };
}

export type ToolImage = { mime: string } & ({ hash: string; size: number } | { data: string });

export type RequestOutcome = 'approve' | 'approve_session' | 'reject' | 'interrupted' | 'void';

/** A permission request or question of the agent, paired with its approval by request_id. */
export interface RequestItem {
  kind: 'request';
  id: string;
  tool: string;
  input: unknown;
  /** The question texts of an AskUserQuestion request. */
  questions: string[];
  /** Absent while the request waits. */
  outcome?: RequestOutcome;
  /** The user's reason for a denial. */
  reason?: string;
  /** Question text to its answer. */
  answers?: Record<string, string>;
}

/** The model's readable reasoning; summary marks the runtime's summary of it. */
export interface ReasoningItem {
  kind: 'reasoning';
  text: string;
  summary: boolean;
}

/** A visual the session drew, at the revision of its newest visual.drawn event. */
export interface VisualItem {
  kind: 'visual';
  visual_id: string;
  revision: number;
}

export type TranscriptItem =
  | { kind: 'text'; text: string }
  | ReasoningItem
  | ToolItem
  | RequestItem
  | VisualItem
  | { kind: 'event'; event: DaemonEvent };

export type ToolState = 'running' | 'ok' | 'failed' | 'none';

/** A call without a result is running until its turn ends, then it got none. */
export function toolState(item: Pick<ToolItem, 'ok'>, ended: boolean): ToolState {
  if (item.ok !== undefined) return item.ok ? 'ok' : 'failed';
  return ended ? 'none' : 'running';
}

/** Milliseconds from the call's start to its completion; null until both are known. */
export const toolDuration = (item: Pick<ToolItem, 'started_at' | 'completed_at'>): number | null =>
  item.started_at !== undefined && item.completed_at !== undefined
    ? Math.max(0, item.completed_at - item.started_at)
    : null;

/**
 * A dispatched subagent as it ran. A Codex spawn completes on dispatch, so it ends with the first
 * later collab call whose agentsStates marks its thread completed or errored, with that message.
 */
export function subagentRun(agent: ToolItem, later: readonly TranscriptItem[]): ToolItem {
  const spawned = field(agent.output, 'agentsStates');
  if (agent.name !== 'collabAgentToolCall' || agent.ok !== true || !spawned) return agent;
  const threads = Object.keys(spawned);
  const running = { ...agent };
  delete running.ok;
  delete running.completed_at;
  delete running.output;
  for (const item of later) {
    if (item.kind !== 'tool' || item.name !== 'collabAgentToolCall') continue;
    const states = field(item.output, 'agentsStates');
    for (const thread of threads) {
      const state = field(states, thread);
      const status = field(state, 'status');
      if (status !== 'completed' && status !== 'errored') continue;
      const message = str(field(state, 'message'));
      return {
        ...running,
        ok: status === 'completed',
        ...(item.completed_at !== undefined && { completed_at: item.completed_at }),
        ...(message !== undefined && { output: message }),
      };
    }
  }
  return running;
}

/** Seconds to a tenth under a minute, for timings read closely; durationText from there on. */
export function elapsedText(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  if (tenths < 600)
    return t(
      { id: 'data.elapsed.seconds', defaultMessage: '{seconds}s' },
      { seconds: (tenths / 10).toFixed(1) },
    );
  return durationText(tenths * 100);
}

/** Two or more tool calls in a row, shown as one folded row. */
export interface ToolGroup {
  kind: 'group';
  calls: ToolItem[];
}

/**
 * The items with each run of two or more consecutive tool calls folded into one group; an
 * orchestration call and a call with an interface stand alone like text.
 */
export function groupToolCalls(items: readonly TranscriptItem[]): (TranscriptItem | ToolGroup)[] {
  const blocks: (TranscriptItem | ToolGroup)[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length > 1) blocks.push({ kind: 'group', calls: run });
    else blocks.push(...run);
    run = [];
  };
  for (const item of items) {
    if (item.kind === 'tool' && !orchestrationLabel(item.name, item.input) && !item.app)
      run.push(item);
    else {
      flush();
      blocks.push(item);
    }
  }
  flush();
  return blocks;
}

/**
 * A finished turn split for its folded view: opening text, the work behind one row, the items that
 * stay visible, and the last text. Null when the work holds no plain tool call.
 */
export function foldTurn(items: TranscriptItem[]): {
  head: TranscriptItem[];
  work: TranscriptItem[];
  kept: TranscriptItem[];
  tail: TranscriptItem[];
} | null {
  const last = items.findLastIndex((item) => item.kind === 'text');
  const first = items.findIndex((item) => item.kind === 'text');
  const firstTool = items.findIndex((item) => item.kind === 'tool');
  const opening = first !== last && (firstTool === -1 || first < firstTool) ? first : -1;
  const work: TranscriptItem[] = [];
  const kept: TranscriptItem[] = [];
  items.forEach((item, i) => {
    if (i === last || i === opening) return;
    const visible =
      (item.kind === 'tool' &&
        (orchestrationLabel(item.name, item.input) !== null || item.app !== undefined)) ||
      (item.kind === 'request' && item.outcome === undefined) ||
      item.kind === 'visual';
    (visible ? kept : work).push(item);
  });
  if (!work.some((item) => item.kind === 'tool')) return null;
  return {
    head: opening === -1 ? [] : [items[opening]!],
    work,
    kept,
    tail: last === -1 ? [] : [items[last]!],
  };
}

const OUTCOME: Record<RequestOutcome, string> = {
  get approve() {
    return t({ id: 'data.transcript.outcome.approve', defaultMessage: 'Allow once' });
  },
  get approve_session() {
    return t({
      id: 'data.transcript.outcome.approveSession',
      defaultMessage: 'Allow for this session',
    });
  },
  get reject() {
    return t({ id: 'data.transcript.outcome.reject', defaultMessage: 'Deny' });
  },
  get interrupted() {
    return t({ id: 'data.transcript.outcome.interrupted', defaultMessage: 'Interrupted' });
  },
  get void() {
    return t({ id: 'data.transcript.outcome.void', defaultMessage: 'Voided' });
  },
};

/** How the request was answered, with the reason of a denial. */
export function outcomeText(item: Pick<RequestItem, 'outcome' | 'reason'>): string {
  if (!item.outcome) return '';
  const label = OUTCOME[item.outcome];
  return item.outcome === 'reject' && item.reason
    ? t(
        { id: 'data.transcript.outcomeReason', defaultMessage: '{label}: {reason}' },
        { label, reason: item.reason },
      )
    : label;
}

const NATIVE_OUTCOME: Record<string, RequestOutcome> = {
  allow: 'approve',
  allow_session: 'approve_session',
  deny: 'reject',
};

/** The answer the newest approval event carries, else the runtime's own decision. */
function requestAnswer(
  approval: unknown,
  decision: string | undefined,
): Pick<RequestItem, 'outcome' | 'reason' | 'answers'> {
  if (approval === undefined) {
    const outcome = decision === undefined ? undefined : NATIVE_OUTCOME[decision];
    return outcome ? { outcome } : {};
  }
  const state = field(approval, 'state'),
    reason = field(approval, 'reason');
  const answers = field(approval, 'answers');
  const outcome: RequestOutcome | undefined =
    state === 'approved'
      ? field(approval, 'session_wide') === true
        ? 'approve_session'
        : 'approve'
      : state === 'rejected'
        ? reason === 'session_lost'
          ? 'interrupted'
          : 'reject'
        : state === 'void'
          ? reason === 'session_lost'
            ? 'interrupted'
            : 'void'
          : undefined;
  if (!outcome) return {};
  const why = str(field(approval, 'decision_reason'));
  return {
    outcome,
    ...(why ? { reason: why } : {}),
    ...(answers && typeof answers === 'object'
      ? { answers: answers as Record<string, string> }
      : {}),
  };
}

/** Events shown only in the verbose transcript. */
export function isQuietEvent(event: DaemonEvent): boolean {
  if (
    event.kind === 'agent.session.started' ||
    event.kind === 'agent.extensions.applied' ||
    event.kind === 'agent.auth.checked' ||
    // The composer shows fast mode, and the session bar the title.
    event.kind === 'agent.fast_mode.changed' ||
    event.kind === 'agent.title.generated' ||
    // ACP agents report the turn start; the turn header shows it already.
    event.kind === 'agent.turn.started' ||
    // Comes every few seconds per running task; the monitor panel shows it.
    event.kind === 'agent.task.progress'
  )
    return true;
  if (event.kind !== 'agent.native') return false;
  // Native frames are runtime protocol traffic; a failed MCP server start is the one worth showing.
  return mcpStartFailure(event) === null;
}

/** The server and error of a Codex frame that reports a failed MCP server start. */
export function mcpStartFailure(
  event: DaemonEvent,
): { server: string; error: string | null } | null {
  if (
    event.kind !== 'agent.native' ||
    str(field(event.payload, 'native_type')) !== 'mcpServer/startupStatus/updated'
  )
    return null;
  const params = field(field(event.payload, 'native'), 'params');
  if (field(params, 'status') !== 'failed') return null;
  return { server: str(field(params, 'name')) ?? '', error: str(field(params, 'error')) ?? null };
}

export interface TurnView {
  turn: SessionTurn;
  /** created_at of the turn.queued event; null while that event is not loaded. */
  at: number | null;
  /** created_at of the first turn.running event. */
  started_at: number | null;
  /** created_at of the event that set `end`. */
  ended_at: number | null;
  /** The turn's agent.message.delta texts joined in sequence order. */
  text: string;
  /** Payload of the turn's newest agent.usage.updated event. */
  usage: unknown;
  /** The newest turn.completed / failed / cancelled event, failed delivery, or agent.turn.completed. */
  end: TurnEnd | null;
  /** Message text, tool calls and the turn's other agent events in sequence order. */
  items: TranscriptItem[];
  /** The MCP server whose interface sent the turn's input. */
  app?: { server: string };
  /** The turn's key point: what its newest agent.session.recapped event says happened. */
  summary?: string;
}

export interface Transcript {
  turns: TurnView[];
  /** Agent events whose turn_id names no turn of the session. */
  loose: { text: string; usage: unknown; items: TranscriptItem[] };
}

const TURN_END = new Set(['turn.completed', 'turn.failed', 'turn.cancelled']);

type Owner = TurnView | Transcript['loose'];
/** Where an item sits; an update replaces it there with a new object. */
interface Slot<T> {
  item: T;
  owner: Owner;
  index: number;
}
interface Build {
  ids: string;
  /** The events applied so far, in sequence order. */
  events: DaemonEvent[];
  views: Map<string, TurnView>;
  loose: Transcript['loose'];
  calls: Map<string, Slot<ToolItem>>;
  requests: Map<string, Slot<RequestItem> & { base: RequestItem }>;
  approvals: Map<string, unknown>;
  decisions: Map<string, string>;
  visuals: Map<string, Slot<VisualItem>>;
  /** Servers whose failed start the thread already shows; Codex reports it again every turn. */
  mcpFailed: Set<string>;
  /** The owner of the newest agent event; visual.drawn names no turn, so a drawing lands there. */
  latest: Owner;
  /** Owners changed since they were last returned. */
  dirty: Set<Owner>;
  returned: Map<Owner, Owner>;
}

// The last build; a call with the same turns and more of the same events continues it.
let last: Build | null = null;

function startBuild(turns: readonly SessionTurn[], ids: string): Build {
  const loose: Transcript['loose'] = { text: '', usage: null, items: [] };
  return {
    ids,
    events: [],
    views: new Map(
      turns.map((turn) => [
        turn.id,
        {
          turn,
          at: null,
          started_at: null,
          ended_at: null,
          text: '',
          usage: null,
          end: null,
          items: [],
        },
      ]),
    ),
    loose,
    calls: new Map(),
    requests: new Map(),
    approvals: new Map(),
    decisions: new Map(),
    visuals: new Map(),
    mcpFailed: new Set(),
    latest: loose,
    dirty: new Set(),
    returned: new Map(),
  };
}

function place<T extends TranscriptItem>(b: Build, slot: Slot<T>, item: T): void {
  slot.item = item;
  slot.owner.items[slot.index] = item;
  b.dirty.add(slot.owner);
}

function answerRequest(b: Build, id: string): void {
  const slot = b.requests.get(id);
  if (slot)
    place(b, slot, { ...slot.base, ...requestAnswer(b.approvals.get(id), b.decisions.get(id)) });
}

function applyEvent(b: Build, event: DaemonEvent): void {
  const own = b.views.get(event.aggregate_id);
  if (own) {
    if (event.kind === 'turn.queued') {
      own.at = event.created_at;
      const server = str(field(field(event.payload, 'app'), 'server'));
      if (server) own.app = { server };
    }
    if (event.kind === 'turn.running') own.started_at ??= event.created_at;
    if (TURN_END.has(event.kind)) {
      own.end = {
        state: event.kind.slice('turn.'.length),
        error: str(field(event.payload, 'error')) ?? null,
      };
      own.ended_at = event.created_at;
    }
    // A steer that never reached the agent ends with this event alone.
    if (event.kind === 'session.turn.delivery' && field(event.payload, 'delivery') === 'failed') {
      own.end = {
        state: 'failed',
        error: str(field(event.payload, 'reason')) ?? own.turn.delivery_reason ?? null,
      };
      own.ended_at = event.created_at;
    }
    b.dirty.add(own);
    return;
  }
  if (event.kind.startsWith('approval.')) {
    const request = str(field(event.payload, 'request_id'));
    if (request) {
      b.approvals.set(request, event.payload);
      answerRequest(b, request);
    }
    return;
  }
  if (event.kind === 'visual.drawn') {
    const id = str(field(event.payload, 'visual_id')) ?? '';
    const revision = Number(field(event.payload, 'revision'));
    const item: VisualItem = { kind: 'visual', visual_id: id, revision };
    // A redraw replaces the item where the first drawing put it.
    const slot = b.visuals.get(id) ?? { item, owner: b.latest, index: b.latest.items.length };
    b.visuals.set(id, slot);
    place(b, slot, item);
    return;
  }
  if (!event.kind.startsWith('agent.')) return;
  // The runtime's quota shows in the tray and Insights, not in the thread.
  if (event.kind === 'agent.quota.updated') return;
  const server = mcpStartFailure(event)?.server;
  if (server !== undefined) {
    if (b.mcpFailed.has(server)) return;
    b.mcpFailed.add(server);
  }
  const target = b.views.get(str(field(event.payload, 'turn_id')) ?? '') ?? b.loose;
  const p = event.payload;
  b.latest = target;
  b.dirty.add(target);
  if (event.kind === 'agent.message.delta') {
    const text = str(field(p, 'text')) ?? '';
    target.text += text;
    const lastItem = target.items.at(-1);
    if (lastItem?.kind === 'text')
      target.items[target.items.length - 1] = { kind: 'text', text: lastItem.text + text };
    else if (text) target.items.push({ kind: 'text', text });
  } else if (event.kind === 'agent.reasoning') {
    const text = str(field(p, 'text'));
    if (text) target.items.push({ kind: 'reasoning', text, summary: field(p, 'summary') === true });
  } else if (event.kind === 'agent.tool.started' || event.kind === 'agent.tool.completed') {
    const id = str(field(p, 'tool_call_id')) ?? '';
    let slot = b.calls.get(id);
    if (!slot) {
      const item: ToolItem = { kind: 'tool', id, name: '', input: undefined };
      slot = { item, owner: target, index: target.items.length };
      b.calls.set(id, slot);
      target.items.push(item);
    }
    const call = { ...slot.item };
    const parent = str(field(p, 'parent_tool_use_id'));
    if (parent) call.parent = parent;
    if (event.kind === 'agent.tool.started') {
      call.name = str(field(p, 'name')) ?? call.name;
      call.input = field(p, 'input') ?? call.input;
      call.started_at = event.created_at;
      const app = field(p, 'app');
      const server = str(field(app, 'server')),
        resource_uri = str(field(app, 'resource_uri'));
      if (server && resource_uri) call.app = { server, resource_uri };
    } else {
      call.output = field(p, 'output');
      call.ok = field(p, 'ok') === true;
      call.completed_at = event.created_at;
      const result = field(p, 'app_result');
      if (Array.isArray(field(result, 'content')))
        call.app_result = result as NonNullable<ToolItem['app_result']>;
      const images = field(p, 'images');
      if (Array.isArray(images))
        call.images = images.filter(
          (image) =>
            /^image\//.test(str(field(image, 'mime')) ?? '') &&
            (str(field(image, 'hash')) || str(field(image, 'data'))),
        );
      const artifact = field(p, 'artifact');
      const url = str(field(artifact, 'url')),
        path = str(field(artifact, 'path'));
      if (url && path) {
        const title = str(field(artifact, 'title')),
          version = str(field(artifact, 'version'));
        call.artifact = {
          url,
          path,
          ...(title ? { title } : {}),
          ...(version ? { version } : {}),
        };
      }
    }
    place(b, slot, call);
  } else if (
    event.kind === 'agent.permission.requested' ||
    event.kind === 'agent.permission.resolved'
  ) {
    const id = str(field(p, 'request_id')) ?? '';
    let slot = b.requests.get(id);
    if (!slot) {
      const base: RequestItem = { kind: 'request', id, tool: '', input: undefined, questions: [] };
      slot = { base, item: base, owner: target, index: target.items.length };
      b.requests.set(id, slot);
      target.items.push(base);
    }
    if (event.kind === 'agent.permission.requested') {
      const detail = field(p, 'detail'),
        questions = field(detail, 'questions');
      slot.base = {
        ...slot.base,
        tool: str(field(p, 'tool')) ?? slot.base.tool,
        input: field(detail, 'input'),
        questions: Array.isArray(questions)
          ? questions.flatMap((q) => str(field(q, 'question')) ?? [])
          : [],
      };
    } else {
      const decision = str(field(p, 'decision'));
      if (decision) b.decisions.set(id, decision);
    }
    answerRequest(b, id);
  } else if (event.kind === 'agent.usage.updated') target.usage = event.payload;
  else if (event.kind === 'agent.session.recapped') {
    const summary = str(field(p, 'happened'));
    if (summary && target !== b.loose) (target as TurnView).summary = summary;
  } else if (event.kind === 'agent.turn.completed' && target !== b.loose) {
    const view = target as TurnView;
    if (!view.end) {
      view.end = {
        state: str(field(event.payload, 'status')) ?? 'completed',
        error: str(field(event.payload, 'error')) ?? null,
      };
      view.ended_at = event.created_at;
    }
  } else target.items.push({ kind: 'event', event });
}

/**
 * The session's turns, in snapshot order, with the output its events carry. Called again with more
 * of the same events, it applies only the new ones and returns unchanged turns as the same objects.
 */
export function buildTranscript(
  turns: readonly SessionTurn[],
  events: readonly DaemonEvent[],
): Transcript {
  const ordered = mergeEvents(events, []);
  const ids = turns.map((turn) => turn.id).join('\0');
  let b = last;
  if (
    !b ||
    b.ids !== ids ||
    ordered.length < b.events.length ||
    b.events.some((event, i) => ordered[i] !== event)
  )
    b = startBuild(turns, ids);
  for (const event of ordered.slice(b.events.length)) applyEvent(b, event);
  b.events = ordered;
  last = b;
  const build = b;
  const current = new Map(turns.map((turn) => [turn.id, turn]));
  const show = <T extends Owner>(
    owner: T,
    changed: (before: T) => boolean,
    extra: Partial<T>,
  ): T => {
    const before = build.returned.get(owner) as T | undefined;
    if (before && !build.dirty.has(owner) && !changed(before)) return before;
    const next = { ...owner, ...extra, items: [...owner.items] };
    build.returned.set(owner, next);
    return next;
  };
  const transcript = {
    turns: [...build.views.values()].map((view) => {
      const turn = current.get(view.turn.id)!;
      return show(view, (before) => before.turn !== turn, { turn });
    }),
    loose: show(build.loose, () => false, {}),
  };
  build.dirty.clear();
  return transcript;
}

/** Why the user cannot write to a session the daemon created; null when the user may send or steer. */
export const READ_ONLY: Record<SessionPurpose, string | null> = {
  conversation: null,
  get reviewer() {
    return t({
      id: 'data.transcript.readOnly.reviewer',
      defaultMessage: 'Review sessions take fixed input; you cannot send or steer',
    });
  },
};

/** Whether session.send and session.steer can go to the session, with the reason when not. */
export function composeState(session: Session): { send: Availability; steer: Availability } {
  const on: Availability = { enabled: true, reason: null };
  const off = (reason: string): Availability => ({ enabled: false, reason });
  const readOnly = READ_ONLY[sessionPurpose(session)];
  const busy =
    readOnly ??
    (session.stop_pending
      ? t({
          id: 'data.transcript.busy.stopPending',
          defaultMessage: "The session's stop is not confirmed yet; you cannot send or steer",
        })
      : session.merge?.state === 'running'
        ? t({
            id: 'data.transcript.busy.merging',
            defaultMessage: 'The session is merging; you cannot send or steer',
          })
        : session.stop_requested
          ? t({
              id: 'data.transcript.busy.discarding',
              defaultMessage: 'The session is being discarded; you cannot send or steer',
            })
          : session.rollback_pending
            ? t({
                id: 'data.transcript.busy.rollingBack',
                defaultMessage: "The session's rollback has not finished; you cannot send or steer",
              })
            : null);
  if (busy) return { send: off(busy), steer: off(busy) };
  if (session.runtime_review) {
    const blocked = off(
      t({
        id: 'data.transcript.readOnly.runtimeReview',
        defaultMessage: 'Analysis allows up to four read-only turns.',
      }),
    );
    return {
      send: session.state === 'open' && session.turn_count < 4 ? on : blocked,
      steer: blocked,
    };
  }
  switch (session.state) {
    case 'open':
      return { send: on, steer: on };
    case 'running':
      return {
        send: off(
          t({
            id: 'data.transcript.compose.turnRunning',
            defaultMessage: "The current turn hasn't ended; steer to change direction",
          }),
        ),
        steer: on,
      };
    case 'reconciling':
      return {
        send: off(
          t({
            id: 'data.transcript.compose.reconcilingSend',
            defaultMessage:
              "The session is reconciling; you can't send until it is confirmed stopped",
          }),
        ),
        steer: off(
          t({
            id: 'data.transcript.compose.reconcilingSteer',
            defaultMessage:
              "The session is reconciling; you can't steer until it is confirmed stopped",
          }),
        ),
      };
    case 'closed':
      return {
        send: off(
          t({
            id: 'data.transcript.compose.closedSend',
            defaultMessage: 'The session is closed; you can no longer send',
          }),
        ),
        steer: off(
          t({
            id: 'data.transcript.compose.closedSteer',
            defaultMessage: 'The session is closed; you can no longer steer',
          }),
        ),
      };
  }
}
