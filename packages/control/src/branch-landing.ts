import {
  DomainError,
  id,
  requireThat,
  type Landing,
  type LandingItem,
  type Principal,
  type Project,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas, type Command } from '@pantheon/protocol';
import {
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handler,
  type Preparers,
} from './context.js';
import { runGit } from './git.js';
import {
  afterSourceLandings,
  landWorkspace,
  projectGateCommands,
  recordGateBaseline,
  type GateCommands,
  type LandingOwner,
} from './landing.js';
import { mergeBase } from './merge-preview.js';
import { commitOf, projectAtRoot } from './review.js';
import { userGit } from './source-git.js';
import { registerWorkspace } from './workspace.js';

/** The input, real root and project of a project.land, once its permissions and gate are checked. */
function landTarget(ctx: ControlContext, principal: Principal, command: Command) {
  userOnly(principal);
  const input = inputSchemas['project.land'].parse(command.input);
  const { root, project } = projectAtRoot(ctx, principal, input.root, command.type);
  revision(ctx, command);
  // project.baseline.start with this project_id finds gate commands to confirm.
  if (!projectGateCommands(project, root)?.length)
    throw new DomainError(
      'no_gate_commands',
      `${root} has no gate commands; a branch lands only through the gate of its root`,
      { project_id: project.id },
    );
  return { input, root, project };
}

/** project.land; the target branch, the branch's commit and their merge base are read before the transaction. */
async function prepareBranchLanding(
  ctx: ControlContext,
  principal: Principal,
  command: Command,
): Promise<Handler> {
  const { input, root } = landTarget(ctx, principal, command);
  const checkedOut = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'], undefined, true);
  requireThat(
    checkedOut.exit_code === 0,
    'invalid_state',
    `${root} has a detached HEAD; check out the branch to land onto`,
  );
  const target_branch = checkedOut.stdout.toString().trim();
  const tip = await commitOf(root, input.branch),
    base = await mergeBase(root, await commitOf(root, 'HEAD'), tip);
  requireThat(base, 'invalid_input', `${input.branch} and ${target_branch} share no history`);
  return (ctx: ControlContext, principal: Principal, command: Command) => {
    const { input, root, project } = landTarget(ctx, principal, command);
    requireThat(
      !ctx.store
        .list<Landing>('landings')
        .some(
          (row) =>
            row.root === root &&
            row.branch === input.branch &&
            (row.state === 'queued' || row.state === 'running'),
        ),
      'resource_busy',
      `${input.branch} is already landing`,
    );
    const landingId = id();
    const registered = registerWorkspace(
      ctx,
      {
        project_id: project.id,
        kind: 'linked_worktree',
        source: root,
        base_ref: tip,
        name: 'land',
      },
      landingId,
      true,
    );
    // Provisioning keeps a base_sha already set; landWorkspace rebases from it and locks the target branch.
    const workspace = ctx.store.update<Workspace>(
      'workspaces',
      { ...registered, base_sha: base, source_branch: target_branch },
      registered.revision,
    );
    const row = ctx.store.insert<Landing>('landings', {
      id: landingId,
      revision: 1,
      project_id: project.id,
      root,
      branch: input.branch,
      target_branch,
      workspace_id: workspace.id,
      ...(input.message === undefined ? {} : { message: input.message, squashed_sha: tip }),
      ...(input.allow_gate_change ? { allow_gate_change: true } : {}),
      state: 'queued',
    });
    ctx.store.enqueue('landing.run', { landing_id: row.id });
    return row;
  };
}

export const branchLandingPreparers: Preparers = { 'project.land': prepareBranchLanding };

/**
 * Ends the row, marks its job done and queues the removal of its worktree, in one transaction; a
 * landed row records the results of the gate commands as the baseline of the target branch.
 */
function finish(
  ctx: ControlContext,
  landingId: string,
  jobId: string,
  fields: Partial<Landing> & { state: 'landed' | 'no_changes' | 'blocked' },
  commands?: GateCommands,
): void {
  ctx.store.transaction(() => {
    const row = ctx.store.must<Landing>('landings', landingId);
    const next = ctx.store.update<Landing>(
      'landings',
      { ...row, ...fields, landing: undefined, finished_at: ctx.store.now() },
      row.revision,
    );
    if (next.state === 'landed')
      recordGateBaseline(
        ctx,
        next,
        next.project_id,
        next.root,
        next.target_branch,
        next.gate_results,
        commands,
      );
    ctx.store.mark(jobId, 'done');
    ctx.store.enqueue('workspace.remove', { workspace_id: row.workspace_id, reason: 'landing' });
  });
}

