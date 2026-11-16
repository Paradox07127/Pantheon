import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DomainError,
  requireThat,
  type Principal,
  type Session,
  type SessionTurn,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, type SessionTurnDiff } from '@pantheon/protocol';
import { numstatFiles, PATCH_BOUND, TIME_BOUND } from './source-git.js';
import {
  projectAccess,
  revision,
  sessionAdapter,
  type ControlContext,
  type Handlers,
} from './context.js';
import { runGit } from './git.js';
import { nativeTurnActive, releaseIdleConversation, withoutNativeConversation } from './session.js';
import { workspaceReadAccess } from './workspace.js';

export const CHECKPOINTS = 'refs/pantheon/checkpoints';

export const checkpointRef = (workspace: Workspace, sessionId: string, turnId: string) =>
  `${CHECKPOINTS}/${workspace.id}/${sessionId}/${turnId}`;

/** The session's git worktree, or undefined when it has none. */
export function gitWorkspace(ctx: ControlContext, session: Session): Workspace | undefined {
  if (!session.workspace_id) return;
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id);
  // The user's own folder gets no hidden refs and no rollback.
  return workspace.kind === 'linked_worktree' ? workspace : undefined;
}

/** The user's global excludes file, when there is one. */
export function globalExcludesFile(): string | undefined {
  const configured = spawnSync(
    'git',
    ['config', '--global', '--path', '--get', 'core.excludesFile'],
    { encoding: 'utf8' },
  );
  const file =
    configured.status === 0 && configured.stdout.trim()
      ? configured.stdout.trim()
      : process.env.XDG_CONFIG_HOME
        ? path.join(process.env.XDG_CONFIG_HOME, 'git/ignore')
        : path.join(os.homedir(), '.config/git/ignore');
  return existsSync(file) ? file : undefined;
}

/** `-c` arguments that apply the user's global excludes file, which runGit's environment hides. */
export function globalExcludes(): string[] {
  const file = globalExcludesFile();
  return file ? ['-c', `core.excludesFile=${file}`] : [];
}

const attachedHead = () =>
  new DomainError(
    'worktree_head_attached',
    'Worktree HEAD is on a branch; checkpoints only work on a detached HEAD',
  );

/**
 * Stores the worktree's files, without ignored ones, as a commit on HEAD under the turn's
 * checkpoint ref; the real index and HEAD stay as they are. A failure is recorded, not thrown.
 */
