import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  constants,
  createReadStream,
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
import { DomainError, id, requireThat, type Principal, type Project } from '@pantheon/domain';
import {
  repoPath,
  type Command,
  type CommandType,
  type inputSchemas,
  type RepoWorkingDiff,
  type RepoWorkingDiffFile,
} from '@pantheon/protocol';
import { inside, projectAccess, userOnly, type ControlContext, type Handler } from './context.js';
import { runGit } from './git.js';
import {
  BOUND,
  PATCH_BOUND,
  git,
  listedWorktrees,
  numstatFiles,
  sourceGit,
  userGit,
  type UserGitResult,
} from './source-git.js';
import { forgetStatusReads } from './workbench-session.js';

const UNDO_MS = 10 * 60 * 1000;
// Paths name files, never pathspec patterns.
const LITERAL = '--literal-pathspecs';
// The panel and git apply consume these patches regardless of the user's display configuration.
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
  /** stateOf the file when it was saved. */
  state: string;
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
  /** stateOf each file once the discard was done, in the order of files. */
  discarded: string[];
  discardedIndex: string;
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

/** What a path holds: nothing, a link's target, a file's mode and content hash, or something else. */
async function stateOf(root: string, file: string): Promise<string> {
  checkedParents(root, file);
  const target = path.join(root, file);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return 'absent';
  if (stat.isSymbolicLink()) return `link ${readlinkSync(target)}`;
  if (!stat.isFile()) return 'other';
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return `file ${stat.mode & 0o7777} ${hash.digest('hex')}`;
}

