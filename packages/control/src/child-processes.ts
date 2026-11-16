import type { ChildProcess } from 'node:child_process';
import { requireThat, type Session } from '@pantheon/domain';
import type { ControlContext } from './context.js';

const processes = new WeakMap<ControlContext, Set<() => void>>();

export function stopChildProcesses(ctx: ControlContext): void {
  for (const stop of processes.get(ctx) ?? []) stop();
}

export function trackChildProcess(
  ctx: ControlContext,
  key: string,
  child: ChildProcess,
  onError: (error: unknown, failed: boolean) => void,
): () => void {
  let recordedIdentity: { pid: number; started: number } | undefined;
  const stop = () => {
    try {
      if (child.pid) {
        const current = recordedIdentity && ctx.readProcess(recordedIdentity.pid);
        // A reused pid belongs to somebody else, including reuse within the same second.
        if (
          current &&
          (current.pid !== recordedIdentity?.pid ||
            current.start_time_us !== recordedIdentity.started)
        )
          return;
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') onError(error, false);
    }
  };
  let running = processes.get(ctx);
  if (!running) {
    running = new Set();
    processes.set(ctx, running);
  }
  running.add(stop);
  let recorded = false;
  child.on('close', () => {
    running.delete(stop);
    if (recorded)
      ctx.store.transaction(() => {
        ctx.store.db.prepare('DELETE FROM inbox WHERE source_key=?').run(key);
      });
  });
  try {
    if (child.pid) {
      const identity = ctx.readProcess(child.pid);
      if (identity) {
        requireThat(
          identity.start_time_us !== undefined && Number.isFinite(identity.start_time_us),
          'termination_unconfirmed',
          key.startsWith('gate-process:')
            ? 'Gate process start time could not be confirmed'
            : 'Check command process start time could not be confirmed',
        );
        ctx.store.transaction(() => {
          recordedIdentity = { pid: identity.pid, started: identity.start_time_us! };
          ctx.store.remember(key, '', { ...recordedIdentity, precision: 'microseconds' });
        });
        recorded = true;
      }
    }
  } catch (error) {
    onError(error, true);
    stop();
  }
  if (ctx.closing) stop();
  return stop;
}

// Records written before start times carried microseconds hold whole seconds.
const sameSecond = (current: number | undefined, recorded: number) =>
  current !== undefined && Math.floor(current / 1_000_000) === Math.floor(recorded / 1_000_000);

export function recoverChildProcesses(ctx: ControlContext): void {
  const records = ctx.store.db
    .prepare(
      "SELECT source_key, receipt FROM inbox WHERE source_key GLOB 'gate-process:*' OR source_key GLOB 'check-process:*'",
    )
    .all() as { source_key: string; receipt: string }[];
  for (const record of records) {
    const [kind, id, index] = record.source_key.split(':'),
      gate = kind === 'gate-process',
      // A workbench session's merge gate runs under the landing owner key session-<session id>.
      session =
        gate && id!.startsWith('session-')
          ? ctx.store.get<Session>('sessions', id!.slice('session-'.length))
          : undefined,
      identity = JSON.parse(record.receipt) as { pid: number; started: number; precision?: string };
    const current = ctx.readProcess(identity.pid);
    let killed = false;
    if (
      Number.isSafeInteger(identity.pid) &&
      identity.pid > 0 &&
      Number.isFinite(identity.started) &&
      current?.pid === identity.pid &&
      (identity.precision === 'microseconds'
        ? current.start_time_us === identity.started
        : sameSecond(current.start_time_us, identity.started))
    ) {
      try {
        process.kill(-identity.pid, 'SIGKILL');
        killed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + 10000,
        wait = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        const remaining = ctx.readProcess(identity.pid);
        if (
          !remaining ||
          (identity.precision === 'microseconds'
            ? remaining.start_time_us !== identity.started
            : !sameSecond(remaining.start_time_us, identity.started))
        )
          break;
        requireThat(
          Date.now() < deadline,
          'termination_unconfirmed',
          gate
            ? 'Landing gate process termination could not be confirmed'
            : 'Check command process termination could not be confirmed',
        );
        Atomics.wait(wait, 0, 0, 10);
      }
    }
    ctx.store.db.prepare('DELETE FROM inbox WHERE source_key=?').run(record.source_key);
    if (session)
      ctx.store.event('session.gate_process_reaped', session, session.project_id, {
        workspace_id: index,
        pid: identity.pid,
        killed,
      });
  }
}
