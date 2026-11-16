import { existsSync } from 'node:fs';
import { requireThat, type Project, type Session, type Workspace } from '@pantheon/domain';
import type { StaleWorkspaces, WorkbenchSession } from '@pantheon/protocol';
import type { ControlContext } from './context.js';
import { runGit } from './git.js';
import { mergePreview } from './merge-preview.js';

/** After a new event the worktrees are read again at most this often, in milliseconds. */
const REFRESH_MS = 2000;
/**
 * Without a new event, a read this long after the last full read reads every worktree again, for
 * edits and commits made outside a session, in milliseconds. Nothing reads on a timer.
 */
export const IDLE_REFRESH_MS = 30_000;

type Prediction = NonNullable<WorkbenchSession['predicted_conflicts']>;
interface RepositoryRead {
  /** The store cursor the last read started at. */
  cursor: number;
  /** When the last read ended, and when the last read of every worktree ended; 0 before the first. */
  at: number;
  full_at: number;
  pending: boolean;
  timer?: NodeJS.Timeout;
  /** By session id: the session state its paths were read at, its head and its changed paths. */
  worktrees: Map<string, { key: string; head: string; files: string[] }>;
  predictions: Map<string, { key: string; value: Prediction }>;
  shared_files?: StaleWorkspaces['shared_files'];
  /** The last recorded failure, so the same one is recorded once. */
  failure?: string;
}
const reads = new WeakMap<ControlContext, Map<string, RepositoryRead>>();

/**
 * What git says about the project's open worktree sessions, as last read. A read never runs git:
 * it schedules the work, which reads only the worktrees whose session changed and reuses a merge
 * preview while both heads stay.
 */
export function repositoryInsights(ctx: ControlContext, projectId: string): RepositoryRead {
  let cache = reads.get(ctx);
  if (!cache) reads.set(ctx, (cache = new Map()));
  let entry = cache.get(projectId);
  if (!entry) {
    entry = {
      cursor: -1,
      at: 0,
      full_at: 0,
      pending: false,
      worktrees: new Map(),
      predictions: new Map(),
    };
    cache.set(projectId, entry);
  }
  if (entry.pending || entry.timer) return entry;
  const measuring = entry,
    now = Date.now(),
    full = now - entry.full_at >= IDLE_REFRESH_MS;
  if (!full && ctx.store.cursor() === entry.cursor) return entry;
  const start = () => {
    measuring.timer = undefined;
    if (ctx.closing) return;
    measuring.pending = true;
    let work!: Promise<void>;
    work = readRepository(ctx, projectId, measuring, full).finally(() => {
      measuring.at = Date.now();
      if (full) measuring.full_at = measuring.at;
      measuring.pending = false;
      ctx.completions.delete(work);
    });
    ctx.completions.add(work);
  };
  const wait = full ? 0 : entry.at + REFRESH_MS - now;
  if (wait > 0) entry.timer = setTimeout(start, wait).unref();
  else {
    // The marker keeps a second read from scheduling the same work before it starts.
    entry.pending = true;
    setImmediate(start);
  }
  return entry;
}

