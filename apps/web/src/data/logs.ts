import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeResult, DesktopBridge } from '@pantheon/protocol';
import { currentLocale, t } from '../i18n';
import { useBoard } from './board';
import { listedTitle } from '../lib/daemon-text';
import { listText } from '../lib/list-text';
import { reasonText } from './needs-you';
import type { DaemonEvent } from './sync';
import { toolLabel } from './tool-calls';

/** Both lists' events once each, by event_id, in sequence order. */
export function mergeEvents(a: readonly DaemonEvent[], b: readonly DaemonEvent[]): DaemonEvent[] {
  const byId = new Map<string, DaemonEvent>();
  for (const event of a) byId.set(event.event_id, event);
  for (const event of b) if (!byId.has(event.event_id)) byId.set(event.event_id, event);
  return [...byId.values()].sort((x, y) => x.sequence - y.sequence);
}

const field = (payload: unknown, key: string): unknown =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const number = (value: unknown): number | null => (typeof value === 'number' ? value : null);

function clip(value: string, max = 120): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface ContextShare {
  used: number;
  window: number | null;
  /** used / window, not capped at 1. */
  ratio: number | null;
}

/** Context occupancy of an agent.usage.updated payload; null without context_tokens. */
export function contextShare(payload: unknown): ContextShare | null {
  const used = number(field(payload, 'context_tokens'));
  if (used === null) return null;
  const window = number(field(payload, 'context_window'));
  return { used, window, ratio: window ? used / window : null };
}

/** Token counts and cost of an agent.usage.updated payload; missing values are "—". */
export function usageText(payload: unknown): string {
  const n = (key: string) => {
    const value = number(field(payload, key));
    return value === null ? '—' : value.toLocaleString(currentLocale());
  };
  const context = contextShare(payload);
  const cost = number(field(payload, 'cost_usd'));
  const source = text(field(payload, 'cost_source'));
  const cached = number(field(payload, 'cached_input_tokens'));
  const usd = cost === null ? '—' : `$${cost.toFixed(2)}`;
  return t(
    {
      id: 'data.logs.usage',
      defaultMessage: '{input}, {output}, {context}, {cost}',
    },
    {
      input:
        cached === null
          ? t(
              { id: 'data.logs.usageInput', defaultMessage: 'Input {count}' },
              { count: n('input_tokens') },
            )
          : t(
              {
                id: 'data.logs.usageInputCached',
                defaultMessage: 'Input {count} (cached {cached})',
              },
              { count: n('input_tokens'), cached: n('cached_input_tokens') },
            ),
      output: t(
        { id: 'data.logs.usageOutput', defaultMessage: 'Output {count}' },
        { count: n('output_tokens') },
      ),
      context: t(
        { id: 'data.logs.usageContext', defaultMessage: 'Context {value}' },
        {
          value:
            context?.ratio != null
              ? `${Math.round(context.ratio * 100)}%`
              : context
                ? context.used.toLocaleString(currentLocale())
                : '—',
        },
      ),
      cost: source
        ? t(
            { id: 'data.logs.usageCostSource', defaultMessage: 'Cost {cost} ({source})' },
            { cost: usd, source },
          )
        : t({ id: 'data.logs.usageCost', defaultMessage: 'Cost {cost}' }, { cost: usd }),
    },
  );
}

