import path from 'node:path';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  DomainError,
  id,
  requireThat,
  type BaselineFacts,
  type BaselineFolder,
  type EnvironmentCheck,
  type Principal,
  type Project,
  type ProjectBaseline,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import {
  inputSchemas,
  pantheonConfigSchema,
  type Command,
  type ProjectFactsRead,
} from '@pantheon/protocol';
import {
  gitFolderAsync,
  inside,
  projectAccess,
  resolvedPath,
  revision,
  userOnly,
  type ControlContext,
  type Preparers,
} from './context.js';
import { queueTurn } from './session-wake.js';
import { sessionDefaults } from './user-config.js';
import { readPantheonFile, setProjectGate, setProjectWorktree } from './project.js';
import { runtime } from './admission.js';
import { runGit } from './git.js';
import { collectFacts, type ProjectFacts } from './baseline-facts.js';
import { renderScanSeed } from './baseline-brief.js';
import { acceptInput } from './session.js';
import { startEnvironmentCheck } from './environment-check.js';

export const BASELINE_WALL_TIME_MS = 30 * 60 * 1000;
const FACTS_KEPT = 30;

/** No commit, or fewer than 3 files outside dot entries and node_modules. */
function emptyProject(root: string, committed: boolean): boolean {
  if (!committed) return true;
  let files = 0;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files >= 3) return;
      if (entry.name.startsWith('.')) continue;
      if (!entry.isDirectory()) files++;
      else if (entry.name !== 'node_modules') walk(path.join(directory, entry.name));
    }
  };
  walk(root);
  return files < 3;
}

function located(root: string, relative: string): boolean {
  if (path.isAbsolute(relative)) return false;
  try {
    return inside(root, realpathSync(path.resolve(root, relative)));
  } catch {
    return false;
  }
}

/** Whether HEAD names a commit in the root. */
async function committed(root: string): Promise<boolean> {
  const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, true);
  return head.exit_code === 0;
}

const commitRefs = (refs: string[]) =>
  refs.flatMap((ref) => /^commit:([0-9a-fA-F]{7,40})$/.exec(ref)?.[1] ?? []);

/**
 * Resolves every commit among refs with one git run per root. The returned check is true when any
 * of the references it is given resolves inside any of the roots.
 */
export async function sourcing(
  roots: string[],
  refs: string[],
): Promise<(refs: string[]) => boolean> {
  const named = [...new Set(commitRefs(refs))],
    found = new Set<string>();
  const input = Buffer.from(named.map((commit) => `${commit}^{commit}\n`).join(''));
  if (named.length)
    await Promise.all(
      roots.map(async (root) => {
        const checked = await runGit(root, ['cat-file', '--batch-check'], input, true);
        if (checked.exit_code !== 0) return;
        // Each input gets one line; a missing or ambiguous name prints its input followed by that word.
        checked.stdout
          .toString()
          .split('\n')
          .forEach((line, index) => {
            if (/^[0-9a-f]+ commit \d+$/.test(line)) found.add(named[index]!);
          });
      }),
    );
  return (list) => {
    const files = list.flatMap((ref) => /^file:(.+?)(?::[1-9][0-9]*)?$/.exec(ref)?.[1] ?? []);
    return (
      files.some((file) => roots.some((root) => located(root, file))) ||
      commitRefs(list).some((commit) => found.has(commit))
    );
  };
}

const lineCount = (text: Buffer): number =>
  text.length === 0 ? 0 : text.toString().split('\n').length - (text.at(-1) === 10 ? 1 : 0);

/**
 * Checks each reference on its own: a file must be tracked at HEAD in a git root, or be a regular
 * file in any other root, and its line must fall inside it; a commit must name a commit in a root.
 * The returned function gives the reason a reference fails, or undefined when it resolves.
 */
