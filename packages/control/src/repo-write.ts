import { execFile } from 'node:child_process';
import {
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { nativeEnvironment } from '@pantheon/adapters';
import {
  DomainError,
  id,
  NATIVE_ENV_ALLOWLIST,
  requireThat,
  type Principal,
  type Project,
  type Session,
} from '@pantheon/domain';
import {
  inputSchemas,
  type Command,
  type RepoWorkingDiff,
  type RepoWorkingDiffFile,
} from '@pantheon/protocol';
import { inside, revision, userOnly, type ControlContext, type Handler } from './context.js';
import { runGit } from './git.js';
import { BOUND, commitOf, git, projectRoot, relativeFile } from './repo.js';
import { numstatFiles, PATCH_BOUND } from './source-git.js';

const UNDO_MS = 10 * 60 * 1000;
const COMMIT_TIMEOUT_MS = 120000;
// Paths name files, never pathspec patterns.
const LITERAL = '--literal-pathspecs';
// The user's diff config may color, convert, prefix or relativize output that parsePatch and git apply read back.
const PLAIN_DIFF = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/** A file as a discard found it: a copy of its bytes and its mode, its link target, or neither when it was absent. */
interface SavedFile {
  path: string;
  copy?: string;
  mode?: number;
  link?: string;
}
/** Saved files and the folder that holds their copies. */
interface SavedFiles {
  backup: string;
  files: SavedFile[];
}
/** The index entries of some paths as `git ls-files -s` prints them, the paths that had none, and each entry's flags. */
interface SavedIndex {
  entries: string[];
  absent: string[];
  flags: Map<string, number>;
}
interface Undo {
  project_id: string;
  root: string;
  files: SavedFile[];
  backup: string;
  index?: SavedIndex;
  expires_at: number;
  timer: NodeJS.Timeout;
}
/** By undo id; held in memory only. */
const undos = new Map<string, Undo>();

// Bits of the flags `git ls-files --debug` prints for an index entry.
const ASSUME_UNCHANGED = 0x8000,
  INTENT_TO_ADD = 0x20000000,
  SKIP_WORKTREE = 0x40000000;

const listed = (output: string) => output.split('\0').filter(Boolean);
const entryPath = (entry: string) => entry.slice(entry.indexOf('\t') + 1);

async function saved(
  root: string,
  backup: string,
  file: string,
  index: number,
): Promise<SavedFile> {
  const target = path.join(root, file);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return { path: file };
  if (stat.isSymbolicLink()) return { path: file, link: readlinkSync(target) };
  const copy = path.join(backup, String(index));
  // Off the event loop and never whole in memory; a clone where the filesystem makes one.
  await copyFile(target, copy, constants.COPYFILE_FICLONE);
  return { path: file, copy, mode: stat.mode & 0o7777 };
}

/** Discard backups sit beside the artifacts directory, in the daemon's data directory. */
function backupsDirectory(ctx: ControlContext): string {
  return path.join(path.dirname(ctx.files.directory), 'discard-backups');
}

/** Removes the backups a stopped daemon left, since the undos that held them were only in its memory. */
export function recoverDiscardBackups(ctx: ControlContext): void {
  const directory = backupsDirectory(ctx);
  // A Control made again in the same process finds the records of the one before.
  for (const [undoId, undo] of undos) if (inside(directory, undo.backup)) forget(undoId);
  rmSync(directory, { recursive: true, force: true });
}

/** Saves the files into a new backup folder, removed again when saving fails. */
async function savedFiles(ctx: ControlContext, root: string, files: string[]): Promise<SavedFiles> {
  const directory = backupsDirectory(ctx);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backup = mkdtempSync(path.join(directory, 'discard-'));
  try {
    return {
      backup,
      files: await Promise.all(files.map((file, index) => saved(root, backup, file, index))),
    };
  } catch (error) {
    rmSync(backup, { recursive: true, force: true });
    throw error;
  }
}

async function writeBack(root: string, file: SavedFile): Promise<void> {
  const target = path.join(root, file.path);
  rmSync(target, { force: true });
  if (file.link === undefined && !file.copy) return;
  mkdirSync(path.dirname(target), { recursive: true });
  if (file.link !== undefined) symlinkSync(file.link, target);
  else {
    await copyFile(file.copy!, target, constants.COPYFILE_FICLONE);
    chmodSync(target, file.mode!);
  }
}

/** Refuses a file whose folders below the root are no longer real folders, as when one was replaced by a symlink. */
function checkedParents(root: string, file: string): void {
  let parent = root;
  for (const part of file.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    // writeBack makes a missing folder and the ones below it again.
    if (!stat) return;
    requireThat(
      stat.isDirectory(),
      'invalid_state',
      `${path.relative(root, parent)} is no longer a folder in the project`,
    );
  }
}

/** Writes saved files and index entries back once every file's folders are checked. */
async function restore(root: string, files: SavedFile[], index?: SavedIndex): Promise<void> {
  for (const file of files) checkedParents(root, file.path);
  for (const file of files) {
    // Again, since writing the file before let other work run.
    checkedParents(root, file.path);
    await writeBack(root, file);
  }
  if (index) await restoreIndex(root, index);
}

async function savedIndex(root: string, paths: string[]): Promise<SavedIndex> {
  const output = await git(root, [LITERAL, 'ls-files', '-s', '--debug', '-z', '--', ...paths]);
  const entries: string[] = [],
    flags = new Map<string, number>();
  // Each entry is `<mode> <object> <stage>\t<path>`, then lines about it that end with its flags in hex.
  for (const [, entry, hex] of output.matchAll(/([^\0]*)\0[^\0]*?\tflags: ([0-9a-f]+)\n/g)) {
    entries.push(entry!);
    flags.set(entryPath(entry!), parseInt(hex!, 16));
  }
  return { entries, absent: paths.filter((file) => !flags.has(file)), flags };
}

async function restoreIndex(root: string, index: SavedIndex): Promise<void> {
  const flagged = (flag: number) =>
    [...index.flags].filter(([, flags]) => flags & flag).map(([file]) => file);
  // `add -N` marks an intent to add again, and only with the file in the worktree.
  const intended = new Set(
    flagged(INTENT_TO_ADD).filter((file) =>
      lstatSync(path.join(root, file), { throwIfNoEntry: false }),
    ),
  );
  // A mode 0 entry first drops every stage of its path, so a conflict's stages do not join a stage 0 entry.
  const dropped = new Map(
    index.entries.map((entry) => {
      const file = entry.slice(entry.indexOf('\t') + 1);
      return [file, `0 ${'0'.repeat(entry.split(' ')[1]!.length)}\t${file}\0`] as const;
    }),
  );
  const kept = index.entries.filter((entry) => !intended.has(entryPath(entry)));
  const steps: [string[], Buffer?][] = [
    [
      ['update-index', '-z', '--index-info'],
      Buffer.from([...dropped.values(), ...kept.map((entry) => `${entry}\0`)].join('')),
    ],
  ];
  if (index.absent.length) steps.push([['update-index', '--force-remove', '--', ...index.absent]]);
  if (intended.size)
    steps.push([[LITERAL, 'add', '--intent-to-add', '--force', '--', ...intended]]);
  for (const [flag, option] of [
    [ASSUME_UNCHANGED, '--assume-unchanged'],
    [SKIP_WORKTREE, '--skip-worktree'],
  ] as const) {
    const files = flagged(flag);
    if (files.length) steps.push([['update-index', option, '--', ...files]]);
  }
  for (const [args, input] of steps) {
    const result = await runGit(root, args, input, true, BOUND);
    requireThat(
      result.exit_code === 0,
      'workspace_read_failed',
      result.error ?? result.stderr.toString(),
    );
  }
}

/** Records the event that has clients read the repository queries again, then returns the receipt. */
const changed =
  (projectId: string, receipt: unknown): Handler =>
  (ctx, _p, c) => {
    ctx.store.event(
      'workspace.repository_changed',
      ctx.store.must<Project>('projects', projectId),
      projectId,
      {},
      c.command_id,
    );
    return receipt;
  };

/** Keeps the saved files, and the index entries a discard reset, for an undo once it succeeded. */
function remembered(
  ctx: ControlContext,
  projectId: string,
  root: string,
  { backup, files }: SavedFiles,
  index?: SavedIndex,
) {
  const undo_id = id();
  const timer = setTimeout(() => forget(undo_id), UNDO_MS).unref();
  undos.set(undo_id, {
    project_id: projectId,
    root,
    files,
    backup,
    index,
    expires_at: ctx.store.now() + UNDO_MS,
    timer,
  });
  return { undo_id };
}

function forget(undoId: string): void {
  const undo = undos.get(undoId)!;
  clearTimeout(undo.timer);
  rmSync(undo.backup, { recursive: true, force: true });
  undos.delete(undoId);
}

async function discard(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  const input = inputSchemas['repo.discard'].parse(c.input);
  const root = projectRoot(ctx, p, input.project_id),
    paths = input.paths.map(relativeFile);
  const [indexed, committed, untracked] = await Promise.all([
    git(root, [LITERAL, 'ls-files', '-z', '--', ...paths]),
    git(root, [LITERAL, 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths]),
    git(root, [LITERAL, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...paths]),
  ]);
  const tracked = [...new Set([...listed(indexed), ...listed(committed)])],
    removed = listed(untracked);
  const index = await savedIndex(root, paths);
  const files = await savedFiles(ctx, root, [...tracked, ...removed]);
  let removing = 0;
  try {
    if (tracked.length) {
      // The user's git, so filters such as git-lfs write the real content back.
      const restored = await userGit(root, [
        'restore',
        '--source=HEAD',
        '--staged',
        '--worktree',
        '--',
        ...tracked,
      ]);
      requireThat(restored.ok, 'workspace_read_failed', restored.output || 'git restore failed');
    }
    for (; removing < removed.length; removing++)
      rmSync(path.join(root, removed[removing]!), { force: true });
  } catch (error) {
    // Puts back what the discard changed before it stopped.
    await restore(root, files.files.slice(0, tracked.length + removing), index);
    rmSync(files.backup, { recursive: true, force: true });
    throw error;
  }
  return changed(input.project_id, remembered(ctx, input.project_id, root, files, index));
}

/** Old and new paths of `git apply --numstat -z` output. */
function patchedPaths(output: Buffer): string[] {
  const tokens = output.toString().split('\0'),
    paths: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const record = tokens[index]!;
    const counted = record.indexOf('\t', record.indexOf('\t') + 1);
    if (counted < 0) continue;
    // The path is the rest of the record after the two counts, tabs and all.
    const name = record.slice(counted + 1);
    // A rename leaves the path empty and is followed by the old and the new path.
    if (name) paths.push(name);
    else paths.push(tokens[++index]!, tokens[++index]!);
  }
  return [...new Set(paths)];
}

