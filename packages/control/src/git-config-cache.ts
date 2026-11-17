import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { wslAutomountRoot, wslDrivePath } from './wsl-mount.js';

export const DRIVER_PATTERN =
  '^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver)$';
const driverKey = new RegExp(DRIVER_PATTERN, 's');
const LIMIT = 256;
// A repository config changed within this time after a check still neutralizes the old driver list.
export const RECHECK_INTERVAL_MS = 1000;

interface Entry {
  /** Every path whose change can alter which repository config git reads or what it says. */
  paths: string[];
  /** Absent: unknown, so the next call asks git again. */
  state?: Map<string, string>;
  /** Absent: this config is never cached, so every call runs the plain query. */
  overrides?: string[];
  /** When `state` last matched the files, on the monotonic clock. */
  checked: number;
}
const entries = new Map<string, Entry>();

export interface ConfigMiss {
  /** Names the entry this miss fills. */
  key: string;
  /** Takes `git rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel`. */
  located(output: string): boolean;
  /** Takes `git config --null --show-origin --list`; undefined means run the plain query. */
  listed(output: Buffer): string[] | undefined;
}

function signature(file: string): string | undefined {
  try {
    const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return 'missing';
    // Discovery checks search permission on objects and refs, so mode and owner count.
    if (stat.isDirectory())
      return `directory ${stat.dev} ${stat.ino} ${stat.mode} ${stat.uid} ${stat.gid}`;
    // Content too: an in-place rewrite of equal size can keep every timestamp within their resolution.
    if (stat.isFile())
      return `file ${stat.dev} ${stat.ino} ${stat.size} ${stat.mtimeNs} ${stat.ctimeNs} ${readFileSync(file, 'latin1')}`;
  } catch {
    /* Unreadable paths are not cached. */
  }
  // Symbolic links would need their targets tracked too, so they are not cached.
  return undefined;
}

function snapshot(paths: string[]) {
  const state = new Map<string, string>();
  for (const file of paths) {
    const value = signature(file);
    if (value === undefined) return undefined;
    state.set(file, value);
  }
  return state;
}