/** One readable line for an event; empty when only the payload's field names are known. */
export function eventSummary(event: DaemonEvent): string {
  const p = event.payload;
  switch (event.kind) {
    case 'agent.message.delta':
      return clip(text(field(p, 'text')) ?? '');
    case 'agent.usage.updated':
      return usageText(p);
    case 'agent.session.started':
      return t(
        { id: 'data.logs.nativeSession', defaultMessage: 'Native session {id}' },
        { id: text(field(p, 'native_session_id')) ?? '—' },
      );
    case 'agent.turn.completed':
      return listText(text(field(p, 'status')), text(field(p, 'error')));
    case 'agent.tool.started': {
      const label = toolLabel(text(field(p, 'name')) ?? '', field(p, 'input'));
      return clip(
        label.detail
          ? t(
              { id: 'data.logs.toolDetail', defaultMessage: 'Tool {title}, {detail}' },
              { title: label.title, detail: label.detail },
            )
          : t({ id: 'data.logs.tool', defaultMessage: 'Tool {title}' }, { title: label.title }),
      );
    }
    case 'agent.tool.completed':
      return field(p, 'ok') === true
        ? t({ id: 'data.logs.toolSucceeded', defaultMessage: 'Tool succeeded' })
        : t({ id: 'data.logs.toolFailed', defaultMessage: 'Tool failed' });
    case 'agent.permission.requested':
      return t(
        { id: 'data.logs.permissionRequested', defaultMessage: 'Permission requested, {tool}' },
        { tool: text(field(p, 'tool')) ?? '—' },
      );
    case 'agent.error':
      return clip(text(field(p, 'message')) ?? '');
    case 'agent.native':
      return (
        text(field(p, 'native_type')) ??
        t({ id: 'data.logs.nativeEvent', defaultMessage: 'Native event' })
      );
    case 'session.pinned':
      return t({ id: 'data.logs.pinned', defaultMessage: 'Pinned' });
    case 'session.gate_run_cancel_requested':
      return t({ id: 'data.logs.checksCancelling', defaultMessage: 'Cancelling checks' });
    case 'session.gate_run_cancelled':
      return t({ id: 'data.logs.checksCancelled', defaultMessage: 'Checks cancelled' });
    case 'session.merge_cancel_requested':
      return t({ id: 'data.logs.mergeCancelling', defaultMessage: 'Cancelling merge' });
    case 'session.merge_cancelled':
      return t({ id: 'data.logs.mergeCancelled', defaultMessage: 'Merge cancelled' });
    case 'session.unpinned':
      return t({ id: 'data.logs.unpinned', defaultMessage: 'Unpinned' });
    case 'session.archived':
      return t({ id: 'data.logs.archived', defaultMessage: 'Archived' });
    case 'session.unarchived':
      return t({ id: 'data.logs.unarchived', defaultMessage: 'Restored' });
    case 'session.deleted': {
      const title = listedTitle({
        title: text(field(p, 'title')) ?? '',
        baseline_started_at: number(field(p, 'baseline_started_at')) ?? undefined,
      });
      return title
        ? t(
            { id: 'data.logs.sessionDeleted', defaultMessage: 'Deleted session {title}' },
            { title },
          )
        : t({ id: 'data.logs.sessionDeletedUntitled', defaultMessage: 'Deleted session' });
    }
    case 'session.turn.delivery': {
      const reason = text(field(p, 'reason'));
      return listText(text(field(p, 'delivery')), reason && reasonText(reason));
    }
  }
  const error = text(field(p, 'error')) ?? text(field(p, 'reason'));
  return error ? clip(reasonText(error)) : '';
}

/**
 * GET /v1/events from `after` up to the daemon cursor of the first page, page by page; keeps the
 * events `keep` accepts. `cursor` is where a later read continues.
 */
export async function readEventHistory(
  bridge: Pick<DesktopBridge, 'query'>,
  options: { project_id?: string | null; after: number; keep?: (event: DaemonEvent) => boolean },
): Promise<BridgeResult<{ events: DaemonEvent[]; cursor: number; reset?: boolean }>> {
  const kept: DaemonEvent[] = [];
  let after = options.after;
  let target: number | null = null;
  let reset = false;
  for (;;) {
    const params: Record<string, string> = { after: String(after), limit: '2000' };
    if (options.project_id) params.project_id = options.project_id;
    const result = await bridge
      .query('events', params)
      .catch((reason: unknown): BridgeResult<unknown> => ({
        ok: false,
        error: {
          code: 'ipc_failed',
          message: reason instanceof Error ? reason.message : String(reason),
        },
      }));
    if (!result.ok) return result;
    const value = result.value as {
      events?: unknown;
      cursor?: unknown;
      snapshot_required?: boolean;
    } | null;
    if (!Array.isArray(value?.events) || typeof value.cursor !== 'number')
      return { ok: false, error: { code: 'bad_response', message: 'events is not a list' } };
    if (value.snapshot_required) {
      if (reset)
        return {
          ok: false,
          error: { code: 'invalid_cursor', message: 'Event history changed during replay' },
        };
      reset = true;
      after = 0;
      target = null;
      kept.length = 0;
      continue;
    }
    target ??= value.cursor;
    const page = value.events as DaemonEvent[];
    for (const event of page)
      if (event.sequence <= target && (!options.keep || options.keep(event))) kept.push(event);
    const last = page.at(-1);
    if (!last || last.sequence >= target || last.sequence <= after)
      return {
        ok: true,
        value: { events: kept, cursor: target, ...(reset ? { reset: true } : {}) },
      };
    after = last.sequence;
  }
}

