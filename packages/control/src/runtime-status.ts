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

/** Runs every runtime's preflight; a refresh still running is shared instead of starting another. */
export function refreshRuntimeStatus(ctx: ControlContext): Promise<void> {
  const running = refreshing.get(ctx);
  if (running) return running;
  const refresh = Promise.all(
    [...ctx.adapters.values()].map(async (adapter) => {
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

export async function reconnectRuntime(ctx: ControlContext, principal: Principal, runtime: string) {
  userOnly(principal);
  const config = readUserConfig(ctx.userConfigDir).runtimes?.[runtime] ?? {};
  requireThat(config.enabled !== false, 'invalid_state', `${runtime} is disabled`);
  let adapter = ctx.adapters.get(runtime);
  try {
    if (!adapter && ctx.createRuntimeAdapter) {
      requireThat(
        (nativeRuntimes as readonly string[]).includes(runtime) ||
          Object.hasOwn(acpProfiles, runtime),
        'invalid_input',
        `Unknown runtime ${runtime}`,
      );
      adapter = await ctx.createRuntimeAdapter(runtime, config);
      if (adapter) ctx.adapters.set(runtime, adapter);
    }
    requireThat(
      adapter?.reconnect,
      'unsupported_capability',
      `${runtime} cannot reconnect on this daemon`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    updateRuntimeConnection(ctx, runtime, false, reason);
    throw new DomainError('runtime_reconnect_failed', `${runtime}: ${reason}`);
  }
  await restoreRuntimeConnection(ctx, runtime, adapter.reconnect.bind(adapter));
  const connection = ctx.runtimeStatus.get(runtime)?.connection;
  if (connection?.connected === false)
    throw new DomainError('runtime_reconnect_failed', `${runtime}: ${connection.reason}`);
  return { runtime, connected: true };
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