async function discardPatch(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  const input = inputSchemas['repo.discard_patch'].parse(c.input);
  const root = projectRoot(ctx, p, input.project_id),
    patch = Buffer.from(input.patch);
  const failed = (result: UserGitResult) =>
    new DomainError('patch_failed', result.output || 'git apply failed');
  const counted = await userGit(root, ['apply', '-R', '--numstat', '-z', '-'], patch);
  if (!counted.ok) throw failed(counted);
  const paths = patchedPaths(counted.stdout).map(relativeFile);
  // The patch is against HEAD, so it would leave staged lines in the index.
  const staged = await runGit(
    root,
    [LITERAL, 'diff', '--cached', '--quiet', '--', ...paths],
    undefined,
    true,
    BOUND,
  );
  if (staged.exit_code === 1)
    throw new DomainError(
      'staged_changes',
      `Staged changes in ${paths.join(', ')}; discard the whole file`,
    );
  requireThat(
    staged.exit_code === 0,
    'workspace_read_failed',
    staged.error ?? staged.stderr.toString(),
  );
  const files = await savedFiles(ctx, root, paths);
  const applied = await userGit(root, ['apply', '-R', '-'], patch);
  if (!applied.ok) {
    rmSync(files.backup, { recursive: true, force: true });
    throw failed(applied);
  }
  return changed(input.project_id, remembered(ctx, input.project_id, root, files));
}