export async function sourceReasons(
  roots: string[],
  refs: string[],
): Promise<(ref: string) => string | undefined> {
  const exists = await sourcing(
    roots,
    commitRefs(refs).map((commit) => `commit:${commit}`),
  );
  const files = refs.flatMap((ref) => {
    const match = /^file:(.+?)(?::([1-9][0-9]*))?$/.exec(ref);
    const root = match && roots.find((root) => located(root, match[1]!));
    return match ? [{ ref, file: match[1]!, line: Number(match[2] ?? 0), root }] : [];
  });
  const reasons = new Map<string, string | undefined>();
  await Promise.all(
    roots.map(async (root) => {
      const here = files.filter((entry) => entry.root === root);
      if (!here.length) return;
      const lines = new Map<string, number | undefined>();
      if (await committed(root)) {
        // A path with a newline cannot be one line of batch input.
        const named = [...new Set(here.map((entry) => entry.file))].filter(
          (file) => !file.includes('\n'),
        );
        const input = Buffer.from(named.map((file) => `HEAD:./${file}\n`).join(''));
        const read = await runGit(root, ['cat-file', '--batch'], input, true);
        let offset = 0;
        for (const file of named) {
          if (read.exit_code !== 0) break;
          const end = read.stdout.indexOf(10, offset);
          const header = /^[0-9a-f]+ (\w+) (\d+)$/.exec(
            read.stdout.subarray(offset, end).toString(),
          );
          offset = end + 1;
          if (!header) continue;
          const size = Number(header[2]);
          if (header[1] === 'blob')
            lines.set(file, lineCount(read.stdout.subarray(offset, offset + size)));
          offset += size + 1;
        }
        for (const entry of here) {
          const count = lines.get(entry.file);
          reasons.set(
            entry.ref,
            count === undefined
              ? `${entry.ref} is not tracked by git at HEAD`
              : entry.line > count
                ? `${entry.ref} is past the end of ${entry.file} (${count} lines)`
                : undefined,
          );
        }
        return;
      }
      for (const entry of here) {
        const target = realpathSync(path.resolve(root, entry.file));
        const count = lstatSync(target).isFile() ? lineCount(readFileSync(target)) : undefined;
        reasons.set(
          entry.ref,
          count === undefined
            ? `${entry.ref} is not a file`
            : entry.line > count
              ? `${entry.ref} is past the end of ${entry.file} (${count} lines)`
              : undefined,
        );
      }
    }),
  );
  return (ref) => {
    if (ref.startsWith('file:'))
      return reasons.has(ref) ? reasons.get(ref) : `${ref} does not exist`;
    if (/^commit:[0-9a-fA-F]{7,40}$/.test(ref))
      return exists([ref]) ? undefined : `${ref} does not name a commit in a project root`;
    return `${ref} is not a file:<path>, file:<path>:<line> or commit:<sha> source`;
  };
}

async function projectFacts(ctx: ControlContext, project: Project): Promise<ProjectFacts> {
  const git = await Promise.all(project.roots.map(gitFolderAsync));
  return collectFacts(
    project.roots.map((root, index) => ({ path: root, git: git[index]! })),
    ctx.store.now(),
  );
}

function storeFacts(
  ctx: ControlContext,
  project: Project,
  facts: ProjectFacts,
  commandId?: string,
): BaselineFacts {
  const snapshot: BaselineFacts = {
    id: id(),
    revision: 1,
    project_id: project.id,
    collected_at: facts.collected_at,
    facts,
  };
  ctx.store.insert('baseline_facts', snapshot);
  const stale = ctx.store
    .list<BaselineFacts>('baseline_facts')
    .filter((entry) => entry.project_id === project.id)
    .slice(0, -FACTS_KEPT);
  for (const entry of stale)
    ctx.store.db.prepare('DELETE FROM baseline_facts WHERE id=?').run(entry.id);
  ctx.store.event('project.facts_collected', snapshot, project.id, {}, commandId);
  return snapshot;
}

