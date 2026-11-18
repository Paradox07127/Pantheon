import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BoardSnapshot,
  BridgeResult,
  SessionDiff,
  SessionTurnDiff,
  WorkbenchSession,
} from '@pantheon/protocol';
import { t } from '../i18n';
import { useBoard } from './board';
import { reasonText } from './needs-you';
import { cachedQuery, forgetQuery, noteResync, readCached, storeQuery } from './query-cache';
import {
  REFRESH_DELAY_MS,
  SLOW_CODES,
  SLOW_RETRY_MS,
  STREAM_KINDS,
  STREAM_REFRESH_MS,
  type DaemonEvent,
} from './sync';

// Texts are getters, so each is read in the language loaded by then.
const DIFF_TEXT: Record<string, string> = {
  get workspace_unavailable() {
    return t({
      id: 'data.diff.workspaceUnavailable',
      defaultMessage: 'The workspace folder is gone or is not a Git repository',
    });
  },
  get diff_base_missing() {
    return t({
      id: 'data.diff.baseMissing',
      defaultMessage: "This session's starting commit was not recorded",
    });
  },
  get workspace_read_failed() {
    return t({ id: 'data.diff.readFailed', defaultMessage: 'git diff failed or timed out' });
  },
};

// Copies the getters of DIFF_TEXT, not their values.
const TURN_DIFF_TEXT: Record<string, string> = Object.defineProperties(
  {
    get checkpoint_missing() {
      return t({
        id: 'data.diff.checkpointMissing',
        defaultMessage: 'No checkpoint was saved before this turn started',
      });
    },
  },
  Object.getOwnPropertyDescriptors(DIFF_TEXT),
);

const field = (payload: unknown, key: string): unknown =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;

interface NewestSeen {
  sessionId: string | null;
  board: BoardSnapshot | null;
  events: readonly DaemonEvent[];
  /** Index of the newest kept event in `events`, -1 for none. */
  at: number;
}

/**
 * The newest event `keep` accepts. `keep` may read only the session and the board, as a new
 * board or session alone scans every event again; otherwise only events appended since are read.
 */
export function useNewestEvent(
  sessionId: string | null,
  keep: (event: DaemonEvent, board: BoardSnapshot | null) => boolean,
): DaemonEvent | undefined {
  const seen = useRef<NewestSeen | null>(null);
  return useBoard((s) => {
    const before = seen.current;
    const same = before !== null && before.sessionId === sessionId && before.board === s.board;
    if (same && before.events === s.events) return before.events[before.at];
    // The store appends events and trims them from the front, so the last one read marks where new ones start.
    const last = same ? before.events.at(-1) : undefined;
    let i = s.events.length - 1,
      at = -1;
    for (; i >= 0 && s.events[i] !== last; i--)
      if (at < 0 && keep(s.events[i]!, s.board)) {
        at = i;
        if (last === undefined) break;
      }
    if (at < 0 && i >= 0 && before!.at >= 0) {
      const moved = before!.at - (before!.events.length - 1 - i);
      if (moved >= 0) at = moved;
    }
    seen.current = { sessionId, board: s.board, events: s.events, at };
    return s.events[at];
  });
}

const turnSessions = new WeakMap<BoardSnapshot['session_turns'], Map<string, string>>();

/**
 * Whether the event is the session's own, one of its turns' or one of its approvals'. Turn events
 * name only the turn, so they count only for turns the board lists.
 */
export const touchesSession = (
  event: DaemonEvent,
  sessionId: string,
  board?: Pick<BoardSnapshot, 'session_turns'> | null,
): boolean => {
  if (event.aggregate_id === sessionId || field(event.payload, 'session_id') === sessionId)
    return true;
  if (!board) return false;
  let sessions = turnSessions.get(board.session_turns);
  if (!sessions) {
    sessions = new Map();
    for (const turn of board.session_turns)
      if (!sessions.has(turn.id)) sessions.set(turn.id, turn.session_id);
    turnSessions.set(board.session_turns, sessions);
  }
  return sessions.get(event.aggregate_id) === sessionId;
};

