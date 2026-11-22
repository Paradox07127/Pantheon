import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { nativeEnvironment } from '@pantheon/adapters';
import {
  DomainError,
  hash,
  requireThat,
  type GateFailureClass,
  type Project,
  type LandingItem,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { rootOf, type ControlContext } from './context.js';
import { inheritedEnvAllowlist } from './native-session.js';
import {
  copyCandidateDependencies,
  runValidationCommand,
  type ValidationResult,
} from './validation-executor.js';
import { retryingIndexLock, runGit } from './git.js';
import { workflowPolicy } from './workflow-policy.js';
import { onDevice } from './remote-workspace.js';
import { forgetWorktreeReads } from './workbench-session.js';

export type GateCommands = NonNullable<Project['gates']>[string];
export type LandingProgress = NonNullable<NonNullable<Session['merge']>['landing']>;

export const segments = (target: string) =>
  target.split('/').filter((segment) => segment && segment !== '.');
/** True when one path equals the other or contains it, compared by path segment. */
export function overlaps(a: string, b: string): boolean {
  const left = segments(a),
    right = segments(b);
  return left
    .slice(0, Math.min(left.length, right.length))
    .every((segment, index) => segment === right[index]);
}

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
  /** A workflow approval may hold a gated candidate before the source moves. */
  beforeLand?(): boolean;
  /** The user let this landing change the paths that protect the gate. */
  allowGateChange?: boolean;
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

/** The enabled gate commands of one project root. */
export function projectGateCommands(project: Project, root: string): GateCommands | undefined {
  return project.gates?.[root]?.filter((command) => command.enabled !== false);
}

/** The gate of the project folder a clone delivers into. */
export function gateCommands(
  ctx: ControlContext,
  project: Project,
  workspace: Workspace,
  session: Session,
): GateCommands | undefined {
  const folder = workspace.source ? rootOf(project, [workspace.source]) : undefined;
  return folder ? projectGateCommands(project, folder) : undefined;
}

/** A run that timed out, could not start or was killed by a signal failed because of the machine. */
function failureClass(result: ValidationResult): GateFailureClass | undefined {
  if (result.timedOut || (result.exit_code === null && result.error) || result.signal)
    return 'environment';
  return result.exit_code === 0 ? undefined : 'code';
}

/** Who runs a gate command. */
type GateRunner = Pick<LandingOwner, 'projectId' | 'cancelled'>;

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
): Promise<NonNullable<LandingItem['gate_results']>[number] | undefined> {
  const result = await inGateSlot(ctx, owner.cancelled, () => {
    // Read once the slot is held: the user can change the project while the command waits.
    const project = ctx.store.must<Project>('projects', owner.projectId);
    return runValidationCommand({
      ctx,
      key,
      argv: command.argv,
      cwd: candidate,
      // The environment a session the user opened gets, outside any Pantheon sandbox.
      env: {
        ...project.env,
        ...nativeEnvironment(inheritedEnvAllowlist(project)),
        // Gates verify a candidate without installing.
        pnpm_config_verify_deps_before_run: 'false',
      },
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
    { stopped: result.stopped },
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

/** The repository files the gate argv names, reading each argument's words as a script's, that one of commits holds. */
export async function gateFiles(
  cwd: string,
  commits: string[],
  commands: GateCommands | undefined,
): Promise<string[]> {
  const words = new Set(
    (commands ?? [])
      .flatMap((command) => command.argv)
      .flatMap((argument) => [
        // Unstripped, as the gate passes it without a shell: a file name may hold spaces or quotes.
        argument,
        ...argument
          .split(/\s+/)
          .flatMap((word) =>
            word.includes('=') ? [word, word.slice(word.indexOf('=') + 1)] : [word],
          )
          .map((word) => word.replace(/^['"]+|['";]+$/g, '')),
      ])
      .map((word) => path.posix.normalize(word))
      .filter(
        (word) =>
          word !== '.' && word !== '..' && !word.startsWith('../') && !path.posix.isAbsolute(word),
      ),
  );
  if (!words.size) return [];
  const listed = await Promise.all(
    commits.map((commit) =>
      git(cwd, [
        '--literal-pathspecs',
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        commit,
        '--',
        ...words,
      ]),
    ),
  );
  return [
    ...new Set(listed.flatMap((files) => files.split('\0')).filter((file) => words.has(file))),
  ];
}

/** Of changed, the files a landing takes only with the user's leave: those the gate names and the root's protected paths. */
export async function changedGateFiles(
  project: Project,
  source: string,
  cwd: string,
  commits: string[],
  changed: string[],
  commands: GateCommands | undefined,
): Promise<string[]> {
  const listed = project.protected_paths?.[rootOf(project, [source]) ?? ''] ?? [],
    named = await gateFiles(cwd, commits, commands);
  return changed.filter(
    (file) =>
      named.includes(file) ||
      listed.some((entry) => within(file, entry) || path.posix.matchesGlob(file, entry)),
  );
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
) {
  const result = await runGateCommand(ctx, owner, key, command, candidate);
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
      const run = () => runChecked(ctx, input, key, command, candidate, commit, temporary);
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
      runChecked(ctx, owner, key, command, candidate, commit, temporary);
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
  // A status read from before the session's last commit would show this result as stale.
  forgetWorktreeReads(workspace.id);
  return results;
}

type GateResults = NonNullable<LandingItem['gate_results']>;

/** The results of the session's newest gate check on the commit. */
export function sessionGateResults(
  ctx: ControlContext,
  projectId: string,
  sessionId: string,
  commit: string,
): GateResults | undefined {
  const row = ctx.store
    .statement(
      "SELECT payload->'$.results' AS results FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind='session.gate_checked' AND aggregate_id=? AND payload->>'$.commit'=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(projectId, sessionId, commit) as { results: string | null } | undefined;
  return row?.results ? (JSON.parse(row.results) as GateResults) : undefined;
}

/** The results the run of this landing before a restart saved for the candidate it gated. */
function savedGateResults(
  ctx: ControlContext,
  owner: LandingOwner,
  workspaceId: string,
  candidate: string,
): GateResults | undefined {
  if (owner.session_id)
    return sessionGateResults(ctx, owner.projectId, owner.session_id, candidate);
  const row = ctx.store
    .statement(
      "SELECT data->'$.gate_results' AS results FROM landings WHERE data->>'$.workspace_id'=?",
    )
    .get(workspaceId) as { results: string | null } | undefined;
  return row?.results ? (JSON.parse(row.results) as GateResults) : undefined;
}

/** The path with its links resolved; as given once it is gone. */
function realRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/** A gate's result as a landing records it for the landings after it. */
type BaselineResult = Pick<GateResults[number], 'name' | 'tests'>;

// The newest baseline records a landing reads; a gate no landing among them ran has no baseline.
const BASELINE_RECORDS = 50;

/**
 * Records, in the transaction that records a landing onto the branch of the repository at root,
 * the results of the gates enabled then; the landings after it compare with them.
 */
export function recordGateBaseline(
  ctx: ControlContext,
  entity: { id: string; revision: number },
  projectId: string,
  root: string,
  branch: string,
  results: GateResults | undefined,
  commands: GateCommands | undefined,
): void {
  const counted: BaselineResult[] = (results ?? [])
    .filter((result) => commands?.some((command) => command.name === result.name))
    .map(({ name, tests }) => (tests ? { name, tests } : { name }));
  if (counted.length)
    ctx.store.event('project.gate_baseline', entity, projectId, {
      root: realRoot(root),
      branch,
      results: counted,
    });
}

/**
 * The blocking reason, with both counts, when a gate passed fewer tests or skipped more than the
 * same gate did at the newest landing onto the branch that ran it; undefined when either side has
 * no counts. Gates of one name pair by their order among that name.
 */
export function droppedTests(
  ctx: ControlContext,
  projectId: string,
  root: string,
  branch: string | null | undefined,
  results: GateResults | undefined,
): string | undefined {
  if (!branch || !results?.length) return;
  const baselines = (
    ctx.store
      .statement(
        "SELECT payload->'$.results' AS results FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind='project.gate_baseline' AND payload->>'$.root'=? AND payload->>'$.branch'=? ORDER BY sequence DESC LIMIT ?",
      )
      .all(projectId, realRoot(root), branch, BASELINE_RECORDS) as { results: string }[]
  ).map((row) => JSON.parse(row.results) as BaselineResult[]);
  for (const [index, result] of results.entries()) {
    const same = (gate: BaselineResult) => gate.name === result.name,
      occurrence = results.slice(0, index).filter(same).length;
    const before = baselines
        .map((baseline) => baseline.filter(same)[occurrence])
        .find((gate) => gate !== undefined)?.tests,
      after = result.tests;
    if (before && after && (after.passed < before.passed || after.skipped > before.skipped))
      return `tests_dropped: ${result.name}: passed ${before.passed}→${after.passed}, skipped ${before.skipped}→${after.skipped}`;
  }
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
      // The gate runs the candidate's own files, so a change to them waits for the user.
      if (!owner.allowGateChange) {
        const project = ctx.store.must<Project>('projects', owner.projectId);
        const guarded = await changedGateFiles(
          project,
          item.source,
          workspace.path,
          [landsOn, target],
          changed,
          commands,
        );
        if (guarded.length)
          return Object.assign({ ...item, reason: 'gate_files_changed' }, { conflicts: guarded });
      }
      // A rebase replays a merge's parents and drops the changes made in the merge itself.
      if (onto && (await git(workspace.path, ['rev-list', '--merges', `${onto}..${target}`])))
        return { ...item, reason: 'merge_commits' };
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
    if (!owner.allowGateChange) {
      // A run resumed after a restart compares the results its earlier run saved.
      const dropped = droppedTests(
        ctx,
        owner.projectId,
        item.source,
        item.branch,
        item.gate_results ??
          (resumed ? savedGateResults(ctx, owner, workspace.id, target) : undefined),
      );
      if (dropped) return { ...item, reason: dropped };
    }
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
