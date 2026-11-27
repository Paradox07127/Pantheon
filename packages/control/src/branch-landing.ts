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
  type Handlers,
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
import {
  gateRunPassed,
  insertLandingRecord,
  listLandedCommits,
  recordEndSequence,
} from './project-landings.js';
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

export const branchLandingHandlers: Handlers = {
  // The landing reads the flag only where it can stop without leaving the root half-moved.
  'project.landing.cancel': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['project.landing.cancel'].parse(c.input);
    const row = ctx.store.get<Landing>('landings', input.landing_id);
    if (!row) throw new DomainError('not_found', `No landing ${input.landing_id}`);
    projectAccess(ctx, p, row.project_id, c.type);
    revision(ctx, c);
    requireThat(
      row.state === 'queued' || row.state === 'running',
      'invalid_state',
      `Landing ${row.id} already finished`,
    );
    // Once the gate passed, the landing moves the target without checking the flag again.
    requireThat(!row.landing, 'invalid_state', `Landing ${row.id} passed its gate and is landing`);
    return ctx.store.update<Landing>('landings', { ...row, cancel_requested: true }, row.revision);
  },
};

function gateHistory(row: Landing) {
  return {
    gate_runs: row.gate_runs ?? Number(row.gate_started_at !== undefined),
    first_gate_passed:
      row.first_gate_passed ??
      (row.gate_finished_at !== undefined && gateRunPassed(row.gate_results!)),
  };
}

type LandingOutcome = Partial<Landing> & { state: 'landed' | 'no_changes' | 'blocked' };
type FinishLanding = (
  fields: LandingOutcome,
  commands?: GateCommands,
  landedCommits?: string[],
) => void;

/**
 * Ends the row, marks its job done and queues the removal of its worktree, in one transaction; a
 * landed row records the results of the gate commands as the baseline of the target branch.
 */