async function discardUndo(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  const input = inputSchemas['repo.discard_undo'].parse(c.input);
  const root = projectRoot(ctx, p, input.project_id),
    undo = undos.get(input.undo_id);
  requireThat(
    undo &&
      undo.project_id === input.project_id &&
      undo.root === root &&
      undo.expires_at > ctx.store.now(),
    'undo_expired',
    'The discard can no longer be undone',
  );
  // Expiring during the restore would remove the backup it copies from.
  clearTimeout(undo.timer);
  try {
    await restore(root, undo.files, undo.index);
  } catch (error) {
    // Kept, so that an undo that failed can be tried again.
    undo.timer = setTimeout(() => forget(input.undo_id), undo.expires_at - ctx.store.now()).unref();
    throw error;
  }
  forget(input.undo_id);
  return changed(input.project_id, {});
}

/** A run of userGit; `code` is the exit code, or the error code when git did not exit on its own. */
interface UserGitResult {
  ok: boolean;
  code: number | string | null;
  stdout: Buffer;
  output: string;
}

/** Git as the user runs it: their environment, configuration, identity, filters and hooks. */
function userGit(
  root: string,
  args: string[],
  input?: Buffer,
  maxBuffer = 4 * PATCH_BOUND,
  env: NodeJS.ProcessEnv = {},
): Promise<UserGitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [LITERAL, ...args],
      {
        cwd: root,
        // Signing and hooks may need the user's ssh and gpg agents.
        env: {
          ...nativeEnvironment([...NATIVE_ENV_ALLOWLIST, 'SSH_AUTH_SOCK', 'GNUPGHOME', 'GPG_TTY']),
          ...env,
        },
        encoding: 'buffer',
        timeout: COMMIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer,
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          code: error ? (error.code ?? null) : 0,
          stdout,
          output: [
            stdout.toString(),
            stderr.toString(),
            error && !stderr.length ? error.message : '',
          ]
            .filter(Boolean)
            .join('\n')
            .trim(),
        }),
    );
    // A git that exits before reading its input breaks the pipe; its exit reports the failure.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** Reads through the user's git, as `git` in repo.ts does through Pantheon's. */
