import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  DomainError,
  hash,
  requireThat,
  type BoardPlan,
  type GateFailureClass,
  type Project,
  type LandingItem,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { rootOf, type ControlContext } from './context.js';
import {
  copyCandidateDependencies,
  runValidationCommand,
  type ValidationResult,
} from './validation-executor.js';
import { retryingIndexLock, runGit } from './git.js';
import { segments } from './task-dispatch.js';
import { retiredBinding, taskGeneration, sessionPlanTask } from './board-plan.js';
import { workflowPolicy } from './workflow-policy.js';
import { onDevice } from './remote-workspace.js';
import { forgetWorktreeReads } from './workbench-session.js';
import { headerPath } from './landing-diff.js';
import { recordGateRun } from './signal-sources.js';

type GateCommands = NonNullable<Project['gates']>[string];
export type LandingProgress = NonNullable<NonNullable<Session['merge']>['landing']>;

/** What a landing belongs to; its key names the landing lease, refs and gate processes. */
export interface LandingOwner {
  key: string;
  projectId: string;
  cancelled(): boolean;
  event(
    kind: 'gate_started' | 'gate_step_checked' | 'gate_checked',
    payload: Record<string, unknown>,
  ): void;
  session_id?: string;
  /** The progress an earlier run of this landing saved, and where this run saves its own. */
  progress?: { saved?: LandingProgress; save(progress: LandingProgress): void };
  /** Paths the landed change must stay within; absent allows any path, empty none. */
  scope?: string[];
  /** A workflow approval may hold a gated candidate before the source moves. */
  beforeLand?(): boolean;
}

/** The argv of the gate commands, as a landing saves and compares them. */
export const gateArgv = (commands: GateCommands | undefined) =>
  JSON.stringify(
    commands?.map((command) =>
      command.skippable ? { argv: command.argv, skippable: true } : command.argv,
    ) ?? [],
  );

/** What a saved gate result holds for: the argv and time limits, and a digest of the env and runner. */
const gateKey = (ctx: ControlContext, projectId: string, commands: GateCommands | undefined) =>
  JSON.stringify({
    argv: gateArgv(commands),
    timeouts: commands?.map((command) => command.timeout_ms ?? null) ?? [],
    settings: hash({
      env: ctx.store.must<Project>('projects', projectId).env ?? {},
      runner: workflowPolicy(ctx, projectId).gate_runner,
    }),
  });

/** The current task contract; retired sessions cannot borrow a task that reuses their id. */
function taskOfSession(ctx: ControlContext, session: Session) {
  const task = session.task,
    direct = session.direct_task;
  const plan = task
    ? ctx.store.get<BoardPlan>('board_plans', task.lead_session_id)
    : direct && ctx.store.get<BoardPlan>('board_plans', session.id);
  return (task && !retiredBinding(plan, session)) ||
    (direct && direct.generation === taskGeneration(plan, direct.id))
    ? plan && sessionPlanTask(plan, session)
    : undefined;
}

/** The enabled gate commands of one project root. */
export function projectGateCommands(project: Project, root: string): GateCommands | undefined {
  return project.gates?.[root]?.filter((command) => command.enabled !== false);
}

/**
 * The gate of the project folder a clone delivers into, then the acceptance of the session's
 * board task, which may need what the gate built.
 */
export function gateCommands(
  ctx: ControlContext,
  project: Project,
  workspace: Workspace,
  session: Session,
): GateCommands | undefined {
  const folder = workspace.source ? rootOf(project, [workspace.source]) : undefined;
  const configured = folder ? projectGateCommands(project, folder) : undefined;
  const task = taskOfSession(ctx, session);
  const acceptance = task?.acceptance ?? [];
  if (!acceptance.length) return configured;
  return [
    ...(configured ?? []),
    ...acceptance.map((command) => ({ name: command, argv: ['/bin/sh', '-c', command] })),
  ];
}

/**
 * A run that timed out, could not start, was killed by a signal or was refused by the gate sandbox
 * failed because of the machine.
 */
function failureClass(result: ValidationResult): GateFailureClass | undefined {
  if (result.timedOut || (result.exit_code === null && result.error) || result.signal)
    return 'environment';
  if (result.exit_code === 0) return;
  // Only the sandbox prints these; a bare "Operation not permitted" also comes from ordinary failures.
  const output = result.log.toString();
  return output.includes('(file system sandbox blocked') ||
    output.includes('sandbox_apply: Operation not permitted')
    ? 'environment'
    : 'code';
}