async function readRepository(
  ctx: ControlContext,
  projectId: string,
  measuring: RepositoryRead,
  full: boolean,
): Promise<void> {
  try {
    measuring.cursor = ctx.store.cursor();
    const workspaces = new Map(
      ctx.store.list<Workspace>('workspaces').map((workspace) => [workspace.id, workspace]),
    );
    const active = ctx.store.list<Session>('sessions').flatMap((session) => {
      if (
        session.project_id !== projectId ||
        !session.workspace_id ||
        session.state === 'closed' ||
        session.outcome
      )
        return [];
      const workspace = workspaces.get(session.workspace_id)!;
      return workspace.kind === 'linked_worktree' &&
        workspace.removed_at === undefined &&
        (!workspace.provisioning || workspace.provisioning.state === 'ready') &&
        existsSync(workspace.path)
        ? [{ session, workspace }]
        : [];
    });
    const git = async (directory: string, args: string[], failure: string) => {
      const result = await runGit(directory, args, undefined, true);
      requireThat(result.exit_code === 0, 'workspace_read_failed', failure);
      return result.stdout.toString();
    };
    const worktrees: RepositoryRead['worktrees'] = new Map(),
      predictions: RepositoryRead['predictions'] = new Map(),
      targets = new Map<string, string>(),
      paths = new Map<string, Set<string>>();
    for (const { session, workspace } of active) {
      const key = JSON.stringify([
        session.revision,
        workspace.revision,
        workspace.path,
        workspace.base_sha,
        ctx.store.eventSpan(session.id)?.last,
      ]);
      let worktree = full ? undefined : measuring.worktrees.get(session.id);
      if (worktree?.key !== key) {
        const failure = 'Worktree changes could not be read';
        worktree = {
          key,
          head: (await git(workspace.path, ['rev-parse', '--verify', 'HEAD'], failure)).trim(),
          files: [
            await git(
              workspace.path,
              ['diff', '--name-only', '-z', workspace.base_sha!, '--'],
              failure,
            ),
            await git(
              workspace.path,
              ['ls-files', '-z', '--others', '--exclude-standard'],
              failure,
            ),
          ]
            .flatMap((names) => names.split('\0'))
            .filter(Boolean),
        };
      }
      worktrees.set(session.id, worktree);
      const source = workspace.source ?? workspace.path;
      // The same path in worktrees of different repositories is a different file.
      for (const file of worktree.files) {
        const pathKey = JSON.stringify([source, file]);
        let ids = paths.get(pathKey);
        if (!ids) paths.set(pathKey, (ids = new Set()));
        ids.add(session.id);
      }
      if (!workspace.source_branch) continue;
      const targetKey = JSON.stringify([source, workspace.source_branch]);
      let target = targets.get(targetKey);
      if (target === undefined) {
        target = (
          await git(
            source,
            ['rev-parse', '--verify', `refs/heads/${workspace.source_branch}`],
            'Merge target could not be read',
          )
        ).trim();
        targets.set(targetKey, target);
      }
      const predictionKey = JSON.stringify([workspace.path, worktree.head, target]);
      const previous = measuring.predictions.get(session.id);
      if (previous?.key === predictionKey) {
        predictions.set(session.id, previous);
        continue;
      }
      const ahead = await git(
        workspace.path,
        ['rev-list', '--count', `${target}..${worktree.head}`, '--'],
        'Worktree commits could not be read',
      );
      if (Number(ahead.trim()) === 0) continue;
      const merge = await mergePreview(source, target, worktree.head, true);
      // 129: this git has no merge preview.
      if (merge.exit_code === 129) continue;
      requireThat(
        merge.exit_code === 0 || merge.exit_code === 1,
        'workspace_read_failed',
        'Merge conflicts could not be read',
      );
      const conflicts =
        merge.exit_code === 0
          ? []
          : merge.stdout.toString().split('\0\0')[0]!.split('\0').slice(1).filter(Boolean);
      predictions.set(session.id, {
        key: predictionKey,
        value: { files: conflicts.slice(0, 20), total: conflicts.length },
      });
    }
    const shared = [...paths]
      .filter(([, ids]) => ids.size >= 2)
      .map(([key, ids]) => ({
        path: (JSON.parse(key) as [string, string])[1],
        session_ids: [...ids].sort(),
      }))
      .sort((a, b) => b.session_ids.length - a.session_ids.length || a.path.localeCompare(b.path));
    const shared_files = { files: shared.slice(0, 50), total: shared.length };
    const changed =
      JSON.stringify([...measuring.predictions]) !== JSON.stringify([...predictions]) ||
      JSON.stringify(measuring.shared_files ?? { files: [], total: 0 }) !==
        JSON.stringify(shared_files);
    measuring.worktrees = worktrees;
    measuring.predictions = predictions;
    measuring.shared_files = shared_files;
    measuring.failure = undefined;
    if (changed) {
      // Clients read again only after an event.
      ctx.store.event(
        'workspace.repository_changed',
        ctx.store.must<Project>('projects', projectId),
        projectId,
        {},
      );
      ctx.changed();
    }
  } catch (error) {
    const failure = String(error);
    if (failure === measuring.failure) return;
    measuring.failure = failure;
    ctx.store.event(
      'workspace.repository_read_failed',
      ctx.store.must<Project>('projects', projectId),
      projectId,
      { error: failure },
    );
    ctx.changed();
  }
}
