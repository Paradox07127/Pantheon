import type { BoardModel, BoardWaiting, SessionTrace } from '@pantheon/protocol';
import type { RunCall, RunForest, RunNode, RunStatus } from './run-tree';

type TraceSpan = SessionTrace['spans'][number];

export type CallView = 'now' | 'history';
export type CallVerb =
  'read' | 'edit' | 'run' | 'search' | 'think' | 'dispatch' | 'subagent' | 'compact' | 'tool';
export type CallState = 'run' | 'wait' | 'ok' | 'bad' | 'ready' | 'idle';
export type BarTone = 'run' | 'wait' | 'bad' | 'idle' | `series-${1 | 2 | 3 | 4 | 5}`;

/** One bar of a row's waterfall, in percent of the table's scale from the start of its turn. */
export interface WaterfallBar {
  left: number;
  width: number;
  tone: BarTone;
  /** Drawn at a third of its strength: a session's own time between calls. */
  faded?: boolean;
  /** Striped: time spent waiting for the user. */
  stripe?: boolean;
  /** Still growing; its end blinks. */
  live?: boolean;
}

/** What the board knows of a session beyond its trace. */
export interface SessionFacts {
  context?: { used_tokens: number; window_tokens: number };
  forked?: boolean;
  waiting?: BoardWaiting;
}

interface RowBase {
  /** Unique in the table. */
  key: string;
  depth: number;
  /** The session the row's calls belong to. */
  session: string;
  state: CallState;
  /** null when none were reported. */
  tokens: number | null;
  /** ms; null without a start. */
  duration: number | null;
  bars: WaterfallBar[];
}

export interface SessionRow extends RowBase {
  type: 'session';
  node: RunNode;
  /** The newest turn's number; null without turns. */
  turn: number | null;
  /** Percent of the context window used; null when unknown or in history. */
  context: number | null;
  forked: boolean;
  lead: boolean;
  ended: boolean;
  open: boolean;
}

export interface CallLine extends RowBase {
  type: 'call';
  call: RunCall;
  verb: CallVerb;
  /** The call's input summary, else a file it touched, else its tool name; null for model calls and compactions. */
  target: string | null;
  /** Files touched beyond target. */
  more: number;
}

export interface SubagentRow extends RowBase {
  type: 'subagent';
  node: RunNode;
  target: string | null;
  open: boolean;
}

export interface ApprovalRow extends RowBase {
  type: 'approval';
  approvalId: string;
  summary: string;
  since: number;
}

export type CallRow = SessionRow | CallLine | SubagentRow | ApprovalRow;

export interface CallFilter {
  only: 'all' | 'failed' | 'slow';
  /** Matched without case against tool names, input summaries, files and approval requests. */
  text: string;
  /** From this long on a call counts as slow, ms. */
  slowMs: number;
}

const SESSION_STATE: Record<RunStatus, CallState> = {
  running: 'run',
  waiting: 'wait',
  ready: 'ready',
  ok: 'ok',
  error: 'bad',
  idle: 'idle',
};

const SPAN_STATE: Record<TraceSpan['status'], CallState> = {
  running: 'run',
  error: 'bad',
  ok: 'ok',
  unknown: 'idle',
};

const VERBS: Record<string, CallVerb> = {
  read: 'read',
  notebookread: 'read',
  view: 'read',
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  apply_patch: 'edit',
  filechange: 'edit',
  bash: 'run',
  shell: 'run',
  local_shell: 'run',
  local_shell_call: 'run',
  exec_command: 'run',
  commandexecution: 'run',
  grep: 'search',
  glob: 'search',
  ls: 'search',
  websearch: 'search',
  web_search: 'search',
  webfetch: 'search',
  task: 'subagent',
  agent: 'subagent',
  collabagenttoolcall: 'subagent',
  start_task: 'dispatch',
  direct_task: 'dispatch',
  message_task: 'dispatch',
};

const VERB_TONE: Record<CallVerb, BarTone> = {
  read: 'series-2',
  edit: 'series-2',
  search: 'series-2',
  dispatch: 'series-2',
  run: 'series-3',
  subagent: 'series-1',
  think: 'series-4',
  compact: 'series-5',
  tool: 'series-5',
};