/** Who runs a gate command; allGates marks every command as a gate candidate, as an environment check's are. */
type GateRunner = Pick<LandingOwner, 'projectId' | 'cancelled'> & { allGates?: boolean };

// The most gate commands one daemon runs at once, across all sources and kinds of check.
const GATE_SLOTS = 2;
/** Each daemon's gate commands in a slot, and the waiters a freed slot passes to in arrival order. */
const gateSlots = new WeakMap<ControlContext, { running: number; waiting: (() => void)[] }>();

/** Runs `run` in a gate slot; undefined when the daemon closed or the run was cancelled first. */
async function inGateSlot<T>(
  ctx: ControlContext,
  cancelled: () => boolean,
  run: () => Promise<T>,
): Promise<T | undefined> {
  let slots = gateSlots.get(ctx);
  if (!slots) gateSlots.set(ctx, (slots = { running: 0, waiting: [] }));
  const held = slots;
  // A freed slot passes straight to the first waiter, so a free slot means nobody waits.
  if (held.running < GATE_SLOTS) held.running++;
  else {
    const granted = await new Promise<boolean>((resolve) => {
      const grant = () => {
        clearInterval(poll);
        resolve(true);
      };
      const poll = setInterval(() => {
        if (!ctx.closing && !cancelled()) return;
        clearInterval(poll);
        held.waiting.splice(held.waiting.indexOf(grant), 1);
        resolve(false);
      }, 50);
      held.waiting.push(grant);
    });
    if (!granted) return;
  }
  try {
    return await run();
  } finally {
    const next = held.waiting.shift();
    if (next) next();
    else held.running--;
  }
}

/** The command's result; undefined when it was stopped while it waited for a gate slot. */
async function runGateCommand(
  ctx: ControlContext,
  owner: GateRunner,
  key: string,
  command: GateCommands[number],
  candidate: string,
  disposable: boolean,
): Promise<NonNullable<LandingItem['gate_results']>[number] | undefined> {
  const result = await inGateSlot(ctx, owner.cancelled, () => {
    // Read once the slot is held: the user can change the project while the command waits.
    const project = ctx.store.must<Project>('projects', owner.projectId);
    return runValidationCommand({
      ctx,
      key,
      argv: command.argv,
      cwd: candidate,
      root: candidate,
      ...(disposable ? { disposable } : {}),
      // Gates inherit no daemon credentials. PATH locates installed executables only;
      // the sandbox still controls which files and child processes they can access.
      env: {
        ...project.env,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        // Gates verify a candidate without installing; pnpm's pre-run install writes the store outside the sandbox.
        pnpm_config_verify_deps_before_run: 'false',
      },
      // The user opened the GPU to the project's gate commands, not to acceptance or hidden checks.
      gpu:
        project.gate_gpu === true &&
        (owner.allGates === true ||
          Object.values(project.gates ?? {}).some((commands) =>
            commands.some((gate) => JSON.stringify(gate.argv) === JSON.stringify(command.argv)),
          )),
      timeoutMs: command.timeout_ms ?? 1200000,
      cancelled: owner.cancelled,
    });
  });
  if (!result) return;
  const failure = failureClass(result);
  return Object.assign(
    {
      state: failure
        ? command.skippable
          ? ('skipped' as const)
          : ('failed' as const)
        : ('passed' as const),
      ...(failure && command.skippable
        ? {
            reason: (result.error ?? result.tail) || (result.timedOut ? 'timeout' : 'cannot_start'),
          }
        : {}),
      name: command.name,
      argv: command.argv,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      timed_out: result.timedOut,
      output: (result.error ?? result.tail).slice(-4000),
      ...(result.tests ? { tests: result.tests } : {}),
      ...(failure ? { failure_class: failure } : {}),
    },
    { boundary: result.boundary, stopped: result.stopped },
  );
}

export const gateFailed = (result: NonNullable<LandingItem['gate_results']>[number]): boolean =>
  result.state !== 'skipped' && (result.exit_code !== 0 || result.timed_out);

/** The newest merge of each source repository; the next one starts after it. */
const sourceMerges = new WeakMap<ControlContext, Map<string, Promise<void>>>();

