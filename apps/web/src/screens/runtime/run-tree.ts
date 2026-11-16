import type {
  BoardActivity,
  BoardModel,
  BoardSegment,
  BoardTaskStatus,
  SessionTrace,
  WorkbenchSession,
} from '@pantheon/protocol';

type TraceSpan = SessionTrace['spans'][number];
type BoardTask = BoardModel['tasks'][number];
type BoardLead = NonNullable<BoardModel['leads']>[number];

export type RunStatus = 'running' | 'waiting' | 'ready' | 'ok' | 'error' | 'idle';

export interface RunCall {
  id: string;
  kind: 'llm' | 'tool' | 'compact';
  name: string;
  status: TraceSpan['status'];
  start: number | null;
  end: number | null;
  /** Input plus output tokens. */
  tokens: number;
}

export interface RunNode {
  /** The session id; the span id of a subagent; the board task id of a task without a session. */
  id: string;
  kind: 'lead' | 'session' | 'subagent';
  runtime: string | null;
  title: string;
  model: string | null;
  status: RunStatus;
  phase: BoardActivity['phase'] | null;
  start: number | null;
  /** null while running or when unknown. */
  end: number | null;
  /** Input plus output tokens of the node's own calls. */
  tokens: number;
  /** The node's own ended turns that reported no tokens, nor did their calls; absent: 0. */
  unreported?: number;
  /** Own calls only, by start, those without a start last. */
  calls: RunCall[];
  children: RunNode[];
  /** The board task of a lead's child or an adhoc node; null for leads and subagents. */
  taskId: string | null;
}

export interface RunForest {
  trees: RunNode[];
  adhoc: RunNode[];
}

export interface RunStats {
  duration_ms: number;
  tokens: number;
  /** Ended turns that reported no tokens; tokens leaves them out. */
  unreported: number;
  llm: number;
  /** Tool calls plus subagents. */
  tool: number;
  errors: number;
  running: number;
}

const TASK_STATUS: Record<BoardTaskStatus, RunStatus> = {
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  ready: 'ready',
  done: 'ok',
  failed: 'error',
  todo: 'idle',
  discarded: 'idle',
};

const LEAD_STATUS: Record<BoardLead['state'], RunStatus> = {
  running: 'running',
  waiting: 'waiting',
  failed: 'error',
  idle: 'idle',
  closed: 'idle',
};

const SPAN_STATUS: Record<TraceSpan['status'], RunStatus> = {
  running: 'running',
  error: 'error',
  ok: 'ok',
  unknown: 'idle',
};

const SPAWN_TOOLS = new Set(['Task', 'Agent']);
const LIVE_PHASES = new Set<BoardActivity['phase']>(['thinking', 'tool', 'gate', 'merging']);
const WORKING_PHASES = new Set<BoardActivity['phase']>([...LIVE_PHASES, 'starting']);

/** The board's ready holds merging sessions; the phase tells them apart. */
function sessionStatus(status: BoardTaskStatus, phase: BoardActivity['phase'] | null): RunStatus {
  if (phase === 'waiting_approval' || phase === 'waiting_input') return 'waiting';
  if (status === 'failed') return 'error';
  if (phase !== null && WORKING_PHASES.has(phase)) return 'running';
  return TASK_STATUS[status];
}

const byStart = (a: { start: number | null }, b: { start: number | null }) =>
  (a.start ?? Infinity) - (b.start ?? Infinity);

/** A Task or Agent call as the daemon records it before the native transcript is indexed. */
const spawns = (span: TraceSpan) => span.kind === 'tool' && SPAWN_TOOLS.has(span.name);

/**
 * The nearest subagent span above span; null when the walk ends without one or the parent chain
 * loops, so a looping chain stays on the session.
 */
function ownerOf(span: TraceSpan, byId: ReadonlyMap<string, TraceSpan>): TraceSpan | null {
  const seen = new Set([span.id]);
  let owner: TraceSpan | null = null;
  for (let id = span.parent; id !== null;) {
    if (seen.has(id)) return null;
    seen.add(id);
    const up = byId.get(id);
    if (!up) break;
    if (owner === null && (up.kind === 'subagent' || spawns(up))) owner = up;
    id = up.parent;
  }
  return owner;
}

