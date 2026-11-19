import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Visual } from '@pantheon/domain';
import {
  command,
  USER_PRINCIPAL_ID,
  type BridgeResult,
  type CommandType,
} from '@pantheon/protocol';
import { t } from '../i18n';
import { useBoard } from './board';
import { runCommand } from './commands';
import { failureText } from './needs-you';
import type { DaemonEvent } from './sync';
import { useRefetchTick } from './workbench-sessions';

export type VisualSize = NonNullable<Visual['pin']>['size'];

export interface VisualRead<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** The visual or project is no longer there. */
  gone: boolean;
}

// A write here reads at once instead of waiting for its visual.changed event.
let writes = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const writeCount = () => writes;

// Visuals are read through commands; unlike runCommand a read leaves the board alone.
async function send(
  type: CommandType,
  input: Record<string, unknown>,
): Promise<BridgeResult<unknown>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  return bridge
    .command(command(USER_PRINCIPAL_ID, type, input))
    .catch((error: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: { code: 'ipc_failed', message: String(error) },
    }));
}

const field = (payload: unknown, key: string): unknown =>
  payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[key] : undefined;

function useVisualRead<T>(
  type: 'visual.read' | 'visual.list',
  key: string | null,
  input: (key: string) => Record<string, unknown>,
  accept: (value: unknown) => T | null,
  touches: (event: DaemonEvent, key: string) => boolean,
): VisualRead<T> {
  const sequence = useBoard((s) => {
    if (key === null) return 0;
    for (let i = s.events.length - 1; i >= 0; i--)
      if (touches(s.events[i]!, key)) return s.events[i]!.sequence;
    return 0;
  });
  const resync = useBoard((s) => s.resync);
  const live = useBoard((s) => s.status.state === 'live');
  // Counts the times the stream went live, so a read that failed while the daemon was away is made again.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const reconnected = reconnects.current.count;
  const written = useSyncExternalStore(subscribe, writeCount, writeCount);
  const tick = useRefetchTick(sequence, false);
  const [state, setState] = useState<{ key: string | null } & VisualRead<T>>({
    key: null,
    data: null,
    loading: true,
    error: null,
    gone: false,
  });
  const runs = useRef(0);
  useEffect(() => {
    if (key === null) return;
    const run = ++runs.current;
    setState((s) =>
      s.key === key
        ? { ...s, loading: true }
        : { key, data: null, loading: true, error: null, gone: false },
    );
    void send(type, input(key)).then((result) => {
      if (run !== runs.current) return;
      const data = result.ok ? accept(result.value) : null;
      setState({
        key,
        data,
        loading: false,
        gone: !result.ok && result.error.code === 'not_found',
        error: !result.ok
          ? failureText(result.error)
          : data === null
            ? t(
                { id: 'data.read.incomplete', defaultMessage: 'Incomplete read result ({method})' },
                { method: type },
              )
            : null,
      });
    });
  }, [type, key, tick, resync, reconnected, written]);
  if (state.key !== key) return { data: null, loading: key !== null, error: null, gone: false };
  return { data: state.data, loading: state.loading, error: state.error, gone: state.gone };
}

const readInput = (visual_id: string) => ({ visual_id });
const acceptVisual = (value: unknown): Visual | null =>
  value && typeof value === 'object' && 'kind' in value && 'spec' in value
    ? (value as Visual)
    : null;
const drawsVisual = (event: DaemonEvent, visualId: string) =>
  (event.kind === 'visual.drawn' && field(event.payload, 'visual_id') === visualId) ||
  (event.kind === 'visual.changed' &&
    (field(event.payload, 'visual_ids') as unknown[] | undefined)?.includes(visualId) === true);

/** One visual; read again when its session draws it again and after a pin, unpin or arrange. */
export const useVisual = (visualId: string | null): VisualRead<Visual> =>
  useVisualRead('visual.read', visualId, readInput, acceptVisual, drawsVisual);

const pinnedInput = (project_id: string) => ({ project_id, pinned: true });
const acceptList = (value: unknown): Visual[] | null => {
  const visuals = field(value, 'visuals');
  return Array.isArray(visuals) ? (visuals as Visual[]) : null;
};
// A drawing may pin itself as it is drawn; deleting a session unpins its visuals or drops their session.
const drawsInProject = (event: DaemonEvent, projectId: string) =>
  (event.kind === 'visual.drawn' ||
    event.kind === 'visual.changed' ||
    event.kind === 'session.deleted') &&
  event.project_id === projectId;