/** Runs `run` after the newest landing of the same source repository ends. */
export function afterSourceLandings(
  ctx: ControlContext,
  source: string,
  run: () => Promise<void>,
): Promise<void> {
  let queue = sourceMerges.get(ctx);
  if (!queue) sourceMerges.set(ctx, (queue = new Map()));
  // Two landings that read the same source HEAD would race its ref update.
  const completion: Promise<void> = (queue.get(source) ?? Promise.resolve())
    .catch(() => {})
    .then(() => run())
    .finally(() => {
      if (queue.get(source) === completion) queue.delete(source);
      ctx.completions.delete(completion);
      if (!ctx.closing) ctx.changed();
    });
  queue.set(source, completion);
  ctx.completions.add(completion);
  void completion.catch(() => {});
  return completion;
}

function gitFailure(result: Awaited<ReturnType<typeof runGit>>): string {
  return (result.stderr.toString().trim() || result.error || 'Git command failed').split('\n')[0]!;
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await runGit(cwd, args, undefined, true, { env });
  if (result.exit_code !== 0) throw new Error(gitFailure(result));
  return result.stdout.toString().trim();
}

/** Agent configuration a session cannot write in its worktree, as protection.ts lists it. */
export const AGENT_CONFIGURATION = ['.claude', '.codex', '.mcp.json'];

const testPath = (file: string) =>
  /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|(?:^|[._-])(?:test|spec)\.[^/]+$|(?:^|\/)test_[^/]+$/.test(
    file,
  );

/** Paths the candidate adds, changes, deletes or renames since it forked from parent. */
async function changedPaths(cwd: string, parent: string, candidate: string): Promise<string[]> {
  const fields = (
    await git(cwd, ['diff', '--name-status', '-z', '-M', `${parent}...${candidate}`, '--'])
  ).split('\0');
  const paths: string[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    // A rename or copy names its old path, then its new one.
    const count = /^[RC]/.test(status) ? 2 : 1;
    paths.push(...fields.slice(index, index + count));
    index += count;
  }
  return [...new Set(paths)];
}

/** Each file's patch since the candidate forked from parent, from one diff of them all. */
async function filePatches(
  cwd: string,
  parent: string,
  candidate: string,
  files: string[],
): Promise<Map<string, string>> {
  if (!files.length) return new Map();
  const lines = new Map<string, string[]>();
  const patch = await git(cwd, [
    '--literal-pathspecs',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--no-color',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--unified=0',
    `${parent}...${candidate}`,
    '--',
    ...files,
  ]);
  let file: string | undefined;
  for (const line of patch.split('\n')) {
    // A file that changes type has two parts, each with its own header.
    if (line.startsWith('diff --git ')) file = headerPath(line);
    if (file === undefined) continue;
    const own = lines.get(file);
    if (own) own.push(line);
    else lines.set(file, [line]);
  }
  return new Map([...lines].map(([name, own]) => [name, own.join('\n')]));
}

/** The files that name an object in commit, from one cat-file run. */
async function presentIn(cwd: string, commit: string, files: string[]): Promise<Set<string>> {
  // Batch input ends each name at a newline, so a path containing one counts as present.
  const asked = files.filter((file) => !file.includes('\n'));
  const present = new Set(files.filter((file) => file.includes('\n')));
  if (!asked.length) return present;
  const result = await runGit(
    cwd,
    ['cat-file', '--batch-check'],
    Buffer.from(asked.map((file) => `${commit}:${file}\n`).join('')),
    true,
  );
  if (result.exit_code !== 0) throw new Error(gitFailure(result));
  const lines = result.stdout.toString().split('\n');
  asked.forEach((file, index) => {
    if (!/ (?:missing|ambiguous)$/.test(lines[index]!)) present.add(file);
  });
  return present;
}

/** Changed paths of the candidate outside every scope path. */
async function outOfScope(
  cwd: string,
  parent: string,
  candidate: string,
  scope: string[],
): Promise<string[]> {
  return (await changedPaths(cwd, parent, candidate)).filter(
    (file) => !scope.some((entry) => within(file, entry)),
  );
}

/**
 * Tracked paths of the candidate that differ from commit. A fresh index from the commit keeps
 * index flags such as skip-worktree that a command set from hiding them.
 */
async function changedTracked(candidate: string, commit: string, index: string): Promise<string> {
  const run = async (args: string[]) => {
    const result = await runGit(candidate, args, undefined, true, {
      env: { GIT_INDEX_FILE: index },
    });
    if (result.exit_code !== 0) throw new Error(gitFailure(result));
    return result.stdout.toString().trim();
  };
  await run(['read-tree', commit]);
  return run(['status', '--porcelain=v1', '--untracked-files=no']);
}

