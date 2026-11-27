import { requireThat, type Principal, type Session, type Workspace } from '@pantheon/domain';
import type { ProjectOverlap } from '@pantheon/protocol';
import { globalExcludes } from './checkpoint.js';
import { projectAccess, type ControlContext } from './context.js';
import { workspaceReady } from './provisioning.js';
import { BOUND, sourceGit } from './source-git.js';
import { workspaceReadAccess } from './workspace.js';

export async function projectOverlap(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): Promise<ProjectOverlap> {
  projectAccess(ctx, principal, projectId, 'project.overlap');
  ctx.store.must('projects', projectId);
  const repositories = new Map<
    string,
    { session_id: string; workspace: Workspace; base: string }[]
  >();
  for (const session of ctx.store.list<Session>('sessions')) {
    if (
      session.project_id !== projectId ||
      !session.workspace_id ||
      session.state === 'closed' ||
      session.outcome
    )
      continue;
    const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id);
    if (workspace.kind === 'in_place' && session.archived_at) continue;
    const base = workspace.kind === 'in_place' ? session.in_place?.base_sha : workspace.base_sha;
    if (!workspaceReady(workspace) || !base) continue;
    const source = workspace.source!;
    let sessions = repositories.get(source);
    if (!sessions) repositories.set(source, (sessions = []));
    sessions.push({ session_id: session.id, workspace, base });
  }
  const pairs: ProjectOverlap['pairs'] = [];
  for (const sessions of repositories.values()) {
    if (sessions.length < 2) continue;
    const untracked = [
      ...(await globalExcludes()),
      'ls-files',
      '--others',
      '--exclude-standard',
      '--full-name',
      '-z',
    ];
    sessions.sort((a, b) => a.session_id.localeCompare(b.session_id));
    const changes = await Promise.all(
      sessions.map(async ({ workspace, base, session_id }) => {
        const git =
          workspace.kind === 'linked_worktree'
            ? workspaceReadAccess(ctx, principal, workspace).git
            : sourceGit(ctx, principal, projectId, workspace.path);
        requireThat(git, 'workspace_unavailable', 'Workspace is not a Git checkout');
        const paths = new Set<string>();
        for (const args of [['diff', '--name-only', '--no-renames', '-z', base, '--'], untracked]) {
          const result = await git(args, BOUND);
          requireThat(
            result.exit_code === 0,
            'workspace_read_failed',
            result.error ?? result.stderr.toString(),
          );
          for (const name of result.stdout.toString().split('\0')) if (name) paths.add(name);
        }
        return { session_id, workspace_id: workspace.id, paths };
      }),
    );
    for (const [index, first] of changes.entries()) {
      for (const second of changes.slice(index + 1)) {
        // Sessions in one checkout cannot tell their changes apart.
        if (second.workspace_id === first.workspace_id) continue;
        const paths = [...first.paths].filter((path) => second.paths.has(path)).sort();
        if (paths.length) pairs.push({ session_ids: [first.session_id, second.session_id], paths });
      }
    }
  }
  return {
    pairs,
    refresh_events: [
      'session.opened',
      'workspace.ready',
      'workspace.repository_changed',
      'workspace.removed',
      'agent.tool.completed',
      'session.write_detected',
      'turn.completed',
      'turn.failed',
      'turn.cancelled',
      'session.remote_pull_changed',
      'session.rolled_back',
      'session.resumed',
      'session.merged',
      'session.discarded',
      'session.archived',
      'session.unarchived',
      'session.closed',
      'session.deleted',
    ],
  };
}