export interface EventHistory {
  /** null until the first read succeeds for this key. */
  events: DaemonEvent[] | null;
  error: string | null;
  reload: () => void;
}

// The streamed events of a project after a sequence that `keep` accepts.
const streamed = (
  project_id: string | null,
  keep: ((event: DaemonEvent) => boolean) | undefined,
  after = 0,
): DaemonEvent[] =>
  useBoard
    .getState()
    .events.filter(
      (e) =>
        e.sequence > after && (!project_id || e.project_id === project_id) && (!keep || keep(e)),
    );

interface ReadHistory {
  events: DaemonEvent[];
  cursor: number;
  /** The board's resync count the events were read under. */
  resync: number;
}

// What reads returned, by project and start. Callers share an entry because neither their key
// nor their filter function says which events the filter keeps.
const histories = new Map<string, ReadHistory>();
const HISTORIES = 16;
const historyKey = (project_id: string | null, after: number) => `${project_id ?? ''}:${after}`;

function cachedHistory(id: string, resync: number): ReadHistory | undefined {
  const history = histories.get(id);
  if (!history) return undefined;
  histories.delete(id);
  // Read before missed or replaced events, its cursor may continue another history.
  if (history.resync !== resync) return undefined;
  histories.set(id, history);
  return history;
}

function storeHistory(id: string, history: ReadHistory): void {
  histories.delete(id);
  histories.set(id, history);
  if (histories.size > HISTORIES) histories.delete(histories.keys().next().value!);
}

const kept = (events: DaemonEvent[], keep: ((event: DaemonEvent) => boolean) | undefined) =>
  keep ? events.filter(keep) : events;

// Whether `held`, in sequence order, has `event`.
function holds(held: readonly DaemonEvent[], event: DaemonEvent): boolean {
  let low = 0;
  let high = held.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (held[mid]!.sequence < event.sequence) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < held.length && held[i]!.sequence === event.sequence; i++)
    if (held[i]!.event_id === event.event_id) return true;
  return false;
}

// `held` itself when `incoming` adds nothing to it; both lists are in sequence order.
function withEvents(held: DaemonEvent[], incoming: readonly DaemonEvent[]): DaemonEvent[] {
  const added = incoming.filter((e) => !holds(held, e));
  if (!added.length) return held;
  const last = held.at(-1)?.sequence ?? -Infinity;
  return added.every((e, i) => e.sequence > (i ? added[i - 1]!.sequence : last))
    ? held.concat(added)
    : mergeEvents(held, added);
}

type HistoryRead = BridgeResult<{ events: DaemonEvent[]; cursor: number; reset?: boolean }>;

// Reads still out, by history, start and resync; a caller that mounts meanwhile waits for one
// that went out under the stream status it sees, so a reconnect reads again.
const reading = new Map<string, { status: unknown; read: Promise<HistoryRead> }>();

function sharedRead(
  bridge: Pick<DesktopBridge, 'query'>,
  project_id: string | null,
  after: number,
  resync: number,
): Promise<HistoryRead> {
  const id = `${historyKey(project_id, after)}:${resync}`;
  const status = useBoard.getState().status;
  const out = reading.get(id);
  if (out && out.status === status) return out.read;
  const read = readEventHistory(bridge, { project_id, after });
  const entry = { status, read };
  reading.set(id, entry);
  void read.then(() => {
    if (reading.get(id) === entry) reading.delete(id);
  });
  return read;
}