/** The shortest gap between two reads while events keep arriving. */
const REFETCH_GAP_MS = 500;

// The newest event sequence a refetch tick saw; a read sent before a newer one may predate it.
let seenSequence = 0;

/**
 * Counts up after the event named by `sequence`, but not for the one there at mount, which the
 * mount's own read covers: streamed frames STREAM_REFRESH_MS after, every
 * other event REFRESH_DELAY_MS after, but never sooner than REFETCH_GAP_MS after the last count.
 * Given the query the count reads, the gap starts when its last read answered, and a count due
 * while a read of it is out waits for that read. Events that arrive while a count is pending join it.
 */
export function useRefetchTick(
  sequence: number,
  stream: boolean,
  query?: readonly [method: string, key: string | null],
): number {
  const [tick, setTick] = useState(0);
  const timer = useRef<{ id?: ReturnType<typeof setTimeout>; at: number } | null>(null);
  const lastRead = useRef(-Infinity);
  const read = useRef(query);
  read.current = query;
  const mounted = useRef(sequence);
  useEffect(() => {
    seenSequence = Math.max(seenSequence, sequence);
    if (!sequence || sequence === mounted.current) return;
    const out = () => {
      const [method, key] = read.current ?? [];
      return method && key ? cachedQuery(method, key) : undefined;
    };
    const arm = (at: number) => {
      const pending = {
        at,
        id: setTimeout(() => {
          const inflight = out()?.inflight;
          if (inflight) {
            pending.at = Infinity;
            void inflight.finally(() => {
              if (timer.current === pending) arm(Date.now() + REFETCH_GAP_MS);
            });
            return;
          }
          timer.current = null;
          lastRead.current = Date.now();
          setTick((n) => n + 1);
        }, at - Date.now()),
      };
      timer.current = pending;
    };
    const now = Date.now();
    const at = Math.max(
      now + (stream ? STREAM_REFRESH_MS : REFRESH_DELAY_MS),
      lastRead.current + REFETCH_GAP_MS,
      (out()?.settledAt ?? -Infinity) + REFETCH_GAP_MS,
    );
    if (timer.current && timer.current.at <= at) return;
    if (timer.current) clearTimeout(timer.current.id);
    arm(at);
  }, [sequence, stream]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current.id);
      // StrictMode runs the effects again with this ref kept.
      timer.current = null;
    },
    [],
  );
  return tick;
}

/** Counts up each time the window regains focus; edits made outside the app send no event. */
export function useFocusTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const focus = () => setTick((n) => n + 1);
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, []);
  return tick;
}

export interface QueryState<T> {
  /** null until a read succeeds; failures clear it unless retention is explicitly enabled. */
  data: T | null;
  /** A read is out and no data shows yet. */
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** A read is out while data shows; that data is no authority for a mutation. */
  refreshing?: boolean;
  /** Retained reads are observations, never authority for a mutation. */
  stale?: boolean;
  readAt?: number | null;
  /** With retention: when the newest read taken was sent, as counted by nextRead; 0 before one. */
  order?: number;
}

let sent = 0;
/** Counts the reads sent, so answers of two hooks can be ordered by when they were asked. */
const nextRead = (): number => ++sent;

export async function readQuery(
  method: string,
  params: Record<string, string | string[]>,
): Promise<BridgeResult<unknown>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  return bridge.query(method, params).catch((reason: unknown): BridgeResult<unknown> => ({
    ok: false,
    error: {
      code: 'ipc_failed',
      message: reason instanceof Error ? reason.message : String(reason),
    },
  }));
}

