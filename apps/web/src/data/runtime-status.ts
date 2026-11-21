import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeResult, ConnectionsStatus, RuntimeStatus } from '@pantheon/protocol';
import { compareRuntimes } from '../components/RuntimeGlyph';
import { t } from '../i18n';
import { useBoard } from './board';
import { failureText, reasonText } from './needs-you';
import type { DaemonEvent } from './sync';

export type RuntimeStatusRead =
  | { state: 'loading' }
  | { state: 'ready'; statuses: RuntimeStatus[] }
  | { state: 'failed'; text: string };

/** Why a session cannot start on the runtime; null when it can or the check could not tell. */
export function unavailableReason(status: RuntimeStatus): string | null {
  if (!status.enabled) return t({ id: 'data.runtimeStatus.disabled', defaultMessage: 'Disabled' });
  if (!status.installed)
    return t({ id: 'data.runtimeStatus.notInstalled', defaultMessage: 'Not installed' });
  if (status.version_ok === false)
    return t(
      { id: 'data.runtimeStatus.versionBelow', defaultMessage: 'Version below {version}' },
      { version: status.min_version },
    );
  if (status.auth.state === 'logged_out')
    return t({ id: 'data.runtimeStatus.loggedOut', defaultMessage: 'Not signed in' });
  if (status.auth.state === 'unsupported_channel')
    return t({
      id: 'data.runtimeStatus.notSubscription',
      defaultMessage: 'Not signed in with a subscription account',
    });
  return null;
}

/** The first x.y.z of the text a runtime prints for its version, else the whole text. */
export const versionNumber = (version: string): string =>
  /\d+\.\d+\.\d+/.exec(version)?.[0] ?? version;

/** What a session asks of its runtime, as the daemon's admission checks it. */
export type SessionKind = 'writer' | 'reviewer' | 'text';

export const supports = (status: RuntimeStatus, capability: string) =>
  status.capabilities?.[capability]?.status === 'supported';

/** Why the runtime cannot hold a session of this kind; null when it can, the status lists no capabilities or isolation is waived. */
export function kindReason(status: RuntimeStatus, kind: SessionKind): string | null {
  // The daemon's admission skips the isolation checks for a runtime its settings allow without them.
  if (!status.capabilities || status.unverified_isolation === true) return null;
  if (kind === 'writer')
    return supports(status, 'write_isolation')
      ? null
      : t({
          id: 'data.runtimeStatus.noWriteIsolation',
          defaultMessage: 'Write isolation not verified',
        });
  if (!supports(status, 'text_execution'))
    return t({
      id: 'data.runtimeStatus.noTextExecution',
      defaultMessage: 'Text execution not verified',
    });
  if (kind === 'reviewer' && !supports(status, 'read_isolation'))
    return t({
      id: 'data.runtimeStatus.noReadIsolation',
      defaultMessage: 'Read isolation not verified',
    });
  return null;
}

/** The kinds of session the runtime can hold, in a fixed order. */
export const sessionKinds = (status: RuntimeStatus): SessionKind[] =>
  status.enabled && status.capabilities
    ? (['writer', 'reviewer', 'text'] as const).filter((kind) => kindReason(status, kind) === null)
    : [];

export async function readStatus(refresh: boolean): Promise<RuntimeStatusRead> {
  const bridge = window.pantheon;
  if (!bridge) return { state: 'failed', text: reasonText('bridge_unavailable') };
  // Through then, so a bridge that throws instead of rejecting fails the read the same way.
  const result = await Promise.resolve()
    .then(() => bridge.query('runtime.status', refresh ? { refresh: 'true' } : {}))
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return { state: 'failed', text: failureText(result.error) };
  const value = result.value as Partial<RuntimeStatus>[] | null;
  if (
    !Array.isArray(value) ||
    !value.every(
      (s) =>
        typeof s?.runtime === 'string' &&
        typeof s.enabled === 'boolean' &&
        typeof s.installed === 'boolean' &&
        typeof s.auth?.state === 'string',
    )
  )
    return {
      state: 'failed',
      text: failureText({ code: 'bad_response', message: 'runtime.status result is incomplete' }),
    };
  return { state: 'ready', statuses: value as RuntimeStatus[] };
}