function real(file: string) {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

// Mirrors git discovery from `start` upward; `located` checks the answer against git's own.
function repositoryLayout(start: string) {
  const paths: string[] = [];
  // As runGit does, a drive path a Windows tool wrote is read in the mount WSL gives that drive.
  const root = wslAutomountRoot();
  const resolve = (link: string, base: string) =>
    (root === undefined ? undefined : wslDrivePath(link, root)) ??
    (path.isAbsolute(link) ? link : `${base}/${link}`);
  try {
    let gitdir: string | undefined;
    for (let directory = start; !gitdir; directory = path.dirname(directory)) {
      const dotGit = path.join(directory, '.git');
      const stat = lstatSync(dotGit, { throwIfNoEntry: false });
      paths.push(dotGit);
      if (stat?.isDirectory()) gitdir = dotGit;
      else if (stat?.isFile()) {
        const link = /^gitdir: (.+?)[\r\n]*$/s.exec(readFileSync(dotGit, 'utf8'))?.[1];
        if (!link) return undefined;
        const raw = resolve(link, directory);
        paths.push(raw);
        gitdir = realpathSync(raw);
      } else if (stat) return undefined;
      else {
        // A directory that becomes a git directory itself would take over discovery.
        paths.push(
          ...['HEAD', 'commondir', 'objects', 'refs'].map((name) => path.join(directory, name)),
        );
        if (path.dirname(directory) === directory) return undefined;
      }
    }
    let commondir = gitdir;
    if (existsSync(path.join(gitdir, 'commondir'))) {
      const link = readFileSync(path.join(gitdir, 'commondir'), 'utf8').replace(/[\r\n]+$/, '');
      const raw = resolve(link, gitdir);
      paths.push(raw);
      commondir = realpathSync(raw);
    }
    paths.push(
      gitdir,
      path.join(gitdir, 'HEAD'),
      path.join(gitdir, 'commondir'),
      path.join(gitdir, 'config.worktree'),
      commondir,
      path.join(commondir, 'objects'),
      path.join(commondir, 'refs'),
      path.join(commondir, 'config'),
    );
    return { gitdir, commondir, paths: [...new Set(paths)] };
  } catch {
    return undefined;
  }
}

function remember(key: string, entry: Entry) {
  entries.delete(key);
  if (entries.size >= LIMIT) entries.delete(entries.keys().next().value!);
  entries.set(key, entry);
}

/**
 * The driver names to neutralize when they are known for `cwd`, undefined when the plain query
 * must run, or the steps that learn them from git.
 */
export function cachedDriverConfig(
  cwd: string,
  workTree: string | undefined,
): { overrides: string[] } | ConfigMiss | undefined {
  const start = real(cwd);
  if (!start) return undefined;
  const key = `${start}\0${workTree ?? ''}`;
  const previous = entries.get(key);
  const now = performance.now();
  const recent = previous !== undefined && now - previous.checked < RECHECK_INTERVAL_MS;
  if (
    previous?.state &&
    (recent ||
      previous.paths.every((file) => {
        const value = signature(file);
        return value !== undefined && value === previous.state!.get(file);
      }))
  ) {
    if (!recent) previous.checked = now;
    return previous.overrides ? { overrides: previous.overrides } : undefined;
  }
  const layout = repositoryLayout(start);
  if (!layout) return undefined;
  // Include targets learned last time are read before git runs, so the cache can be filled now.
  const paths = [...new Set([...layout.paths, ...(previous?.paths ?? [])])];
  const before = snapshot(paths);
  if (!before) return undefined;
  let toplevel = '';
  return {
    key,
    located(output) {
      const [gitdir = '', commondir = '', top = '', rest] = output.split('\n');
      toplevel = real(top) ?? '';
      const known =
        rest === '' &&
        toplevel !== '' &&
        real(gitdir) === layout.gitdir &&
        real(commondir) === layout.commondir;
      if (!known) remember(key, { paths, state: before, checked: now });
      return known;
    },
    listed(output) {
      const fields = output.toString().split('\0');
      if (fields.pop() !== '' || fields.length % 2 !== 0) return undefined;
      const overrides = new Set<string>();
      const files: string[] = [];
      const targets: string[] = [];
      let cacheable = true;
      for (let index = 0; index < fields.length; index += 2) {
        const origin = fields[index]!;
        const entry = fields[index + 1]!;
        const split = entry.indexOf('\n');
        const name = split === -1 ? entry : entry.slice(0, split);
        if (driverKey.test(name)) overrides.add(name);
        // Relative origins are relative to the top level, where git runs.
        const file = origin.startsWith('file:')
          ? path.isAbsolute(origin.slice(5))
            ? origin.slice(5)
            : `${toplevel}/${origin.slice(5)}`
          : undefined;
        if (file) files.push(file);
        else if (origin !== 'command line:') cacheable = false;
        const condition = /^includeif\.(.*)\.path$/s.exec(name)?.[1];
        if (name !== 'include.path' && condition === undefined) continue;
        const target = split === -1 ? '' : entry.slice(split + 1);
        // Interpolated paths, and conditions on the branch or other state, are not tracked.
        if (
          !file ||
          target === '' ||
          /^[~%]/.test(target) ||
          (condition !== undefined &&
            (!/^(gitdir|gitdir\/i|hasconfig):/.test(condition) || /[~%]/.test(condition)))
        )
          cacheable = false;
        // Joined, not normalized: git resolves '..' after symbolic links, as lstat does.
        else targets.push(path.isAbsolute(target) ? target : `${path.dirname(file)}/${target}`);
      }
      const dependencies = [...new Set([...layout.paths, ...targets])];
      if (!files.every((file) => dependencies.includes(file))) cacheable = false;
      const checked = performance.now();
      const after = snapshot(dependencies);
      const settled =
        after !== undefined &&
        dependencies.every((file) => before.has(file) && after.get(file) === before.get(file));
      remember(key, {
        paths: dependencies,
        state: settled ? after : undefined,
        overrides: cacheable ? [...overrides] : undefined,
        checked,
      });
      return [...overrides];
    },
  };
}