function updateRow(ctx: ControlContext, landingId: string, fields: Partial<Landing>): void {
  ctx.store.transaction(() => {
    const row = ctx.store.must<Landing>('landings', landingId);
    ctx.store.update<Landing>('landings', { ...row, ...fields }, row.revision);
  });
}

/**
 * Commits base..HEAD of the worktree as one commit with the message, as the user commits;
 * a worktree that already holds that one commit is left as it is, so saved gate progress holds.
 */
async function squash(
  workspace: Workspace,
  base: string,
  message: string,
): Promise<string | undefined> {
  const read = async (args: string[]) => {
    const result = await runGit(workspace.path, args, undefined, true);
    requireThat(
      result.exit_code === 0,
      'git_failed',
      result.stderr.toString().trim() || result.error || 'Git command failed',
    );
    return result.stdout.toString().trim();
  };
  const head = await read(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head === base) return;
  if (
    (await read(['rev-list', '--count', `${base}..HEAD`])) === '1' &&
    (await read(['log', '-1', '--format=%B', 'HEAD'])) === message.trim()
  )
    return;
  await read(['reset', '--quiet', '--soft', base]);
  // Commits that undo each other leave nothing to commit; HEAD stays at base and nothing lands.
  const staged = await runGit(workspace.path, ['diff', '--cached', '--quiet'], undefined, true);
  if (staged.exit_code === 0) return;
  const committed = await userGit(workspace.path, ['commit', '--quiet', '-m', message]);
  if (committed.ok) return;
  await read(['reset', '--quiet', '--soft', head]);
  return (committed.output || 'git commit failed').split('\n')[0];
}

/**
 * The squashed commit of the newest earlier landing onto the row's target that the worktree's HEAD
 * holds and the target does not; rows list in the order they were queued.
 */
async function squashedAncestor(
  ctx: ControlContext,
  row: Landing,
  worktree: string,
): Promise<string | undefined> {
  const holds = async (cwd: string, ancestor: string, descendant: string) =>
    (await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], undefined, true))
      .exit_code === 0;
  const squashed = ctx.store
    .list<Landing>('landings')
    .filter(
      (other) =>
        other.state === 'landed' &&
        other.squashed_sha !== undefined &&
        other.root === row.root &&
        other.target_branch === row.target_branch,
    );
  for (const other of squashed.reverse())
    if (
      (await holds(worktree, other.squashed_sha!, 'HEAD')) &&
      !(await holds(row.root, other.squashed_sha!, `refs/heads/${row.target_branch}`))
    )
      return other.squashed_sha;
}