const EVERY_MS = 5 * 60_000;
const NONE: Readonly<Record<string, string>> = {};

const NO_RUNTIMES: readonly string[] = [];

/** Whether the runtimes page and the runtime pickers list it: an ACP runtime only once its handshake answered. */
export const listedRuntime = (status: RuntimeStatus): boolean => status.handshake !== false;

const installedOf = (statuses: readonly RuntimeStatus[]) =>
  statuses.filter((s) => s.installed && listedRuntime(s)).map((s) => s.runtime);

/** The installed runtimes of the newest read that answered, for a mount whose own read has not. */
let lastInstalled: readonly string[] = NO_RUNTIMES;

/**
 * What a runtime picker lists, in display order: the installed runtimes and the given ones (the
 * current or saved choice). Until the read answers, the installed ones of the last read that did.
 */
export function offeredRuntimes(
  read: RuntimeStatusRead,
  keep: readonly (string | null | undefined)[],
): string[] {
  const installed = read.state === 'ready' ? installedOf(read.statuses) : lastInstalled;
  const kept = keep.filter((r): r is string => !!r);
  return [...new Set([...installed, ...kept])].sort(compareRuntimes);
}

/** Sequence of the newest runtime connection or ACP handshake change in the stream; 0 when there is none. */
function connectionTrigger(events: readonly DaemonEvent[]): number {
  return (
    events.findLast(
      (e) => e.kind === 'runtime.connection_changed' || e.kind === 'runtime.handshake_changed',
    )?.sequence ?? 0
  );
}

/** Every mounted runtime status reader; the read issued last lands in all of them. */
const statusReaders = new Set<(next: RuntimeStatusRead) => void>();
let statusAsked = 0;
/** The forced read in flight; a plain read joins it instead of overtaking it with the cached answer. */
let statusForced: Promise<void> | null = null;
/** The plain read in flight and the newest connection change it was sent after. */
let statusPlain: { done: Promise<void>; seen: number } | null = null;

/** The runtimes a read lists, in display order, and why each cannot start a session (of `kind` when given). */
export function runtimeChoices(
  read: RuntimeStatusRead,
  kind?: SessionKind,
): { runtimes: readonly string[]; unavailable: Readonly<Record<string, string>> } {
  const unavailable =
    read.state === 'ready'
      ? Object.fromEntries(
          read.statuses.flatMap((s) => {
            const why = unavailableReason(s) ?? (kind ? kindReason(s, kind) : null);
            return why ? [[s.runtime, why]] : [];
          }),
        )
      : NONE;
  const runtimes =
    read.state === 'ready'
      ? read.statuses
          .filter(listedRuntime)
          .map((s) => s.runtime)
          .sort(compareRuntimes)
      : NO_RUNTIMES;
  return { runtimes, unavailable };
}

/**
 * GET /v1/runtime.status on mount, every EVERY_MS and after each connection or handshake change; unavailable maps
 * a runtime to why it cannot start a session (of `kind` when given).
 */