/**
 * The daemon's past events for `key` (null reads nothing) from `after`, continued on reconnect and
 * read again from `after` on resync; holds only what `keep` accepts. A cached read shows at once.
 */
export function useEventHistory(options: {
  key: string | null;
  project_id: string | null;
  after: number;
  keep?: (event: DaemonEvent) => boolean;
}): EventHistory {
  const { key, project_id } = options;
  const live = useBoard((s) => s.status.state === 'live');
  const resync = useBoard((s) => s.resync);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    events: DaemonEvent[] | null;
    error: string | null;
  }>(() => {
    const history =
      key === null ? undefined : cachedHistory(historyKey(project_id, options.after), resync);
    return history
      ? { key, events: kept(history.events, options.keep), error: null }
      : { key: null, events: null, error: null };
  });
  const latest = useRef(options);
  latest.current = options;
  // The board's resync count the held events were streamed under.
  const heldUnder = useRef(resync);
  // Counts the times the stream went live, so a disconnect alone reads nothing.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const reconnected = reconnects.current.count;

  useEffect(() => {
    if (key === null) return;
    let previous: readonly DaemonEvent[] | undefined;
    const append = () => {
      const stream = useBoard.getState().events;
      if (stream === previous) return;
      previous = stream;
      const events = streamed(project_id, latest.current.keep);
      if (!events.length) return;
      setState((s) => {
        const held = s.key === key ? (s.events ?? []) : [];
        const next = withEvents(held, events);
        return next === s.events ? s : { key, events: next, error: s.key === key ? s.error : null };
      });
    };
    append();
    return useBoard.subscribe(append);
  }, [key, project_id]);

  useEffect(() => {
    if (key === null) return;
    const bridge = window.pantheon;
    let current = true;
    const start = latest.current.after;
    const id = historyKey(project_id, start);
    const known = cachedHistory(id, resync);
    if (known) {
      const events = kept(known.events, latest.current.keep);
      setState((s) => {
        const next = withEvents(s.key === key ? (s.events ?? []) : [], events);
        return next === s.events ? s : { key, events: next, error: null };
      });
    }
    const after = known ? known.cursor : start;
    void (
      bridge
        ? sharedRead(bridge, project_id, after, resync)
        : Promise.resolve<HistoryRead>({
            ok: false,
            error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
          })
    ).then((result) => {
      if (!current) return;
      if (!result.ok) {
        const error = t(
          { id: 'data.failure.reasonMessage', defaultMessage: '{reason} ({message})' },
          { reason: reasonText(result.error.code), message: result.error.message },
        );
        setState((s) => ({ key, events: s.key === key ? s.events : null, error }));
        return;
      }
      const { events, cursor, reset } = result.value;
      const prior = cachedHistory(id, resync);
      if (reset || !known) storeHistory(id, { events, cursor, resync });
      else if (prior && prior.cursor >= after)
        storeHistory(id, {
          events: prior.events.concat(events.filter((e) => e.sequence > prior.cursor)),
          cursor: Math.max(prior.cursor, cursor),
          resync,
        });
      const keep = latest.current.keep;
      // A history read from the start replaces what was held, but for the live events after it.
      const fresh = reset || !known ? streamed(project_id, keep, cursor) : null;
      // Live events the board buffer dropped during the read are still held, unless replaced.
      const newerHeld = fresh !== null && !reset && heldUnder.current === resync;
      if (fresh) heldUnder.current = resync;
      setState((s) => {
        const held = s.key === key ? (s.events ?? []) : [];
        const base = !fresh
          ? held
          : newerHeld
            ? withEvents(
                fresh,
                held.filter((e) => e.sequence > cursor),
              )
            : fresh;
        const next = withEvents(base, kept(events, keep));
        return next === s.events && s.error === null ? s : { key, events: next, error: null };
      });
    });
    return () => {
      current = false;
    };
  }, [key, project_id, reconnected, resync, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const mine = state.key === key;
  return {
    events: mine ? state.events : null,
    error: mine ? state.error : null,
    reload,
  };
}
