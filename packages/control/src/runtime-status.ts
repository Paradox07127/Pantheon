import type { RuntimeStatus } from '@pantheon/protocol';
import {
  DomainError,
  requireThat,
  type Principal,
  type Project,
  type QuotaWindow,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { acpProfiles, nativeRuntimes } from '@pantheon/adapters';
import { sessionAdapter, userOnly, type ControlContext } from './context.js';
import { isolationWaived } from './admission.js';
import { readUserConfig } from './user-config.js';
import { stopTurn } from './session.js';

const refreshing = new WeakMap<ControlContext, Promise<void>>();
const checking = new WeakMap<ControlContext, Map<string, Promise<void>>>();
/** The waits before each reconnect the daemon tries on its own; the last one repeats until it connects. */
const RETRY_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
type Retry = { timer?: ReturnType<typeof setTimeout> };
const retrying = new WeakMap<ControlContext, Map<string, Retry>>();

/**
 * Runs every runtime's preflight, and the ACP initialize of each ACP-profile runtime; a refresh
 * still running is shared instead of starting another.
 */
export function refreshRuntimeStatus(ctx: ControlContext): Promise<void> {
  const running = refreshing.get(ctx);
  if (running) return running;
  const refresh = Promise.all(
    [...ctx.adapters.values()].map(async (adapter) => {
      if (Object.hasOwn(acpProfiles, adapter.name) && adapter.reconnect) {
        // A failed handshake only keeps the runtime unlisted; it holds none of its sessions.
        const handshake = await adapter.reconnect().then(
          () => true,
          () => false,
        );
        if (ctx.adapters.get(adapter.name) !== adapter) return;
        const before = ctx.runtimeStatus.get(adapter.name)?.handshake;
        ctx.runtimeStatus.set(adapter.name, {
          ...ctx.runtimeStatus.get(adapter.name),
          runtime: adapter.name,
          handshake,
          checked_at: new Date(ctx.store.now()).toISOString(),
        });
        // The interface lists an ACP runtime by its handshake, so a changed one has it read again.
        if (before === undefined || before === handshake) return;
        const projects = ctx.store.list<Project>('projects').map((project) => project.id);
        ctx.store.transaction(() => {
          for (const project of projects.length ? projects : [''])
            ctx.store.event(
              'runtime.handshake_changed',
              { id: adapter.name, revision: 1 },
              project,
              { runtime: adapter.name, handshake },
            );
        });
        ctx.changed();
        return;
      }
      if (!adapter.preflight) return;
      const found = await adapter.preflight();
      if (ctx.adapters.get(adapter.name) !== adapter) return;
      ctx.runtimeStatus.set(adapter.name, {
        ...ctx.runtimeStatus.get(adapter.name),
        runtime: adapter.name,
        ...found,
        checked_at: new Date(ctx.store.now()).toISOString(),
      });
      if (found.installed && (found.error || found.auth.reason === 'timeout'))
        updateRuntimeConnection(
          ctx,
          adapter.name,
          false,
          found.error ?? found.auth.reason ?? 'Runtime could not start',
        );
    }),
  )
    .then(() => {})
    .finally(() => refreshing.delete(ctx));
  refreshing.set(ctx, refresh);
  return refresh;
}

/** Adds each known runtime that had no executable at the start and has one now. */
async function findInstalledRuntimes(ctx: ControlContext): Promise<void> {
  const create = ctx.createRuntimeAdapter;
  if (!create) return;
  const configured = readUserConfig(ctx.userConfigDir).runtimes ?? {};
  await Promise.all(
    [...nativeRuntimes, ...Object.keys(acpProfiles)]
      .filter((runtime) => !ctx.adapters.has(runtime) && configured[runtime]?.enabled !== false)
      .map(async (runtime) => {
        // A configuration the adapter refuses leaves the runtime absent, as at the start.
        const adapter = await create(runtime, configured[runtime] ?? {}).catch(() => undefined);
        if (adapter && adapter.report.version !== 'unprobed' && !ctx.adapters.has(runtime))
          ctx.adapters.set(runtime, adapter);
      }),
  );
}

export async function runtimeStatus(
  ctx: ControlContext,
  refresh: boolean,
): Promise<RuntimeStatus[]> {
  if (refresh) await Promise.all([refreshRuntimeStatus(ctx), findInstalledRuntimes(ctx)]);
  else if ([...ctx.runtimeStatus.values()].every((status) => status.checked_at === undefined))
    await refreshRuntimeStatus(ctx);
  // A handshake still running, or not run because its adapter came after the refresh began, has not failed.
  const unanswered = () =>
    [...ctx.adapters.values()].some(
      (adapter) =>
        Object.hasOwn(acpProfiles, adapter.name) &&
        adapter.reconnect &&
        ctx.runtimeStatus.get(adapter.name)?.handshake === undefined,
    );
  while (unanswered()) await refreshRuntimeStatus(ctx);
  const configured = readUserConfig(ctx.userConfigDir).runtimes;
  const runtimes = new Set([
    ...ctx.adapters.keys(),
    ...Object.keys(configured ?? {}),
    ...nativeRuntimes,
    ...Object.keys(acpProfiles),
  ]);
  return [...runtimes].map((runtime) => {
    const adapter = ctx.adapters.get(runtime);
    const config = configured?.[runtime];
    const enabled = config?.enabled !== false;
    return {
      runtime,
      installed: adapter !== undefined && adapter.report.version !== 'unprobed',
      version: adapter && adapter.report.version !== 'unprobed' ? adapter.report.version : null,
      min_version: null,
      version_ok: null,
      auth: { state: 'unknown' },
      checked_at: adapter?.report.checked_at ?? new Date(ctx.store.now()).toISOString(),
      ...ctx.runtimeStatus.get(runtime),
      ...config,
      ...(enabled &&
        Object.hasOwn(acpProfiles, runtime) && {
          handshake: ctx.runtimeStatus.get(runtime)?.handshake === true,
        }),
      unverified_isolation: isolationWaived(ctx, runtime),
      enabled,
      capabilities: enabled ? adapter?.report.capabilities : undefined,
      connection: runtimeConnection(ctx, runtime),
    };
  });
}

export function runtimeConnection(ctx: ControlContext, runtime: string) {
  const status = ctx.runtimeStatus.get(runtime);
  const adapter = ctx.adapters.get(runtime);
  const installed =
    adapter !== undefined && (status?.installed ?? adapter.report.version !== 'unprobed');
  const saved = installed ? status?.connection : undefined;
  const connected = installed && (saved?.connected ?? true);
  const sessions =
    saved?.connected === false
      ? ctx.store
          .list<Session>('sessions')
          .filter(
            (session) => session.runtime === runtime && ['open', 'running'].includes(session.state),
          )
      : [];
  return {
    connected,
    ...(saved?.connected === false
      ? { disconnected_since: saved.disconnected_since, reason: saved.reason }
      : {}),
    held_session_count: sessions.length,
    held_session_ids: sessions.map((session) => session.id),
  };
}

export function updateRuntimeConnection(
  ctx: ControlContext,
  runtime: string,
  connected: boolean,
  reason?: string,
): void {
  const previous = ctx.runtimeStatus.get(runtime);
  if (connected) stopRetry(ctx, runtime);
  else if (
    !ctx.closing &&
    (ctx.adapters.has(runtime) || knownRuntime(runtime)) &&
    !retrying.get(ctx)?.has(runtime)
  )
    retryLater(ctx, runtime, 0);
  if (
    (connected && !previous?.connection) ||
    (previous?.connection?.connected === connected && previous.connection.reason === reason)
  )
    return;
  const connection = {
    connected,
    ...(connected
      ? {}
      : {
          disconnected_since:
            previous?.connection?.disconnected_since ?? new Date(ctx.store.now()).toISOString(),
          reason,
        }),
    held_session_count: 0,
    held_session_ids: [] as string[],
  };
  ctx.runtimeStatus.set(runtime, { ...previous, connection });
  const projects = ctx.store.list<Project>('projects').map((project) => project.id);
  ctx.store.transaction(() => {
    for (const project of projects.length ? projects : ['']) {
      const held = runtimeConnection(ctx, runtime).held_session_ids.filter(
        (id) => ctx.store.must<Session>('sessions', id).project_id === project,
      );
      ctx.store.event('runtime.connection_changed', { id: runtime, revision: 1 }, project, {
        runtime,
        ...connection,
        held_session_count: held.length,
        held_session_ids: held,
      });
    }
  });
  ctx.changed();
}

function stopRetry(ctx: ControlContext, runtime: string): void {
  clearTimeout(retrying.get(ctx)?.get(runtime)?.timer);
  retrying.get(ctx)?.delete(runtime);
}

/** Stops every reconnect the daemon would try on its own. */
export function stopRuntimeRetries(ctx: ControlContext): void {
  for (const runtime of retrying.get(ctx)?.keys() ?? []) stopRetry(ctx, runtime);
}

/** Tries the reconnect of a disconnected runtime after the wait of its attempt, and again while it fails. */
function retryLater(ctx: ControlContext, runtime: string, attempt: number): void {
  const runtimes = retrying.get(ctx) ?? new Map<string, Retry>();
  retrying.set(ctx, runtimes);
  stopRetry(ctx, runtime);
  const retry: Retry = {};
  runtimes.set(runtime, retry);
  retry.timer = setTimeout(
    () =>
      void ctx
        .runtimeChange(async () => {
          // A reconnect or config change queued before this one may have settled the runtime.
          if (runtimes.get(runtime) !== retry) return;
          const enabled = readUserConfig(ctx.userConfigDir).runtimes?.[runtime]?.enabled !== false;
          if (ctx.closing || !enabled) return stopRetry(ctx, runtime);
          // A failure is stored on the runtime's connection.
          await reconnectNow(ctx, runtime).catch(() => {});
          if (
            runtimes.get(runtime) === retry &&
            ctx.runtimeStatus.get(runtime)?.connection?.connected === false
          )
            retryLater(ctx, runtime, attempt + 1);
        })
        .catch((error: unknown) => {
          ctx.diagnostic(error);
          if (runtimes.get(runtime) === retry) retryLater(ctx, runtime, attempt + 1);
        }),
    RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)],
  );
  retry.timer.unref();
}