export function useRuntimeStatus(kind?: SessionKind) {
  const [read, setRead] = useState<RuntimeStatusRead>({ state: 'loading' });
  const changed = useBoard((s) => connectionTrigger(s.events));
  const seen = useRef(changed);
  // Only the latest read lands; an earlier one answered late is dropped.
  const load = useCallback((refresh: boolean, join = false) => {
    if (!refresh && statusForced) return statusForced;
    // A reload asks anew; a mount, the timer or a change joins a read sent since the last change.
    if (join && !refresh && statusPlain?.seen === seen.current) return statusPlain.done;
    const at = ++statusAsked;
    const done: Promise<void> = readStatus(refresh).then((next) => {
      if (statusForced === done) statusForced = null;
      if (statusPlain?.done === done) statusPlain = null;
      if (at !== statusAsked) return;
      if (next.state === 'ready') lastInstalled = installedOf(next.statuses);
      for (const reader of statusReaders) reader(next);
    });
    if (refresh) statusForced = done;
    else statusPlain = { done, seen: seen.current };
    return done;
  }, []);
  useEffect(() => {
    statusReaders.add(setRead);
    void load(false, true);
    const timer = setInterval(() => void load(false, true), EVERY_MS);
    return () => {
      clearInterval(timer);
      statusReaders.delete(setRead);
      // A read no mounted reader waits for is joined by none.
      if (statusReaders.size === 0) statusPlain = null;
    };
  }, [load]);
  useEffect(() => {
    if (seen.current === changed) return;
    seen.current = changed;
    void load(false, true);
  }, [changed, load]);
  const { runtimes, unavailable } = runtimeChoices(read, kind);
  // Unavailable for a reason of their own setup, whatever the session asks of them.
  const disconnected =
    read.state === 'ready'
      ? read.statuses.filter((s) => unavailableReason(s) !== null).map((s) => s.runtime)
      : NO_RUNTIMES;
  return {
    read,
    runtimes,
    unavailable,
    disconnected,
    refresh: () => void load(true),
    reload: () => load(false),
  };
}

export type ConnectionsRead =
  | { state: 'loading' }
  | ({ state: 'ready' } & Pick<ConnectionsStatus, 'github'> &
      Partial<Omit<ConnectionsStatus, 'github'>>)
  | { state: 'failed'; text: string };

export async function readConnections(refresh: boolean): Promise<ConnectionsRead> {
  const bridge = window.pantheon;
  if (!bridge) return { state: 'failed', text: reasonText('bridge_unavailable') };
  const result = await Promise.resolve()
    .then(() => bridge.query('connections.status', refresh ? { refresh: 'true' } : {}))
    .catch((reason: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: {
        code: 'ipc_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      },
    }));
  if (!result.ok) return { state: 'failed', text: failureText(result.error) };
  const value = result.value as Partial<ConnectionsStatus> | null;
  const github = value?.github;
  if (typeof github?.state !== 'string' || typeof github.installed !== 'boolean')
    return {
      state: 'failed',
      text: failureText({
        code: 'bad_response',
        message: 'connections.status result is incomplete',
      }),
    };
  return {
    state: 'ready',
    github,
    huggingface: value?.huggingface,
    cloudflare: value?.cloudflare,
  };
}

/** Every mounted connections reader; the read issued last lands in all of them. */
const connectionsReaders = new Set<(next: ConnectionsRead) => void>();
let connectionsAsked = 0;
/** Number of the forced read in flight, 0 without one; a plain read waits for its answer instead. */
let connectionsForced = 0;

/** GET /v1/connections.status on mount; refresh asks gh again instead of the daemon's cached answer. */
export function useConnectionsStatus() {
  const [read, setRead] = useState<ConnectionsRead>({ state: 'loading' });
  const [checking, setChecking] = useState(false);
  // Only the latest read lands; an earlier one answered late is dropped.
  const load = useCallback((refresh: boolean) => {
    if (!refresh && connectionsForced) return;
    const at = ++connectionsAsked;
    if (refresh) connectionsForced = at;
    setChecking(refresh);
    void readConnections(refresh).then((next) => {
      if (connectionsForced === at) connectionsForced = 0;
      if (at === connectionsAsked) for (const reader of connectionsReaders) reader(next);
    });
  }, []);
  useEffect(() => {
    const reader = (next: ConnectionsRead) => {
      setRead(next);
      setChecking(false);
    };
    connectionsReaders.add(reader);
    load(false);
    return () => {
      connectionsReaders.delete(reader);
    };
  }, [load]);
  return { read, checking, refresh: () => load(true) };
}
