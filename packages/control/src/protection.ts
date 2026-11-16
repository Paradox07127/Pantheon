import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireThat } from '@pantheon/domain';
import { inside, resolvedPath } from './context.js';
import { runGit } from './git.js';

export interface ProtectionPaths {
  dataDir: string;
  desktopUserDataDir: string;
  home: string;
  codexHome: string;
  sourceRepo?: string;
  workspacePath?: string;
  otherWorkspaces: string[];
  backupDir: string;
}

export interface ProtectionEntry {
  path: string;
  deny: 'read_write' | 'write';
  reason: string;
}

// A symlinked entry is protected under its own name too, so it cannot be swapped for a real file.
function entryPaths(target: string): string[] {
  const named = path.join(resolvedPath(path.dirname(target)), path.basename(target)),
    resolved = resolvedPath(target);
  return named === resolved ? [resolved] : [named, resolved];
}

export function protectionList(input: ProtectionPaths): ProtectionEntry[] {
  const entries: ProtectionEntry[] = [];
  const add = (target: string | undefined, deny: ProtectionEntry['deny'], reason: string) => {
    if (target === undefined) return;
    for (const entry of entryPaths(target)) entries.push({ path: entry, deny, reason });
  };
  add(input.dataDir, 'read_write', 'Pantheon database, artifacts and daemon credentials');
  add(input.desktopUserDataDir, 'read_write', 'Desktop settings and logs');
  add(input.backupDir, 'read_write', 'Protected backups');
  add(input.sourceRepo, 'write', 'Original repository checkout');
  if (input.sourceRepo)
    add(path.join(input.sourceRepo, '.git'), 'write', 'Original repository metadata');
  for (const workspace of input.otherWorkspaces) add(workspace, 'write', 'Other workspace');
  add(path.join(input.home, '.claude'), 'write', 'Claude configuration and state');
  add(path.join(input.home, '.claude.json'), 'write', 'Claude configuration');
  add(input.codexHome, 'write', 'Codex configuration and state');
  for (const file of ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile'])
    add(path.join(input.home, file), 'write', 'Shell startup configuration');
  if (input.workspacePath) {
    const { pointer, gitDir, commonDir } = gitMetadata(input.workspacePath);
    add(pointer, 'write', 'Workspace git metadata pointer');
    add(path.join(commonDir, 'hooks'), 'write', 'Workspace git hooks');
    for (const file of configFiles(input.workspacePath, input.home, [
      path.join(commonDir, 'config'),
      path.join(gitDir, 'config.worktree'),
    ]))
      add(file, 'write', 'Workspace git configuration');
  }
  if (input.workspacePath)
    for (const [name, reason] of [
      ['.claude', 'Workspace Claude configuration'],
      ['.codex', 'Workspace Codex configuration'],
      ['.mcp.json', 'Workspace MCP configuration'],
    ] as const)
      add(path.join(input.workspacePath, name), 'write', reason);
  return entries;
}

/** A linked worktree's .git is a pointer to its own metadata, which names the shared metadata. */
function gitMetadata(root: string): { pointer?: string; gitDir: string; commonDir: string } {
  const pointer = path.join(root, '.git');
  if (!lstatSync(pointer, { throwIfNoEntry: false })?.isFile())
    return { gitDir: pointer, commonDir: pointer };
  const gitDir = path.resolve(
      root,
      readFileSync(pointer, 'utf8')
        .replace(/^gitdir: /, '')
        .trim(),
    ),
    common = path.join(gitDir, 'commondir');
  return {
    pointer,
    gitDir,
    commonDir: existsSync(common)
      ? path.resolve(gitDir, readFileSync(common, 'utf8').trim())
      : gitDir,
  };
}

/** The configuration files, plus every file inside root they include whether or not its condition holds now. */
function configFiles(root: string, home: string, files: string[]): string[] {
  const found = [...files],
    pending = [...files],
    seen = new Set(files);
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    // Outside any checkout, so a commondir planted in one cannot make git refuse to read.
    const listed = runGit('/', [
      'config',
      '--file',
      file,
      '--null',
      '--get-regexp',
      '^include(if\\..*)?\\.path$',
    ]);
    if (listed.exit_code !== 0) continue;
    for (const entry of listed.stdout.toString().split('\0').filter(Boolean)) {
      const value = entry.slice(entry.indexOf('\n') + 1),
        target = value.startsWith('~/')
          ? path.join(home, value.slice(2))
          : path.resolve(path.dirname(file), value);
      if (seen.has(target)) continue;
      seen.add(target);
      pending.push(target);
      if (inside(root, target) || inside(root, resolvedPath(target))) found.push(target);
    }
  }
  return found;
}

