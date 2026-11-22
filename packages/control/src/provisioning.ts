import { existsSync, lstatSync, realpathSync, rmdirSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { nativeEnvironment, terminate } from '@pantheon/adapters';
import {
  requireThat,
  type CancelReceipt,
  type Project,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { inside, managedRootOf, resolvedPath, type ControlContext } from './context.js';
import { copyDependencyFolders } from './dependency-folders.js';
import { restoreCheckpoint } from './checkpoint.js';
import { runGit } from './git.js';
import { onWslAutomount } from './wsl-mount.js';
import { unsnooze } from './session.js';
import { afterSpawnedTurn } from './conductor.js';

type Provisioning = NonNullable<Workspace['provisioning']>;
interface Job {
  cancelled: boolean;
  /** Stops the dependency copy, which runs outside the tracked git child. */
  copying: AbortController;
  timedOut?: boolean;
  child?: ChildProcess;
  exited?: Promise<void>;
  stopping?: Promise<CancelReceipt>;
  stop?: CancelReceipt;
}
const jobs = new WeakMap<ControlContext, Map<string, Job>>();
// Concurrent `git worktree add` in one repository can read another's half-written .git/worktrees entry.
const worktreeAdds = new WeakMap<ControlContext, Map<string, Promise<unknown>>>();

export function workspaceReady(workspace: Workspace): boolean {
  return (
    workspace.removed_at === undefined &&
    (!workspace.provisioning || workspace.provisioning.state === 'ready')
  );
}

function workbenchTurns(ctx: ControlContext, session: Session): SessionTurn[] {
  return ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === session.id && ['queued', 'running'].includes(turn.state));
}

function workbenchSessions(ctx: ControlContext, workspace: Workspace): Session[] {
  return ctx.store
    .list<Session>('sessions')
    .filter((session) => session.workspace_id === workspace.id && session.state !== 'closed');
}

/** Fails the session's queued and running turns; the caller owns the transaction. */
export function failWorkbenchTurns(ctx: ControlContext, session: Session, error: string): void {
  for (const turn of workbenchTurns(ctx, session)) {
    const failed = ctx.store.update(
      'session_turns',
      { ...turn, delivery: 'failed' as const, delivery_reason: error, state: 'failed' as const },
      turn.revision,
    );
    ctx.store.event('session.turn.delivery', failed, failed.project_id, {
      delivery: 'failed',
      reason: error,
    });
    ctx.store.event('turn.failed', failed, failed.project_id, { error });
  }
}

/** Ends the sessions waiting for a worktree that will never be ready and returns them; the caller owns the transaction. */
function failWorkbenchSessions(
  ctx: ControlContext,
  workspace: Workspace,
  error: string,
): Session[] {
  const sessions = workbenchSessions(ctx, workspace);
  for (const session of sessions) {
    failWorkbenchTurns(ctx, session, error);
    const next = ctx.store.update(
      'sessions',
      { ...session, state: 'closed' as const, stop_pending: false },
      session.revision,
    );
    ctx.store.event('session.closed', next, next.project_id, { reason: 'workspace_failed', error });
    unsnooze(ctx, next.id, 'session_ended');
  }
  return sessions;
}

function record(
  ctx: ControlContext,
  workspaceId: string,
  patch: Partial<Provisioning>,
  tell = true,
): Workspace {
  const ended: Session[] = [];
  const recorded = ctx.store.transaction(() => {
    const current = ctx.store.must<Workspace>('workspaces', workspaceId);
    if (current.kind === 'in_place') return current;
    const next = ctx.store.update(
      'workspaces',
      {
        ...current,
        provisioning: { ...current.provisioning!, ...patch },
      },
      current.revision,
    );
    ctx.store.event('workspace.provisioning', next, next.project_id, next.provisioning);
    if (patch.state === 'failed' || patch.state === 'cancelled') {
      ended.push(
        ...failWorkbenchSessions(
          ctx,
          next,
          [patch.error ?? `Workspace provisioning ${patch.state}`, next.provisioning?.output]
            .filter(Boolean)
            .join('\n'),
        ),
      );
      if (
        ctx.store
          .list<Session>('sessions')
          .some((session) => session.workspace_id === next.id && session.outcome === 'discarded') ||
        // A session deleted while provisioning has no row; its delete queued the removal.
        ctx.store
          .pending()
          .some(
            (job) =>
              job.kind === 'workspace.remove' && JSON.parse(job.payload).workspace_id === next.id,
          )
      ) {
        // Worktree removal leaves behind a reservation Git never populated.
        try {
          rmdirSync(next.path);
        } catch {
          /* A populated worktree is removed with its Git metadata. */
        }
        ctx.store.enqueue('workspace.remove', { workspace_id: next.id, reason: 'discarded' });
      }
    }
    ctx.changed();
    return next;
  });
  if (tell) for (const session of ended) if (session.spawned_by) afterSpawnedTurn(ctx, session.id);
  return recorded;
}

function assertReservation(ctx: ControlContext, workspace: Workspace): void {
  const stat = lstatSync(workspace.path);
  const identity = workspace.provisioning?.directory_identity;
  requireThat(
    managedRootOf(ctx, workspace.path) &&
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      realpathSync(workspace.path) === workspace.path &&
      identity?.dev === stat.dev &&
      identity.ino === stat.ino,
    'scope_violation',
    'Managed workspace reservation changed',
  );
  requireThat(workspace.owner === 'none', 'resource_busy', 'Provisioning workspace has an owner');
  requireThat(
    workspace.source && realpathSync(workspace.source) === workspace.source,
    'scope_violation',
    'Workspace source changed',
  );
}

function stop(job: Job): void {
  job.cancelled = true;
  job.copying.abort();
  if (!job.child || !job.exited || job.stopping) return;
  job.stopping = terminate(
    job.child as ChildProcessWithoutNullStreams,
    job.exited,
    Date.now() + 5000,
  ).then((receipt) => (job.stop = receipt));
}

/** Launches bounded work without holding the dispatch loop or command transaction open. */
export function startWorkspaceProvisioning(ctx: ControlContext, workspaceId: string): void {
  const workspace = ctx.store.must<Workspace>('workspaces', workspaceId);
  // The user's own folder is never created, populated or removed.
  if (workspace.kind === 'in_place') return;
  let active = jobs.get(ctx);
  if (!active) jobs.set(ctx, (active = new Map()));
  const running = active.get(workspaceId);
  if (running) {
    if (workspace.provisioning?.cancel_requested || ctx.closing) stop(running);
    return;
  }
  if (workspace.provisioning?.state !== 'queued') return;
  if (workspace.provisioning.cancel_requested || ctx.closing) {
    record(ctx, workspaceId, { state: 'cancelled', finished_at: ctx.store.now() });
    return;
  }
  const job: Job = { cancelled: false, copying: new AbortController() };
  active.set(workspaceId, job);
  record(ctx, workspaceId, { state: 'running', started_at: ctx.store.now(), phase: 'resolve' });
  const check = () => {
    const current = ctx.store.must<Workspace>('workspaces', workspaceId);
    requireThat(
      !job.cancelled && !ctx.closing && !current.provisioning?.cancel_requested,
      'provisioning_cancelled',
      'Workspace provisioning cancelled',
    );
    assertReservation(ctx, current);
  };
  const ownChild = (child: ChildProcess): void => {
    job.child = child;
    job.stopping = undefined;
    job.exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => {
        if (!child.pid) resolve();
      });
    });
    let processIdentity;
    try {
      processIdentity = child.pid ? (ctx.readProcess(child.pid) ?? { pid: child.pid }) : undefined;
      record(ctx, workspaceId, { process_identity: processIdentity });
    } catch {
      // An unrecorded process cannot safely be recovered, so stop this owned child.
      stop(job);
    }
  };
  const git = async (cwd: string, args: string[], phase: string): Promise<string> => {
    check();
    record(ctx, workspaceId, { phase, progress: undefined });
    let lastProgress = 0;
    const result = await runGit(cwd, args, undefined, true, {
      before_spawn: check,
      // Our deadline stops the process group and records the transport-close evidence.
      timeout_ms: 0,
      max_buffer: 1024 * 1024,
      on_spawn: (child) => {
        ownChild(child);
        child.stderr?.on('data', (chunk: Buffer) => {
          if (Date.now() - lastProgress < 250 || ctx.closing) return;
          lastProgress = Date.now();
          const progress = chunk
            .toString()
            .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
            .slice(-512);
          record(ctx, workspaceId, { progress });
        });
        if (job.cancelled || ctx.closing) stop(job);
      },
    });
    if (job.stopping) await job.stopping;
    check();
    requireThat(
      result.exit_code === 0,
      'invalid_workspace',
      `Git workspace setup failed: ${(result.error ?? result.stderr.toString()).slice(0, 2048)}`,
    );
    return result.stdout.toString().trim();
  };
  let timer = setTimeout(() => {
    job.timedOut = true;
    stop(job);
  }, 120000);
  let work!: Promise<void>;
  work = (async () => {
    try {
      // Freeze the requested ref first; the worktree never follows a moving source HEAD.
      const commit = await git(
        workspace.source!,
        [
          'rev-parse',
          '--verify',
          '--end-of-options',
          `${workspace.provisioning!.base_ref}^{commit}`,
        ],
        'resolve',
      );
      const source = workspace.source!;
      let queue = worktreeAdds.get(ctx);
      if (!queue) worktreeAdds.set(ctx, (queue = new Map()));
      const added = (queue.get(source) ?? Promise.resolve())
        .catch(() => {})
        .then(() =>
          git(
            source,
            [
              'worktree',
              'add',
              // Windows git prunes the registration of a worktree at a path it cannot see, unless locked.
              ...(onWslAutomount(source)
                ? ['--lock', '--reason', 'Pantheon session worktree']
                : []),
              '--detach',
              workspace.path,
              commit,
            ],
            'worktree',
          ),
        );
      queue.set(source, added);
      await added;
      const head = await git(workspace.path, ['rev-parse', 'HEAD'], 'verify');
      requireThat(
        head === commit,
        'invalid_workspace',
        'Worktree commit differs from the frozen source',
      );
      check();
      if (workspace.provisioning!.checkpoint)
        await restoreCheckpoint(workspace.path, workspace.provisioning!.checkpoint);
      record(ctx, workspaceId, { phase: 'dependencies', progress: undefined });
      // Sessions can work without dependencies; failing here would keep the session from starting.
      let dependenciesSkipped: string | undefined;
      try {
        await copyDependencyFolders(workspace.source!, workspace.path, job.copying.signal);
      } catch (error) {
        dependenciesSkipped = (error instanceof Error ? error.message : String(error)).slice(
          0,
          512,
        );
      }
      check();
      const project = ctx.store.must<Project>('projects', workspace.project_id);
      const preparation = project.worktree;
      if (preparation) {
        record(ctx, workspaceId, { phase: 'copy', progress: undefined });
        for (const entry of preparation.copy_paths) {
          check();
          const from = path.resolve(source, entry),
            to = path.resolve(workspace.path, entry);
          requireThat(
            inside(source, resolvedPath(from)) && inside(workspace.path, resolvedPath(to)),
            'scope_violation',
            'Copy path escapes the project folder or worktree',
          );
          if (!existsSync(from)) continue;
          await mkdir(path.dirname(to), { recursive: true });
          await cp(from, to, {
            recursive: true,
            dereference: false,
            verbatimSymlinks: true,
            // Runs per file, so a stop does not wait for the whole tree.
            filter: () => {
              if (job.cancelled) check();
              return true;
            },
          });
        }
        check();
      }
      const command = workspace.provisioning!.command ?? preparation?.command;
      if (command) {
        record(ctx, workspaceId, { phase: 'prepare', output: '' });
        clearTimeout(timer);
        timer = setTimeout(() => {
          job.timedOut = true;
          stop(job);
        }, command.timeout_ms ?? 1200000);
        let output = '';
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          const child = spawn(command.argv[0]!, command.argv.slice(1), {
            cwd: workspace.path,
            env: { ...nativeEnvironment(), ...project.env },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
          });
          ownChild(child);
          const collect = (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-4000);
          };
          child.stdout.on('data', collect);
          child.stderr.on('data', collect);
          child.once('error', reject);
          child.once('close', resolve);
        });
        record(ctx, workspaceId, { output });
        if (job.stopping) await job.stopping;
        check();
        requireThat(
          exitCode === 0,
          'invalid_workspace',
          `Worktree preparation command failed (exit ${exitCode})`,
        );
      }
      check();
      ctx.store.transaction(() => {
        const current = ctx.store.must<Workspace>('workspaces', workspaceId);
        const next = ctx.store.update(
          'workspaces',
          {
            ...current,
            base_sha: current.base_sha ?? head,
            provisioning: {
              ...current.provisioning!,
              state: 'ready' as const,
              phase: 'complete',
              process_identity: undefined,
              finished_at: ctx.store.now(),
            },
          },
          current.revision,
        );
        ctx.store.event('workspace.ready', next, next.project_id, { base_sha: next.base_sha });
        if (dependenciesSkipped !== undefined)
          ctx.store.event('workspace.dependencies_skipped', next, next.project_id, {
            reason: dependenciesSkipped,
          });
        for (const session of workbenchSessions(ctx, next))
          for (const turn of workbenchTurns(ctx, session))
            if (turn.state === 'queued') ctx.store.enqueue('session.turn', { turn_id: turn.id });
      });
      ctx.changed();
    } catch (error) {
      if (job.stopping) await job.stopping;
      record(ctx, workspaceId, {
        state: job.cancelled
          ? job.stop && !job.stop.stopped
            ? 'reconciling'
            : job.timedOut
              ? 'failed'
              : 'cancelled'
          : 'failed',
        error: job.timedOut
          ? 'Workspace provisioning deadline exceeded'
          : String(error).slice(0, 2048),
        stop: job.stop,
        finished_at: ctx.store.now(),
        ...(job.stop?.stopped ? { process_identity: undefined } : {}),
      });
    } finally {
      clearTimeout(timer);
      active.delete(workspaceId);
      ctx.completions.delete(work);
    }
  })();
  ctx.completions.add(work);
}

export function stopWorkspaceProvisioning(ctx: ControlContext): void {
  for (const job of jobs.get(ctx)?.values() ?? []) stop(job);
}

/** Never restart into a partially populated directory or assume missing leader means stopped descendants. */
export function recoverWorkspaceProvisioning(ctx: ControlContext): void {
  for (const workspace of ctx.store.list<Workspace>('workspaces')) {
    const provisioning = workspace.provisioning;
    if (!provisioning) continue;
    if (provisioning.state === 'queued') {
      ctx.store.enqueue('workspace.provision', { workspace_id: workspace.id });
      continue;
    }
    if (!['running', 'reconciling'].includes(provisioning.state)) continue;
    const pid = provisioning.process_identity?.pid;
    let groupAbsent = false;
    if (pid && Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        groupAbsent = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    // Before recovery the spawner may still look busy with a turn the restart ends; recovery tells it.
    record(
      ctx,
      workspace.id,
      {
        state: groupAbsent ? 'failed' : 'reconciling',
        error: groupAbsent
          ? 'Provisioning interrupted; original process group is absent. Partial files preserved; detached descendants are unverified.'
          : 'Provisioning interrupted; process termination is unconfirmed. Partial files preserved.',
      },
      false,
    );
  }
}