/** GET method for key; refetch after ticks, reconnect, resync and reload. Retention is display-only. */
export function useQuery<T>(
  method: string,
  key: string | null,
  params: (key: string) => Record<string, string | string[]>,
  accept: (value: unknown) => T | null,
  tick: number,
  text: Record<string, string> = {},
  retain = false,
): QueryState<T> {
  const live = useBoard((s) => s.status.state === 'live');
  const resync = useBoard((s) => s.resync);
  noteResync(resync);
  const [attempt, setAttempt] = useState(0);
  // `cached`: data is the cache's, kept from an earlier mount, until a read of this one lands.
  // `slow`: the last read timed out after its retry, so the data shown predates it.
  const [state, setState] = useState<
    { key: string | null; cached?: boolean; slow?: boolean } & Omit<QueryState<T>, 'reload'>
  >({
    key: null,
    data: null,
    loading: true,
    error: null,
    readAt: null,
  });
  const latest = useRef({ method, key, params, accept, text });
  latest.current = { method, key, params, accept, text };
  // Numbers of the last read started and of the newest read whose answer was taken.
  const runs = useRef({ started: 0, taken: 0 });
  // Counts the times the stream went live, so a disconnect alone reads nothing.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const reconnected = reconnects.current.count;
  // Inputs of the last read. A new key or StrictMode's second run joins a read of the same query
  // still out; a tick, reconnect, resync or reload asks the daemon again.
  const asked = useRef<readonly unknown[] | null>(null);
  // The key whose slow answer was already read again once, and that retry's timer.
  const slowRetry = useRef<{ key: string | null; timer?: ReturnType<typeof setTimeout> }>({
    key: null,
  });
  useEffect(() => () => clearTimeout(slowRetry.current.timer), []);

  useEffect(() => {
    if (!key) return;
    clearTimeout(slowRetry.current.timer);
    const run = ++runs.current.started;
    const order = nextRead();
    const inputs = [method, key, tick, reconnected, resync, attempt];
    const before = asked.current;
    const share =
      !before ||
      before[0] !== method ||
      before[1] !== key ||
      inputs.every((input, i) => Object.is(input, before[i]));
    // Moved by the tick or a resync, not by this hook's reconnect or reload: other mounts of the
    // same query moved with it, so they share a read sent for the same tick.
    const ticked = !share && before?.[3] === reconnected && before?.[5] === attempt;
    asked.current = inputs;
    const hit = cachedQuery(method, key);
    // Data already shown stays, with its error, until this read lands.
    setState((s) =>
      s.key === key
        ? { ...s, error: s.data === null ? null : s.error, loading: true }
        : {
            key,
            data: (hit?.data ?? null) as T | null,
            readAt: hit?.data != null ? hit.readAt : null,
            cached: hit?.data != null,
            error: null,
            loading: true,
          },
    );
    const read = () => readQuery(method, latest.current.params(key));
    // A mount joins only a read sent once the newest event a tick has seen was in.
    const reading = readCached(
      method,
      key,
      read,
      share || ticked,
      ticked ? `${tick} ${resync}` : `seen ${seenSequence}`,
    );
    void reading.then((result) => {
      // A slow read of the same key still lands unless a newer answer was already taken.
      const now = latest.current;
      if (
        now.method !== method ||
        now.key !== key ||
        run < runs.current.taken ||
        (retain && run !== runs.current.started)
      )
        return;
      runs.current.taken = run;
      const { accept, text } = now;
      const value = result.ok ? accept(result.value) : null;
      const slow = !result.ok && SLOW_CODES.has(result.error.code);
      const retry = slow && slowRetry.current.key !== key;
      slowRetry.current.key = slow ? key : null;
      if (retry)
        slowRetry.current.timer = setTimeout(() => setAttempt((n) => n + 1), SLOW_RETRY_MS);
      const loading = retry || run !== runs.current.started;
      const readAt = Date.now();
      if (value !== null) storeQuery(method, key, value, readAt, reading);
      else if (!retain && !slow) forgetQuery(method, key);
      setState((previous) =>
        value !== null
          ? { key, data: value, loading, error: null, readAt, order }
          : slow && previous.key === key && (retry || previous.data !== null)
            ? // A slow daemon is no failure: what is shown stays, without an error.
              { ...previous, loading, error: null, slow: !retry, order }
            : {
                key,
                data: retain && previous.key === key ? previous.data : null,
                readAt: retain && previous.key === key ? previous.readAt : null,
                cached: retain && previous.key === key && previous.cached,
                order,
                loading,
                error: result.ok
                  ? t(
                      {
                        id: 'data.read.incomplete',
                        defaultMessage: 'Incomplete read result ({method})',
                      },
                      { method: method },
                    )
                  : t(
                      { id: 'data.failure.reasonMessage', defaultMessage: '{reason} ({message})' },
                      {
                        reason: text[result.error.code] ?? reasonText(result.error.code),
                        message: result.error.message,
                      },
                    ),
              },
      );
    });
    return () => {
      if (retain && runs.current.started === run) runs.current.started++;
    };
  }, [method, key, tick, reconnected, resync, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  if (!key || state.key !== key) {
    // Until this mount's first read starts, show what an earlier mount read while it reads again.
    const hit = key ? cachedQuery(method, key) : undefined;
    return hit?.data != null
      ? {
          data: hit.data as T,
          loading: false,
          refreshing: true,
          error: null,
          reload,
          ...(retain && { readAt: hit.readAt, stale: true }),
        }
      : { data: null, loading: key !== null, refreshing: false, error: null, reload };
  }
  return {
    data: state.data,
    loading: state.loading && state.data === null,
    refreshing: state.loading && state.data !== null,
    error: state.error,
    reload,
    ...(retain && {
      readAt: state.readAt ?? null,
      order: state.order ?? 0,
      // A cached answer predates this mount, so it is no authority until a read of its own lands.
      stale:
        state.data !== null &&
        (!live || state.error !== null || state.cached === true || state.slow === true),
    }),
  };
}

const listParams = (project_id: string) => ({ project_id });
const acceptList = (value: unknown): WorkbenchSession[] | null =>
  Array.isArray(value) ? (value as WorkbenchSession[]) : null;

/** The project's session list as last read, without reading it again; undefined before a read. */
export const listedSessions = (projectId: string): readonly WorkbenchSession[] | undefined =>
  acceptList(cachedQuery('session.list', projectId)?.data) ?? undefined;

// Kinds whose aggregate may be a session, turn or worktree the list and board do not name yet.
const SESSION_PREFIXES = ['session.', 'turn.', 'workspace.', 'approval.', 'agent.', 'permission.'];

/**
 * Ids of the listed sessions the event can change: [] when none, null when it may change one
 * neither the list nor the board names yet.
 */
export function sessionScope(
  event: DaemonEvent,
  listed: readonly WorkbenchSession[],
  board: Pick<BoardSnapshot, 'sessions' | 'session_turns'> | null,
): string[] | null {
  // The rows' baseline waiting states and gate freshness follow these project facts.
  if (event.kind.startsWith('project.baseline_') || event.kind === 'project.gate_set') return null;
  const aggregate = event.aggregate_id,
    named = field(event.payload, 'session_id');
  const owner =
    (typeof named === 'string' ? named : undefined) ??
    board?.session_turns.find((turn) => turn.id === aggregate)?.session_id ??
    listed.find((session) => session.workspace_id === aggregate)?.id ??
    aggregate;
  if (listed.some((session) => session.id === owner)) return [owner];
  const known = board?.sessions.find((session) => session.id === owner);
  // The list holds these kinds of session, resident ones without a workspace among them.
  if (known)
    return known.workspace_id || known.baseline || known.runtime_review || known.resident
      ? [owner]
      : [];
  return SESSION_PREFIXES.some((prefix) => event.kind.startsWith(prefix)) ? null : [];
}

/**
 * The current list with the sessions in `ids` (null: all) taken from the fresh read; other rows take
 * it only where it differs, as outside edits send no event. Rows the fresh read lacks are dropped.
 */
export function mergeSessions(
  current: readonly WorkbenchSession[],
  fresh: readonly WorkbenchSession[],
  ids: ReadonlySet<string> | null,
): WorkbenchSession[] {
  if (!ids) return [...fresh];
  const byId = new Map(fresh.map((session) => [session.id, session]));
  const known = new Set(current.map((session) => session.id));
  return [
    ...current.flatMap((session) => {
      const next = byId.get(session.id);
      if (!next) return [];
      if (!ids.has(session.id))
        return [JSON.stringify(next) !== JSON.stringify(session) ? next : session];
      return [next];
    }),
    ...fresh.filter((session) => ids.has(session.id) && !known.has(session.id)),
  ];
}

/**
 * The project's worktree sessions: a session's events re-read only that session; reconnect, resync,
 * focus and reload re-read the whole list. A failed read keeps the last list beside its error.
 */
export function useSessionList(projectId: string | null): QueryState<WorkbenchSession[]> {
  const resync = useBoard((s) => s.resync);
  const events = useBoard((s) => s.events);
  const board = useBoard((s) => s.board);
  const focus = useFocusTick();
  const full = useQuery(
    'session.list',
    projectId,
    listParams,
    acceptList,
    resync + focus,
    {},
    true,
  );
  const live = useBoard((s) => s.status.state === 'live');
  const [patched, setPatched] = useState<{
    project: string;
    base: WorkbenchSession[];
    list: WorkbenchSession[];
    order: number;
  } | null>(null);
  const order = full.order ?? 0;
  // An event read sent after the newest whole read taken outranks that read's answer and error.
  const ahead = patched?.project === projectId && patched.order > order;
  const shown = patched && (patched.base === full.data || ahead) ? patched.list : full.data;
  const latest = useRef({ base: full.data, shown, order, board, reload: full.reload });
  latest.current = { base: full.data, shown, order, board, reload: full.reload };
  const sync = useRef({
    handled: 0,
    // Sessions whose events arrived since the last read; null when the whole list is due.
    pending: new Set<string>() as Set<string> | null,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    // When the pending timer fires.
    at: 0,
    generation: 0,
    reading: false,
    again: false,
  });

  const read = useCallback((): void => {
    const s = sync.current,
      base = latest.current.base;
    s.timer = undefined;
    if (!projectId || !base) return;
    if (s.reading) {
      s.again = true;
      return;
    }
    const ids = s.pending,
      generation = s.generation,
      order = nextRead();
    s.pending = new Set();
    s.reading = true;
    // Other lists of the project that handled the same events join this read.
    const reading = readCached(
      'session.list',
      projectId,
      () => readQuery('session.list', listParams(projectId)),
      true,
      `events ${s.handled}`,
    );
    void reading.then((result) => {
      s.reading = false;
      const now = latest.current;
      if (generation === s.generation) {
        const fresh = result.ok ? acceptList(result.value) : null;
        if (!fresh) now.reload();
        else if (now.base !== base && now.order > order) {
          // A whole read sent later landed meanwhile; read these sessions again on top of it.
          s.pending = s.pending && ids ? new Set([...s.pending, ...ids]) : null;
          s.again = true;
        } else if (now.base) {
          const list = mergeSessions(now.shown ?? now.base, fresh, ids);
          storeQuery('session.list', projectId, list, Date.now(), reading);
          setPatched({ project: projectId, base: now.base, list, order });
        }
      }
      if (s.again) {
        s.again = false;
        current.current();
      }
    });
  }, [projectId]);
  const current = useRef(read);
  current.current = read;

  // A pending read keeps its time unless the new event needs one sooner.
  const schedule = useCallback(
    (stream: boolean): void => {
      const s = sync.current;
      const now = Date.now(),
        at = now + (stream ? STREAM_REFRESH_MS : REFRESH_DELAY_MS);
      if (s.timer && s.at <= at) return;
      clearTimeout(s.timer);
      s.at = at;
      s.timer = setTimeout(read, at - now);
    },
    [read],
  );

  useEffect(() => {
    const s = sync.current;
    clearTimeout(s.timer);
    s.timer = undefined;
    s.generation++;
    s.again = false;
    s.pending = new Set();
    // The whole read covers the events before this point.
    s.handled = events.at(-1)?.sequence ?? 0;
  }, [projectId, resync]);

  useEffect(() => {
    const s = sync.current;
    let start = events.length;
    while (start > 0 && events[start - 1]!.sequence > s.handled) start--;
    if (!projectId || start === events.length) return;
    s.handled = events.at(-1)!.sequence;
    let due = false,
      stream = true;
    for (const event of events.slice(start)) {
      if (event.project_id !== projectId) continue;
      const ids = sessionScope(event, latest.current.shown ?? [], latest.current.board);
      if (ids?.length === 0) continue;
      due = true;
      if (!STREAM_KINDS.has(event.kind)) stream = false;
      if (!ids) s.pending = null;
      else for (const id of ids) s.pending?.add(id);
    }
    if (due) schedule(stream);
  }, [events, projectId, schedule]);

  useEffect(() => {
    const s = sync.current;
    if (full.data && (!s.pending || s.pending.size) && !s.timer) schedule(false);
  }, [full.data, schedule]);

  useEffect(
    () => () => {
      clearTimeout(sync.current.timer);
      sync.current.generation++;
      sync.current.again = false;
    },
    [],
  );

  return ahead ? { ...full, data: shown, error: null, stale: !live } : { ...full, data: shown };
}

const diffParams = (session_id: string) => ({ session_id });
const acceptDiff = (value: unknown): SessionDiff | null => {
  const diff = value as Partial<SessionDiff> | null;
  return Array.isArray(diff?.files) && typeof diff.truncated === 'boolean'
    ? (diff as SessionDiff)
    : null;
};

/** The worktree's changes of one session; read again after the session's events and on focus. */
export function useSessionDiff(sessionId: string | null): QueryState<SessionDiff> {
  const last = useNewestEvent(
    sessionId,
    (e, board) => sessionId !== null && touchesSession(e, sessionId, board),
  );
  const sequence = last?.sequence ?? 0;
  const stream = STREAM_KINDS.has(last?.kind ?? '');
  const tick = useRefetchTick(sequence, stream, ['session.diff', sessionId]) + useFocusTick();
  return useQuery('session.diff', sessionId, diffParams, acceptDiff, tick, DIFF_TEXT);
}

// Ids never hold a newline, so it joins the two into one query key.
const turnDiffParams = (key: string) => {
  const [session_id = '', turn_id = ''] = key.split('\n');
  return { session_id, turn_id };
};
const acceptTurnDiff = (value: unknown): SessionTurnDiff | null => {
  const diff = value as Partial<SessionTurnDiff> | null;
  return Array.isArray(diff?.files) && typeof diff.truncated === 'boolean'
    ? (diff as SessionTurnDiff)
    : null;
};

/** What one turn of a session changed; read again after the session's events and on focus. */
export function useTurnDiff(
  sessionId: string | null,
  turnId: string | null,
): QueryState<SessionTurnDiff> {
  const last = useNewestEvent(
    sessionId,
    (e, board) => sessionId !== null && touchesSession(e, sessionId, board),
  );
  const sequence = last?.sequence ?? 0;
  const stream = STREAM_KINDS.has(last?.kind ?? '');
  const key = sessionId !== null && turnId !== null ? `${sessionId}\n${turnId}` : null;
  const tick = useRefetchTick(sequence, stream, ['session.turn_diff', key]) + useFocusTick();
  return useQuery('session.turn_diff', key, turnDiffParams, acceptTurnDiff, tick, TURN_DIFF_TEXT);
}