export function baselineRuntime(ctx: ControlContext, project: Project, requested?: string): string {
  // A runtime whose binary did not answer `--version` is registered as 'unprobed'.
  const fits = (name: string | undefined) => {
    const report = name === undefined ? undefined : ctx.adapters.get(name)?.report;
    return (
      report !== undefined &&
      report.version !== 'unprobed' &&
      report.capabilities.text_execution?.status === 'supported' &&
      report.capabilities.read_isolation?.status === 'supported'
    );
  };
  if (requested !== undefined) {
    requireThat(fits(requested), 'unsupported_capability', `${requested} cannot run a baseline`);
    return requested;
  }
  const runtimeName = [sessionDefaults(ctx, project)?.runtime, ...ctx.adapters.keys()].find(fits);
  requireThat(runtimeName, 'unsupported_capability', 'No installed runtime can run a baseline');
  return runtimeName;
}

function createBaselineSession(
  ctx: ControlContext,
  project: Project,
  baselineId: string,
  runtimeName: string,
  brief: string,
  choice: { model?: string; effort?: Session['requested_effort'] },
): Session {
  runtime(ctx, runtimeName, 'reviewer');
  const session: Session = {
    id: id(),
    revision: 1,
    project_id: project.id,
    runtime: runtimeName,
    device_id: 'local',
    state: 'running',
    turn_count: 1,
    baseline: { baseline_id: baselineId },
    ...(choice.model !== undefined && { requested_model: choice.model }),
    ...(choice.effort !== undefined && { requested_effort: choice.effort }),
  };
  ctx.store.insert('sessions', session);
  const turn: SessionTurn = {
    id: id(),
    revision: 1,
    project_id: project.id,
    session_id: session.id,
    model: session.reported_model ?? session.requested_model ?? null,
    input: brief,
    kind: 'send',
    delivery: 'pending',
    state: 'queued',
  };
  ctx.store.insert('session_turns', turn);
  ctx.store.enqueue('session.turn', { turn_id: turn.id });
  ctx.store.event('session.opened', session, project.id, { purpose: 'baseline' });
  ctx.store.event('turn.queued', turn, project.id, { purpose: 'baseline' });
  return session;
}

/** Writes a sibling file and renames it over the target, so a reader never sees half a file. */
function replaceFile(file: string, text: string): void {
  const temporary = `${file}.${id()}.tmp`;
  writeFileSync(temporary, text, { flag: 'wx' });
  renameSync(temporary, file);
}

/** Replaces only the keys this confirmation owns and keeps the rest of an existing file. */
function writeProjectConfig(
  ctx: ControlContext,
  root: string,
  keys: Record<string, unknown>,
): void {
  const directory = path.join(root, '.pantheon');
  const file = path.join(directory, 'config.json');
  const ignore = path.join(directory, '.gitignore');
  // A link committed to the repository would carry the write outside the project.
  requireThat(
    [directory, file, ignore].every(
      (entry) => !lstatSync(entry, { throwIfNoEntry: false })?.isSymbolicLink(),
    ),
    'config_path_symlink',
    `${directory} or a file in it is a symbolic link`,
  );
  const existing = readPantheonFile(file, pantheonConfigSchema) ?? { version: 1 };
  const before = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const created = !existsSync(directory);
  const ignored = existsSync(ignore);
  mkdirSync(directory, { recursive: true });
  // The command can still fail after this write, in a later folder.
  ctx.rollback?.push(() => {
    if (!ignored) rmSync(ignore, { force: true });
    if (before === undefined) rmSync(file, { force: true });
    else replaceFile(file, before);
    if (created) rmdirSync(directory);
  });
  replaceFile(file, JSON.stringify({ ...existing, ...keys }, null, 2) + '\n');
  if (!ignored) replaceFile(ignore, 'config.local.json\n');
}

function boundBaseline(ctx: ControlContext, p: Principal, baselineId: string, action: string) {
  const baseline = ctx.store.must<ProjectBaseline>('project_baselines', baselineId);
  projectAccess(ctx, p, baseline.project_id, action);
  const session = p.session_id ? ctx.store.get<Session>('sessions', p.session_id) : undefined;
  requireThat(
    session?.baseline?.baseline_id === baseline.id && baseline.session_id === session.id,
    'permission_denied',
    'Bound baseline session required',
  );
  requireThat(baseline.state === 'running', 'invalid_state', 'Baseline is not running');
  return { baseline, session };
}

