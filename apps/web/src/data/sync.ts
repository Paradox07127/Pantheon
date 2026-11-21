import type {
  BoardSnapshot,
  BridgeResult,
  BrowserRequest,
  DesktopBridge,
  EventFrame,
} from '@pantheon/protocol';

export type DaemonEvent = Extract<EventFrame, { type: 'event' }>['event'];
export type SyncStatus =
  | { state: 'connecting' }
  | { state: 'live' }
  // protocol_mismatch: the daemon speaks another protocol version; retrying waits for a restart.
  | { state: 'offline'; reason: string; protocol_mismatch?: true };
export interface SyncView {
  board: BoardSnapshot | null;
  events: DaemonEvent[];
  cursor: number;
  /** Sequence of the newest event that can change the board that an applied board read covers. */
  changed: number;
  /** `changed` and the board cursor after the last applied read of each project, '' for every project. */
  reads: Record<string, { changed: number; cursor: number }>;
  status: SyncStatus;
  /** Message of the last failed board read; null once a board is applied. */
  error: string | null;
  /** Counts up when events were missed or replaced; reads built from events start over. */
  resync: number;
  /** Revision of the daemon's native transcript index from its last trace.changed frame. */
  trace_revision: number;
  /** The board is the one an earlier run stored; no read of this run has landed yet. */
  stale: boolean;
}
export const MAX_EVENTS = 2000;
export const REFRESH_DELAY_MS = 100;
const FIRST_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
// Milliseconds without any frame before a live subscription counts as lost; the daemon sends a
// heartbeat every 15 s.
const LIVENESS_MS = 45_000;
// Streamed text and raw native frames arrive per token; the board reads only the attempt
// activity they move (phase, Codex plan), so they refresh it at most once per STREAM_REFRESH_MS.
export const STREAM_KINDS: ReadonlySet<string> = new Set([
  'agent.message.delta',
  'agent.native',
  'agent.task.progress',
]);
export const STREAM_REFRESH_MS = 2000;
// A hidden window runs no animation frames; its notices wait at most this long instead.
const HIDDEN_FRAME_MS = 250;
// Answers that mean the daemon is up but slow; they read as loading, not as a failure.
export const SLOW_CODES: ReadonlySet<string> = new Set(['query_timeout', 'daemon_busy']);
// A query hook reads once more this long after a slow answer.
export const SLOW_RETRY_MS = 2000;
// Some daemon writes record no event, so a read of one project misses them; once this long has
// passed since the last read of every project, the next read after an event reads every project.
export const WHOLE_READ_MS = 30_000;

// How a read of one project's board, which holds only that project's rows, merges into the board
// of every project: the read's cursor replaces the cursor, and the project's rows, found by `id` in
// projects and by `project_id` elsewhere, are replaced in place; new ones follow at the end.
// A row the read holds leaves the board wherever it was, since a row can move to another project.
// The daemon's board also carries reviews, which BoardSnapshot does not list.
const MERGE: Record<keyof BoardSnapshot | 'reviews', 'cursor' | 'id' | 'project_id'> = {
  cursor: 'cursor',
  projects: 'id',
  project_briefs: 'project_id',
  sessions: 'project_id',
  session_turns: 'project_id',
  workspaces: 'project_id',
  reviews: 'project_id',
};
type Rows = Record<string, { id: string; project_id?: string }[] | undefined>;

// The last applied board of each scope, so a new window shows it while it connects.
const SNAPSHOT_KEY = 'pantheon.boardSnapshot.v1';
const SNAPSHOT_LIMIT = 2 * 1024 * 1024;
const SNAPSHOT_SAVE_MS = 1000;