// A bar this narrow still shows where the call sat.
const MIN_WIDTH = 1.5;
const SPAWN_TOOLS = new Set(['Task', 'Agent']);

/** The verb a call is shown with, by kind and by tool name without its MCP server prefix. */
export function callVerb(kind: RunCall['kind'], name: string): CallVerb {
  if (kind === 'llm') return 'think';
  if (kind === 'compact') return 'compact';
  const bare = name.replace(/^mcp__.+?__/, '').toLowerCase();
  return VERBS[bare] ?? 'tool';
}

/** Each session's context, fork and pending request from the board, by session id. */
export function boardFacts(
  board: Pick<BoardModel, 'tasks' | 'leads'>,
): ReadonlyMap<string, SessionFacts> {
  const facts = new Map<string, SessionFacts>();
  for (const lead of board.leads ?? [])
    if (lead.waiting || lead.context)
      facts.set(lead.session_id, { waiting: lead.waiting, context: lead.context });
  for (const task of board.tasks) {
    const newest = task.segments
      .filter((segment) => segment.session_id !== null)
      .reduce<(typeof task.segments)[number] | null>(
        (at, segment) =>
          at === null || (segment.started_at ?? Infinity) >= (at.started_at ?? Infinity)
            ? segment
            : at,
        null,
      );
    if (!newest) continue;
    facts.set(newest.session_id!, {
      context: task.context,
      forked: !!task.forked_from,
      waiting: task.activity?.waiting,
    });
  }
  return facts;
}

const lasted = (start: number | null, end: number | null, running: boolean, now: number) => {
  const last = end ?? (running ? now : null);
  return start === null || last === null ? null : Math.max(0, last - start);
};

interface Window {
  start: number;
  end: number;
}

/** A bar from..to ms in its turn, kept as ms until the scale is known. */
interface RawBar extends Omit<WaterfallBar, 'left' | 'width'> {
  from: number;
  to: number;
}

type Draft = CallRow & { raw: RawBar[] };

interface Context {
  view: CallView;
  now: number;
  toggled: ReadonlySet<string>;
  filter: CallFilter | null;
}

const filterOn = (filter: CallFilter | undefined): filter is CallFilter =>
  !!filter && (filter.only !== 'all' || filter.text.trim() !== '');

function textMatches(filter: CallFilter, ...texts: (string | undefined)[]): boolean {
  const needle = filter.text.trim().toLowerCase();
  return needle === '' || texts.some((text) => text?.toLowerCase().includes(needle));
}

function callMatches(
  filter: CallFilter,
  state: CallState,
  duration: number | null,
  ...texts: (string | undefined)[]
): boolean {
  if (filter.only === 'failed' && state !== 'bad') return false;
  if (filter.only === 'slow' && (duration === null || duration < filter.slowMs)) return false;
  return textMatches(filter, ...texts);
}

function callBar(
  start: number | null,
  end: number | null,
  state: CallState,
  verb: CallVerb,
  window: Window,
  ctx: Context,
): RawBar[] {
  if (start === null) return [];
  const running = state === 'run';
  const last = end ?? (running ? ctx.now : start);
  return [
    {
      from: start - window.start,
      to: last - window.start,
      tone: state === 'bad' ? 'bad' : VERB_TONE[verb],
      live: running && ctx.view === 'now',
    },
  ];
}

/** A subagent's rows: its own row, then its calls and subagents by start when open. */
function subagentRows(
  node: RunNode,
  session: string,
  depth: number,
  byId: ReadonlyMap<string, TraceSpan>,
  window: Window,
  ctx: Context,
): { rows: Draft[]; hit: boolean } {
  const key = `a:${session}/${node.id}`;
  const open = !ctx.toggled.has(key);
  const state = SESSION_STATE[node.status];
  const duration = lasted(node.start, node.end, state === 'run', ctx.now);
  const target = SPAWN_TOOLS.has(node.title)
    ? (byId.get(node.id)?.input_summary ?? null)
    : node.title;
  const inner = childRows(node, session, depth + 1, byId, window, ctx);
  const self = ctx.filter
    ? callMatches(ctx.filter, state, duration, node.title, target ?? undefined)
    : true;
  const row: Draft = {
    type: 'subagent',
    key,
    depth,
    session,
    state,
    tokens: node.tokens > 0 ? node.tokens : null,
    duration,
    node,
    target,
    open,
    bars: [],
    raw: callBar(node.start, node.end, state, 'subagent', window, ctx),
  };
  if (ctx.filter && !self && !inner.hit) return { rows: [], hit: false };
  return { rows: [row, ...(open ? inner.rows : [])], hit: self || inner.hit };
}

