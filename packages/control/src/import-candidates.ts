import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { requireThat, type Project } from '@pantheon/domain';
import type { ImportCandidate, ImportCandidates, ImportableSession } from '@pantheon/protocol';
import { inside, resolvedPath, type ControlContext } from './context.js';
import { runGit } from './git.js';
import { traceProjects } from './trace-view.js';

const SCAN_MS = 300;
const PRESELECT_SESSIONS = 3;
const PRESELECT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_ROOTS = ['/tmp', '/private/tmp', '/private/var/folders', os.tmpdir()];

type Remote = ImportCandidate['remote'];

// Git answers per folder, kept for the life of the daemon.
const toplevels = new Map<string, Promise<string | null>>();
const remotes = new Map<string, Promise<Remote>>();

function toplevel(dir: string): Promise<string | null> {
  let found = toplevels.get(dir);
  if (!found) {
    found = runGit(dir, ['rev-parse', '--show-toplevel'], undefined, true).then((result) =>
      result.exit_code === 0 ? result.stdout.toString().trim() || null : null,
    );
    toplevels.set(dir, found);
  }
  return found;
}

export function remoteOf(root: string): Promise<Remote> {
  let found = remotes.get(root);
  if (!found) {
    found = runGit(root, ['remote', 'get-url', 'origin'], undefined, true).then((result) =>
      result.exit_code === 0 ? parseRemote(result.stdout.toString().trim()) : null,
    );
    remotes.set(root, found);
  }
  return found;
}

/** host, owner and name of an https, ssh or scp-style remote URL. */
function parseRemote(url: string): Remote {
  const match =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(url) ??
    /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(url);
  if (!match) return null;
  const parts = match[2]!
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length < 2) return null;
  return { host: match[1]!, owner: parts.slice(0, -1).join('/'), name: parts.at(-1)! };
}

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** The folders with native history outside every project, preselected ones first. */
export async function importCandidates(
  ctx: ControlContext,
  temporaryRoots: readonly string[] = TEMPORARY_ROOTS,
): Promise<ImportCandidates> {
  if (!ctx.trace) return { indexing: null, candidates: [] };
  const progress = await ctx.trace.scan(traceProjects(ctx), SCAN_MS);
  const indexing = progress.done_files < progress.total_files ? progress : null;
  const projectRoots = ctx.store.list<Project>('projects').flatMap((project) => project.roots);
  const data = [
    ctx.protectionPaths?.dataDir,
    ...ctx.managedWorkspaceRoots,
    ctx.protectionPaths?.backupDir,
    ctx.protectionPaths?.desktopUserDataDir,
  ].flatMap((dir) => (dir === undefined ? [] : [resolvedPath(dir)]));
  const temporary = temporaryRoots.map((root) => resolvedPath(root));

  const groups = new Map<
    string,
    {
      git: boolean;
      cwdExists: boolean;
      ids: Set<string>;
      runtimes: Set<ImportCandidate['runtimes'][number]>;
      last: number | null;
    }
  >();
  for (const record of ctx.trace.unassignedRecords()) {
    const cwd = resolvedPath(record.cwd);
    const cwdExists = existsSync(cwd);
    const top = cwdExists ? await toplevel(cwd) : null;
    const root = top === null ? cwd : resolvedPath(top);
    let group = groups.get(root);
    if (!group) {
      group = { git: top !== null, cwdExists, ids: new Set(), runtimes: new Set(), last: null };
      groups.set(root, group);
    }
    group.ids.add(record.native_id);
    group.runtimes.add(record.runtime as ImportCandidate['runtimes'][number]);
    const mtime = await mtimeOf(record.path);
    if (mtime !== null && (group.last === null || mtime > group.last)) group.last = mtime;
  }

  const now = ctx.store.now();
  const candidates: ImportCandidate[] = [];
  for (const [root, group] of groups) {
    const remote = group.git ? await remoteOf(root) : null;
    const parent = path.dirname(root);
    // A repository is nested only inside another candidate, so fixture repositories of a used
    // project drop out while one in an unrelated outer checkout stays.
    const outer = parent !== root ? await toplevel(parent) : null;
    const excluded: ImportCandidate['excluded'] = !group.cwdExists
      ? 'missing'
      : projectRoots.some((other) => inside(other, root) || inside(root, other))
        ? 'nested_project'
        : data.some((dir) => inside(dir, root))
          ? 'pantheon_data'
          : temporary.some((dir) => inside(dir, root))
            ? 'temporary'
            : outer !== null && groups.has(resolvedPath(outer))
              ? 'nested_repo'
              : undefined;
    candidates.push({
      root,
      name: remote?.name ?? path.basename(root),
      git: group.git,
      remote,
      sessions: group.ids.size,
      runtimes: [...group.runtimes].sort(),
      last_active_at: group.last === null ? null : new Date(group.last).toISOString(),
      preselected:
        excluded === undefined &&
        group.git &&
        group.ids.size >= PRESELECT_SESSIONS &&
        group.last !== null &&
        now - group.last <= PRESELECT_DAYS * DAY_MS,
      ...(excluded === undefined ? {} : { excluded }),
    });
  }
  candidates.sort(
    (a, b) =>
      Number(b.preselected) - Number(a.preselected) ||
      (b.last_active_at ?? '').localeCompare(a.last_active_at ?? ''),
  );
  return { indexing, candidates };
}

/** The native sessions in a project's external lanes. */
export async function importableSessions(
  ctx: ControlContext,
  projectId: string,
): Promise<ImportableSession[]> {
  const project = ctx.store.must<Project>('projects', projectId);
  requireThat(project.removed_at === undefined, 'not_found', `projects/${projectId}`);
  const roots = new Set(project.roots.map((root) => resolvedPath(root)));
  const sessions = ctx.trace?.importable(projectId) ?? [];
  // A session in a repository nested inside a root works on that repository, not the project's.
  const kept = await Promise.all(
    sessions.map(async (session) => {
      const top = await toplevel(resolvedPath(session.cwd));
      return top === null || roots.has(resolvedPath(top));
    }),
  );
  return sessions.filter((_, index) => kept[index]);
}
