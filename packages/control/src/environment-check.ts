import { rm } from 'node:fs/promises';
import {
  id,
  type EnvironmentCheck,
  type Project,
  type Session,
  type SignalIssue,
  type Workspace,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { runGit } from './git.js';
import { gateFailed, gateTemporary, runCandidateCommand } from './landing.js';
import { noteSignalHistory } from './signals.js';
import { afterCommit } from './workbench-session.js';
import { registerWorkspace } from './workspace.js';

type CheckCommand = NonNullable<Project['gates']>[string][number];
type SetupCommand = NonNullable<NonNullable<Workspace['provisioning']>['command']>;
type Results = NonNullable<Awaited<ReturnType<typeof runCandidateCommand>>>[];

/** Ends the row and queues the removal of its worktree; the caller owns the transaction. */
function finish(
  ctx: ControlContext,
  row: EnvironmentCheck,
  end:
    | { state: 'passed' }
    | {
        state: 'failed' | 'inconclusive';
        reason_code: NonNullable<EnvironmentCheck['reason_code']>;
      },
  fields: Partial<EnvironmentCheck> = {},
): void {
  const ended = ctx.store.update<EnvironmentCheck>(
    'environment_checks',
    { ...row, ...fields, ...end, finished_at: ctx.store.now() },
    row.revision,
  );
  ctx.store.enqueue('workspace.remove', {
    workspace_id: row.workspace_id!,
    reason: 'environment_check',
  });
  if (ended.cause.kind !== 'signal') return;
  const base = ended.commit?.slice(0, 7) ?? 'the base commit',
    failed = ended.commands.find((command) => command.exit_code !== 0);
  noteSignalHistory(
    ctx,
    ended.cause.issue_id,
    ended.state === 'passed'
      ? `Passes on ${base} in a fresh worktree`
      : failed
        ? `Fails on ${base} in a fresh worktree: ${failed.name} exit ${failed.exit_code}`
        : `The check on ${base} in a fresh worktree did not finish: ${ended.reason_code}`,
  );
}

/** Waits for the worktree's provisioning, then runs the commands in it and ends the row. */
function checkEnvironment(
  ctx: ControlContext,
  row: EnvironmentCheck,
  commands: CheckCommand[],
  setup: SetupCommand | undefined,
) {
  const cancelled = () => {
    const current = ctx.store.get<EnvironmentCheck>('environment_checks', row.id);
    return current?.state !== 'running' || current.revision !== row.revision;
  };
  const committed = afterCommit(ctx);
  const work: Promise<void> = Promise.resolve()
    .then(async () => {
      if (!committed() || ctx.closing) return;
      let workspace = ctx.store.must<Workspace>('workspaces', row.workspace_id!);
      while (['queued', 'running'].includes(workspace.provisioning!.state)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (ctx.closing || cancelled()) return;
        workspace = ctx.store.must<Workspace>('workspaces', row.workspace_id!);
      }
      const provisioning = workspace.provisioning!;
      const setupResult = {
        name: 'setup',
        argv: setup?.argv ?? [],
        duration_ms:
          provisioning.started_at === undefined
            ? 0
            : (provisioning.finished_at ?? ctx.store.now()) - provisioning.started_at,
      };
      if (provisioning.state !== 'ready')
        return ctx.store.transaction(() => {
          if (cancelled()) return;
          finish(
            ctx,
            row,
            { state: 'failed', reason_code: 'setup_failed' },
            {
              commands: [
                {
                  ...setupResult,
                  exit_code: Number(/\(exit (\d+)\)/.exec(provisioning.error ?? '')?.[1] ?? -1),
                  output_tail: [provisioning.error, provisioning.output]
                    .filter(Boolean)
                    .join('\n')
                    .slice(-4000),
                },
              ],
            },
          );
        });
      const head = await runGit(workspace.path, ['rev-parse', 'HEAD'], undefined, true);
      if (head.exit_code !== 0)
        throw new Error(head.stderr.toString().trim() || head.error || 'Git command failed');
      const commit = head.stdout.toString().trim();
      const key = `gate-process:environment-check:${row.id}`,
        results: Results = [];
      const temporary = await gateTemporary(ctx);
      try {
        for (const command of commands.filter((command) => command.enabled !== false)) {
          if (ctx.closing || cancelled()) return;
          const run = () =>
            runCandidateCommand(
              ctx,
              { projectId: row.project_id, cancelled },
              key,
              command,
              workspace.path,
              commit,
              temporary,
              false,
            );
          let result = await run();
          // A failure of the machine may not repeat, so the same worktree runs the command once more.
          if (result?.failure_class === 'environment') result = await run();
          if (!result) return;
          results.push(result);
          if (gateFailed(result)) break;
        }
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        if (cancelled()) return;
        const failed = results.find(gateFailed);
        finish(
          ctx,
          row,
          !failed
            ? { state: 'passed' }
            : failed.failure_class === 'environment'
              ? { state: 'inconclusive', reason_code: 'checks_environment' }
              : { state: 'failed', reason_code: 'checks_failed' },
          {
            commit,
            commands: [
              ...(setup
                ? [{ ...setupResult, exit_code: 0, output_tail: provisioning.output ?? '' }]
                : []),
              ...results.map((result) => ({
                name: result.name,
                argv: result.argv,
                // A run that timed out or gave no exit code still failed.
                exit_code: gateFailed(result) ? result.exit_code || -1 : 0,
                duration_ms: result.duration_ms,
                output_tail: result.output,
                ...(result.failure_class ? { failure_class: result.failure_class } : {}),
              })),
            ],
          },
        );
      });
    })
    .catch(() => {
      if (ctx.closing) return;
      ctx.store.transaction(() => {
        if (!cancelled()) finish(ctx, row, { state: 'inconclusive', reason_code: 'check_error' });
      });
    })
    .finally(() => {
      ctx.completions.delete(work);
      if (!ctx.closing) ctx.changed();
    });
  ctx.completions.add(work);
}