export function isRuntimeHeld(ctx: ControlContext, runtime: string): boolean {
  return (
    ctx.runtimeStatus.get(runtime)?.connection?.connected === false ||
    checking.get(ctx)?.has(runtime) === true
  );
}

export function checkRuntimeConnection(ctx: ControlContext, runtime: string): void {
  const adapter = ctx.adapters.get(runtime);
  if (!adapter?.reconnect || isRuntimeHeld(ctx, runtime)) return;
  void restoreRuntimeConnection(ctx, runtime, adapter.reconnect.bind(adapter));
}

function restoreRuntimeConnection(
  ctx: ControlContext,
  runtime: string,
  reconnect: () => Promise<void>,
): Promise<void> {
  const checks = checking.get(ctx) ?? new Map<string, Promise<void>>();
  checking.set(ctx, checks);
  const running = checks.get(runtime);
  if (running) return running;
  const check = Promise.resolve()
    .then(async () => {
      await reconnect();
      for (const [key, handle] of ctx.handles) {
        const session = ctx.store.must<Session>('sessions', handle.platform_session_id);
        if (session.runtime !== runtime) continue;
        const state = (await sessionAdapter(ctx, session)!.inspect(handle)).state;
        if (state === 'exited' || state === 'unknown') await stopTurn(ctx, key);
        await ctx.cancelling.get(key);
      }
      updateRuntimeConnection(ctx, runtime, true);
      ctx.store.transaction(() => {
        for (const turn of ctx.store.list<SessionTurn>('session_turns')) {
          if (turn.state !== 'queued' || !['pending', 'queued'].includes(turn.delivery)) continue;
          const session = ctx.store.must<Session>('sessions', turn.session_id);
          if (session.runtime === runtime && ['open', 'running'].includes(session.state))
            ctx.store.enqueue('session.turn', { turn_id: turn.id });
        }
      });
      // The runtime runs again, but its last preflight still lists it as not installed.
      if (!ctx.closing && ctx.runtimeStatus.get(runtime)?.installed === false)
        await refreshRuntimeStatus(ctx).catch(ctx.diagnostic);
    })
    .catch((error: unknown) => {
      updateRuntimeConnection(
        ctx,
        runtime,
        false,
        error instanceof Error ? error.message : String(error),
      );
    })
    .finally(() => {
      checks.delete(runtime);
      ctx.completions.delete(check);
    });
  checks.set(runtime, check);
  ctx.completions.add(check);
  return check;
}