function childRows(
  node: RunNode,
  session: string,
  depth: number,
  byId: ReadonlyMap<string, TraceSpan>,
  window: Window,
  ctx: Context,
  inTurn: (id: string) => boolean = () => true,
): { rows: Draft[]; hit: boolean } {
  const items: { start: number | null; rows: Draft[] }[] = [];
  let hit = false;
  for (const call of node.calls) {
    if (!inTurn(call.id)) continue;
    const state = SPAN_STATE[call.status];
    const duration = lasted(call.start, call.end, state === 'run', ctx.now);
    const verb = callVerb(call.kind, call.name);
    const traced = byId.get(call.id);
    const touched = traced?.files ?? [];
    const summary = traced?.input_summary;
    if (ctx.filter && !callMatches(ctx.filter, state, duration, call.name, summary, ...touched))
      continue;
    hit = true;
    items.push({
      start: call.start,
      rows: [
        {
          type: 'call',
          key: `c:${session}/${call.id}`,
          depth,
          session,
          state,
          tokens: traced?.tokens !== undefined || call.tokens > 0 ? call.tokens : null,
          duration,
          call,
          verb,
          target: summary ?? touched[0] ?? (call.kind === 'tool' ? call.name : null),
          more: summary === undefined ? Math.max(0, touched.length - 1) : 0,
          bars: [],
          raw: callBar(call.start, call.end, state, verb, window, ctx),
        },
      ],
    });
  }
  for (const child of node.children) {
    if (child.kind !== 'subagent' || !inTurn(child.id)) continue;
    const sub = subagentRows(child, session, depth, byId, window, ctx);
    if (sub.rows.length === 0) continue;
    hit ||= sub.hit;
    items.push({ start: child.start, rows: sub.rows });
  }
  items.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
  return { rows: items.flatMap((item) => item.rows), hit };
}

function sessionRows(
  node: RunNode,
  spans: readonly TraceSpan[],
  facts: SessionFacts | undefined,
  ctx: Context,
): Draft[] {
  const key = `s:${node.id}`;
  const turns = spans.filter((span) => span.kind === 'turn' && span.parent === null);
  const newest = turns.reduce<TraceSpan | null>(
    (at, span) => (at === null || (span.start ?? -Infinity) >= (at.start ?? -Infinity) ? span : at),
    null,
  );
  const byId = new Map(spans.map((span) => [span.id, span]));
  const inTurn = newest ? (id: string) => byId.get(id)?.turn === newest.id : () => true;
  const state = SESSION_STATE[node.status];
  const live = state === 'run' || state === 'wait';
  const shown = node.calls.filter((call) => inTurn(call.id));
  const starts = shown.flatMap((call) => (call.start === null ? [] : [call.start]));
  const ends = shown.flatMap((call) => {
    const last = call.end ?? call.start;
    return last === null ? [] : [last];
  });
  const start = newest?.start ?? node.start ?? (starts.length ? Math.min(...starts) : null);
  const end =
    newest?.end ??
    (live ? ctx.now : ends.length ? Math.max(...ends) : (node.end ?? start ?? ctx.now));
  const window: Window = { start: start ?? ctx.now, end: Math.max(end, start ?? end) };
  const length = window.end - window.start;

  const waiting = facts?.waiting;
  const raw: RawBar[] = [];
  if (start !== null) {
    if (state === 'wait' && waiting) {
      const at = Math.min(Math.max(waiting.since - window.start, 0), length);
      raw.push({ from: 0, to: at, tone: 'idle', faded: true });
      raw.push({ from: at, to: length, tone: 'wait', stripe: true });
    } else if (state === 'run') {
      raw.push({ from: 0, to: length, tone: 'run', live: ctx.view === 'now' });
    } else {
      raw.push({ from: 0, to: length, tone: 'idle', faded: true });
    }
  }

  const children = childRows(node, node.id, 1, byId, window, ctx, inTurn);
  const approval: Draft[] = [];
  if (waiting?.kind === 'approval' && state === 'wait') {
    const matched =
      !ctx.filter || (ctx.filter.only === 'all' && textMatches(ctx.filter, waiting.summary));
    if (matched)
      approval.push({
        type: 'approval',
        key: `w:${node.id}/${waiting.approval_id}`,
        depth: 1,
        session: node.id,
        state: 'wait',
        tokens: null,
        duration: Math.max(0, ctx.now - waiting.since),
        approvalId: waiting.approval_id,
        summary: waiting.summary,
        since: waiting.since,
        bars: [],
        raw:
          ctx.view === 'history'
            ? [
                {
                  from: waiting.since - window.start,
                  to: length,
                  tone: 'wait',
                  stripe: true,
                },
              ]
            : [],
      });
  }
  if (ctx.filter && !children.hit && approval.length === 0) return [];

  const open = (ctx.view === 'now' || ctx.filter !== null) !== ctx.toggled.has(key);
  const context =
    ctx.view === 'now' && facts?.context && facts.context.window_tokens > 0
      ? Math.round((facts.context.used_tokens / facts.context.window_tokens) * 100)
      : null;
  const head: Draft = {
    type: 'session',
    key,
    depth: 0,
    session: node.id,
    state,
    tokens: node.tokens > 0 ? node.tokens : null,
    duration:
      ctx.view === 'now'
        ? lasted(node.start, node.end, true, ctx.now)
        : start === null
          ? null
          : length,
    node,
    turn: turns.length > 0 ? turns.length : null,
    context,
    forked: !!facts?.forked,
    lead: node.kind === 'lead',
    ended: !live && node.end !== null,
    open,
    bars: [],
    raw,
  };
  return [head, ...(open ? [...children.rows, ...approval] : [])];
}