async function landBranch(ctx: ControlContext, landingId: string, jobId: string): Promise<void> {
  const workspaceId = ctx.store.must<Landing>('landings', landingId).workspace_id;
  let workspace = ctx.store.must<Workspace>('workspaces', workspaceId);
  while (['queued', 'running'].includes(workspace.provisioning!.state)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (ctx.closing) return;
    workspace = ctx.store.must<Workspace>('workspaces', workspaceId);
  }
  if (workspace.provisioning!.state !== 'ready')
    return finish(ctx, landingId, jobId, { state: 'blocked', reason: 'workspace_failed' });
  if (ctx.store.must<Landing>('landings', landingId).state === 'queued')
    updateRow(ctx, landingId, { state: 'running', started_at: ctx.store.now() });
  await afterSourceLandings(ctx, ctx.store.must<Landing>('landings', landingId).root, async () => {
    if (ctx.closing) return;
    const row = ctx.store.must<Landing>('landings', landingId);
    const project = ctx.store.must<Project>('projects', row.project_id);
    // The gate can be cleared while the landing waits for the root.
    const commands = projectGateCommands(project, row.root);
    if (!commands?.length)
      return finish(ctx, landingId, jobId, { state: 'blocked', reason: 'no_gate_commands' });
    // Commits of a branch that landed squashed would replay onto their own squashed commit.
    const squashedTip = await squashedAncestor(ctx, row, workspace.path);
    if (row.message !== undefined) {
      const worktree = ctx.store.must<Workspace>('workspaces', workspaceId);
      const failed = await squash(worktree, squashedTip ?? worktree.base_sha!, row.message);
      if (failed !== undefined)
        return finish(ctx, landingId, jobId, {
          state: 'blocked',
          reason: `commit_failed: ${failed}`,
        });
    }
    workspace = ctx.store.must<Workspace>('workspaces', workspaceId);
    const head = await runGit(
      workspace.path,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      undefined,
      true,
    );
    // Not session-: landing.ts reads an owner key of that form as the session whose task rules apply.
    const owner: LandingOwner = {
      key: `land-${landingId}`,
      projectId: row.project_id,
      cancelled: () => false,
      allowGateChange: row.allow_gate_change,
      squashedTip,
      // A gate that starts again, after the root moved, drops the results of the earlier run.
      event: (kind, payload) =>
        updateRow(ctx, landingId, {
          gate_results:
            kind === 'gate_started'
              ? []
              : (payload.results as NonNullable<LandingItem['gate_results']>),
        }),
      progress: {
        saved: row.landing,
        save: (landing) => updateRow(ctx, landingId, { landing }),
      },
    };
    const item = await landWorkspace(
      ctx,
      owner,
      workspace,
      head.exit_code === 0 ? head.stdout.toString().trim() : undefined,
      commands,
    );
    if (!item) return;
    const current = ctx.store.must<Landing>('landings', landingId);
    const { conflicts, conflict_commits } = item as LandingItem & {
      conflicts?: string[];
      conflict_commits?: string[];
    };
    finish(
      ctx,
      landingId,
      jobId,
      {
        // A rebase can drop every commit, when the target already has their changes.
        state: item.state === 'landed' && item.from_sha === item.to_sha ? 'no_changes' : item.state,
        reason: item.reason,
        conflicts,
        conflict_commits,
        gate_results: item.gate_results ?? current.gate_results,
        from_sha: item.from_sha,
        to_sha: item.to_sha,
      },
      commands,
    );
  });
}

/** By daemon, the landing jobs running now. */
const runs = new WeakMap<ControlContext, Set<string>>();

/** Runs a queued landing off the dispatch loop; its job stays pending until a result commits. */
export function runLanding(ctx: ControlContext, landingId: string, jobId: string): void {
  let running = runs.get(ctx);
  if (!running) runs.set(ctx, (running = new Set()));
  if (ctx.closing || running.has(jobId)) return;
  const row = ctx.store.get<Landing>('landings', landingId),
    workspace = row && ctx.store.get<Workspace>('workspaces', row.workspace_id);
  if (!row || !workspace || workspace.removed_at !== undefined) {
    ctx.store.transaction(() => {
      if (row)
        ctx.store.update<Landing>(
          'landings',
          {
            ...row,
            state: 'blocked',
            reason: 'workspace_missing',
            landing: undefined,
            finished_at: ctx.store.now(),
          },
          row.revision,
        );
      ctx.store.mark(jobId, 'done');
    });
    return;
  }
  running.add(jobId);
  const work: Promise<void> = landBranch(ctx, landingId, jobId)
    .catch((error: unknown) => {
      if (ctx.closing) return;
      finish(ctx, landingId, jobId, {
        state: 'blocked',
        reason: `landing_failed: ${(error as Error).message.split('\n')[0]}`,
      });
    })
    .finally(() => {
      running.delete(jobId);
      ctx.completions.delete(work);
      if (!ctx.closing) ctx.changed();
    });
  ctx.completions.add(work);
}

/** project.landing.read: one landing, to the user of its project. */
export function landingRead(ctx: ControlContext, principal: Principal, landingId: string): Landing {
  userOnly(principal);
  const row = ctx.store.get<Landing>('landings', landingId);
  if (!row) throw new DomainError('not_found', `No landing ${landingId}`);
  projectAccess(ctx, principal, row.project_id, 'project.landing.read');
  return row;
}