/**
 * A worktree commits through the source repository's objects and its own metadata folder, so
 * only those are writable; everything else in the source stays write-protected entry by entry.
 */
export function worktreeSandbox(
  input: ProtectionPaths & {
    sourceRepo: string;
    workspacePath: string;
    worktreeId: string;
    tempDir: string;
    /** A session a lead dispatched for a task also may not read other worktrees, native records or reviews. */
    taskSession?: { reviewsDirs: string[] };
  },
): { writable_roots: string[]; protected_entries: ProtectionEntry[] } {
  const source = resolvedPath(input.sourceRepo),
    metadata = path.join(source, '.git'),
    worktrees = path.join(metadata, 'worktrees');
  // A linked worktree, submodule or separate Git directory keeps its metadata elsewhere.
  requireThat(
    lstatSync(metadata, { throwIfNoEntry: false })?.isDirectory(),
    'source_metadata_unsupported',
    `The source folder's .git is not a directory: ${metadata}`,
  );
  const roots = [
    input.workspacePath,
    path.join(metadata, 'objects'),
    path.join(worktrees, input.worktreeId),
    input.tempDir,
  ];
  // A session may replace its own writable root with a symlink; resolving it would grant the target.
  for (const root of roots) {
    const stat = lstatSync(root, { throwIfNoEntry: false });
    requireThat(
      !stat || stat.isDirectory(),
      'sandbox_path_replaced',
      `A writable sandbox root is no longer a real directory: ${root}`,
    );
  }
  const writable_roots = roots.map(resolvedPath);
  // The source entries are replaced below, and the workspace's .git is a pointer file whose
  // hooks and config paths cannot be resolved, so only its agent configuration entries remain.
  const entries = protectionList({
    ...input,
    sourceRepo: undefined,
    workspacePath: undefined,
    otherWorkspaces: input.taskSession ? [] : input.otherWorkspaces,
  });
  if (input.taskSession)
    for (const target of [
      ...input.otherWorkspaces,
      ...nativeRecords(input),
      ...input.taskSession.reviewsDirs,
    ])
      for (const entry of entryPaths(target))
        entries.push({
          path: entry,
          deny: 'read_write',
          reason: 'Other workspaces, reviews and native session records',
        });
  const add = (targets: string[], reason: string) => {
    for (const target of targets)
      for (const entry of entryPaths(target)) entries.push({ path: entry, deny: 'write', reason });
  };
  add(
    ['.claude', '.codex', '.mcp.json'].map((name) => path.join(input.workspacePath, name)),
    'Workspace agent configuration',
  );
  const children = (folder: string, except: string[]) =>
    readdirSync(folder)
      .filter((name) => !except.includes(name))
      .map((name) => path.join(folder, name));
  add(children(source, ['.git']), 'Original repository checkout');
  add(
    [
      ...new Set([
        ...children(metadata, ['objects', 'worktrees']),
        ...['hooks', 'config', 'HEAD', 'index', 'packed-refs', 'refs', 'logs', 'info'].map((name) =>
          path.join(metadata, name),
        ),
      ]),
    ],
    'Original repository metadata',
  );
  add(children(worktrees, [input.worktreeId]), 'Other worktree metadata');
  add([path.join(worktrees, input.worktreeId, 'config.worktree')], 'Worktree git configuration');
  add(
    ['commondir', 'gitdir'].map((name) => path.join(worktrees, input.worktreeId, name)),
    'Worktree links to the source repository',
  );
  add([path.join(input.workspacePath, '.git')], 'Worktree git metadata pointer');
  // Sandbox write denials override allowed roots, so a denial above a root would block commits.
  requireThat(
    !entries.some((entry) => writable_roots.some((root) => inside(entry.path, root))),
    'scope_violation',
    'A protected entry contains a writable worktree root',
  );
  return { writable_roots, protected_entries: entries };
}