/**
 * The session node with its calls and subagents filled from spans, task children first; a start
 * or end the head lacks comes from its own calls and turns, the end only once nothing runs.
 */
export function sessionNode(
  head: Omit<RunNode, 'tokens' | 'calls' | 'children'>,
  spans: readonly TraceSpan[],
  tasks: RunNode[],
): RunNode {
  const root: RunNode = { ...head, tokens: 0, calls: [], children: [] };
  const byId = new Map(spans.map((span) => [span.id, span]));
  const subagents = new Map<string, RunNode>();
  const nodeOf = (span: TraceSpan) => {
    let node = subagents.get(span.id);
    if (!node) {
      node = {
        id: span.id,
        kind: 'subagent',
        runtime: null,
        title: span.name,
        model: null,
        status: SPAN_STATUS[span.status],
        phase: null,
        start: span.start,
        end: span.end,
        tokens: 0,
        calls: [],
        children: [],
        taskId: null,
      };
      subagents.set(span.id, node);
    }
    return node;
  };
  const turns: TraceSpan[] = [];
  // Turn id → the tokens of its calls.
  const called = new Map<string, number>();
  for (const span of spans) {
    if (span.kind === 'turn') {
      turns.push(span);
      continue;
    }
    const owner = ownerOf(span, byId);
    const holder = owner ? nodeOf(owner) : root;
    if (span.kind === 'subagent' || spawns(span)) {
      holder.children.push(nodeOf(span));
      continue;
    }
    const tokens = (span.tokens?.input ?? 0) + (span.tokens?.output ?? 0);
    called.set(span.turn, (called.get(span.turn) ?? 0) + tokens);
    holder.calls.push({
      id: span.id,
      kind: span.kind,
      name: span.name,
      status: span.status,
      start: span.start,
      end: span.end,
      tokens,
    });
  }
  for (const node of [root, ...subagents.values()]) {
    node.calls.sort(byStart);
    node.children.sort(byStart);
    node.tokens = node.calls.reduce((sum, call) => sum + call.tokens, 0);
  }
  // A turn's own usage counts where its calls carry less: a Codex turn records usage without model calls.
  const own: TraceSpan[] = [];
  for (const turn of turns) {
    const owner = ownerOf(turn, byId);
    if (!owner) own.push(turn);
    const usage = (turn.tokens?.input ?? 0) + (turn.tokens?.output ?? 0);
    const holder = owner ? nodeOf(owner) : root;
    holder.tokens += Math.max(0, usage - (called.get(turn.id) ?? 0));
    if (!turn.tokens && !called.get(turn.id) && turn.end !== null && turn.status !== 'running')
      holder.unreported = (holder.unreported ?? 0) + 1;
  }
  root.children = [...tasks, ...root.children];
  const timed = [...root.calls, ...own];
  const starts = timed.flatMap((item) => (item.start === null ? [] : [item.start]));
  const lasts = timed.flatMap((item) => {
    const last = item.end ?? item.start;
    return last === null ? [] : [last];
  });
  const running =
    root.status === 'running' || root.children.some((child) => child.status === 'running');
  root.start ??= starts.length === 0 ? null : starts.reduce((a, b) => Math.min(a, b));
  root.end ??= running || lasts.length === 0 ? null : lasts.reduce((a, b) => Math.max(a, b));
  return root;
}

