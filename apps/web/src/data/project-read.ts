import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRead } from '@pantheon/domain';
import type { BridgeResult, CommandType, DesktopBridge } from '@pantheon/protocol';
import { t } from '../i18n';
import { useBoard } from './board';
import { runCommand } from './commands';
import { failureText } from './needs-you';
import { cachedQuery, noteResync, readCached, storeQuery } from './query-cache';
import { SLOW_CODES, SLOW_RETRY_MS } from './sync';

export type { ProjectRead };
export type MilestoneView = ProjectRead['milestones'][number];
export type Milestone = MilestoneView['milestone'];
export type ProjectBrief = NonNullable<ProjectRead['brief']>;

/** Error codes meaning the daemon does not have the query or command at all. */
const UNAVAILABLE: readonly string[] = ['unknown_route', 'unsupported_command'];

export const isUnavailable = (code: string): boolean => UNAVAILABLE.includes(code);

export interface ProjectReadState {
  /** The last read of this project; kept while a newer read is in flight or after it fails. */
  read: ProjectRead | null;
  /** Set when the last read failed; the read above, if any, is older than the board. */
  error: string | null;
  /** The daemon has no project.read; nothing on the page can be derived. */
  unavailable: boolean;
  /** A read is out and there is no read to show yet. */
  loading: boolean;
  /** The read is one an earlier mount cached and this one's own read has not landed; no authority. */
  stale: boolean;
  reload: () => void;
}

const readQuery = (
  bridge: Pick<DesktopBridge, 'query'>,
  method: string,
  project_id: string,
  extra: Record<string, string> = {},
): Promise<BridgeResult<unknown>> =>
  bridge
    .query(method, { project_id, ...extra })
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));

function checked<T>(
  result: BridgeResult<unknown>,
  method: string,
  valid: (value: unknown) => boolean,
): BridgeResult<T> {
  if (!result.ok) return result;
  if (!valid(result.value))
    return { ok: false, error: { code: 'bad_response', message: `${method} shape` } };
  return { ok: true, value: result.value as T };
}

/**
 * A per-project GET query, read again after each board read, on reconnect and on resync; a failure
 * keeps the last read. A project read before shows its cached read while it
 * reads again. Queries of the same input asked for the same reason share one read.
 */