/**
 * A session in the user's own folder writes its project root directly, so the whole root is
 * writable and only the repository's settings, agent configuration and other worktrees are not.
 */
export function inPlaceSandbox(
  input: Omit<ProtectionPaths, 'sourceRepo' | 'workspacePath'> & {
    projectRoot: string;
    tempDir: string;
  },
): { writable_roots: string[]; protected_entries: ProtectionEntry[] } {
  const entries = protectionList({ ...input, workspacePath: input.projectRoot });
  const { commonDir } = gitMetadata(input.projectRoot);
  for (const entry of entryPaths(path.join(commonDir, 'worktrees')))
    entries.push({ path: entry, deny: 'write', reason: 'Other worktree metadata' });
  // Linux leaves it writable: bwrap would mount /dev/null there, and git refuses an empty commondir.
  if (process.platform === 'darwin')
    for (const entry of entryPaths(path.join(commonDir, 'commondir')))
      entries.push({ path: entry, deny: 'write', reason: 'Workspace git metadata pointer' });
  const roots = [input.projectRoot, input.tempDir];
  // Both roots arrive resolved, so a symlink at or above one was planted later; resolving it would grant the target.
  for (const root of roots)
    requireThat(
      lstatSync(root, { throwIfNoEntry: false })?.isDirectory() &&
        resolvedPath(root) === path.resolve(root),
      'sandbox_path_replaced',
      `A writable sandbox root is no longer a real directory: ${root}`,
    );
  return {
    writable_roots: roots.map(resolvedPath),
    protected_entries: entries,
  };
}

function nativeRecords(input: Pick<ProtectionPaths, 'home' | 'codexHome'>): string[] {
  return [
    path.join(input.home, '.claude/projects'),
    path.join(input.codexHome, 'sessions'),
    path.join(input.codexHome, 'archived_sessions'),
    path.join(input.codexHome, 'session_index.jsonl'),
  ];
}

function nativeRecordsAndSkills(input: Pick<ProtectionPaths, 'home' | 'codexHome'>): string[] {
  return [
    ...nativeRecords(input),
    path.join(input.home, '.claude/skills'),
    path.join(input.home, '.agents/skills'),
    path.join(input.codexHome, 'skills'),
  ];
}

export function plannerProtectionList(
  input: Omit<ProtectionPaths, 'sourceRepo' | 'workspacePath'> & { workspaceRoot?: string },
): ProtectionEntry[] {
  return [
    ...protectionList({ ...input, otherWorkspaces: [] }),
    ...[
      ...input.otherWorkspaces,
      ...nativeRecordsAndSkills(input),
      ...(input.workspaceRoot ? [path.join(input.workspaceRoot, 'reviews')] : []),
    ].flatMap((target) =>
      entryPaths(target).map((entry): ProtectionEntry => ({
        path: entry,
        deny: 'read_write',
        reason: 'Other workspaces, reviews, native session records and user skills',
      })),
    ),
  ];
}

export function reviewerProtectionList(
  input: Omit<ProtectionPaths, 'sourceRepo' | 'workspacePath'> & {
    reviewerPath: string;
    otherReviewers: string[];
  },
): ProtectionEntry[] {
  return [
    ...protectionList(input),
    ...[...input.otherReviewers, ...nativeRecordsAndSkills(input)].flatMap((target) =>
      entryPaths(target).map((entry): ProtectionEntry => ({
        path: entry,
        deny: 'read_write',
        reason: 'Other reviews, native session records and user skills',
      })),
    ),
    ...entryPaths(input.reviewerPath).map((entry): ProtectionEntry => ({
      path: entry,
      deny: 'write',
      reason: 'Reviewer artifact folder',
    })),
  ];
}

export function assertManagedLocation(
  target: string,
  temporaryRoots: readonly string[] = ['/tmp', '/private/tmp', '/private/var/folders', os.tmpdir()],
): void {
  const absolute = path.resolve(target),
    resolved = resolvedPath(absolute);
  for (const root of temporaryRoots)
    requireThat(
      !inside(path.resolve(root), absolute) && !inside(resolvedPath(root), resolved),
      'scope_violation',
      'Managed workspaces and backups cannot be in temporary directories',
    );
}