/** One session node per segment with a session, oldest first; one node for a task without any. */
function taskNodes(task: BoardTask, spans: ReadonlyMap<string, readonly TraceSpan[]>): RunNode[] {
  const phase = task.activity?.phase ?? null;
  const segments = task.segments
    .filter(
      (segment): segment is BoardSegment & { session_id: string } => segment.session_id !== null,
    )
    .sort((a, b) => (a.started_at ?? Infinity) - (b.started_at ?? Infinity));
  if (segments.length === 0) {
    return [
      {
        id: task.id,
        kind: 'session',
        runtime: null,
        title: task.title,
        model: null,
        status: sessionStatus(task.status, phase),
        phase,
        start: null,
        end: null,
        tokens: 0,
        calls: [],
        children: [],
        taskId: task.id,
      },
    ];
  }
  return segments.map((segment, index) =>
    sessionNode(
      {
        id: segment.session_id,
        kind: 'session',
        runtime: segment.runtime,
        title: segment.title,
        model: segment.model,
        status: sessionStatus(segment.status, index === segments.length - 1 ? phase : null),
        phase: index === segments.length - 1 ? phase : null,
        start: segment.started_at,
        end: segment.ended_at,
        taskId: task.id,
      },
      spans.get(segment.session_id) ?? [],
      [],
    ),
  );
}

/** Newest start or end in the subtree; -Infinity without any. */
function newest(node: RunNode): number {
  return node.children.reduce(
    (at, child) => Math.max(at, newest(child)),
    Math.max(node.start ?? -Infinity, node.end ?? -Infinity),
  );
}

export function runForest(
  board: Pick<BoardModel, 'tasks' | 'leads'>,
  sessions: readonly Pick<WorkbenchSession, 'id' | 'runtime'>[],
  spans: ReadonlyMap<string, readonly TraceSpan[]>,
): RunForest {
  const runtimes = new Map(sessions.map((session) => [session.id, session.runtime]));
  const leads = new Set(board.leads?.map((lead) => lead.session_id));
  const trees = (board.leads ?? []).map((lead) => {
    const node = sessionNode(
      {
        id: lead.session_id,
        kind: 'lead',
        runtime: runtimes.get(lead.session_id) ?? null,
        title: lead.title,
        model: null,
        status: LEAD_STATUS[lead.state],
        phase: null,
        start: null,
        end: null,
        taskId: null,
      },
      spans.get(lead.session_id) ?? [],
      board.tasks
        .filter((task) => task.owner_session_id === lead.session_id)
        .flatMap((task) => taskNodes(task, spans)),
    );
    node.model = node.calls.filter((call) => call.kind === 'llm').at(-1)?.name ?? null;
    return { node, at: newest(node) };
  });
  trees.sort((a, b) => (a.at === b.at ? 0 : b.at - a.at));
  return {
    trees: trees.map(({ node }) => node),
    adhoc: board.tasks
      .filter((task) => !leads.has(task.owner_session_id ?? ''))
      .flatMap((task) => taskNodes(task, spans)),
  };
}

function* walk(nodes: readonly RunNode[]): Generator<RunNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

export function runStats(nodes: readonly RunNode[], now: number): RunStats {
  const stats: RunStats = {
    duration_ms: 0,
    tokens: 0,
    unreported: 0,
    llm: 0,
    tool: 0,
    errors: 0,
    running: 0,
  };
  let start = Infinity;
  let end = -Infinity;
  for (const node of walk(nodes)) {
    if (node.start !== null) start = Math.min(start, node.start);
    const last = node.end ?? (node.status === 'running' ? now : null);
    if (last !== null) end = Math.max(end, last);
    stats.tokens += node.tokens;
    stats.unreported += node.unreported ?? 0;
    if (node.kind === 'subagent') stats.tool += 1;
    if (node.status === 'error') stats.errors += 1;
    if (node.status === 'running') stats.running += 1;
    for (const call of node.calls) {
      if (call.kind === 'llm') stats.llm += 1;
      if (call.kind === 'tool') stats.tool += 1;
      if (call.status === 'error') stats.errors += 1;
    }
  }
  if (start !== Infinity && end !== -Infinity) stats.duration_ms = end - start;
  return stats;
}

export function isLive(forest: RunForest): boolean {
  for (const node of walk([...forest.trees, ...forest.adhoc])) {
    if (node.status === 'running' || (node.phase !== null && LIVE_PHASES.has(node.phase))) {
      return true;
    }
  }
  return false;
}