/** True when the path equals the scope entry or lies below it, compared by path segment. */
function within(file: string, entry: string): boolean {
  const inner = segments(file),
    outer = segments(entry);
  return outer.length <= inner.length && outer.every((segment, index) => segment === inner[index]);
}

async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const result = await runGit(
    cwd,
    ['merge-base', '--is-ancestor', ancestor, descendant],
    undefined,
    true,
    { env },
  );
  if (result.exit_code === 0) return true;
  if (result.exit_code === 1) return false;
  throw new Error(gitFailure(result));
}

/**
 * The source's git directories, pinned so a commondir written there later cannot point landing's
 * git at configuration a session wrote; undefined when the source already has one git never makes.
 */
async function sourceGitEnv(source: string): Promise<NodeJS.ProcessEnv | undefined> {
  const located = await runGit(
    source,
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
    undefined,
    true,
  );
  if (located.error?.startsWith('sandbox_path_replaced')) return undefined;
  if (located.exit_code !== 0) throw new Error(gitFailure(located));
  const [gitDir = '', commonDir = '', workTree = ''] = located.stdout.toString().trim().split('\n');
  if (commonDir !== gitDir && path.dirname(gitDir) !== path.join(commonDir, 'worktrees'))
    return undefined;
  return {
    GIT_DIR: gitDir,
    GIT_COMMON_DIR: commonDir,
    GIT_WORK_TREE: workTree,
    // Only local transport, so no rewritten URL reaches ssh or a helper command.
    GIT_ALLOW_PROTOCOL: 'file',
  };
}

/** The user's own identity for the source, read with their normal git configuration. */
export async function sourceCommitter(
  source: string,
): Promise<{ name: string; email: string } | undefined> {
  const read = (key: string) =>
    promisify(execFile)('git', ['config', '--get', key], { cwd: source, timeout: 120000 }).then(
      ({ stdout }) => stdout.trim(),
      () => '',
    );
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  return name && email ? { name, email } : undefined;
}

/** A new directory for one gate run's clone and index. */
export async function gateTemporary(ctx: ControlContext): Promise<string> {
  // Candidate tests may create managed workspaces, which refuse temporary directories.
  const gates = ctx.workspaceRoot ? path.join(ctx.workspaceRoot, '.gates') : os.tmpdir();
  await mkdir(gates, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(gates, 'pantheon-gate-'));
}

/** A clone of repository at commit with the dependency folders of source; undefined when stopped. */
async function cloneCandidate(
  ctx: ControlContext,
  key: string,
  repository: string,
  source: string,
  commit: string,
  temporary: string,
  cancelled: () => boolean,
): Promise<string | undefined> {
  const candidate = path.join(temporary, 'repository');
  const clone = () =>
    git(temporary, ['clone', '--no-hardlinks', '--quiet', '--', repository, candidate]);
  // A local clone copies object files one by one; a temporary one another git writes meanwhile can vanish first.
  await clone().catch(async (error: Error) => {
    if (!error.message.includes('failed to copy file')) throw error;
    await rm(candidate, { recursive: true, force: true });
    await clone();
  });
  await git(candidate, ['checkout', '--quiet', '--detach', commit]);
  return (await copyCandidateDependencies(ctx, key, source, candidate, cancelled))
    ? candidate
    : undefined;
}

/** Runs one command on the candidate, failed when it changed tracked files; undefined when stopped. */
async function runChecked(
  ctx: ControlContext,
  owner: GateRunner,
  key: string,
  command: GateCommands[number],
  candidate: string,
  commit: string,
  temporary: string,
  disposable: boolean,
) {
  const result = await runGateCommand(ctx, owner, key, command, candidate, disposable);
  if (!result || ctx.closing || owner.cancelled()) return;
  // Later commands would check another tree than the commit that lands.
  const changed = await changedTracked(candidate, commit, path.join(temporary, 'index'));
  if (changed)
    Object.assign(result, {
      exit_code: null,
      state: 'failed',
      failure_class: 'code',
      output:
        `The command changed tracked files of the candidate, so it did not check the commit:\n${changed}`.slice(
          0,
          4000,
        ),
    });
  return result;
}
export { runChecked as runCandidateCommand };

/**
 * Runs commands on commit in a fresh clone of source as the gate does, without the gate's events
 * or its recorded run; undefined when it stopped early.
 */