/** Stored boards by project id, '' for the board of every project. */
function storedBoards(): Record<string, BoardSnapshot> {
  const raw = localStorage.getItem(SNAPSHOT_KEY);
  if (raw === null) return {};
  try {
    const boards: Record<string, BoardSnapshot> = JSON.parse(raw);
    const valid = (b: BoardSnapshot) =>
      !!b && typeof b.cursor === 'number' && Array.isArray(b.projects);
    if (!boards || typeof boards !== 'object' || !Object.values(boards).every(valid))
      throw new Error('Unknown boards');
    return boards;
  } catch {
    localStorage.removeItem(SNAPSHOT_KEY);
    return {};
  }
}

function restoreBoards(): Record<string, BoardSnapshot> {
  try {
    return storedBoards();
  } catch {
    // Without storage a window starts with no board.
    return {};
  }
}

/** Stores `board` for `scope` beside `boards` and returns the boards storage now holds. */
function storeBoard(
  boards: Record<string, BoardSnapshot>,
  scope: string,
  board: BoardSnapshot,
): Record<string, BoardSnapshot> {
  try {
    let next = { ...boards, [scope]: board };
    let text = JSON.stringify(next);
    if (text.length > SNAPSHOT_LIMIT) text = JSON.stringify((next = { [scope]: board }));
    if (text.length <= SNAPSHOT_LIMIT) {
      localStorage.setItem(SNAPSHOT_KEY, text);
      return next;
    }
  } catch {
    // A full or missing storage keeps the last stored boards.
  }
  return boards;
}

