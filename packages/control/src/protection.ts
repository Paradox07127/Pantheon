import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  type Stats,
} from 'node:fs';
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

export async function protectionList(input: ProtectionPaths): Promise<ProtectionEntry[]> {
  const entries = protectionListWithoutWorkspace(input);
  const add = (target: string | undefined, deny: ProtectionEntry['deny'], reason: string) => {
    if (target === undefined) return;
    for (const entry of entryPaths(target)) entries.push({ path: entry, deny, reason });
  };
  if (input.workspacePath) {
    const { pointer, gitDir, commonDir } = gitMetadata(input.workspacePath);
    add(pointer, 'write', 'Workspace git metadata pointer');
    add(path.join(commonDir, 'hooks'), 'write', 'Workspace git hooks');
    const repository = [path.join(commonDir, 'config'), path.join(gitDir, 'config.worktree')];
    for (const file of repository) add(file, 'write', 'Workspace git configuration');
    for (const target of await configFiles(
      [input.workspacePath, gitDir, commonDir].map(resolvedPath),
      input.home,
      [...repository, ...(await userConfigFiles(input.home))],
    ))
      if (!entries.some((entry) => entry.path === target))
        entries.push({ path: target, deny: 'write', reason: 'Workspace git configuration' });
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

/** The entries of protectionList that need no git: all of them for an input without a workspace. */
export function protectionListWithoutWorkspace(
  input: Omit<ProtectionPaths, 'workspacePath'>,
): ProtectionEntry[] {
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
  return entries;
}

/** A linked worktree's .git is a pointer to its own metadata, which names the shared metadata. */
function gitMetadata(root: string): { pointer?: string; gitDir: string; commonDir: string } {
  const pointer = path.join(root, '.git');
  if (!lstatSync(pointer, { throwIfNoEntry: false })?.isFile())
    return { gitDir: pointer, commonDir: pointer };
  const gitDir = located(
      root,
      readFileSync(pointer, 'utf8')
        .replace(/^gitdir: /, '')
        .trim(),
    ),
    common = path.join(gitDir, 'commondir');
  return {
    pointer,
    gitDir,
    commonDir: existsSync(common) ? located(gitDir, readFileSync(common, 'utf8').trim()) : gitDir,
  };
}

/** Git appends a relative path to its folder and leaves the kernel to resolve the result. */
function located(folder: string, value: string): string {
  return traversal(path.isAbsolute(value) ? value : `${folder}/${value}`).real;
}

/**
 * Resolves an absolute path as the kernel does, so '..' after a symlink leaves the symlink's
 * target. Lists every symlink passed, and the first component that is missing or not a folder.
 */
function traversal(target: string): { links: string[]; real: string; stop?: string } {
  const links: string[] = [],
    pending = target.split('/');
  let real = '/',
    stop: string | undefined;
  while (pending.length) {
    const name = pending.shift()!;
    if (name === '' || name === '.') continue;
    real = name === '..' ? path.dirname(real) : path.join(real, name);
    if (stop !== undefined || name === '..') continue;
    let stat: Stats | undefined;
    try {
      stat = lstatSync(real, { throwIfNoEntry: false });
    } catch {
      // Git cannot read past a component the user cannot read either.
    }
    if (stat?.isSymbolicLink() && links.length < 40) {
      links.push(real);
      const link = readlinkSync(real);
      pending.unshift(...link.split('/'));
      real = path.isAbsolute(link) ? '/' : path.dirname(real);
    } else if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && pending.some(Boolean)))
      stop = real;
  }
  return { links, real, stop };
}

// Git answers about configuration files, kept while every file they came from stays unchanged.
const userConfigs = new Map<string, { stamps: Map<string, string>; files: string[] }>();
const includes = new Map<string, { stamp: string; paths: string[] }>();
const readingUserConfigs = new Map<string, Promise<string[]>>();
const readingIncludes = new Map<string, Promise<string[]>>();