async function userRead(root: string, args: string[]): Promise<string> {
  const result = await userGit(root, args);
  requireThat(result.ok, 'workspace_read_failed', result.output);
  return result.stdout.toString();
}

async function commit(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  const input = inputSchemas['repo.commit'].parse(c.input);
  const root = projectRoot(ctx, p, input.project_id),
    paths = input.paths.map(relativeFile);
  const index = await savedIndex(root, paths);
  // `git add` refuses a path in neither the index nor the worktree, such as a rename's old path.
  const adding = paths.filter(
    (file) =>
      !index.absent.includes(file) || lstatSync(path.join(root, file), { throwIfNoEntry: false }),
  );
  for (const args of [
    ...(adding.length ? [['add', '--', ...adding]] : []),
    ['commit', '--only', '-m', input.message, '--', ...paths],
  ]) {
    const result = await userGit(root, args);
    if (result.ok) continue;
    // Git leaves what `git add` staged in the index when the commit fails.
    await restoreIndex(root, index);
    throw new DomainError('commit_failed', result.output || `git ${args[0]} failed`);
  }
  const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  return changed(input.project_id, { sha });
}

/** Reads through the user's git, which exits 1 for nothing, as `config --get` and `symbolic-ref -q` do. */
async function optional(root: string, args: string[]): Promise<string | null> {
  const result = await userGit(root, args);
  if (result.code === 1) return null;
  requireThat(result.ok, 'workspace_read_failed', result.output);
  return result.stdout.toString().trim();
}