/** The project's pinned visuals in board order. */
export const usePinnedVisuals = (projectId: string | null): VisualRead<Visual[]> =>
  useVisualRead('visual.list', projectId, pinnedInput, acceptList, drawsInProject);

/** The visuals one session of the project drew; read again when it draws. */
export const useSessionVisuals = (projectId: string, sessionId: string | null) =>
  useVisualRead(
    'visual.list',
    sessionId,
    (session_id) => ({ project_id: projectId, session_id }),
    acceptList,
    (event, session_id) => event.kind === 'visual.drawn' && event.aggregate_id === session_id,
  );

/** Sends a visual write; null when it landed, else why it did not. */
async function write(type: CommandType, input: Record<string, unknown>): Promise<string | null> {
  const result = await runCommand(type, input, null);
  if (!result.ok) return failureText(result.error);
  writes++;
  for (const listener of listeners) listener();
  return null;
}

export type VisualWidth = NonNullable<NonNullable<Visual['pin']>['width']>;

/** Without a width a pinned visual keeps the width it had. */
export const pinVisual = (visualId: string, size: VisualSize, width?: VisualWidth) =>
  write(
    'visual.pin',
    width === undefined ? { visual_id: visualId, size } : { visual_id: visualId, size, width },
  );

export const unpinVisual = (visualId: string) => write('visual.unpin', { visual_id: visualId });

/** `order` holds exactly the project's pinned visual ids. */
export const arrangeVisuals = (projectId: string, order: string[]) =>
  write('visual.arrange', { project_id: projectId, order });

/* Refresh: the session that drew a visual draws it again in place */

/**
 * A redraw asked of a visual's session: the revision the visual had, the turn carrying the ask and
 * when it was sent; both null while it waits behind another turn of its session.
 */
interface Refresh {
  revision: number;
  turn: string | null;
  at: number | null;
}
let refreshes: ReadonlyMap<string, Refresh> = new Map();
const refreshListeners = new Set<() => void>();
const subscribeRefreshes = (listener: () => void) => {
  refreshListeners.add(listener);
  return () => void refreshListeners.delete(listener);
};
const askedRefreshes = () => refreshes;
function setRefreshes(change: (next: Map<string, Refresh>) => void) {
  const next = new Map(refreshes);
  change(next);
  refreshes = next;
  for (const listener of refreshListeners) listener();
}

// Prompts stay in English whatever the interface language is.
const redrawPrompt = (v: Visual) =>
  `Draw this visual again with fresh data. Fetch its data again and call draw with the same title and kind, and replaces set to its id:\n- ${v.title} (${v.kind}): replaces "${v.id}"`;

/**
 * Waits until the session can take a new turn, at a revision past `after` once a turn was sent:
 * its revision then, null when the board does not show it, or 'gone' once it is deleted.
 */
function turnFree(sessionId: string, after: number | null): Promise<number | null | 'gone'> {
  return new Promise((resolve) => {
    const settled = (state: ReturnType<typeof useBoard.getState>) => {
      if (state.events.some((e) => e.kind === 'session.deleted' && e.aggregate_id === sessionId)) {
        resolve('gone');
        return true;
      }
      const session = state.board?.sessions.find((s) => s.id === sessionId);
      if (
        session &&
        (session.state === 'running' ||
          session.state === 'reconciling' ||
          (after !== null && session.revision <= after))
      )
        return false;
      resolve(session?.revision ?? null);
      return true;
    };
    if (settled(useBoard.getState())) return;
    const stop = useBoard.subscribe((state) => {
      if (settled(state)) stop();
    });
  });
}

/** Sends one session its visuals one turn each, each after the turn before it ended. */
async function redrawInTurns(sessionId: string, drawn: readonly Visual[]): Promise<string | null> {
  let failed: string | null = null;
  let after: number | null = null;
  for (const [index, v] of drawn.entries()) {
    const revision = await turnFree(sessionId, after);
    if (revision === 'gone') {
      setRefreshes((next) => drawn.slice(index).forEach((left) => next.delete(left.id)));
      break;
    }
    const at = Date.now();
    const result = await runCommand(
      'session.send',
      { session_id: sessionId, input: redrawPrompt(v) },
      revision,
    );
    const turn = result.ok ? field(result.value, 'id') : undefined;
    setRefreshes((next) => {
      if (result.ok)
        next.set(v.id, { revision: v.revision, turn: typeof turn === 'string' ? turn : null, at });
      else next.delete(v.id);
    });
    if (result.ok) after = revision;
    else failed ??= failureText(result.error);
  }
  return failed;
}

