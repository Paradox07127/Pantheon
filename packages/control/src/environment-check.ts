import { rm } from 'node:fs/promises';
import {
  id,
  requireThat,
  type EnvironmentCheck,
  type Principal,
  type Project,
  type ProjectBaseline,
  type Workspace,
} from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { baselineChecked, baselineCommands } from './baseline.js';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { runGit } from './git.js';
import { gateFailed, gateTemporary, runCandidateCommand } from './landing.js';
import { afterCommit } from './workbench-session.js';
import { registerWorkspace } from './workspace.js';

type CheckCommand = NonNullable<Project['gates']>[string][number];
type SetupCommand = NonNullable<NonNullable<Workspace['provisioning']>['command']>;
type Results = NonNullable<Awaited<ReturnType<typeof runCandidateCommand>>>[];

/** Tells the app a check started or ended, so its views read the checks again. */
function checkEvent(
  ctx: ControlContext,
  kind: 'started' | 'finished',
  row: EnvironmentCheck,
): void {
  ctx.store.event(`environment.check_${kind}`, row, row.project_id, {
    check_id: row.id,
    root: row.root,
    state: row.state,
    ...(row.cause.kind === 'baseline' && { baseline_id: row.cause.baseline_id }),
  });
}

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
  checkEvent(ctx, 'finished', ended);
  if (ended.cause.kind === 'baseline') baselineChecked(ctx, ended);
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
  checkEvent(ctx, 'started', row);
  checkEnvironment(ctx, row, input.commands, own ?? input.setup);
  return row;
}

export const environmentCheckHandlers: Handlers = {
  'project.environment.verify': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['project.environment.verify'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    const project = ctx.store.must<Project>('projects', input.project_id);
    requireThat(
      input.root === undefined || project.roots.includes(input.root),
      'invalid_input',
      `${input.root} is not a root of this project`,
    );
    requireThat(
      !ctx.store
        .list<EnvironmentCheck>('environment_checks')
        .some((row) => row.project_id === project.id && row.state === 'running'),
      'resource_busy',
      'An environment check of this project is running',
    );
    const roots = input.root === undefined ? project.roots : [input.root];
    if (input.baseline_id !== undefined) {
      const baseline = ctx.store.must<ProjectBaseline>('project_baselines', input.baseline_id);
      requireThat(
        baseline.project_id === project.id,
        'invalid_input',
        'The baseline is not of this project',
      );
      requireThat(
        baseline.state === 'submitted' && baseline.result,
        'invalid_state',
        'Baseline must be submitted before its commands are checked',
      );
      const folders = baseline.result.folders.filter(
        (folder) => roots.includes(folder.root) && baselineCommands(folder).length,
      );
      requireThat(folders.length, 'invalid_state', 'No folder of this baseline proposes commands');
      return folders.map((folder) =>
        startEnvironmentCheck(ctx, {
          project_id: project.id,
          root: folder.root,
          commands: baselineCommands(folder),
          ...(folder.setup && { setup: { argv: folder.setup.argv } }),
          base_ref: 'HEAD',
          cause: { kind: 'baseline', baseline_id: baseline.id, attempt: 1 },
        }),
      );
    }
    const checked = roots.flatMap((root) => {
      const commands = (project.gates?.[root] ?? []).filter((command) => command.enabled !== false);
      return commands.length ? [{ root, commands }] : [];
    });
    requireThat(checked.length, 'invalid_state', 'No root of this project has gate commands');
    return checked.map(({ root, commands }) =>
      startEnvironmentCheck(ctx, {
        project_id: project.id,
        root,
        commands,
        base_ref: 'HEAD',
        cause: { kind: 'user' },
      }),
    );
  },
};

/** The project's checks, newest first; `baseline_id` keeps the checks of that baseline's commands. */
export function environmentChecks(
  ctx: ControlContext,
  p: Principal,
  input: { project_id: string; baseline_id?: string; limit?: number },
): EnvironmentCheck[] {
  userOnly(p);
  projectAccess(ctx, p, input.project_id, 'project.environment.checks');
  return ctx.store
    .list<EnvironmentCheck>('environment_checks')
    .filter(
      (row) =>
        row.project_id === input.project_id &&
        (input.baseline_id === undefined ||
          (row.cause.kind === 'baseline' && row.cause.baseline_id === input.baseline_id)),
    )
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, input.limit ?? 20);
}

/** Startup ends checks that were running and queues the removal of their worktrees. */
export function recoverEnvironmentChecks(ctx: ControlContext): void {
  for (const row of ctx.store.list<EnvironmentCheck>('environment_checks'))
    if (row.state === 'running')
      finish(ctx, row, { state: 'inconclusive', reason_code: 'daemon_restart' });
}