function finish(
  ctx: ControlContext,
  landingId: string,
  jobId: string,
  commits: string[] | null,
  fields: LandingOutcome,
  commands?: GateCommands,
  landedCommits?: string[],
): void {
  ctx.store.transaction(() => {
    const row = ctx.store.must<Landing>('landings', landingId);
    const next = ctx.store.update<Landing>(
      'landings',
      { ...row, ...fields, landing: undefined, finished_at: ctx.store.now() },
      row.revision,
    );
    const workspace = ctx.store.get<Workspace>('workspaces', row.workspace_id);
    const branch = row.branch.replace(/^refs\/heads\//, '');
    const reviews = ctx.store
      .statement(
        `
      WITH previous AS (
        SELECT ${recordEndSequence} AS cutoff
        FROM landing_records r JOIN landings l ON l.id=r.id
        WHERE r.data->>'$.project_id'=$project AND l.data->>'$.root'=$root
          AND r.data->>'$.branch' IN ($branch,$ref)
        ORDER BY r.rowid DESC LIMIT 1
      )
      SELECT count(*) AS rounds FROM reviews
      WHERE json_extract(data,'$.project_id')=$project AND data->>'$.range.source'=$root
        AND (NOT EXISTS (SELECT 1 FROM previous) OR EXISTS (
          SELECT 1 FROM events WHERE aggregate_id=reviews.id AND kind='review.requested'
            AND sequence>(SELECT cutoff FROM previous)
        ))
        AND data->>'$.range.to_sha' IN (SELECT value FROM json_each($commits))
    `,
      )
      .get({
        $project: row.project_id,
        $root: row.root,
        $branch: branch,
        $ref: `refs/heads/${branch}`,
        $commits: JSON.stringify(commits),
      });
    insertLandingRecord(
      ctx,
      {
        id: row.id,
        revision: 1,
        project_id: row.project_id,
        branch: row.branch,
        state: fields.state,
        reason: next.reason ?? null,
        ended_at: next.finished_at!,
        landed_sha: fields.state === 'landed' ? next.to_sha! : null,
        ...gateHistory(next),
        review_rounds: commits === null ? null : Number(reviews!.rounds),
        turns: 0,
        input_tokens: 0,
        output_tokens: 0,
        wall_ms: null,
      },
      landedCommits,
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
    if (workspace && workspace.removed_at === undefined)
      ctx.store.enqueue('workspace.remove', { workspace_id: row.workspace_id, reason: 'landing' });
  });
}

function updateRow(
  ctx: ControlContext,
  landingId: string,
  fields: (row: Landing) => Partial<Landing>,
): void {
  ctx.store.transaction(() => {
    const row = ctx.store.must<Landing>('landings', landingId);
    ctx.store.update<Landing>('landings', { ...row, ...fields(row) }, row.revision);
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
 * The nearest commit HEAD shares with the branch of an earlier squashed landing onto the row's
 * target, when the target holds that landing's squashed commit but not the shared commit itself.
 */
async function squashedAncestor(
  ctx: ControlContext,
  row: Landing,
  worktree: string,
): Promise<string | undefined> {
  const holds = async (cwd: string, ancestor: string, descendant: string) =>
    (await runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant], undefined, true))
      .exit_code === 0;
  const target = `refs/heads/${row.target_branch}`;
  const cuts: string[] = [];
  for (const other of ctx.store.list<Landing>('landings'))
    if (
      other.state === 'landed' &&
      other.squashed_sha !== undefined &&
      other.to_sha !== undefined &&
      other.root === row.root &&
      other.target_branch === row.target_branch
    ) {
      const cut = await runGit(
        worktree,
        ['merge-base', 'HEAD', other.squashed_sha],
        undefined,
        true,
      );
      const sha = cut.stdout.toString().trim();
      if (
        cut.exit_code === 0 &&
        !(await holds(row.root, sha, target)) &&
        (await holds(row.root, other.to_sha, target))
      )
        cuts.push(sha);
    }
  for (const cut of cuts) {
    let nearest = true;
    for (const other of cuts) nearest &&= await holds(worktree, other, cut);
    if (nearest) return cut;
  }
}

async function landBranch(
  ctx: ControlContext,
  landingId: string,
  finish: FinishLanding,
  collectCommits: (base: string) => Promise<void>,
): Promise<void> {
  const workspaceId = ctx.store.must<Landing>('landings', landingId).workspace_id;
  let workspace = ctx.store.must<Workspace>('workspaces', workspaceId);
  const cancelled = () => ctx.store.must<Landing>('landings', landingId).cancel_requested === true;
  const block = (reason: string) => finish({ state: 'blocked', reason });
  while (['queued', 'running'].includes(workspace.provisioning!.state)) {
    if (cancelled()) return block('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (ctx.closing) return;
    workspace = ctx.store.must<Workspace>('workspaces', workspaceId);
  }
  if (cancelled()) return block('cancelled');
  if (workspace.provisioning!.state !== 'ready') return block('workspace_failed');
  if (ctx.store.must<Landing>('landings', landingId).state === 'queued')
    updateRow(ctx, landingId, () => ({ state: 'running', started_at: ctx.store.now() }));
  let entered = false,
    ended = false;
  const landed = afterSourceLandings(
    ctx,
    ctx.store.must<Landing>('landings', landingId).root,
    async () => {
      entered = true;
      if (ended || ctx.closing) return;
      const row = ctx.store.must<Landing>('landings', landingId);
      // Commits of a branch that landed squashed would replay onto their own squashed commit.
      const squashedTip = await squashedAncestor(ctx, row, workspace.path);
      await collectCommits(
        squashedTip ?? row.landing?.from_sha ?? `refs/heads/${row.target_branch}`,
      );
      if (cancelled()) return block('cancelled');
      const project = ctx.store.must<Project>('projects', row.project_id);
      // The gate can be cleared while the landing waits for the root.
      const commands = projectGateCommands(project, row.root);
      if (!commands?.length) return block('no_gate_commands');
      if (row.message !== undefined) {
        const worktree = ctx.store.must<Workspace>('workspaces', workspaceId);
        const failed = await squash(worktree, squashedTip ?? worktree.base_sha!, row.message);
        if (failed !== undefined)
          return finish({
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
        cancelled,
        allowGateChange: row.allow_gate_change,
        squashedTip,
        // A gate that starts again, after the root moved, drops the results of the earlier run.
        event: (kind, payload) =>
          updateRow(ctx, landingId, (current) => {
            if (kind === 'gate_started') {
              const { gate_runs, first_gate_passed } = gateHistory(current);
              return {
                gate_runs: gate_runs + 1,
                first_gate_passed,
                gate_results: [],
                gate_started_at: ctx.store.now(),
                gate_finished_at: undefined,
              };
            }
            const results = payload.results as NonNullable<LandingItem['gate_results']>;
            if (kind === 'gate_step_checked') return { gate_results: results };
            return {
              gate_results: results,
              gate_finished_at: ctx.store.now(),
              first_gate_passed:
                (current.gate_runs ?? 1) === 1 ? gateRunPassed(results) : current.first_gate_passed,
            };
          }),
        progress: {
          saved: row.landing,
          save: (landing) => updateRow(ctx, landingId, () => ({ landing })),
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
      // A rebase can drop every commit when the target already has their changes.
      const state =
        item.state === 'landed' && item.from_sha === item.to_sha ? 'no_changes' : item.state;
      finish(
        {
          state,
          reason: item.reason,
          conflicts,
          conflict_commits,
          gate_results: item.gate_results ?? current.gate_results,
          from_sha: item.from_sha,
          to_sha: item.to_sha,
        },
        commands,
        state === 'landed' ? await listLandedCommits(row.root, item.from_sha!, item.to_sha!) : [],
      );
    },
  );
  // A cancel while another landing holds the root ends this one now; its turn in the queue does nothing.
  while (!entered) {
    await Promise.race([landed, new Promise((resolve) => setTimeout(resolve, 250))]);
    if (!entered && !ctx.closing && cancelled()) {
      ended = true;
      return block('cancelled');
    }
  }
  await landed;
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
  if (!row) {
    ctx.store.mark(jobId, 'done');
    return;
  }
  let commits: string[] | null = [];
  const finishAttempt: FinishLanding = (fields, commands, landedCommits) =>
    finish(ctx, landingId, jobId, commits, fields, commands, landedCommits);
  if (!workspace || workspace.removed_at !== undefined) {
    finishAttempt({ state: 'blocked', reason: 'workspace_missing' });
    return;
  }
  running.add(jobId);
  const work: Promise<void> = landBranch(ctx, landingId, finishAttempt, async (base) => {
    const result = await runGit(
      row.root,
      ['rev-list', `${base}..${workspace.provisioning!.base_ref}`],
      undefined,
      true,
    );
    commits =
      result.exit_code === 0 ? result.stdout.toString().trim().split('\n').filter(Boolean) : null;
  })
    .catch((error: unknown) => {
      if (ctx.closing) return;
      finishAttempt({
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

/** project.landing.find: the queued or running landing of the branch at the root, to the user. */
export function landingFind(
  ctx: ControlContext,
  principal: Principal,
  named: string,
  branch: string,
): Landing {
  userOnly(principal);
  const { root } = projectAtRoot(ctx, principal, named, 'project.landing.find');
  const row = ctx.store
    .list<Landing>('landings')
    .find(
      (each) =>
        each.root === root &&
        each.branch === branch &&
        (each.state === 'queued' || each.state === 'running'),
    );
  if (!row) throw new DomainError('not_found', `${branch} is not landing at ${root}`);
  return row;
}