export function startSync(
  bridge: Pick<DesktopBridge, 'query' | 'subscribe'>,
  /** browser answers the sessions' browser tool calls; the daemon sends them to one window only. */
  options: { project_id?: string; browser?: (request: BrowserRequest) => void },
  onChange: (view: SyncView) => void,
): { refresh(): void; reconnect(): void; stop(): void } {
  const params = options.project_id ? { project_id: options.project_id } : undefined;
  const scope = options.project_id ?? '';
  const seen = new Set<string>();
  // What storage holds, parsed once here; this run's saves keep it current.
  let boards = restoreBoards(),
    board: BoardSnapshot | null = boards[scope] ?? null,
    stale = board !== null,
    saveTimer: ReturnType<typeof setTimeout> | undefined,
    events: DaemonEvent[] = [],
    cursor = 0,
    // Sequence of the newest event that can change the board.
    boardCursor = 0,
    // The boardCursor of the newest applied board read; streamed events leave it.
    changed = 0,
    reads: SyncView['reads'] = {},
    status: SyncStatus = { state: 'connecting' },
    error: string | null = null,
    resync = 0,
    trace_revision = 0,
    stopped = false,
    backoff = FIRST_BACKOFF_MS,
    // Set by a 1013 close and cleared by an event; a second 1013 while set backs off.
    replayClosed = false,
    // Only frames from this subscription count; bumping it disowns the current one.
    subscription = 0,
    // Bumped on snapshot_required; board reads issued before it describe the replaced history.
    generation = 0,
    // A replacement history may have lower cursors than the board still on screen.
    boardGeneration = -1,
    // The generation a subscription of this run followed; reconnecting in it resumes at `cursor`.
    streamed = -1,
    // Startup board reads still out; a reconnect waits for them instead of sending another.
    starting = 0,
    end: (() => void) | undefined,
    retryTimer: ReturnType<typeof setTimeout> | undefined,
    livenessTimer: ReturnType<typeof setTimeout> | undefined,
    refreshTimer: ReturnType<typeof setTimeout> | undefined,
    // When the pending refreshTimer fires.
    refreshAt = 0,
    streamTimer: ReturnType<typeof setTimeout> | undefined,
    refreshBackoff = FIRST_BACKOFF_MS,
    refreshing = false,
    refreshAgain = false,
    // Projects named by events since the last read, '' for none, each with its newest sequence.
    pending = new Map<string, number>(),
    // The next read is of every project: a gap, a manual refresh or a failed read of every project.
    readWhole = false,
    // When the last read of every project was sent.
    wholeReadAt = 0,
    // When the last event arrived.
    eventAt = 0,
    // Events received since the last notice; the notice appends them in one copy.
    arrived: DaemonEvent[] = [],
    frame: number | undefined,
    frameTimer: ReturnType<typeof setTimeout> | undefined,
    noticeDue = false;

  const notify = (): void => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearTimeout(frameTimer);
    frame = frameTimer = undefined;
    if (!noticeDue || stopped) return;
    noticeDue = false;
    if (arrived.length) {
      events = events.concat(arrived);
      const delivered = events.length - arrived.length;
      arrived = [];
      if (events.length > MAX_EVENTS) {
        // Watchers never see events trimmed before a notice carried them, so they start over.
        if (events.length - MAX_EVENTS > delivered) resync++;
        for (const old of events.splice(0, events.length - MAX_EVENTS)) seen.delete(old.event_id);
      }
    }
    onChange({
      board,
      events,
      cursor,
      changed,
      reads,
      status,
      error,
      resync,
      trace_revision,
      stale,
    });
  };
  // Called once a read of this run is applied to `board`.
  const applied = (): void => {
    stale = false;
    saveTimer ??= setTimeout(() => {
      saveTimer = undefined;
      if (board) boards = storeBoard(boards, scope, board);
    }, SNAPSHOT_SAVE_MS);
  };
  // Subscribers hear of every change made within one frame in a single notice.
  const emit = (): void => {
    if (noticeDue) return;
    noticeDue = true;
    if (typeof requestAnimationFrame !== 'function') {
      queueMicrotask(notify);
      return;
    }
    frame = requestAnimationFrame(notify);
    frameTimer = setTimeout(notify, HIDDEN_FRAME_MS);
  };
  const offline = (reason: string): void => {
    status = { state: 'offline', reason };
    emit();
  };
  const retry = (next: () => void): void => {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(next, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };
  // ipcRenderer.invoke rejects when the main-process handler throws.
  const readBoard = (asked = params): Promise<BridgeResult<unknown>> =>
    bridge.query('board', asked).catch((reason: unknown) => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));

  function connect(): void {
    const issued = generation;
    // A mismatch stays shown while its retry read is out.
    if (status.state !== 'offline' || !status.protocol_mismatch) {
      status = { state: 'connecting' };
      emit();
    }
    starting++;
    wholeReadAt = Date.now();
    void readBoard().then((result) => {
      starting--;
      if (stopped || issued !== generation) return;
      if (!result.ok) {
        error = result.error.message;
        if (result.error.code === 'protocol_mismatch') {
          status = { state: 'offline', reason: result.error.message, protocol_mismatch: true };
          emit();
          backoff = MAX_BACKOFF_MS;
        } else if (SLOW_CODES.has(result.error.code)) emit();
        else offline(result.error.message);
        retry(connect);
        return;
      }
      const fresh = result.value as BoardSnapshot;
      // A manual refresh can answer before this startup or replacement read.
      if (!board || boardGeneration !== issued || fresh.cursor >= board.cursor) board = fresh;
      boardGeneration = issued;
      // A reconnect resumes the stream where it stopped, so the events since then still arrive.
      cursor = streamed === issued ? Math.min(cursor, board.cursor) : board.cursor;
      boardCursor = board.cursor;
      changed = Math.max(changed, boardCursor);
      reads = { '': { changed, cursor: board.cursor } };
      error = null;
      applied();
      emit();
      subscribe();
    });
  }

  // Counts the subscription lost unless a frame arrives within LIVENESS_MS, its first one included.
  const watch = (): void => {
    clearTimeout(livenessTimer);
    livenessTimer = setTimeout(() => {
      subscription++;
      end?.();
      end = undefined;
      offline('No frame from the daemon');
      retry(subscribe);
    }, LIVENESS_MS);
  };

  function subscribe(): void {
    const id = ++subscription;
    streamed = generation;
    end?.();
    const asked = {
      cursor,
      project_id: options.project_id,
      ...(options.browser && { browser: true }),
    };
    watch();
    end = bridge.subscribe(asked, (frame) => {
      if (stopped || id !== subscription) return;
      clearTimeout(livenessTimer);
      if (frame.type !== 'closed' && frame.type !== 'snapshot_required') watch();
      switch (frame.type) {
        case 'subscribed':
          if (!replayClosed) backoff = FIRST_BACKOFF_MS;
          status = { state: 'live' };
          emit();
          return;
        case 'event':
          replayClosed = false;
          backoff = FIRST_BACKOFF_MS;
          receive(frame.event);
          return;
        case 'heartbeat':
          return;
        case 'trace.changed':
          trace_revision = frame.revision;
          emit();
          return;
        case 'browser.request':
          options.browser?.(frame.request);
          return;
        case 'snapshot_required':
          // The daemon closes this socket next; that close is not a disconnect.
          subscription++;
          generation++;
          boardCursor = changed = 0;
          clearTimeout(refreshTimer);
          clearTimeout(streamTimer);
          refreshTimer = streamTimer = undefined;
          refreshAgain = false;
          pending = new Map();
          readWhole = false;
          events = [];
          arrived = [];
          seen.clear();
          resync++;
          connect();
          return;
        case 'closed':
          offline(`${frame.code} ${frame.reason}`);
          if (frame.code === 1013 && !replayClosed) {
            replayClosed = true;
            subscribe();
          } else retry(subscribe);
      }
    });
  }

  function receive(event: DaemonEvent): void {
    if (seen.has(event.event_id) || event.sequence <= cursor) return;
    seen.add(event.event_id);
    // Only the unfiltered stream carries every sequence; a project's stream skips the others.
    const gap = !options.project_id && event.sequence > cursor + 1;
    if (gap) resync++;
    arrived.push(event);
    cursor = event.sequence;
    eventAt = Date.now();
    emit();
    if (gap) readWhole = true;
    pending.set(event.project_id, event.sequence);
    if (STREAM_KINDS.has(event.kind) && !gap) {
      streamTimer ??= setTimeout(() => {
        streamTimer = undefined;
        fetchBoard();
      }, STREAM_REFRESH_MS);
      return;
    }
    boardCursor = event.sequence;
    scheduleRefresh();
  }

  // A pending read keeps its time unless this one is due sooner, so a burst cannot postpone it.
  function scheduleRefresh(delay = REFRESH_DELAY_MS): void {
    const at = Date.now() + delay;
    if (refreshTimer !== undefined && refreshAt <= at) return;
    clearTimeout(refreshTimer);
    refreshAt = at;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      fetchBoard();
    }, delay);
  }

  function fetchBoard(): void {
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    // A project's window reads its own board whole; a board of every project not yet read in this
    // history or an event without a project has nothing a project's read can merge into.
    const whole =
      readWhole ||
      !!options.project_id ||
      !board ||
      boardGeneration !== generation ||
      pending.has('') ||
      (pending.size > 0 &&
        Date.now() - wholeReadAt >= WHOLE_READ_MS &&
        (globalThis.document?.visibilityState ?? 'visible') === 'visible');
    const asked = pending;
    if (!whole && !asked.size) return;
    pending = new Map();
    readWhole = false;
    refreshing = true;
    const issued = generation;
    const covers = boardCursor;
    const projects = whole ? [] : [...asked.keys()];
    if (whole) wholeReadAt = Date.now();
    void Promise.all(
      whole ? [readBoard()] : projects.map((project_id) => readBoard({ project_id })),
    ).then((results) => {
      refreshing = false;
      if (stopped) return;
      if (issued === generation) {
        const failed = results.find((result) => !result.ok);
        // The projects whose read succeeded, in the order of `fresh`.
        const answered = projects.filter((_, i) => results[i]!.ok);
        const fresh = results.flatMap((result) =>
          result.ok ? [result.value as BoardSnapshot] : [],
        );
        const at = Math.min(...fresh.map((read) => read.cursor));
        if (fresh.length && (!board || boardGeneration !== issued || at >= board.cursor)) {
          if (whole) board = fresh[0]!;
          else {
            const merged: Record<string, unknown> = {};
            for (const [field, key] of Object.entries(MERGE))
              merged[field] =
                key === 'cursor'
                  ? at
                  : answered.reduce(
                      (rows, project, i) => {
                        const read = new Map(
                          ((fresh[i] as unknown as Rows)[field] ?? []).map((row) => [row.id, row]),
                        );
                        return rows
                          .flatMap((row) => {
                            if (row[key] !== project) return read.has(row.id) ? [] : [row];
                            const replaced = read.get(row.id);
                            read.delete(row.id);
                            return replaced ? [replaced] : [];
                          })
                          .concat([...read.values()]);
                      },
                      (board as unknown as Rows)[field] ?? [],
                    );
            board = merged as unknown as BoardSnapshot;
          }
          // A read the daemon answered before an event it was asked for reads that project again.
          for (const [project, sequence] of asked)
            if (
              (whole || answered.includes(project)) &&
              sequence > (whole ? at : fresh[answered.indexOf(project)]!.cursor)
            )
              pending.set(project, Math.max(pending.get(project) ?? 0, sequence));
          boardGeneration = issued;
          applied();
          if (!failed) {
            changed = Math.max(changed, Math.min(covers, board.cursor));
            error = null;
            refreshBackoff = FIRST_BACKOFF_MS;
            if (board.cursor < boardCursor) scheduleRefresh();
          }
          const read = { changed, cursor: board.cursor };
          reads = whole
            ? { '': read }
            : { ...reads, ...Object.fromEntries(answered.map((project) => [project, read])) };
          emit();
        }
        if (failed && !failed.ok) {
          // The next read asks again for what this one asked of the reads that failed.
          readWhole ||= whole;
          for (const [project, sequence] of asked)
            if (!answered.includes(project))
              pending.set(project, Math.max(pending.get(project) ?? 0, sequence));
          error = failed.error.message;
          emit();
          clearTimeout(refreshTimer);
          refreshTimer = undefined;
          scheduleRefresh(refreshBackoff);
          refreshBackoff = Math.min(refreshBackoff * 2, MAX_BACKOFF_MS);
        }
      }
      if (refreshAgain) {
        refreshAgain = false;
        fetchBoard();
      }
    });
  }

  // Other windows store their own scopes under the same key; the next save here keeps them.
  const onStorage = (e: StorageEvent) => {
    if (e.key === SNAPSHOT_KEY) boards = restoreBoards();
  };
  globalThis.addEventListener?.('storage', onStorage);
  // Picks up the daemon writes that record no event.
  const onFocus = () => {
    readWhole = true;
    scheduleRefresh();
  };
  globalThis.addEventListener?.('focus', onFocus);
  // A hidden window skips the read of every project after WHOLE_READ_MS; showing it catches up.
  const onVisible = () => {
    if (
      globalThis.document?.visibilityState === 'visible' &&
      eventAt > wholeReadAt &&
      Date.now() - wholeReadAt >= WHOLE_READ_MS
    ) {
      readWhole = true;
      scheduleRefresh();
    }
  };
  globalThis.document?.addEventListener?.('visibilitychange', onVisible);
  connect();
  // The starting view replaces the previous one at once.
  notify();
  return {
    refresh() {
      readWhole = true;
      scheduleRefresh();
    },
    // Connects now instead of when the backoff runs out, and starts the backoff over.
    reconnect() {
      if (starting) return;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      backoff = FIRST_BACKOFF_MS;
      connect();
    },
    stop() {
      stopped = true;
      globalThis.removeEventListener?.('storage', onStorage);
      globalThis.removeEventListener?.('focus', onFocus);
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
      end?.();
      clearTimeout(retryTimer);
      clearTimeout(livenessTimer);
      clearTimeout(refreshTimer);
      clearTimeout(streamTimer);
      clearTimeout(saveTimer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(frameTimer);
    },
  };
}