export async function checkCandidate(
  ctx: ControlContext,
  input: {
    key: string;
    projectId: string;
    source: string;
    commit: string;
    commands: GateCommands;
    cancelled(): boolean;
  },
): Promise<NonNullable<LandingItem['gate_results']> | undefined> {
  if (ctx.closing || input.cancelled()) return;
  const key = `gate-process:${input.key}`,
    results: NonNullable<LandingItem['gate_results']> = [];
  const temporary = await gateTemporary(ctx);
  try {
    const { source, commit } = input;
    const candidate = await cloneCandidate(
      ctx,
      key,
      source,
      source,
      commit,
      temporary,
      input.cancelled,
    );
    if (!candidate) return;
    for (const command of input.commands.filter((command) => command.enabled !== false)) {
      if (ctx.closing || input.cancelled()) return;
      const run = () => runChecked(ctx, input, key, command, candidate, commit, temporary, true);
      let result = await run();
      // A failure of the machine may not repeat, so the same candidate runs the command once more.
      if (result?.failure_class === 'environment') result = await run();
      if (!result) return;
      results.push(result);
      if (gateFailed(result)) break;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return ctx.closing || input.cancelled() ? undefined : results;
}

/** Runs the gate on commit in a fresh clone of the workspace; undefined when it stopped early. */
export async function checkGates(
  ctx: ControlContext,
  owner: LandingOwner,
  workspace: Workspace,
  source: string,
  commands: GateCommands,
  commit: string,
  previous: NonNullable<LandingItem['gate_results']> = [],
): Promise<NonNullable<LandingItem['gate_results']> | undefined> {
  commands = commands.filter((command) => command.enabled !== false);
  const policy = workflowPolicy(ctx, owner.projectId);
  const session = owner.session_id
    ? ctx.store.must<Session>('sessions', owner.session_id)
    : undefined;
  requireThat(
    policy.gate_runner !== 'session' || !session || !onDevice(session),
    'unsupported_capability',
    'Remote session gates cannot return bounded command exit codes',
  );
  const results: NonNullable<LandingItem['gate_results']> = [];
  if (ctx.closing || owner.cancelled()) return;
  const temporary = await gateTemporary(ctx);
  try {
    const inSession = policy.gate_runner === 'session' && !!session;
    const key = `gate-process:${owner.key}:${workspace.id}`;
    const candidate = inSession
      ? workspace.path
      : await cloneCandidate(ctx, key, workspace.path, source, commit, temporary, owner.cancelled);
    if (!candidate) return;
    owner.event('gate_started', {
      workspace_id: workspace.id,
      candidate_path: candidate,
      commit,
      check_spec_hash: hash(commands),
      commands,
    });
    const run = (command: GateCommands[number]) =>
      runChecked(ctx, owner, key, command, candidate, commit, temporary, !inSession);
    for (const [index, command] of commands.entries()) {
      if (ctx.closing || owner.cancelled()) return;
      // A fresh clone lacks the ignored outputs of earlier steps, so only the worktree carries them.
      const kept = inSession ? previous[index] : undefined;
      if (kept && (kept.state === 'skipped' || (kept.exit_code === 0 && !kept.timed_out))) {
        results.push({ ...kept, carried: true });
        owner.event('gate_step_checked', {
          workspace_id: workspace.id,
          results: [...results],
          total: commands.length,
        });
        continue;
      }
      let result = await run(command);
      // A failure of the machine may not repeat, so the same candidate runs the command once more.
      if (
        result?.failure_class === 'environment' ||
        (result?.state === 'failed' && policy.gate_on_fail === 'retry')
      )
        result = await run(command);
      if (!result) return;
      results.push(result);
      owner.event('gate_step_checked', {
        workspace_id: workspace.id,
        results: [...results],
        total: commands.length,
      });
      if (gateFailed(result)) break;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  if (ctx.closing || owner.cancelled()) return;
  owner.event('gate_checked', {
    workspace_id: workspace.id,
    commit,
    check_spec_hash: hash(commands),
    results,
  });
  ctx.store.transaction(() =>
    recordGateRun(ctx, {
      project_id: owner.projectId,
      session_id: owner.session_id,
      commit,
      results,
      runner: policy.gate_runner,
    }),
  );
  return results;
}

export async function landWorkspace(
  ctx: ControlContext,
  owner: LandingOwner,
  workspace: Workspace,
  target?: string,
  commands?: GateCommands,
  onto?: string,
): Promise<LandingItem | undefined> {
  const item: LandingItem = {
    workspace_id: workspace.id,
    source: workspace.source ?? workspace.path,
    state: 'blocked',
  };
  if (!target) return { ...item, reason: 'artifact_commit_missing' };
  if (ctx.closing) return;
  if (owner.cancelled()) return { ...item, reason: 'cancelled' };
  const lease = `landing:${owner.key}`,
    leased = !!commands?.length || !!onto;
  const available = ctx.store.transaction(() => {
    const current = ctx.store.must<Workspace>('workspaces', workspace.id);
    if (current.owner !== 'none' && current.owner !== lease) return false;
    if (leased)
      ctx.store.update(
        'workspaces',
        { ...current, owner: lease, ownership_epoch: current.ownership_epoch + 1 },
        current.revision,
      );
    return true;
  });
  if (!available) return { ...item, reason: 'workspace_owned' };
  let resumed: LandingProgress | undefined;
  let sourceEnv: NodeJS.ProcessEnv | undefined;
  try {
    try {
      // A rebase stopped partway leaves HEAD on a partial commit, and status does not report it.
      const rebaseDirectories = await git(workspace.path, [
        'rev-parse',
        '--git-path',
        'rebase-merge',
        '--git-path',
        'rebase-apply',
      ]);
      if (
        rebaseDirectories
          .split('\n')
          .some((directory) => existsSync(path.resolve(workspace.path, directory)))
      )
        return { ...item, reason: 'rebase_interrupted' };
      if (await git(workspace.path, ['status', '--porcelain=v1', '--untracked-files=no']))
        return { ...item, reason: 'clone_dirty' };
      if (target === workspace.base_sha) return { ...item, state: 'no_changes' };
      sourceEnv = await sourceGitEnv(item.source);
      if (!sourceEnv) return { ...item, reason: 'sandbox_path_replaced' };
      // Checked before a rebase onto another branch's commits rewrites the worktree.
      if (workspace.source_branch !== undefined) {
        const checkedOut = await runGit(
          item.source,
          ['symbolic-ref', '--quiet', '--short', 'HEAD'],
          undefined,
          true,
          { env: sourceEnv },
        );
        if (checkedOut.stdout.toString().trim() !== workspace.source_branch)
          return { ...item, reason: 'target_branch_changed' };
      }
      // Without a destination the fetch brings the commit's objects and writes no ref.
      const fetchBase = (commit: string, ref?: string) =>
        git(workspace.path, [
          'fetch',
          '--no-tags',
          '--no-prune',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--no-auto-maintenance',
          '--',
          item.source,
          ref ? `+${commit}:${ref}` : commit,
        ]);
      let sourceHead: string | undefined;
      if (!onto && commands?.length) {
        // Gates check what will land, so a session behind a moved source is rebased first.
        sourceHead = await git(item.source, ['rev-parse', '--verify', 'HEAD^{commit}'], sourceEnv);
        await fetchBase(sourceHead);
        if (!(await isAncestor(workspace.path, sourceHead, target))) onto = sourceHead;
      }
      // Checked before a rebase, which would write the files into the worktree.
      const landsOn =
        onto ??
        sourceHead ??
        (await git(item.source, ['rev-parse', '--verify', 'HEAD^{commit}'], sourceEnv));
      if (landsOn !== sourceHead) await fetchBase(landsOn);
      const changed = await changedPaths(workspace.path, landsOn, target);
      const agentConfiguration = changed.filter((file) =>
        AGENT_CONFIGURATION.some((entry) => within(file, entry)),
      );
      if (agentConfiguration.length)
        return Object.assign(
          { ...item, reason: 'protected_paths' },
          { conflicts: agentConfiguration },
        );
      const session = ctx.store
        .list<Session>('sessions')
        .find((candidate) => owner.key === `session-${candidate.id}`);
      const task = session && taskOfSession(ctx, session);
      if (task) {
        const inputs = (commands ?? []).flatMap((command) =>
          command.argv.flatMap((argument) =>
            (argument.match(/[^\s"'`;|&()<>*]+/g) ?? []).map((token) =>
              token.replace(/^--[^=]+=/, '').replace(/^\.\//, ''),
            ),
          ),
        );
        const patches = await filePatches(
          workspace.path,
          landsOn,
          target,
          changed.filter(testPath),
        );
        // A file the acceptance names counts only when it existed before: a new one is the task's output.
        const existed = await presentIn(
          workspace.path,
          landsOn,
          changed.filter((file) =>
            // A token with no path segment, such as a bare `.`, would contain every file.
            inputs.some((input) => segments(input).length && within(file, input)),
          ),
        );
        const verificationFiles: string[] = [];
        for (const file of changed) {
          const configuration =
            /^(?:\.github\/workflows\/|\.circleci\/)|(?:^|\/)(?:package\.json|pnpm-workspace\.ya?ml|\.gitlab-ci\.ya?ml|Jenkinsfile|Makefile|(?:vitest|jest|playwright|eslint)\.config\.[^/]+|tsconfig(?:\.[^/]+)?\.json|pytest\.ini|tox\.ini|pyproject\.toml)$/.test(
              file,
            );
          const patch = patches.get(file);
          const deleted = patch !== undefined && /\ndeleted file mode /.test(patch);
          // Hunk lines only: the `---` and `+++` headers would match the line rules.
          let hunk = false;
          const body = (patch ?? '')
            .split('\n')
            .filter((line) => {
              if (line.startsWith('diff --git ')) hunk = false;
              else if (line.startsWith('@@')) hunk = true;
              else return hunk;
              return false;
            })
            .join('\n');
          const weakened =
            deleted ||
            /^-.*\b(?:expect\s*\(|(?:it|test|describe|xit|xtest|xdescribe)\s*(?:\(|\.))/m.test(
              body,
            ) ||
            /^\+.*(?:\b(?:it|test|describe)\s*\.\s*skip\b|\.\s*only\b|\b(?:xit|xtest|xdescribe)\s*\(|\bpytest\.mark\.(?:skip|skipif|xfail)\b|\bunittest\.skip|\bt\.Skip\(|#\[ignore\b)/m.test(
              body,
            );
          // A named test only gains cases from pure additions.
          const named = existed.has(file) && (!testPath(file) || deleted || /^-/m.test(body));
          if (weakened || configuration || named) verificationFiles.push(file);
        }
        const unlisted = verificationFiles.filter(
          (file) => !task.scope.some((entry) => segments(entry).join('/') === file),
        );
        if (unlisted.length)
          return Object.assign(
            { ...item, reason: 'verification_changed' },
            { conflicts: unlisted },
          );
        if (verificationFiles.length)
          ctx.store.event('session.verification_change_allowed', session!, owner.projectId, {
            files: verificationFiles,
            reason: 'explicit_task_scope',
          });
      }
      // A rebase replays a merge's parents and drops the changes made in the merge itself.
      if (onto && (await git(workspace.path, ['rev-list', '--merges', `${onto}..${target}`])))
        return { ...item, reason: 'merge_commits' };
      // Before a rebase, so a file outside the scope that another task merged is no conflict first.
      // Against the fork point, so the files of merges it would be rebased onto do not count;
      // a rebase replays only the files the commits change, so it adds none to check after it.
      if (owner.scope) {
        const outside = await outOfScope(workspace.path, landsOn, target, owner.scope);
        if (outside.length)
          return Object.assign({ ...item, reason: 'out_of_scope' }, { conflicts: outside });
      }
      if (onto) {
        const committer = await sourceCommitter(item.source);
        if (!committer) return { ...item, reason: 'committer_unknown' };
        await git(workspace.path, ['checkout', '--quiet', '--detach', target]);
        await fetchBase(onto, `refs/pantheon/landing-base/${owner.key}/${workspace.id}`);
        // Repository configuration may turn on rebase.updateRefs, which moves other branches.
        const rebase = await runGit(
          workspace.path,
          ['rebase', '--quiet', '--no-update-refs', onto],
          undefined,
          true,
          {
            env: {
              GIT_COMMITTER_NAME: committer.name,
              GIT_COMMITTER_EMAIL: committer.email,
              GIT_COMMITTER_DATE: new Date().toISOString(),
            },
          },
        );
        if (rebase.exit_code !== 0) {
          const conflicts = await git(workspace.path, ['diff', '--name-only', '--diff-filter=U']);
          if (!conflicts) {
            // A rebase can stop partway without conflicts, as on an untracked file a commit adds;
            // one that refused to start has nothing to abort.
            await runGit(workspace.path, ['rebase', '--abort'], undefined, true);
            throw new Error(gitFailure(rebase));
          }
          await git(workspace.path, ['rebase', '--abort']);
          const files = conflicts.split('\n');
          // The commits of the target the session's commits did not start from.
          const commits = await git(workspace.path, [
            '--literal-pathspecs',
            'log',
            '--format=%H %s',
            '--max-count=5',
            `${target}..${onto}`,
            '--',
            ...files,
          ]);
          const lines = commits ? commits.split('\n') : [];
          return Object.assign(
            { ...item, reason: 'rebase_conflict' },
            { conflicts: files },
            lines.length
              ? {
                  conflict_commits: lines.map((line) => line.slice(line.indexOf(' ') + 1)),
                  conflict_shas: lines.map((line) => line.slice(0, line.indexOf(' '))),
                }
              : {},
          );
        }
        item.rebased_from = target;
        target = await git(workspace.path, ['rev-parse', 'HEAD']);
        // The worktree now forks from onto, so the session's own change starts there.
        ctx.store.transaction(() => {
          const current = ctx.store.must<Workspace>('workspaces', workspace.id);
          ctx.store.update('workspaces', { ...current, base_sha: onto }, current.revision);
        });
        forgetWorktreeReads(workspace.id);
      }
      // An earlier run already gated this candidate with the same commands and settings.
      const saved = owner.progress?.saved;
      resumed =
        saved?.candidate === target && saved.gate_argv === gateKey(ctx, owner.projectId, commands)
          ? saved
          : undefined;
      if (commands?.length && !resumed) {
        item.to_sha = target;
        if ((await git(workspace.path, ['rev-parse', 'HEAD'])) !== target)
          await git(workspace.path, ['checkout', '--quiet', '--detach', target]);
        const results = await checkGates(ctx, owner, workspace, item.source, commands, target);
        if (!results) return ctx.closing ? undefined : { ...item, reason: 'cancelled' };
        item.gate_results = results;
        if (results.some(gateFailed)) return { ...item, reason: 'gate_failed' };
      }
    } finally {
      if (leased)
        ctx.store.transaction(() => {
          const current = ctx.store.must<Workspace>('workspaces', workspace.id);
          if (current.owner === lease)
            ctx.store.update(
              'workspaces',
              { ...current, owner: 'none', ownership_epoch: current.ownership_epoch + 1 },
              current.revision,
            );
        });
    }
    const branch = await runGit(
      item.source,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      undefined,
      true,
      { env: sourceEnv },
    );
    if (branch.exit_code === 1) return { ...item, reason: 'detached_head' };
    if (branch.exit_code !== 0) throw new Error(gitFailure(branch));
    item.branch = branch.stdout.toString().trim();
    if (workspace.source_branch !== undefined && item.branch !== workspace.source_branch)
      return { ...item, reason: 'target_branch_changed' };
    const head = await git(item.source, ['rev-parse', '--verify', 'HEAD^{commit}'], sourceEnv);
    // After a fast-forward the source HEAD is the candidate itself, so a rerun keeps the saved parent.
    item.from_sha = resumed?.branch === item.branch ? resumed.from_sha : head;
    item.to_sha = target;
    await git(
      item.source,
      [
        'fetch',
        '--no-tags',
        '--no-prune',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--no-auto-maintenance',
        '--',
        workspace.path,
        `+${target}:refs/pantheon/landing/${owner.key}/${workspace.id}`,
      ],
      sourceEnv,
    );
    if (!(await isAncestor(item.source, head, target, sourceEnv))) {
      // A crash can leave git ahead of the saved landing receipt.
      if (await isAncestor(item.source, target, head, sourceEnv))
        return { ...item, state: 'landed' };
      return landWorkspace(ctx, owner, workspace, item.rebased_from ?? target, commands, head);
    }
    if (ctx.closing) return;
    if (owner.cancelled()) return { ...item, reason: 'cancelled' };
    owner.progress?.save({
      stage: 'gated',
      candidate: target,
      branch: item.branch,
      from_sha: item.from_sha,
      gate_argv: gateKey(ctx, owner.projectId, commands),
    });
    if (owner.beforeLand && !owner.beforeLand()) return;
    const fastForward = [
      'merge',
      '--ff-only',
      '--no-overwrite-ignore',
      '--no-autostash',
      '--',
      target,
    ];
    const merge = await retryingIndexLock(
      () => runGit(item.source, fastForward, undefined, true, { env: sourceEnv }),
      (result) => (result.exit_code === 0 ? '' : result.stderr.toString()),
    );
    if (merge.exit_code !== 0) {
      if (
        /would be overwritten by merge|not uptodate\. Cannot merge/i.test(merge.stderr.toString())
      )
        return { ...item, reason: 'local_changes' };
      throw new Error(gitFailure(merge));
    }
    return { ...item, state: 'landed' };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'dependency_folder_skipped')
      return { ...item, reason: error.code };
    return { ...item, reason: `git_failed: ${(error as Error).message.split('\n')[0]}` };
  }
}