/** The newest facts snapshot, and whether every folder holds no code yet. */
export async function projectFactsRead(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): Promise<ProjectFactsRead> {
  projectAccess(ctx, p, projectId, 'project.read');
  const { roots } = ctx.store.must<Project>('projects', projectId);
  const heads = await Promise.all(roots.map(committed));
  const snapshot = ctx.store
    .list<BaselineFacts>('baseline_facts')
    .filter((entry) => entry.project_id === projectId)
    .at(-1);
  return {
    facts: snapshot?.facts ?? null,
    collected_at: snapshot?.collected_at ?? null,
    empty: roots.every((root, index) => emptyProject(root, heads[index]!)),
  };
}

export function projectBaselineRead(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): ProjectBaseline | null {
  projectAccess(ctx, p, projectId, 'project.read');
  return (
    ctx.store
      .list<ProjectBaseline>('project_baselines')
      .filter((baseline) => baseline.project_id === projectId)
      .at(-1) ?? null
  );
}

function startTarget(ctx: ControlContext, p: Principal, c: Command) {
  userOnly(p);
  const input = inputSchemas['project.baseline.start'].parse(c.input);
  revision(ctx, c);
  projectAccess(ctx, p, input.project_id, c.type);
  requireThat(
    !ctx.store
      .list<ProjectBaseline>('project_baselines')
      .some((baseline) => baseline.project_id === input.project_id && baseline.state === 'running'),
    'resource_busy',
    'A baseline is already running for this project',
  );
  return { input, project: ctx.store.must<Project>('projects', input.project_id) };
}

function submitTarget(ctx: ControlContext, p: Principal, c: Command) {
  const { baseline_id, folders } = inputSchemas['project.baseline.submit'].parse(c.input);
  revision(ctx, c);
  const { baseline, session } = boundBaseline(ctx, p, baseline_id, c.type);
  const project = ctx.store.must<Project>('projects', baseline.project_id);
  const roots = folders.map((folder) => folder.root);
  requireThat(
    roots.length === project.roots.length && project.roots.every((root) => roots.includes(root)),
    'invalid_input',
    `folders must name each project folder once: ${project.roots.join(', ')}`,
  );
  return { folders, baseline, session, project };
}

function confirmTarget(ctx: ControlContext, p: Principal, c: Command) {
  userOnly(p);
  const input = inputSchemas['project.baseline.confirm'].parse(c.input);
  const baseline = ctx.store.must<ProjectBaseline>('project_baselines', input.baseline_id);
  projectAccess(ctx, p, baseline.project_id, c.type);
  return { input, baseline };
}

export const baselinePreparers: Preparers = {
  'project.baseline.start': async (ctx, p, c) => {
    const target = startTarget(ctx, p, c).project;
    const facts = await projectFacts(ctx, target);
    // A git folder's HEAD was read with its facts.
    const heads = await Promise.all(
      target.roots.map((root, index) => {
        const folder = facts.folders[index]!;
        return folder.git ? folder.head !== undefined : committed(root);
      }),
    );
    const empty = target.roots.every((root, index) => emptyProject(root, heads[index]!));
    return (ctx, p, c) => start(ctx, p, c, facts, empty);
  },
  'project.baseline.submit': async (ctx, p, c) => {
    const { folders } = submitTarget(ctx, p, c);
    // A folder's sources resolve inside that folder only.
    const checks = await Promise.all(
      folders.map((folder) =>
        sourcing(
          [realpathSync(folder.root)],
          [...folder.gate.flatMap((entry) => entry.sources), ...(folder.setup?.sources ?? [])],
        ),
      ),
    );
    return (ctx, p, c) => submit(ctx, p, c, checks);
  },
  'project.facts.refresh': async (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['project.facts.refresh'].parse(c.input);
    revision(ctx, c);
    projectAccess(ctx, p, input.project_id, c.type);
    const facts = await projectFacts(ctx, ctx.store.must<Project>('projects', input.project_id));
    return (ctx, p, c) => {
      userOnly(p);
      revision(ctx, c);
      projectAccess(ctx, p, input.project_id, c.type);
      const { facts: _, ...receipt } = storeFacts(
        ctx,
        ctx.store.must<Project>('projects', input.project_id),
        facts,
        c.command_id,
      );
      return receipt;
    };
  },
  'project.baseline.confirm': async (ctx, p, c) => {
    const target = confirmTarget(ctx, p, c),
      project = ctx.store.must<Project>('projects', target.baseline.project_id);
    // The gate check this confirmation makes reads the answers cached here.
    const git = await Promise.all(project.roots.map(gitFolderAsync));
    const gitRoots = new Set(project.roots.filter((_, index) => git[index]));
    return (ctx, p, c) => confirm(ctx, p, c, gitRoots);
  },
};