async function push(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  const input = inputSchemas['repo.push'].parse(c.input);
  const root = projectRoot(ctx, p, input.project_id);
  const branch = await optional(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  requireThat(branch !== null, 'invalid_state', 'The checkout is not on a branch');
  const [remote, merge, remotes, sshCommand] = await Promise.all([
    optional(root, ['config', '--get', `branch.${branch}.remote`]),
    optional(root, ['config', '--get', `branch.${branch}.merge`]),
    userRead(root, ['remote']),
    optional(root, ['config', '--get', 'core.sshCommand']),
  ]);
  const upstream = remote !== null && merge !== null;
  requireThat(
    upstream || remotes.split('\n').includes('origin'),
    'no_remote',
    `${branch} has no upstream and the repository has no origin remote`,
  );
  // A full refspec pushes this branch alone, whatever push.default says.
  const args = upstream
    ? ['push', '--', remote, `refs/heads/${branch}:${merge}`]
    : ['push', '--set-upstream', '--', 'origin', `refs/heads/${branch}:refs/heads/${branch}`];
  // Fails at once where a password or host key would otherwise be asked for.
  const pushed = await userGit(root, args, undefined, undefined, {
    GIT_TERMINAL_PROMPT: '0',
    ...(process.env.GIT_SSH_COMMAND !== undefined
      ? { GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND }
      : sshCommand === null
        ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
        : {}),
  });
  if (!pushed.ok)
    throw new DomainError(
      /^ ! \[rejected\]/m.test(pushed.output) ? 'push_rejected' : 'push_failed',
      pushed.output || 'git push failed',
    );
  return changed(input.project_id, {});
}

/** Runs git steps through userGit, stopping at the first that fails. */
async function undone(root: string, steps: string[][]): Promise<void> {
  for (const args of steps) {
    const result = await userGit(root, args);
    requireThat(result.ok, 'workspace_read_failed', result.output);
  }
}

// The checkout had no tracked changes, so a hard reset takes back only what the revert did.
const UNDO_REVERT = [
  ['revert', '--quit'],
  ['reset', '--hard', '--quiet', 'HEAD'],
];

async function revert(ctx: ControlContext, p: Principal, c: Command): Promise<Handler> {
  const input = inputSchemas['repo.revert'].parse(c.input);
  const root = projectRoot(ctx, p, input.project_id);
  const sha = await commitOf(root, input.sha);
  const dirty = await userRead(root, ['status', '--porcelain', '--untracked-files=no']);
  requireThat(dirty === '', 'dirty_checkout', 'The checkout has uncommitted changes');
  const merge = ctx.store
    .kindEvents(input.project_id, ['session.merged'])
    .findLast((event) => (event.payload as { to_sha?: string }).to_sha === sha);
  const from = (merge?.payload as { from_sha?: string } | undefined)?.from_sha;
  const range = from ? `${from}..${sha}` : null;
  const reverted = await userGit(
    root,
    range ? ['revert', '--no-edit', '--no-commit', range] : ['revert', '--no-edit', sha],
  );
  if (!reverted.ok) {
    const conflicts = listed(await git(root, ['diff', '--name-only', '-z', '--diff-filter=U']));
    if (!conflicts.length) {
      await undone(root, UNDO_REVERT);
      throw new DomainError('revert_failed', reverted.output || 'git revert failed');
    }
    await undone(root, [['revert', '--abort']]);
    throw new DomainError('revert_conflict', `Reverting conflicts in ${conflicts.join(', ')}`);
  }
  if (range) {
    const session = ctx.store.must<Session>('sessions', merge!.aggregate_id);
    const title = session.title ?? session.native_title ?? session.id;
    const committed = await userGit(root, [
      'commit',
      '-m',
      `Revert "${title}"`,
      '-m',
      `This reverts ${range}.`,
    ]);
    if (!committed.ok) {
      await undone(root, UNDO_REVERT);
      throw new DomainError('commit_failed', committed.output || 'git commit failed');
    }
  }
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
  return changed(input.project_id, { sha: head });
}

const writes = {
  'repo.discard': discard,
  'repo.discard_patch': discardPatch,
  'repo.discard_undo': discardUndo,
  'repo.commit': commit,
  'repo.push': push,
  'repo.revert': revert,
};

export const isRepoWrite = (type: string): boolean => Object.hasOwn(writes, type);

/** The newest repository write of each project; the next one's git work starts once it settled. */
const running = new Map<string, Promise<unknown>>();

/**
 * Runs a repository write in the project's first folder after the project's earlier ones, since
 * each holds the index while it runs; the returned handler records it.
 */
export async function prepareRepoWrite(
  ctx: ControlContext,
  p: Principal,
  c: Command,
): Promise<Handler> {
  userOnly(p);
  revision(ctx, c);
  const type = c.type as keyof typeof writes;
  const { project_id } = inputSchemas[type].parse(c.input);
  const write = () => writes[type](ctx, p, c);
  const next = (running.get(project_id) ?? Promise.resolve()).then(write, write);
  running.set(project_id, next);
  try {
    return await next;
  } finally {
    if (running.get(project_id) === next) running.delete(project_id);
  }
}

/** The upstream of the checked-out branch and how far HEAD is from it; null without one. */
async function upstreamOf(root: string): Promise<RepoWorkingDiff['upstream']> {
  const name = await userGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  // Git exits 128 when HEAD is detached, has no upstream, or its upstream is gone.
  if (!name.ok) return null;
  const counted = await userRead(root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
  const [behind, ahead] = counted.trim().split('\t').map(Number);
  return { name: name.stdout.toString().trim(), ahead: ahead!, behind: behind! };
}

/** The first folder's staged, unstaged and untracked changes against its HEAD. */
export async function repoWorkingDiff(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): Promise<RepoWorkingDiff> {
  // It runs the user's own git, outside every session sandbox.
  userOnly(p);
  const root = projectRoot(ctx, p, projectId);
  const [head, branch, upstream, statuses, numstat, untracked] = await Promise.all([
    userRead(root, ['rev-parse', '--verify', 'HEAD']),
    optional(root, ['symbolic-ref', '--short', '-q', 'HEAD']),
    upstreamOf(root),
    // The user's git, so clean filters and autocrlf compare the worktree as a commit would.
    userRead(root, ['diff', ...PLAIN_DIFF, '--name-status', '-z', '--find-renames', 'HEAD', '--']),
    userRead(root, ['diff', ...PLAIN_DIFF, '--numstat', '-z', '--find-renames', 'HEAD', '--']),
    userRead(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const counts = new Map(
    numstatFiles(Buffer.from(numstat)).map((file) => [file.path, file] as const),
  );
  const files: RepoWorkingDiffFile[] = [];
  const tokens = statuses.split('\0');
  for (let index = 0; index < tokens.length; index++) {
    const letter = tokens[index]![0];
    if (!letter) continue;
    const old_path = letter === 'R' ? tokens[++index]! : undefined,
      file = tokens[++index]!,
      counted = counts.get(file);
    files.push({
      path: file,
      ...(letter === 'R' ? { old_path } : {}),
      status:
        letter === 'A'
          ? 'added'
          : letter === 'D'
            ? 'deleted'
            : letter === 'R'
              ? 'renamed'
              : 'modified',
      additions: counted ? counted.additions : null,
      deletions: counted ? counted.deletions : null,
    });
  }
  let patch = '',
    truncated = false;
  const append = async (args: string[], env?: NodeJS.ProcessEnv) => {
    const remaining = PATCH_BOUND - Buffer.byteLength(patch);
    if (truncated || remaining <= 0) return void (truncated = true);
    const result = await userGit(root, args, undefined, remaining, env);
    if (result.ok) patch += result.stdout.toString();
    else if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') truncated = true;
    else throw new DomainError('workspace_read_failed', result.output);
  };
  await append(['diff', ...PLAIN_DIFF, '--find-renames', 'HEAD', '--']);
  if (untracked) {
    // An index holding only the untracked files, as intent to add, diffs them all as new files in one run.
    const scratch = mkdtempSync(path.join(tmpdir(), 'pantheon-untracked-'));
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    try {
      const added = await userGit(
        root,
        ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        Buffer.from(untracked),
        undefined,
        env,
      );
      requireThat(added.ok, 'workspace_read_failed', added.output);
      const counted = await userGit(
        root,
        ['diff', ...PLAIN_DIFF, '--numstat', '-z', '--'],
        undefined,
        undefined,
        env,
      );
      requireThat(counted.ok, 'workspace_read_failed', counted.output);
      const stats = new Map(numstatFiles(counted.stdout).map((file) => [file.path, file] as const));
      for (const file of listed(untracked)) {
        const stat = stats.get(file);
        files.push({
          path: file,
          status: 'untracked',
          additions: stat ? stat.additions : 0,
          deletions: stat ? stat.deletions : 0,
        });
      }
      await append(['diff', ...PLAIN_DIFF, '--'], env);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return {
    head_sha: head.trim(),
    branch,
    upstream,
    files,
    patch: truncated ? null : patch,
    truncated,
  };
}
