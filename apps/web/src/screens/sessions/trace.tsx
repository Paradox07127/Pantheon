import { Fragment, useState, useSyncExternalStore } from 'react';
import { useBoard } from '../../data/board';
import { useNow } from '../../data/needs-you';
import { useSessionActivity } from '../../data/session-activity';
import { elapsedText, type ToolItem, type TurnView } from '../../data/transcript';
import { t } from '../../i18n';
import { ViewToggle } from '../board/Charts';
import { dayText } from '../../lib/time-text';
import { tokenText } from '../board/panels-model';
import { ActivitySpark, ContextMeter, TraceWaterfall } from './RunCharts';
import { callResult } from './run-model';
import './thread.css';

export interface TraceRow {
  id: string;
  /** When the turn began running, else when it was queued. */
  started: number | null;
  /** Null until the turn ends. */
  duration: number | null;
  tools: number;
  input: number | null;
  output: number | null;
}

export interface TraceTotal {
  duration: number | null;
  tools: number;
  input: number | null;
  output: number | null;
}

const count = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const field = (payload: unknown, key: string): unknown =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
const sum = (values: (number | null)[]): number | null =>
  values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null;

/** One row per turn and their total; token counts come from the turn, else its newest usage event. */
export function traceRows(turns: readonly TurnView[]): { rows: TraceRow[]; total: TraceTotal } {
  const rows = turns.map((view): TraceRow => {
    const started = view.started_at ?? view.at;
    return {
      id: view.turn.id,
      started,
      duration:
        started !== null && view.ended_at !== null ? Math.max(0, view.ended_at - started) : null,
      tools: view.items.filter((item) => item.kind === 'tool').length,
      input: view.turn.usage?.input_tokens ?? count(field(view.usage, 'input_tokens')),
      output: view.turn.usage?.output_tokens ?? count(field(view.usage, 'output_tokens')),
    };
  });
  return {
    rows,
    total: {
      duration: sum(rows.map((r) => r.duration)),
      tools: rows.reduce((a, r) => a + r.tools, 0),
      input: sum(rows.map((r) => r.input)),
      output: sum(rows.map((r) => r.output)),
    },
  };
}

const NONE = '—';
const tokens = (n: number | null) => (n === null ? NONE : tokenText(n));
const elapsed = (ms: number | null) => (ms === null ? NONE : elapsedText(ms));

/** The tool calls of a turn with their time and result. */
function turnCalls(view: TurnView) {
  return view.items
    .filter((item): item is ToolItem => item.kind === 'tool')
    .map((tool) => ({
      id: tool.id,
      name: tool.name || t({ id: 'sessions.parts.tool', defaultMessage: 'Tool' }),
      duration:
        tool.started_at !== undefined && tool.completed_at !== undefined
          ? Math.max(0, tool.completed_at - tool.started_at)
          : null,
      result: callResult(tool.ok),
    }));
}

/** The table view of the trace: each turn's time, tool calls and tokens, its calls below it. */
export function TraceTable({ turns, now }: { turns: readonly TurnView[]; now: number }) {
  const { rows, total } = traceRows(turns);
  return (
    <table className="ss-trt">
      <thead>
        <tr>
          <th scope="col">{t({ id: 'sessions.parts.traceStart', defaultMessage: 'Start' })}</th>
          <th scope="col">
            {t({ id: 'sessions.parts.traceDuration', defaultMessage: 'Duration' })}
          </th>
          <th scope="col">
            {t({ id: 'sessions.parts.traceCalls', defaultMessage: 'Tool calls' })}
          </th>
          <th scope="col">{t({ id: 'sessions.parts.input', defaultMessage: 'Input' })}</th>
          <th scope="col">{t({ id: 'sessions.parts.output', defaultMessage: 'Output' })}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <Fragment key={row.id}>
            <tr>
              <td>{row.started === null ? NONE : dayText(row.started, now, { time: true })}</td>
              <td>{elapsed(row.duration)}</td>
              <td>{row.tools}</td>
              <td>{tokens(row.input)}</td>
              <td>{tokens(row.output)}</td>
            </tr>
            {turnCalls(turns[i]!).map((call) => (
              <tr key={call.id} className="rn-call">
                <td>{call.name}</td>
                <td>{elapsed(call.duration)}</td>
                <td colSpan={3}>{call.result}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">{t({ id: 'sessions.parts.traceTotal', defaultMessage: 'Total' })}</th>
          <td>{elapsed(total.duration)}</td>
          <td>{total.tools}</td>
          <td>{tokens(total.input)}</td>
          <td>{tokens(total.output)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** The session's turns as a waterfall, or as a table of their time, tool calls and tokens. */
export function TraceSection({ turns, now }: { turns: readonly TurnView[]; now: number }) {
  const [table, setTable] = useState(false);
  // The Trace panel's head already names it on screen.
  return (
    <section
      className="ss-trace"
      aria-label={t({ id: 'sessions.parts.trace', defaultMessage: 'Trace' })}
    >
      <div className="rn-hd">
        <ViewToggle table={table} onToggle={() => setTable(!table)} />
      </div>
      {!table ? <TraceWaterfall turns={turns} now={now} /> : <TraceTable turns={turns} now={now} />}
    </section>
  );
}

// The turns of each thread on screen; the inspector shows their trace without reading the history again.
const shown = new Map<string, readonly TurnView[]>();
const NO_TURNS: readonly TurnView[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Called by a thread each time it shows its turns, and with null turns as it goes; null forgets every thread. */
export function showThreadTurns(
  next: { sessionId: string; turns: readonly TurnView[] | null } | null,
) {
  if (!next) shown.clear();
  else if (next.turns) shown.set(next.sessionId, next.turns);
  else shown.delete(next.sessionId);
  listeners.forEach((listener) => listener());
}

/** The turns of the session's thread while it is on screen; null when it is not. */
export const shownTurns = (sessionId: string): readonly TurnView[] | null =>
  shown.get(sessionId) ?? null;

/** The turns of the session's thread while it is on screen, and its newest usage payload. */
export function useThreadTurns(sessionId: string) {
  const read = () => shown.get(sessionId) ?? NO_TURNS;
  const turns = useSyncExternalStore(subscribe, read, read);
  const sessionUsage = useBoard((s) => s.board?.sessions.find((x) => x.id === sessionId)?.usage);
  return { turns, usage: turns.findLast((view) => view.usage != null)?.usage ?? sessionUsage };
}

/** The session's context and activity, and the trace of its thread while it is on screen. */
export function ThreadTrace({ sessionId }: { sessionId: string }) {
  const { turns, usage } = useThreadTurns(sessionId);
  const activity = useSessionActivity(sessionId);
  const now = useNow();
  return (
    <>
      <dl className="ss-run">
        <dt>{t({ id: 'sessions.parts.traceContext', defaultMessage: 'Context' })}</dt>
        <dd>
          <ContextMeter usage={usage} />
        </dd>
        <dt>{t({ id: 'sessions.parts.traceActivity', defaultMessage: 'Activity' })}</dt>
        <dd>
          <ActivitySpark activity={activity.data} />
        </dd>
      </dl>
      {turns.length > 0 && <TraceSection turns={turns} now={now} />}
    </>
  );
}