function start(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  facts: ProjectFacts,
  empty: boolean,
): ProjectBaseline {
  const { input, project } = startTarget(ctx, p, c);
  const snapshot = storeFacts(ctx, project, facts, c.command_id);
  const base = {
    id: id(),
    revision: 1,
    project_id: project.id,
    facts_id: snapshot.id,
    dropped: 0,
  };
  if (empty) {
    const baseline: ProjectBaseline = { ...base, state: 'empty', created_at: ctx.store.now() };
    ctx.store.insert('project_baselines', baseline);
    ctx.store.event('project.baseline_empty', baseline, project.id, {}, c.command_id);
    return baseline;
  }
  const runtimeName = baselineRuntime(ctx, project, input.runtime);
  const session = createBaselineSession(
    ctx,
    project,
    base.id,
    runtimeName,
    renderScanSeed(project, snapshot.facts.folders),
    input,
  );
  const baseline: ProjectBaseline = {
    ...base,
    state: 'running',
    session_id: session.id,
    runtime: runtimeName,
    created_at: ctx.store.now(),
    deadline: ctx.store.now() + BASELINE_WALL_TIME_MS,
  };
  ctx.store.insert('project_baselines', baseline);
  ctx.store.event(
    'project.baseline_started',
    baseline,
    project.id,
    { session_id: session.id },
    c.command_id,
  );
  return baseline;
}

function submit(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  sourced: ((refs: string[]) => boolean)[],
): ProjectBaseline {
  const { folders, baseline, session, project } = submitTarget(ctx, p, c);
  let dropped = 0;
  const kept = folders.map((folder, index): BaselineFolder => {
    const valid = sourced[index]!;
    const gate = folder.gate.filter((entry) => valid(entry.sources));
    const setup = folder.setup && valid(folder.setup.sources) ? folder.setup : undefined;
    dropped += folder.gate.length - gate.length + (folder.setup && !setup ? 1 : 0);
    return { root: folder.root, gate, ...(setup && { setup }) };
  });
  const next = ctx.store.update<ProjectBaseline>(
    'project_baselines',
    {
      ...baseline,
      state: 'submitted',
      result: { folders: project.roots.map((root) => kept.find((entry) => entry.root === root)!) },
      dropped,
    },
    baseline.revision,
  );
  ctx.store.event(
    'project.baseline_submitted',
    next,
    next.project_id,
    { session_id: session.id, dropped },
    c.command_id,
  );
  if (
    next.environment?.fix_requested_at !== undefined &&
    !ctx.store
      .list<EnvironmentCheck>('environment_checks')
      .some(
        (row) =>
          row.cause.kind === 'baseline' &&
          row.cause.baseline_id === next.id &&
          row.cause.attempt === 2,
      )
  )
    for (const folder of next.result!.folders) {
      const commands = baselineCommands(folder);
      if (!commands.length) continue;
      try {
        startEnvironmentCheck(ctx, {
          project_id: project.id,
          root: folder.root,
          commands,
          ...(folder.setup && { setup: { argv: folder.setup.argv } }),
          base_ref: 'HEAD',
          cause: { kind: 'baseline', baseline_id: next.id, attempt: 2 },
        });
      } catch (error) {
        // A folder Pantheon cannot make a worktree of gets no check; the submission still stands.
        if (!(error instanceof DomainError)) throw error;
      }
    }
  return next;
}