export async function captureCheckpoint(
  ctx: ControlContext,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const workspace = gitWorkspace(ctx, ctx.store.must<Session>('sessions', sessionId));
  if (!workspace) return;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-checkpoint-'));
  const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
  const git = async (args: string[]): Promise<string> => {
    const result = await runGit(workspace.path, args, undefined, true, { env });
    if (result.exit_code !== 0)
      throw new Error(`git ${args[0]}: ${result.stderr.toString().trim() || result.error}`);
    return result.stdout.toString().trim();
  };
  try {
    const attached = await runGit(workspace.path, ['symbolic-ref', '-q', 'HEAD'], undefined, true);
    if (attached.exit_code === 0) throw attachedHead();
    const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
    await git(['read-tree', head]);
    await git([...globalExcludes(), 'add', '-A']);
    const tree = await git(['write-tree']);
    const commit = await git([
      'commit-tree',
      tree,
      '-p',
      head,
      '-m',
      `Pantheon checkpoint before turn ${turnId}`,
    ]);
    await git(['update-ref', checkpointRef(workspace, sessionId, turnId), commit]);
  } catch (error) {
    ctx.store.transaction(() => {
      const session = ctx.store.must<Session>('sessions', sessionId);
      ctx.store.event('session.checkpoint_failed', session, session.project_id, {
        turn_id: turnId,
        error: String(error),
      });
    });
    ctx.changed();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * By session, the newest turn of the project whose files session.rollback restores: one that ran
 * with its checkpoint stored, not rolled back, and queued after the session's newest merge.
 */
export function restorableTurns(ctx: ControlContext, projectId: string): Map<string, string> {
  const events = (kind: string, field: string) =>
    ctx.store.db
      .prepare(
        `SELECT ${field} AS value, sequence FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind=? ORDER BY sequence`,
      )
      .all(projectId, kind) as { value: string; sequence: number }[];
  const merged = new Map(
    events('session.merged', 'aggregate_id').map((event) => [event.value, event.sequence]),
  );
  const failed = new Set(
    events('session.checkpoint_failed', "payload->>'$.turn_id'").map((event) => event.value),
  );
  const ran = new Set(events('turn.running', 'aggregate_id').map((event) => event.value));
  const queued = ctx.store.db
    .prepare(
      "SELECT t.id, t.data->>'$.session_id' AS session_id, t.data->>'$.kind' AS kind, t.data->>'$.origin' AS origin, t.data->>'$.rolled_back' AS rolled_back, e.sequence FROM events e INDEXED BY events_project_kind JOIN session_turns t ON t.id=e.aggregate_id WHERE e.project_id=? AND e.kind='turn.queued' ORDER BY e.sequence",
    )
    .all(projectId) as {
    id: string;
    session_id: string;
    kind: SessionTurn['kind'];
    origin: SessionTurn['origin'] | null;
    rolled_back: number | null;
    sequence: number;
  }[];
  const restorable = new Map<string, string>();
  for (const turn of queued)
    // Compaction and reflection turns take no checkpoint; a steer injected into a running turn never runs.
    if (
      ran.has(turn.id) &&
      !failed.has(turn.id) &&
      !turn.rolled_back &&
      turn.origin !== 'compaction' &&
      turn.origin !== 'reflection' &&
      turn.sequence > (merged.get(turn.session_id) ?? 0)
    )
      restorable.set(turn.session_id, turn.id);
  return restorable;
}

/** Freezes a fork's files and HEAD under its own ref without changing the source index. */
export function forkCheckpoint(workspace: Workspace, ref: string, checkpoint?: string): void {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-checkpoint-'));
  const git = (args: string[]): string => {
    const result = runGit(workspace.path, args, undefined, false, {
      env: { GIT_INDEX_FILE: path.join(directory, 'index') },
    });
    requireThat(
      result.exit_code === 0,
      'invalid_workspace',
      `Git ${args[0]} failed: ${result.stderr.toString().slice(0, 2048)}`,
    );
    return result.stdout.toString().trim();
  };
  try {
    if (!checkpoint) {
      const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
      git(['read-tree', head]);
      git([...globalExcludes(), 'add', '-A']);
      const tree = git(['write-tree']);
      checkpoint = git(['commit-tree', tree, '-p', head, '-m', 'Pantheon session fork']);
    }
    git(['update-ref', ref, checkpoint]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * What changed from the turn's checkpoint to the checkpoint of the next turn that has one, or to
 * the worktree's files without ignored ones when no later turn has a checkpoint.
 */
export async function readTurnDiff(
  ctx: ControlContext,
  principal: Principal,
  sessionId: string,
  turnId: string,
): Promise<SessionTurnDiff> {
  const session = ctx.store.must<Session>('sessions', sessionId);
  const workspace = gitWorkspace(ctx, session);
  requireThat(workspace, 'invalid_state', 'Only a git worktree session has turn checkpoints');
  const { authorize, git: run } = workspaceReadAccess(ctx, principal, workspace);
  if (!run)
    throw new DomainError(
      'workspace_unavailable',
      'Workspace directory is missing or not a Git repository',
    );
  const failed = (): never => {
    throw new DomainError('workspace_read_failed', 'Turn diff failed or exceeded its time bound');
  };
  const small = { max_buffer: 4096, timeout_ms: TIME_BOUND };
  const checkpoint = async (turn: SessionTurn) => {
    const found = await run(
      [
        'rev-parse',
        '--verify',
        '--quiet',
        `${checkpointRef(workspace, session.id, turn.id)}^{tree}`,
      ],
      small,
    );
    if (found.exit_code !== 0 && found.exit_code !== 1) failed();
    return found.exit_code === 0 ? found.stdout.toString().trim() : undefined;
  };
  // The turn id becomes part of a git revision, so only the session's own turns are looked up.
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((t) => t.session_id === session.id);
  const index = turns.findIndex((t) => t.id === turnId);
  const from = index === -1 ? undefined : await checkpoint(turns[index]!);
  if (!from) throw new DomainError('checkpoint_missing', 'This turn has no checkpoint');
  let to: string | undefined;
  for (const later of turns.slice(index + 1)) if ((to = await checkpoint(later))) break;
  if (!to) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-turn-diff-'));
    const env = { GIT_INDEX_FILE: path.join(directory, 'index') };
    const git = async (args: string[]) => {
      const result = await runGit(workspace.path, args, undefined, true, {
        ...small,
        env,
        before_spawn: authorize,
      });
      if (result.exit_code !== 0) failed();
      return result.stdout.toString().trim();
    };
    try {
      await git(['read-tree', 'HEAD']);
      await git([...globalExcludes(), 'add', '-A']);
      to = await git(['write-tree']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const range = ['--find-renames', from, to, '--'];
  const numstat = await run(['diff', '--numstat', '-z', ...range], {
    max_buffer: 4 * PATCH_BOUND,
    timeout_ms: TIME_BOUND,
  });
  if (numstat.exit_code !== 0) failed();
  const patch = await run(['diff', ...range], { max_buffer: PATCH_BOUND, timeout_ms: TIME_BOUND });
  const truncated =
    patch.exit_code !== 0 && /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/.test(patch.error ?? '');
  if (patch.exit_code !== 0 && !truncated) failed();
  return {
    session_id: session.id,
    turn_id: turnId,
    files: numstatFiles(numstat.stdout).map((file) => ({ ...file, untracked: false })),
    patch: truncated ? null : patch.stdout.toString(),
    truncated,
  };
}

/**
 * Makes the worktree files equal the checkpoint's tree, deleting files outside it except ignored
 * ones, then moves the detached HEAD to the checkpoint's parent with the index equal to it.
 * Refuses a HEAD on a branch before changing anything.
 */
export function restoreCheckpoint(worktree: string, checkpoint: string): string {
  const git = (args: string[], input?: Buffer, exitCodes: (number | null)[] = [0]): string => {
    const result = runGit(worktree, args, input);
    requireThat(
      exitCodes.includes(result.exit_code),
      'invalid_workspace',
      `Git ${args[0]} failed: ${result.stderr.toString().slice(0, 2048)}`,
    );
    return result.stdout.toString();
  };
  const paths = (output: string) => output.split('\0').filter(Boolean);
  // symbolic-ref exits 1 for a detached HEAD.
  if (git(['symbolic-ref', '-q', 'HEAD'], undefined, [0, 1])) throw attachedHead();
  const head = git(['rev-parse', '--verify', `${checkpoint}^`]).trim();
  // Listed before read-tree brings back the checkpoint's .gitignore, so today's rules apply.
  const inCheckpoint = new Set(paths(git(['ls-tree', '-r', '-z', '--name-only', checkpoint])));
  const outside = [
    ...paths(git(['ls-files', '-z'])),
    ...paths(git([...globalExcludes(), 'ls-files', '-z', '--others', '--exclude-standard'])),
  ].filter((file) => !inCheckpoint.has(file));
  git(['read-tree', '--reset', '-u', checkpoint]);
  // check-ignore exits 1 when none of the files is ignored by the checkpoint's rules.
  const ignoredThen = new Set(
    outside.length
      ? paths(
          git(
            [...globalExcludes(), 'check-ignore', '-z', '--stdin'],
            Buffer.from(outside.map((file) => `${file}\0`).join('')),
            [0, 1],
          ),
        )
      : [],
  );
  for (const file of outside) {
    if (ignoredThen.has(file)) continue;
    rmSync(path.join(worktree, file), { force: true });
    for (
      let directory = path.dirname(path.join(worktree, file));
      directory !== worktree && existsSync(directory) && !readdirSync(directory).length;
      directory = path.dirname(directory)
    )
      rmdirSync(directory);
  }
  // --no-deref detaches HEAD even if it was put on a branch since the check, so no branch moves.
  git(['update-ref', '--no-deref', 'HEAD', head]);
  git(['read-tree', '--reset', head]);
  git(['update-index', '-q', '--refresh'], undefined, [0, 1]);
  return head;
}

/**
 * The conversation goes back to before `turnId`: that turn and the later ones are marked rolled
 * back, and the next input forks the native history at the end of the turn before it, or, without
 * such a fork point, starts a fresh native conversation with the record before that turn.
 */
function rollBackConversation(ctx: ControlContext, session: Session, turnId: string): Session {
  const turns = ctx.store
    .list<SessionTurn>('session_turns')
    .filter((turn) => turn.session_id === session.id);
  const at = turns.findIndex((turn) => turn.id === turnId);
  for (const later of turns.slice(at))
    if (!later.rolled_back)
      ctx.store.update('session_turns', { ...later, rolled_back: true }, later.revision);
  const before = turns.slice(0, at).findLast((turn) => !turn.rolled_back);
  const native =
    sessionAdapter(ctx, session)?.report.capabilities.conversation_rollback?.status === 'supported';
  // A turn with a handoff opened a new native conversation, so earlier fork points are not in it.
  const sameConversation =
    before && !turns.slice(turns.indexOf(before) + 1).some((turn) => turn.handoff !== undefined);
  return native && session.native_id && before?.native_history_end && sameConversation
    ? {
        ...session,
        native_fork: { session_id: session.native_id, after: before.native_history_end },
      }
    : { ...withoutNativeConversation(ctx, session), handoff_before_turn_id: turnId };
}

/** Records the session's pending rollback as done, with the conversation unless it restored files only. */
export function finishRollback(
  ctx: ControlContext,
  session: Session,
  head: string,
  cause?: string,
): Session {
  const { turn_id: turnId, scope = 'both' } = session.rollback_pending!;
  const kept = { ...session, rollback_pending: undefined };
  const next = ctx.store.update(
    'sessions',
    scope === 'files' ? kept : rollBackConversation(ctx, kept, turnId),
    session.revision,
  );
  ctx.store.event(
    'session.rolled_back',
    next,
    next.project_id,
    { turn_id: turnId, head, ...(scope === 'files' ? { scope } : {}) },
    cause,
  );
  return next;
}

/** Commits fn by itself from inside a command's open transaction, which goes on afterwards. */
function commitApart<T>(ctx: ControlContext, fn: () => T): T {
  // The command has only read so far, so committing its transaction here writes nothing of it.
  ctx.store.db.exec('COMMIT');
  try {
    return ctx.store.transaction(fn);
  } finally {
    ctx.store.db.exec('BEGIN IMMEDIATE');
  }
}

/** Deletes the checkpoint refs of the workspace's sessions from the repository that outlives it. */
export function deleteCheckpoints(workspace: Workspace): void {
  const listed = runGit(workspace.source!, [
    'for-each-ref',
    '--format=%(refname)',
    `${CHECKPOINTS}/${workspace.id}/`,
  ]);
  requireThat(
    listed.exit_code === 0,
    'invalid_workspace',
    `Git could not list checkpoint refs: ${listed.stderr.toString().slice(0, 2048)}`,
  );
  const refs = listed.stdout.toString().split('\n').filter(Boolean);
  if (!refs.length) return;
  const deleted = runGit(
    workspace.source!,
    ['update-ref', '--stdin'],
    Buffer.from(refs.map((ref) => `delete ${ref}\n`).join('')),
  );
  requireThat(
    deleted.exit_code === 0,
    'invalid_workspace',
    `Git could not delete checkpoint refs: ${deleted.stderr.toString().slice(0, 2048)}`,
  );
}

export const checkpointHandlers: Handlers = {
  'session.rollback': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can roll back a session');
    const input = inputSchemas['session.rollback'].parse(c.input),
      session = ctx.store.must<Session>('sessions', input.session_id);
    projectAccess(ctx, p, session.project_id, c.type);
    revision(ctx, c, session);
    requireThat(!session.outcome, 'invalid_state', `Session was ${session.outcome}`);
    requireThat(session.merge?.state !== 'running', 'invalid_state', 'Session is being merged');
    requireThat(
      session.state === 'open' && !session.stop_pending,
      'invalid_state',
      `Session is ${session.stop_pending ? 'stopping' : session.state}`,
    );
    // Absent is both: the files and the conversation go back to before the turn.
    const scope = input.scope ?? 'both';
    // The turn id becomes part of a git revision, so only the session's own turns are looked up.
    const turn = ctx.store.get<SessionTurn>('session_turns', input.turn_id);
    requireThat(turn?.session_id === session.id, 'invalid_state', 'Turn has no checkpoint');
    // An idle native process writes nothing, so the files are restored while it closes.
    const idle = ctx.idleConversations.has(session.id);
    requireThat(
      idle || !nativeTurnActive(ctx, session),
      'invalid_state',
      'Session still has a native process; retry once it has closed',
    );
    if (scope === 'conversation') {
      if (idle) releaseIdleConversation(ctx, session);
      const next = ctx.store.update(
        'sessions',
        rollBackConversation(ctx, session, turn.id),
        session.revision,
      );
      ctx.store.event(
        'session.rolled_back',
        next,
        next.project_id,
        { turn_id: turn.id, scope },
        c.command_id,
      );
      return next;
    }
    const workspace = gitWorkspace(ctx, session);
    requireThat(workspace, 'invalid_state', 'Only a git worktree session can restore files');
    // Checked before the intent is stored, so a refusal leaves nothing for recovery to finish.
    if (runGit(workspace.path, ['symbolic-ref', '-q', 'HEAD']).exit_code === 0)
      throw attachedHead();
    // A lead's merged direct task is on the source branch; its earlier commits are not the worktree's base.
    const merged = ctx.store.db
      .prepare(
        "SELECT max(sequence) AS sequence FROM events WHERE aggregate_id=? AND kind='session.merged'",
      )
      .get(session.id) as { sequence: number | null };
    const queued = ctx.store.db
      .prepare('SELECT min(sequence) AS sequence FROM events WHERE aggregate_id=?')
      .get(input.turn_id) as { sequence: number | null };
    requireThat(
      merged.sequence === null || (queued.sequence ?? 0) > merged.sequence,
      'invalid_state',
      'The turn started before the last merge of this session, whose changes are on the source branch now; roll back only to a turn after it',
    );
    if (idle) releaseIdleConversation(ctx, session);
    const found = runGit(workspace.path, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${checkpointRef(workspace, session.id, turn.id)}^{commit}`,
    ]);
    requireThat(found.exit_code === 0, 'invalid_state', 'Turn has no checkpoint');
    const checkpoint = found.stdout.toString().trim();
    // Kept when the command fails after the files moved, so recover can finish the rollback.
    const pending = commitApart(ctx, () =>
      ctx.store.update(
        'sessions',
        {
          ...session,
          rollback_pending: {
            checkpoint,
            turn_id: input.turn_id,
            ...(scope === 'files' ? { scope } : {}),
          },
        },
        session.revision,
      ),
    );
    const head = restoreCheckpoint(workspace.path, checkpoint);
    ctx.failpoint('after_rollback_restore_before_record');
    return finishRollback(ctx, pending, head, c.command_id);
  },
};