/**
 * Asks each visual's session (deleted ones skipped) to draw it again with fresh data, one turn per
 * visual: a session's visuals one after another, the sessions side by side. Null when every ask went
 * out, else why the first one did not.
 */
export async function refreshVisuals(visuals: readonly Visual[]): Promise<string | null> {
  const bySession = new Map<string, Visual[]>();
  for (const v of visuals)
    if (v.session_id) bySession.set(v.session_id, [...(bySession.get(v.session_id) ?? []), v]);
  // Every visual counts as refreshing from the start, so a progress count never runs ahead.
  setRefreshes((next) => {
    for (const drawn of bySession.values())
      for (const v of drawn) next.set(v.id, { revision: v.revision, turn: null, at: null });
  });
  const failures = await Promise.all(
    [...bySession].map(([sessionId, drawn]) => redrawInTurns(sessionId, drawn)),
  );
  return failures.find((failed) => failed !== null) ?? null;
}

export const refreshVisual = (visual: Visual) => refreshVisuals([visual]);

/**
 * The redraws of these visuals not drawn yet: waiting while the turn that asked runs, failed once
 * it ended or the visual's session was deleted. A newer revision drawn or read ends either.
 */
function useRedraws(visuals: readonly Visual[] | null): ReadonlyMap<string, 'waiting' | 'failed'> {
  const asked = useSyncExternalStore(subscribeRefreshes, askedRefreshes, askedRefreshes);
  const events = useBoard((s) => s.events);
  const turns = useBoard((s) => s.board?.session_turns);
  const redraws = useMemo(() => {
    const open = new Map<string, 'waiting' | 'failed'>();
    for (const [id, ask] of asked) {
      const read = visuals?.find((v) => v.id === id);
      if (!read || read.revision > ask.revision) continue;
      const drawn = events.some(
        (e) => drawsVisual(e, id) && Number(field(e.payload, 'revision')) > ask.revision,
      );
      const turn = turns?.find((t) => t.id === ask.turn);
      const sessionGone =
        read.session_id === null ||
        events.some((e) => e.kind === 'session.deleted' && e.aggregate_id === read.session_id);
      const ended = sessionGone || (!!turn && turn.state !== 'queued' && turn.state !== 'running');
      if (!drawn) open.set(id, ended ? 'failed' : 'waiting');
    }
    return open;
  }, [asked, events, turns, visuals]);
  // A newer revision read ends a redraw for good.
  useEffect(() => {
    const read = [...asked].filter(
      ([id, ask]) => (visuals?.find((v) => v.id === id)?.revision ?? 0) > ask.revision,
    );
    if (read.length) setRefreshes((next) => read.forEach(([id]) => next.delete(id)));
  }, [asked, visuals]);
  return redraws;
}

function useRedrawIds(
  visuals: readonly Visual[] | null,
  state: 'waiting' | 'failed',
): ReadonlySet<string> {
  const redraws = useRedraws(visuals);
  return useMemo(
    () => new Set([...redraws].filter(([, s]) => s === state).map(([id]) => id)),
    [redraws, state],
  );
}

/** The ids of these visuals still waiting on a redraw. */
export const useRefreshing = (visuals: readonly Visual[] | null): ReadonlySet<string> =>
  useRedrawIds(visuals, 'waiting');

/** The ids of these visuals whose asking turn or session ended without drawing them again. */
export const useRedrawFailed = (visuals: readonly Visual[] | null): ReadonlySet<string> =>
  useRedrawIds(visuals, 'failed');

/** When the turn asking each redraw was sent; a redraw waiting behind another turn has none yet. */
export function useRedrawStarts(): ReadonlyMap<string, number> {
  const asked = useSyncExternalStore(subscribeRefreshes, askedRefreshes, askedRefreshes);
  return useMemo(
    () =>
      new Map([...asked].flatMap(([id, ask]) => (ask.at === null ? [] : [[id, ask.at] as const]))),
    [asked],
  );
}