function confirm(ctx: ControlContext, p: Principal, c: Command, gitRoots: Set<string>): unknown {
  const { input, baseline } = confirmTarget(ctx, p, c);
  revision(ctx, c, baseline);
  requireThat(
    baseline.state === 'submitted' && baseline.result,
    'invalid_state',
    'Baseline must be submitted before confirmation',
  );
  const projectId = baseline.project_id;
  for (const gate of input.gates ?? [])
    setProjectGate(
      ctx,
      p,
      {
        ...c,
        type: 'project.gate.set',
        input: { project_id: projectId, root: gate.root, commands: gate.commands },
        expected_revision: ctx.store.must<Project>('projects', projectId).revision,
      },
      gitRoots,
    );
  // A setup the folders agree on and the newest checks ran passing prepares workers' worktrees too.
  const proposed = baseline.result.folders.filter((folder) => folder.setup);
  const setup = proposed[0]?.setup!.argv;
  const project = ctx.store.must<Project>('projects', projectId);
  const { latest } = baselineChecks(ctx, baseline.id);
  if (
    setup &&
    !project.worktree?.command &&
    proposed.every((folder) => {
      const ran = latest
        .find((check) => check.root === folder.root)
        ?.commands.find((command) => command.name === 'setup');
      return (
        folder.setup!.argv.join('\0') === setup.join('\0') &&
        ran?.argv.join('\0') === setup.join('\0') &&
        ran.exit_code === 0
      );
    })
  )
    setProjectWorktree(
      ctx,
      project,
      { copy_paths: project.worktree?.copy_paths ?? [], command: { argv: setup } },
      c.command_id,
    );
  const next = ctx.store.update<ProjectBaseline>(
    'project_baselines',
    { ...baseline, state: 'confirmed' },
    baseline.revision,
  );
  ctx.store.event('project.baseline_confirmed', next, projectId, {}, c.command_id);
  // Non-git folders are read-only.
  for (const gate of input.gates ?? []) {
    const root = resolvedPath(gate.root);
    if (gitRoots.has(root)) writeProjectConfig(ctx, root, { gate: gate.commands });
  }
  return next;
}

/** The session has no live process, queued or running turn, or pending stop left. */
export function sessionEnded(ctx: ControlContext, sessionId: string): boolean {
  const session = ctx.store.must<Session>('sessions', sessionId);
  return (
    !session.stop_pending &&
    !session.process_identity &&
    !['running', 'reconciling'].includes(session.state) &&
    ![...ctx.handles.values()].some((handle) => handle.platform_session_id === sessionId) &&
    !ctx.store
      .list<SessionTurn>('session_turns')
      .some((turn) => turn.session_id === sessionId && ['queued', 'running'].includes(turn.state))
  );
}

/** The commands an environment check of a folder runs: its gate without the commands turned off. */
export function baselineCommands(
  folder: BaselineFolder,
): { name: string; argv: string[]; skippable?: boolean }[] {
  return folder.gate
    .filter((command) => command.enabled !== false)
    .map(({ name, argv, skippable }) => ({ name, argv, ...(skippable && { skippable }) }));
}

/** Every check of the baseline's proposed commands, and the newest one of each root. */
function baselineChecks(ctx: ControlContext, baselineId: string) {
  const all = ctx.store
    .list<EnvironmentCheck>('environment_checks')
    .filter((entry) => entry.cause.kind === 'baseline' && entry.cause.baseline_id === baselineId);
  return {
    all,
    latest: all.filter(
      (entry, index) => !all.slice(index + 1).some((later) => later.root === entry.root),
    ),
  };
}

/**
 * Records an ended check of a baseline's proposed commands. When the newest check of every
 * folder has ended and one failed on its code, the submitted baseline goes back to its session
 * once to fix the commands. The caller owns the transaction.
 */