/**
 * Inserts a running check of root and registers its throwaway worktree at base_ref; the commands
 * run after the caller's transaction commits. `setup` prepares the worktree when the project has
 * no worktree command of its own.
 */
export function startEnvironmentCheck(
  ctx: ControlContext,
  input: {
    project_id: string;
    root: string;
    commands: CheckCommand[];
    setup?: SetupCommand;
    base_ref: string;
    cause: EnvironmentCheck['cause'];
  },
): EnvironmentCheck {
  const project = ctx.store.must<Project>('projects', input.project_id),
    checkId = id();
  const own = project.worktree?.command;
  // A root that is no git checkout fails provisioning, which ends the check as a setup failure.
  let workspace = registerWorkspace(
    ctx,
    {
      project_id: project.id,
      kind: 'linked_worktree',
      source: input.root,
      base_ref: input.base_ref,
      name: 'environment-check',
    },
    checkId,
    true,
  );
  if (!own && input.setup)
    workspace = ctx.store.update<Workspace>(
      'workspaces',
      { ...workspace, provisioning: { ...workspace.provisioning!, command: input.setup } },
      workspace.revision,
    );
  const row = ctx.store.insert<EnvironmentCheck>('environment_checks', {
    id: checkId,
    revision: 1,
    project_id: project.id,
    root: workspace.source!,
    workspace_id: workspace.id,
    cause: input.cause,
    state: 'running',
    commands: [],
    started_at: ctx.store.now(),
  });
  checkEnvironment(ctx, row, input.commands, own ?? input.setup);
  return row;
}

/**
 * Starts a check of the issue's failed gate command, or of the whole gate without a name, on the
 * head of the root the session's gate ran in. Each issue gets one check, and a project runs one at
 * a time; a muted issue leaves the check to the issue that muted it. The caller owns the
 * transaction.
 */
export function checkOnBase(
  ctx: ControlContext,
  issue: SignalIssue,
  sessionId: string | undefined,
  name?: string,
): void {
  if (
    issue.state === 'muted' ||
    ctx.store
      .list<EnvironmentCheck>('environment_checks')
      .some(
        (row) =>
          row.project_id === issue.project_id &&
          (row.state === 'running' ||
            (row.cause.kind === 'signal' && row.cause.issue_id === issue.id)),
      )
  )
    return;
  const project = ctx.store.must<Project>('projects', issue.project_id),
    workspaceId = sessionId && ctx.store.get<Session>('sessions', sessionId)?.workspace_id,
    root =
      (workspaceId && ctx.store.get<Workspace>('workspaces', workspaceId)?.source) ||
      project.roots[0]!;
  const commands = (project.gates?.[root] ?? []).filter(
    (command) => command.enabled !== false && (name === undefined || command.name === name),
  );
  if (!commands.length) return;
  try {
    startEnvironmentCheck(ctx, {
      project_id: project.id,
      root,
      commands,
      base_ref: 'HEAD',
      cause: { kind: 'signal', issue_id: issue.id },
    });
  } catch {
    // A root Pantheon cannot make a worktree of gets no check; the gate run is still recorded.
  }
}

/** Startup ends checks that were running and queues the removal of their worktrees. */
export function recoverEnvironmentChecks(ctx: ControlContext): void {
  for (const row of ctx.store.list<EnvironmentCheck>('environment_checks'))
    if (row.state === 'running')
      finish(ctx, row, { state: 'inconclusive', reason_code: 'daemon_restart' });
}