const knownRuntime = (runtime: string) =>
  (nativeRuntimes as readonly string[]).includes(runtime) || Object.hasOwn(acpProfiles, runtime);

export async function reconnectRuntime(ctx: ControlContext, principal: Principal, runtime: string) {
  userOnly(principal);
  try {
    await reconnectNow(ctx, runtime);
  } catch (error) {
    // After a failure the user saw, the next retry waits the first step again.
    if (retrying.get(ctx)?.has(runtime)) retryLater(ctx, runtime, 0);
    throw error;
  }
  return { runtime, connected: true };
}

/** Finds the runtime's adapter again if it has none, and reconnects it; throws while it stays down. */
async function reconnectNow(ctx: ControlContext, runtime: string): Promise<void> {
  const config = readUserConfig(ctx.userConfigDir).runtimes?.[runtime] ?? {};
  requireThat(config.enabled !== false, 'invalid_state', `${runtime} is disabled`);
  let adapter = ctx.adapters.get(runtime);
  try {
    if (!adapter && ctx.createRuntimeAdapter) {
      requireThat(knownRuntime(runtime), 'invalid_input', `Unknown runtime ${runtime}`);
      adapter = await ctx.createRuntimeAdapter(runtime, config);
      requireThat(!ctx.closing, 'invalid_state', 'The daemon is stopping');
      if (adapter) ctx.adapters.set(runtime, adapter);
    }
    requireThat(
      adapter?.reconnect,
      'unsupported_capability',
      `${runtime} cannot reconnect on this daemon`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!ctx.closing) updateRuntimeConnection(ctx, runtime, false, reason);
    throw new DomainError('runtime_reconnect_failed', `${runtime}: ${reason}`);
  }
  await restoreRuntimeConnection(ctx, runtime, adapter.reconnect.bind(adapter));
  const connection = ctx.runtimeStatus.get(runtime)?.connection;
  if (connection?.connected === false)
    throw new DomainError('runtime_reconnect_failed', `${runtime}: ${connection.reason}`);
}

/** Account-wide updates from any session replace the windows they report. */
export function updateRuntimeQuota(
  ctx: ControlContext,
  runtime: string,
  windows: QuotaWindow[],
): void {
  const previous = ctx.runtimeStatus.get(runtime);
  const latest = new Map(previous?.quota?.windows.map((window) => [window.window, window]));
  for (const window of windows) latest.set(window.window, window);
  ctx.runtimeStatus.set(runtime, {
    ...previous,
    quota: { windows: [...latest.values()], seen_at: ctx.store.now() },
  });
}