export function baselineChecked(ctx: ControlContext, row: EnvironmentCheck): void {
  if (row.cause.kind !== 'baseline') return;
  const { baseline_id, attempt } = row.cause;
  const baseline = ctx.store.must<ProjectBaseline>('project_baselines', baseline_id);
  const { all, latest: checks } = baselineChecks(ctx, baseline_id);
  const environment: NonNullable<ProjectBaseline['environment']> = {
    ...baseline.environment,
    check_ids: [
      ...new Set([...(baseline.environment?.check_ids ?? []), ...all.map((entry) => entry.id)]),
    ],
    commands: checks.flatMap((check) => {
      const folder = baseline.result?.folders.find((entry) => entry.root === check.root);
      return [
        ...check.commands.map((command) => ({
          root: check.root,
          name: command.name,
          state: command.exit_code === 0 ? ('passed' as const) : ('failed' as const),
        })),
        ...(folder ? baselineCommands(folder) : [])
          .filter((command) => !check.commands.some((ran) => ran.name === command.name))
          .map((command) => ({ root: check.root, name: command.name, state: 'not_run' as const })),
      ];
    }),
  };
  const failed = checks.filter((entry) => entry.state === 'failed');
  let session: Session | undefined;
  if (
    attempt === 1 &&
    failed.length &&
    checks.every((entry) => entry.state !== 'running') &&
    baseline.state === 'submitted' &&
    baseline.result &&
    environment.fix_requested_at === undefined
  ) {
    session = ctx.store.must<Session>('sessions', baseline.session_id!);
    try {
      acceptInput(ctx, session, session.state === 'running' ? 'steer' : 'send');
    } catch (error) {
      // A baseline session that no longer takes input leaves the failure on the card for the user.
      if (!(error instanceof DomainError)) throw error;
      session = undefined;
    }
  }
  if (!session) {
    ctx.store.update<ProjectBaseline>(
      'project_baselines',
      { ...baseline, environment },
      baseline.revision,
    );
    return;
  }
  const setups = new Set(
    baseline.result!.folders.flatMap((folder) =>
      folder.setup ? [folder.setup.argv.join('\0')] : [],
    ),
  );
  // The check prepares with the project's worktree command, else with the folder's setup.
  const prepared = ctx.store.must<Project>('projects', baseline.project_id).worktree?.command
    ? "prepared the way a worker gets one, with the project's worktree command,"
    : !setups.size
      ? 'prepared the way a worker gets one,'
      : setups.size === 1
        ? 'prepared with your setup command, which workers get only once it passes here and the user confirms the baseline,'
        : "prepared with the folder's setup command, which workers do not get because the folders propose different ones,";
  const now = ctx.store.now();
  ctx.store.update<ProjectBaseline>(
    'project_baselines',
    {
      ...baseline,
      state: 'running',
      deadline: now + BASELINE_WALL_TIME_MS,
      environment: { ...environment, fix_requested_at: now },
    },
    baseline.revision,
  );
  queueTurn(
    ctx,
    session,
    [
      `Pantheon ran the commands you proposed in a fresh worktree, ${prepared} and these failed:`,
      ...failed.flatMap((check) =>
        check.commands
          .filter((command) => command.exit_code !== 0)
          .map(
            (command) =>
              `- ${command.name} in ${check.root} (exit ${command.exit_code}):\n${command.output_tail}`,
          ),
      ),
      'Fix the command and submit every folder again with project_baseline_submit, or keep it and say in your reply why it cannot run here. You get this once: Pantheon checks the commands one more time after you submit and does not send them back again.',
    ].join('\n'),
    'baseline',
    row.id,
  );
}

export function tickProjectBaselines(ctx: ControlContext): void {
  for (const baseline of ctx.store.list<ProjectBaseline>('project_baselines')) {
    if (baseline.state !== 'running') continue;
    const reason =
      ctx.store.now() >= baseline.deadline!
        ? 'baseline_window_expired'
        : sessionEnded(ctx, baseline.session_id!)
          ? 'baseline_missing'
          : undefined;
    if (!reason) continue;
    const next = ctx.store.update<ProjectBaseline>(
      'project_baselines',
      { ...baseline, state: 'failed', reason },
      baseline.revision,
    );
    ctx.store.event('project.baseline_failed', next, next.project_id, { reason });
  }
}