function* sessionsOf(nodes: readonly RunNode[]): Generator<RunNode> {
  for (const node of nodes) {
    if (node.kind === 'subagent') continue;
    yield node;
    yield* sessionsOf(node.children);
  }
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));

/**
 * The table's rows: each session with the calls and subagents of its newest turn, by start, and
 * the approval it waits on; scale is the longest of those turns, ms, which every bar is drawn on.
 */
export function callRows({
  forest,
  facts,
  spans,
  view,
  now,
  toggled,
  filter,
}: {
  forest: RunForest;
  facts: ReadonlyMap<string, SessionFacts>;
  spans: ReadonlyMap<string, readonly TraceSpan[]>;
  view: CallView;
  now: number;
  /** Rows whose fold differs from the default: sessions open in the now view or under a filter, folded in history; subagents open. */
  toggled: ReadonlySet<string>;
  filter?: CallFilter;
}): { rows: CallRow[]; scale: number } {
  const ctx: Context = { view, now, toggled, filter: filterOn(filter) ? filter : null };
  const drafts: Draft[] = [];
  let scale = 0;
  for (const node of sessionsOf([...forest.trees, ...forest.adhoc])) {
    const rows = sessionRows(node, spans.get(node.id) ?? [], facts.get(node.id), ctx);
    for (const bar of rows[0]?.raw ?? []) scale = Math.max(scale, bar.to);
    drafts.push(...rows);
  }
  // Without any time the scale stays one second, so no bar divides by zero.
  if (scale <= 0) scale = 1000;
  const rows = drafts.map(({ raw, ...row }): CallRow => ({
    ...row,
    bars: raw.map(({ from, to, ...bar }) => {
      const left = clamp((from / scale) * 100);
      return { left, width: Math.max(MIN_WIDTH, clamp((to / scale) * 100) - left), ...bar };
    }),
  }));
  return { rows, scale };
}

/** The key one row up or down from selected, staying at either end; from nothing, the first or last. */
export function stepRow(
  rows: readonly CallRow[],
  selected: string | null,
  step: 1 | -1,
): string | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((row) => row.key === selected);
  if (at < 0) return (step > 0 ? rows[0] : rows.at(-1))!.key;
  return rows[Math.min(rows.length - 1, Math.max(0, at + step))]!.key;
}