async function saved(
  root: string,
  backup: string,
  file: string,
  index: number,
): Promise<SavedFile> {
  const target = path.join(root, file);
  const state = await stateOf(root, file);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return { path: file, state };
  if (stat.isSymbolicLink()) return { path: file, link: readlinkSync(target), state };
  const copy = path.join(backup, String(index));
  await copyFile(target, copy, constants.COPYFILE_FICLONE);
  return { path: file, copy, mode: stat.mode & 0o7777, state };
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
    const copies: SavedFile[] = [];
    for (const file of files) copies.push(await saved(root, backup, file, copies.length));
    return { backup, files: copies };
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

async function selectedFiles(root: string, paths: string[]) {
  for (const file of paths) {
    checkedParents(root, file);
    requireThat(
      !lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isDirectory(),
      'invalid_input',
      `${file} is a directory. Select individual files.`,
    );
  }
  const [output, tree] = await Promise.all([
    git(root, [LITERAL, 'ls-files', '-s', '--debug', '-z', '--', ...paths]),
    git(root, [LITERAL, 'ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', ...paths]),
  ]);
  const entries: string[] = [],
    flags = new Map<string, number>();
  // Each entry is `<mode> <object> <stage>\t<path>`, then lines about it that end with its flags in hex.
  for (const [, entry, hex] of output.matchAll(/([^\0]*)\0[^\0]*?\tflags: ([0-9a-f]+)\n/g)) {
    entries.push(entry!);
    flags.set(entryPath(entry!), parseInt(hex!, 16));
  }
  const tracked = new Set([...flags.keys(), ...listed(tree)]);
  // A deleted directory is still a recursive Git pathspec.
  const selected = new Set(paths);
  for (const file of tracked)
    requireThat(selected.has(file), 'invalid_input', 'Select individual files');
  return { tracked, index: { entries, absent: paths.filter((file) => !flags.has(file)), flags } };
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
      const file = entryPath(entry);
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

function indexState(root: string, files: SavedFile[], index?: SavedIndex) {
  const paths = new Set([...files.map((file) => file.path), ...(index?.absent ?? [])]);
  return git(root, [LITERAL, 'ls-files', '-s', '-z', '--', ...paths]);
}

/** Keeps the saved files, and the index entries a discard reset, for an undo once it succeeded. */
async function remembered(
  ctx: ControlContext,
  projectId: string,
  root: string,
  { backup, files }: SavedFiles,
  index?: SavedIndex,
) {
  const discardedIndex = await indexState(root, files, index);
  const discarded: string[] = [];
  for (const file of files) discarded.push(await stateOf(root, file.path));
  const undo_id = id();
  const timer = setTimeout(() => forget(undo_id), UNDO_MS).unref();
  undos.set(undo_id, {
    project_id: projectId,
    root,
    files,
    discarded,
    discardedIndex,
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

async function discard(ctx: ControlContext, root: string, projectId: string, paths: string[]) {
  const { tracked, index } = await selectedFiles(root, paths);
  const untracked = await git(root, [
    LITERAL,
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...paths,
  ]);
  // A staged deletion recreated in the worktree is both committed and untracked.
  const removed = listed(untracked).filter((file) => !tracked.has(file));
  const files = await savedFiles(ctx, root, [...tracked, ...removed]);
  let removing = 0;
  try {
    if (tracked.size) {
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
    for (; removing < removed.length; removing++) {
      const file = removed[removing]!;
      checkedParents(root, file);
      rmSync(path.join(root, file), { force: true });
    }
    return await remembered(ctx, projectId, root, files, index);
  } catch (error) {
    // Puts back what the discard changed before it stopped.
    await restore(root, files.files.slice(0, tracked.size + removing), index);
    rmSync(files.backup, { recursive: true, force: true });
    throw error;
  }
}

async function checkPatchEncoding(root: string, textPaths: Set<string>) {
  if (!textPaths.size) return;
  const message = 'Cannot discard a text patch for a file with invalid UTF-8';
  // Removed lines may no longer exist in the worktree. Check Git's bytes before decoding them.
  const diff = await userGit(root, [
    'diff',
    ...PLAIN_DIFF,
    '--text',
    '--unified=0',
    'HEAD',
    '--',
    ...textPaths,
  ]);
  requireThat(diff.ok, 'workspace_read_failed', diff.output);
  requireThat(isUtf8(diff.stdout), 'patch_failed', message);
  for (const file of textPaths) {
    checkedParents(root, file);
    const target = path.join(root, file);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      requireThat(isUtf8(readlinkSync(target, { encoding: 'buffer' })), 'patch_failed', message);
    } else if (stat?.isFile()) {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        for await (const chunk of createReadStream(target)) decoder.decode(chunk, { stream: true });
        decoder.decode();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA')
          throw new DomainError('patch_failed', message);
        throw error;
      }
    }
  }
}

async function discardPatch(
  ctx: ControlContext,
  p: Principal,
  root: string,
  projectId: string,
  patch: Buffer,
) {
  const failed = (result: UserGitResult) =>
    new DomainError('patch_failed', result.output || 'git apply failed');
  // Numstat names the destination of a rename. Read both directions so undo saves both paths.
  const paths = new Set<string>();
  const textPaths = new Set<string>();
  for (const direction of [[], ['-R']]) {
    const counted = await userGit(root, ['apply', ...direction, '--numstat', '-z', '-'], patch);
    if (!counted.ok) throw failed(counted);
    for (const file of numstatFiles(counted.stdout)) {
      paths.add(file.path);
      if (file.additions !== null) textPaths.add(file.path);
    }
  }
  for (const file of paths) {
    repoPath.parse(file);
    checkedParents(root, file);
  }
  // The patch is against HEAD, so it would leave staged lines in the index.
  const read = sourceGit(ctx, p, projectId, root);
  const staged = await read(
    [LITERAL, 'diff', ...PLAIN_DIFF, '--cached', '--quiet', '--', ...paths],
    BOUND,
  );
  if (staged.exit_code === 1)
    throw new DomainError(
      'staged_changes',
      `Staged changes in ${[...paths].join(', ')}; discard the whole file`,
    );
  requireThat(
    staged.exit_code === 0,
    'workspace_read_failed',
    staged.error ?? staged.stderr.toString(),
  );
  await checkPatchEncoding(root, textPaths);
  const files = await savedFiles(ctx, root, [...paths]);
  const applied = await userGit(root, ['apply', '-R', '-'], patch);
  if (!applied.ok) {
    rmSync(files.backup, { recursive: true, force: true });
    throw failed(applied);
  }
  return remembered(ctx, projectId, root, files);
}

async function discardUndo(ctx: ControlContext, root: string, projectId: string, undoId: string) {
  const undo = undos.get(undoId);
  requireThat(
    undo &&
      undo.project_id === projectId &&
      undo.root === root &&
      undo.expires_at > ctx.store.now(),
    'undo_expired',
    'The discard can no longer be undone',
  );
  // Expiring during the restore would remove the backup it copies from.
  clearTimeout(undo.timer);
  try {
    // A file as the discard left it, or as an undo that failed partway already put it back.
    for (const [index, file] of undo.files.entries()) {
      const state = await stateOf(root, file.path);
      requireThat(
        state === undo.discarded[index] || state === file.state,
        'invalid_state',
        `${file.path} changed after the discard`,
      );
    }
    requireThat(
      (await indexState(root, undo.files, undo.index)) === undo.discardedIndex,
      'invalid_state',
      'The index entries for the discarded paths changed after the discard',
    );
    await restore(root, undo.files, undo.index);
  } catch (error) {
    // Kept, so that an undo that failed can be tried again.
    undo.timer = setTimeout(() => forget(undoId), undo.expires_at - ctx.store.now()).unref();
    throw error;
  }
  forget(undoId);
  return {};
}

async function userRead(root: string, args: string[]): Promise<string> {
  const result = await userGit(root, args);
  requireThat(result.ok, 'workspace_read_failed', result.output);
  return result.stdout.toString();
}

async function commit(root: string, paths: string[], message: string) {
  const { index } = await selectedFiles(root, paths);
  // `git add` refuses a path in neither the index nor the worktree, such as a rename's old path.
  const adding = paths.filter(
    (file) =>
      !index.absent.includes(file) || lstatSync(path.join(root, file), { throwIfNoEntry: false }),
  );
  for (const args of [
    ...(adding.length ? [['add', '--', ...adding]] : []),
    ['commit', '--only', '-m', message, '--', ...paths],
  ]) {
    const result = await userGit(root, args);
    if (result.ok) continue;
    // Git leaves what `git add` staged in the index when the commit fails.
    await restoreIndex(root, index);
    throw new DomainError('commit_failed', result.output || `git ${args[0]} failed`);
  }
  const sha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  return { sha };
}

/** git config exits 1 when the key is unset. */
async function optionalConfig(root: string, key: string): Promise<string | null> {
  const result = await userGit(root, ['config', '--get', key]);
  if (result.code === 1) return null;
  requireThat(result.ok, 'workspace_read_failed', result.output);
  return result.stdout.toString().trim();
}

async function push(root: string, branch: string | null) {
  requireThat(branch !== null, 'invalid_state', 'The checkout is not on a branch');
  const [remote, merge, remotes, sshCommand] = await Promise.all([
    optionalConfig(root, `branch.${branch}.remote`),
    optionalConfig(root, `branch.${branch}.merge`),
    userRead(root, ['remote']),
    optionalConfig(root, 'core.sshCommand'),
  ]);
  const upstream = remote !== null && merge !== null;
  requireThat(
    upstream || remotes.split('\n').includes('origin'),
    'no_remote',
    `${branch} has no upstream and the repository has no origin remote`,
  );
  // A full refspec pushes this branch alone, whatever push.default says.
  const ref = `refs/heads/${branch}`;
  const args = upstream
    ? ['push', '--no-follow-tags', '--', remote, `${ref}:${merge}`]
    : ['push', '--no-follow-tags', '--set-upstream', '--', 'origin', `${ref}:${ref}`];
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
  return {};
}

type RepoWrite = Extract<CommandType, `repo.${string}`>;
type RepoWriteCommand = {
  [T in RepoWrite]: Command & { type: T; input: ReturnType<(typeof inputSchemas)[T]['parse']> };
}[RepoWrite];

/** Called after Control.execute validated the command and its input. */
export const isRepoWrite = (command: Command): command is RepoWriteCommand =>
  command.type.startsWith('repo.');

async function projectWorktree(ctx: ControlContext, projectId: string) {
  const root = ctx.store.must<Project>('projects', projectId).roots[0]!;
  const worktree = (await listedWorktrees(root)).find((candidate) => candidate.path === root);
  requireThat(worktree, 'invalid_state', 'The project folder is no longer a Git worktree');
  return worktree;
}

/** Git finishes before the transaction that records the change and its receipt. */
export async function prepareRepoWrite(
  ctx: ControlContext,
  p: Principal,
  c: RepoWriteCommand,
): Promise<Handler> {
  const projectId = c.input.project_id;
  const { path: root, branch } = await projectWorktree(ctx, projectId);
  try {
    let receipt: unknown;
    switch (c.type) {
      case 'repo.commit':
        receipt = await commit(root, c.input.paths, c.input.message);
        break;
      case 'repo.push':
        receipt = await push(root, branch);
        break;
      case 'repo.discard':
        receipt = await discard(ctx, root, projectId, c.input.paths);
        break;
      case 'repo.discard_patch':
        receipt = await discardPatch(ctx, p, root, projectId, Buffer.from(c.input.patch));
        break;
      case 'repo.discard_undo':
        receipt = await discardUndo(ctx, root, projectId, c.input.undo_id);
        break;
    }
    return (ctx, _p, command) => {
      ctx.store.event(
        'workspace.repository_changed',
        ctx.store.must<Project>('projects', projectId),
        projectId,
        {},
        command.command_id,
      );
      return receipt;
    };
  } finally {
    forgetStatusReads(root);
  }
}

/** The upstream of the checked-out branch and how far HEAD is from it; null without one. */
async function upstreamOf(root: string): Promise<RepoWorkingDiff['upstream']> {
  const name = await userGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  // Git exits 128 when HEAD is detached, has no upstream, or its upstream is gone.
  if (name.code === 128) return null;
  requireThat(name.ok, 'workspace_read_failed', name.output);
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
  userOnly(p);
  projectAccess(ctx, p, projectId, 'project.read');
  const { path: root, head_sha, branch } = await projectWorktree(ctx, projectId);
  const tracked = (...patch: string[]) => [
    'diff',
    ...PLAIN_DIFF,
    '--raw',
    '--numstat',
    ...patch,
    '-z',
    '--find-renames',
    head_sha,
    '--',
  ];
  const [upstream, whole, untracked] = await Promise.all([
    upstreamOf(root),
    // The user's git, so clean filters and autocrlf compare the worktree as a commit would.
    userGit(root, tracked('-p', '--binary')),
    userRead(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  let patch = '',
    truncated = false;
  let output = whole.stdout.toString();
  if (whole.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    output = await userRead(root, tracked());
    truncated = true;
  } else requireThat(whole.ok, 'workspace_read_failed', whole.output);
  // Raw entries, then numstat entries, then a NUL and the patch.
  const tokens = output.split('\0');
  let index = 0;
  const raw: { letter: string; old_path: string | undefined; file: string }[] = [];
  for (; tokens[index]?.startsWith(':'); index++) {
    const letter = tokens[index]!.split(' ')[4]![0]!;
    const old_path = letter === 'R' ? tokens[++index]! : undefined;
    raw.push({ letter, old_path, file: tokens[++index]! });
  }
  const numstatStart = index;
  for (; /^(\d+|-)\t(\d+|-)\t/.test(tokens[index] ?? ''); index++)
    // A rename leaves the path empty and is followed by the old and the new path.
    if (/^(\d+|-)\t(\d+|-)\t$/.test(tokens[index]!)) index += 2;
  const numstat = tokens.slice(numstatStart, index).join('\0');
  if (!truncated) {
    patch = tokens.slice(index + 1).join('\0');
    if (Buffer.byteLength(patch) > PATCH_BOUND) {
      patch = '';
      truncated = true;
    }
  }
  const counts = new Map(
    numstatFiles(Buffer.from(numstat)).map((file) => [file.path, file] as const),
  );
  const files: RepoWorkingDiffFile[] = [];
  for (const { letter, old_path, file } of raw) {
    const counted = counts.get(file);
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
      if (!truncated) {
        const remaining = PATCH_BOUND - Buffer.byteLength(patch);
        if (remaining === 0) truncated = true;
        else {
          const result = await userGit(
            root,
            ['diff', ...PLAIN_DIFF, '--binary', '--'],
            undefined,
            remaining,
            env,
          );
          if (result.ok) patch += result.stdout.toString();
          else if (result.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') truncated = true;
          else throw new DomainError('workspace_read_failed', result.output);
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return {
    head_sha,
    branch,
    upstream,
    files,
    patch: truncated ? null : patch,
    truncated,
  };
}