export function useProjectQuery<T>(
  method: string,
  project_id: string | null,
  valid: (value: unknown) => boolean,
  /** More query input, such as which of the project's objects to read. */
  extra?: Record<string, string>,
  /** events: only events that change the board can change the answer, so streamed ones read nothing. */
  options?: { events?: boolean },
): Omit<ProjectReadState, 'read'> & { read: T | null } {
  const of = extra ? JSON.stringify(extra) : '';
  const cacheKey = (id: string) => (of ? `${id} ${of}` : id);
  const identity = project_id ? `${method} ${cacheKey(project_id)}` : null;
  const ready = useBoard((s) => s.board !== null);
  const events = options?.events ?? false;
  const changed = useBoard((s) => (events ? s.changed : (s.board?.cursor ?? 0)));
  const live = useBoard((s) => s.status.state === 'live');
  const resync = useBoard((s) => s.resync);
  noteResync(resync);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    identity: string | null;
    read: T | null;
    error: string | null;
    unavailable: boolean;
    loading: boolean;
    stale: boolean;
  }>({
    identity: null,
    read: null,
    error: null,
    unavailable: false,
    loading: true,
    stale: false,
  });
  const check = useRef(valid);
  check.current = valid;
  const wanted = useRef({ method, project_id, of });
  wanted.current = { method, project_id, of };
  // Numbers of the last read started and of the newest read whose answer was taken.
  const runs = useRef({ started: 0, taken: 0 });
  // Counts the times the stream went live, so a disconnect alone reads nothing.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const reconnected = reconnects.current.count;
  // This hook's reconnect and reload counts at its last read; a read they start asks the daemon.
  const counted = useRef<{ reconnected: number; attempt: number } | null>(null);
  // The query whose slow answer was already read again once, and that retry's timer.
  const slowRetry = useRef<{ of: string | null; timer?: ReturnType<typeof setTimeout> }>({
    of: null,
  });
  useEffect(() => () => clearTimeout(slowRetry.current.timer), []);

  useEffect(() => {
    if (!project_id || !ready) return;
    clearTimeout(slowRetry.current.timer);
    const bridge = window.pantheon;
    const run = ++runs.current.started;
    const valid = check.current;
    const trigger = `${changed} ${resync}`;
    const before = counted.current;
    const share = !before || (before.reconnected === reconnected && before.attempt === attempt);
    counted.current = { reconnected, attempt };
    setState((s) => {
      if (s.identity === identity) return s.read === null ? { ...s, loading: true } : s;
      const hit = (cachedQuery(method, cacheKey(project_id))?.data ?? null) as T | null;
      return {
        identity,
        read: hit,
        error: null,
        unavailable: false,
        loading: hit === null,
        stale: hit !== null,
      };
    });
    const reading = bridge
      ? readCached(
          method,
          cacheKey(project_id),
          () => readQuery(bridge, method, project_id, extra),
          share,
          trigger,
        )
      : Promise.resolve<BridgeResult<unknown>>({
          ok: false,
          error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
        });
    void reading.then((answer) => {
      const result = checked<T>(answer, method, valid);
      // A slow read of the same project still lands unless a newer answer was already taken.
      const now = wanted.current;
      if (
        now.method !== method ||
        now.project_id !== project_id ||
        now.of !== of ||
        run < runs.current.taken
      )
        return;
      runs.current.taken = run;
      if (result.ok) storeQuery(method, cacheKey(project_id), result.value, Date.now(), reading);
      const slow = !result.ok && SLOW_CODES.has(result.error.code);
      const asked = `${method} ${cacheKey(project_id)}`;
      const retry = slow && slowRetry.current.of !== asked;
      slowRetry.current.of = slow ? asked : null;
      if (retry)
        slowRetry.current.timer = setTimeout(() => setAttempt((n) => n + 1), SLOW_RETRY_MS);
      setState((s) => {
        const read = s.identity === identity ? s.read : null;
        // A slow daemon is no failure: what is shown stays, without an error, and is stale once
        // the retry is spent.
        if (slow && s.identity === identity && (retry || read !== null))
          return { ...s, error: null, loading: read === null, stale: s.stale || !retry };
        return result.ok
          ? {
              identity,
              read: result.value,
              error: null,
              unavailable: false,
              loading: false,
              stale: false,
            }
          : {
              identity,
              read,
              error: failureText(result.error),
              unavailable: isUnavailable(result.error.code),
              loading: read === null && run !== runs.current.started,
              stale: s.identity === identity && s.stale,
            };
      });
    });
  }, [method, project_id, of, ready, changed, reconnected, resync, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  if (!project_id)
    return { read: null, error: null, unavailable: false, loading: false, stale: false, reload };
  if (state.identity !== identity) {
    // Until this mount's first read starts, show what an earlier mount read.
    const hit = (cachedQuery(method, cacheKey(project_id))?.data ?? null) as T | null;
    return {
      read: hit,
      error: null,
      unavailable: false,
      loading: hit === null,
      stale: hit !== null,
      reload,
    };
  }
  return {
    read: state.read,
    error: state.error,
    unavailable: state.unavailable,
    loading: state.loading,
    stale: state.stale,
    reload,
  };
}

/** What the daemon saved: the id and revision of the object a command's receipt returns. */
export interface Receipt {
  command: CommandType;
  id: string | null;
  revision: number | null;
  at: number;
}

export function receiptOf(command: CommandType, value: unknown, at: number): Receipt {
  const object = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    command,
    id: typeof object.id === 'string' ? object.id : null,
    revision: typeof object.revision === 'number' ? object.revision : null,
    at,
  };
}

export type MutationResult =
  { ok: true; receipt: Receipt; value: unknown } | { ok: false; error: string };

/** Sends one project-fact command; an unavailable command says so instead of a generic failure. */
export async function sendProjectCommand(
  type: CommandType,
  input: Record<string, unknown>,
  expected_revision: number | null,
): Promise<MutationResult> {
  const result = await runCommand(type, input, expected_revision);
  if (result.ok)
    return { ok: true, receipt: receiptOf(type, result.value, Date.now()), value: result.value };
  return {
    ok: false,
    error: isUnavailable(result.error.code)
      ? t(
          {
            id: 'data.projectRead.unavailable',
            defaultMessage: "The backend doesn't provide {type} yet",
          },
          { type },
        )
      : failureText(result.error),
  };
}