function stamp(file: string): string {
  const stat = statSync(file, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` : '';
}

/** The global and system configuration files git reads for a session that runs with this home. */
async function userConfigFiles(home: string): Promise<string[]> {
  const key = `${home}\0${process.env.GIT_CONFIG_NOSYSTEM ?? ''}`,
    cached = userConfigs.get(key);
  if (cached && [...cached.stamps].every(([file, value]) => stamp(file) === value))
    return cached.files;
  let reading = readingUserConfigs.get(key);
  if (!reading) {
    reading = listUserConfigFiles(home, key).finally(() => readingUserConfigs.delete(key));
    readingUserConfigs.set(key, reading);
  }
  return reading;
}

async function listUserConfigFiles(home: string, key: string): Promise<string[]> {
  const listed = await runGit(
    '/',
    ['config', '--null', '--show-origin', '--list'],
    undefined,
    true,
    {
      env: {
        HOME: home,
        GIT_CONFIG_GLOBAL: undefined,
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
        XDG_CONFIG_HOME: undefined,
      },
    },
  );
  const origins =
    listed.exit_code === 0
      ? listed.stdout
          .toString()
          .split('\0')
          .filter((field, index) => index % 2 === 0 && field.startsWith('file:'))
          .map((field) => field.slice('file:'.length))
      : [];
  const files = [...new Set([`${home}/.gitconfig`, `${home}/.config/git/config`, ...origins])];
  if (listed.exit_code === 0)
    userConfigs.set(key, { stamps: new Map(files.map((file) => [file, stamp(file)])), files });
  return files;
}

/** The include paths a configuration file names, as written. */
async function includePaths(file: string): Promise<string[]> {
  const current = stamp(file),
    cached = includes.get(file);
  if (cached?.stamp === current) return cached.paths;
  const key = `${file}\0${current}`;
  let reading = readingIncludes.get(key);
  if (!reading) {
    reading = listIncludePaths(file, current).finally(() => readingIncludes.delete(key));
    readingIncludes.set(key, reading);
  }
  return reading;
}

async function listIncludePaths(file: string, current: string): Promise<string[]> {
  // Outside any checkout, so a commondir planted in one cannot make git refuse to read.
  const listed = await runGit(
    '/',
    ['config', '--file', file, '--null', '--get-regexp', '^include(if\\..*)?\\.path$'],
    undefined,
    true,
  );
  // Status 1 means no include; any other failure is not kept.
  if (listed.exit_code !== 0 && listed.exit_code !== 1) return [];
  const paths =
    listed.exit_code === 0
      ? listed.stdout
          .toString()
          .split('\0')
          .filter(Boolean)
          .map((entry) => entry.slice(entry.indexOf('\n') + 1))
      : [];
  includes.set(file, { stamp: current, paths });
  return paths;
}

/**
 * The paths inside roots that decide what git reads from these configuration files and every
 * file they include, whether or not an include's condition holds now: each symlink on the way,
 * and the file itself or its first component still missing.
 */
async function configFiles(roots: string[], home: string, files: string[]): Promise<string[]> {
  const found = new Set<string>(),
    seen = new Set<string>(),
    pending = [...files];
  for (let named = pending.pop(); named !== undefined; named = pending.pop()) {
    const { links, real, stop } = traversal(named);
    for (const target of [...links, stop ?? real])
      if (roots.some((root) => target !== root && inside(root, target))) found.add(target);
    if (stop !== undefined) continue;
    // A relative include is relative to the folder of the name git opened, not of a symlink's target.
    const folder = traversal(path.dirname(named)).real,
      key = `${folder}\0${real}`;
    if (seen.has(key) || !statSync(real, { throwIfNoEntry: false })?.isFile()) continue;
    seen.add(key);
    for (const value of await includePaths(real))
      pending.push(
        value.startsWith('~/')
          ? `${home}/${value.slice(2)}`
          : path.isAbsolute(value)
            ? value
            : `${folder}/${value}`,
      );
  }
  return [...found];
}

/** A protected file with another hard link can be changed through that link, which no rule names. */
function assertNoHardLinks(entries: ProtectionEntry[], writableRoots: string[]): void {
  const devices = new Set(
    writableRoots.flatMap((root) => statSync(root, { throwIfNoEntry: false })?.dev ?? []),
  );
  for (const { path: target } of entries) {
    const files = lstatSync(target, { throwIfNoEntry: false })?.isDirectory()
      ? readdirSync(target).map((name) => path.join(target, name))
      : [target];
    for (const file of files) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      requireThat(
        !stat?.isFile() || stat.nlink === 1 || !devices.has(stat.dev),
        'scope_violation',
        `A protected file has another hard link a session could write through: ${file}`,
      );
    }
  }
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
    /** The folders of the checks only milestone verification runs, which no session may read. */
    hiddenChecksDirs?: string[];
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
  const entries = protectionListWithoutWorkspace({
    ...input,
    sourceRepo: undefined,
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
  for (const target of input.hiddenChecksDirs ?? [])
    for (const entry of entryPaths(target))
      entries.push({ path: entry, deny: 'read_write', reason: 'Hidden milestone checks' });
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
  assertNoHardLinks(entries, writable_roots);
  return { writable_roots, protected_entries: entries };
}

/**
 * A session in the user's own folder writes its project root directly, so the whole root is
 * writable and only the repository's settings, agent configuration and other worktrees are not.
 */
export async function inPlaceSandbox(
  input: Omit<ProtectionPaths, 'sourceRepo' | 'workspacePath'> & {
    projectRoot: string;
    tempDir: string;
    /** The folders of the checks only milestone verification runs, which no session may read. */
    hiddenChecksDirs?: string[];
  },
): Promise<{ writable_roots: string[]; protected_entries: ProtectionEntry[] }> {
  const entries = await protectionList({ ...input, workspacePath: input.projectRoot });
  for (const target of input.hiddenChecksDirs ?? [])
    for (const entry of entryPaths(target))
      entries.push({ path: entry, deny: 'read_write', reason: 'Hidden milestone checks' });
  const { gitDir, commonDir } = gitMetadata(input.projectRoot),
    worktrees = path.join(commonDir, 'worktrees'),
    // A linked worktree commits through its own metadata folder and the shared objects and refs.
    linked = path.dirname(gitDir) === worktrees;
  const deny = (targets: string[], reason: string) => {
    for (const target of targets)
      for (const entry of entryPaths(target)) entries.push({ path: entry, deny: 'write', reason });
  };
  if (linked) {
    deny(
      readdirSync(worktrees)
        .filter((name) => name !== path.basename(gitDir))
        .map((name) => path.join(worktrees, name)),
      'Other worktree metadata',
    );
    deny(
      ['commondir', 'gitdir'].map((name) => path.join(gitDir, name)),
      'Workspace git metadata pointer',
    );
  } else {
    deny([worktrees], 'Other worktree metadata');
    // Linux leaves it writable: bwrap would mount /dev/null there, and git refuses an empty commondir.
    if (process.platform === 'darwin')
      deny([path.join(commonDir, 'commondir')], 'Workspace git metadata pointer');
  }
  const roots = [
    input.projectRoot,
    input.tempDir,
    ...(linked
      ? [gitDir, ...['objects', 'refs', 'logs'].map((name) => path.join(commonDir, name))]
      : []),
  ];
  // Every root arrives resolved, so a symlink at or above one was planted later; resolving it would grant the target.
  for (const root of roots)
    requireThat(
      lstatSync(root, { throwIfNoEntry: false })?.isDirectory() &&
        resolvedPath(root) === path.resolve(root),
      'sandbox_path_replaced',
      `A writable sandbox root is no longer a real directory: ${root}`,
    );
  const writable_roots = roots.map(resolvedPath);
  assertNoHardLinks(entries, writable_roots);
  return { writable_roots, protected_entries: entries };
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
    ...protectionListWithoutWorkspace({ ...input, otherWorkspaces: [] }),
    ...[
      ...input.otherWorkspaces,
      ...nativeRecordsAndSkills(input),
      ...(input.workspaceRoot
        ? [path.join(input.workspaceRoot, 'reviews'), path.join(input.workspaceRoot, 'checks')]
        : []),
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
    /** The folders of the checks only milestone verification runs, which no session may read. */
    hiddenChecksDirs?: string[];
  },
): ProtectionEntry[] {
  return [
    ...protectionListWithoutWorkspace(input),
    ...[...input.otherReviewers, ...nativeRecordsAndSkills(input)].flatMap((target) =>
      entryPaths(target).map((entry): ProtectionEntry => ({
        path: entry,
        deny: 'read_write',
        reason: 'Other reviews, native session records and user skills',
      })),
    ),
    ...(input.hiddenChecksDirs ?? []).flatMap((target) =>
      entryPaths(target).map((entry): ProtectionEntry => ({
        path: entry,
        deny: 'read_write',
        reason: 'Hidden milestone checks',
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
