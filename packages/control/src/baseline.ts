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
  type BaselineAnswer,
  type BaselineFacts,
  type BaselineFolder,
  type BaselineQuestion,
  type ExtensionOverrides,
  type Principal,
  type Project,
  type ProjectBrief,
  type ProjectBaseline,
  type Session,
  type SessionTurn,
  type BaselineResult,
  type Visual,
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
  sessionPrincipal,
  userOnly,
  type ControlContext,
  type Handler,
  type Handlers,
  type Preparers,
} from './context.js';
import { sessionDefaults } from './user-config.js';
import { DISABLED, projectHandlers, readPantheonFile, setProjectGate } from './project.js';
import { projectFactHandlers } from './project-facts.js';
import { runtime } from './admission.js';
import { runGit } from './git.js';
import { collectFacts, type ProjectFacts } from './baseline-facts.js';
import { renderScanSeed } from './baseline-brief.js';
import { startLead } from './lead-session.js';
import { readSessionOpening, type SessionOpening } from './workbench-session.js';
import { acceptInput } from './session.js';
import { queueTurn } from './task-tracking.js';
import { readAppSettings } from './app-settings.js';
import { visualHandlers } from './visual.js';
import { rangeCommits, startRangeStory, type RangeCommit } from './range-story.js';

export const BASELINE_WALL_TIME_MS = 30 * 60 * 1000;
const FACTS_KEPT = 30;
/** The range a confirmed baseline explains as a range story. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;
const NO_OVERRIDES: ExtensionOverrides = {
  disabled_mcp_servers: [],
  disabled_plugins: [],
  disabled_skills: [],
  disable_apps: false,
  disable_hooks: false,
};

/** Runtimes whose adapter can list its extensions. */
export function inventoryRuntimes(ctx: ControlContext): string[] {
  return [...ctx.adapters].filter(([, adapter]) => adapter.inventory).map(([name]) => name);
}

/** True for the running baseline session of this project, which may read extension inventories. */
export function baselineSessionOf(ctx: ControlContext, p: Principal, projectId: string): boolean {
  const session = p.session_id ? ctx.store.get<Session>('sessions', p.session_id) : undefined;
  if (!session?.baseline) return false;
  sessionPrincipal(ctx, p);
  const baseline = ctx.store.get<ProjectBaseline>(
    'project_baselines',
    session.baseline.baseline_id,
  );
  return (
    session.project_id === projectId &&
    baseline?.session_id === session.id &&
    baseline.state === 'running'
  );
}

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

/** Task lists by root default to those of the newest submitted or confirmed baseline. */
async function projectFacts(
  ctx: ControlContext,
  project: Project,
  taskLists?: Record<string, string[]>,
): Promise<ProjectFacts> {
  const lists =
    taskLists ??
    Object.fromEntries(
      (
        ctx.store
          .list<ProjectBaseline>('project_baselines')
          .filter(
            (entry) =>
              entry.project_id === project.id && ['submitted', 'confirmed'].includes(entry.state),
          )
          .at(-1)?.result?.folders ?? []
      ).map((folder) => [folder.root, folder.context?.task_lists ?? []]),
    );
  const git = await Promise.all(project.roots.map(gitFolderAsync));
  return collectFacts(
    project.roots.map((root, index) => ({ path: root, git: git[index]!, task_lists: lists[root] })),
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

/** The confirmed result and the commits each root gained since the snapshot it was judged on. */
async function previousScan(ctx: ControlContext, baseline: ProjectBaseline) {
  const counts = await Promise.all(
    (ctx.store.get<BaselineFacts>('baseline_facts', baseline.facts_id)?.facts.folders ?? []).map(
      async (folder) => {
        if (!folder.head) return [];
        const count = await runGit(
          folder.root,
          ['rev-list', '--count', `${folder.head}..HEAD`],
          undefined,
          true,
        );
        return count.exit_code === 0
          ? [[folder.root, Number(count.stdout.toString().trim())] as const]
          : [];
      },
    ),
  );
  return { result: baseline.result!, commits_since: Object.fromEntries(counts.flat()) };
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
  // The command can still fail after this write, in a later folder or when opening the lead.
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

/** Each workstream's items found again by hash in the newest snapshot of the same root. */
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
  const baseline = ctx.store
    .list<ProjectBaseline>('project_baselines')
    .filter(
      (entry) => entry.project_id === projectId && ['submitted', 'confirmed'].includes(entry.state),
    )
    .at(-1);
  const find = (item: { root: string; path: string; hash: string }) => {
    const lists =
      snapshot?.facts.folders.find((folder) => folder.root === item.root)?.checklists ?? [];
    const match = (list: (typeof lists)[number]) =>
      list.items.find((entry) => entry.hash === item.hash);
    const same = lists.find((list) => list.path === item.path);
    return (same && match(same)) ?? lists.map(match).find(Boolean);
  };
  return {
    facts: snapshot?.facts ?? null,
    collected_at: snapshot?.collected_at ?? null,
    empty: roots.every((root, index) => emptyProject(root, heads[index]!)),
    workstreams: (baseline?.result?.workstreams ?? []).map((stream) => {
      const found = stream.items.map(find);
      return {
        id: stream.id,
        title: stream.title,
        status: stream.status,
        next: stream.next,
        blockers: stream.blockers,
        ...(stream.modules && { modules: stream.modules }),
        ...(stream.depends_on && { depends_on: stream.depends_on }),
        ...(stream.risks && { risks: stream.risks }),
        done: found.filter((item) => item?.done).length,
        open: found.filter((item) => item && !item.done).length,
        missing: found.filter((item) => !item).length,
      };
    }),
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
  if (p.role !== 'lead') userOnly(p);
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

function submitFolderTarget(ctx: ControlContext, p: Principal, c: Command) {
  const { baseline_id, ...submitted } = inputSchemas['project.baseline.submit_folder'].parse(
    c.input,
  );
  revision(ctx, c);
  const { baseline, session } = boundBaseline(ctx, p, baseline_id, c.type);
  const project = ctx.store.must<Project>('projects', baseline.project_id);
  requireThat(
    project.roots.includes(submitted.root),
    'invalid_input',
    `root must be one of the project folders: ${project.roots.join(', ')}`,
  );
  return { submitted, baseline, session, root: realpathSync(submitted.root) };
}

function submitTarget(ctx: ControlContext, p: Principal, c: Command) {
  const { baseline_id, ...submitted } = inputSchemas['project.baseline.submit'].parse(c.input);
  revision(ctx, c);
  const { baseline, session } = boundBaseline(ctx, p, baseline_id, c.type);
  const project = ctx.store.must<Project>('projects', baseline.project_id);
  const { folders = [] } = baseline;
  const missing = project.roots.filter((root) => !folders.some((entry) => entry.root === root));
  requireThat(
    !missing.length,
    'invalid_state',
    `Submit each folder with project_baseline_submit_folder first; missing: ${missing.join(', ')}`,
  );
  const intro = ctx.store.projectIntro(project.id);
  requireThat(
    intro && (intro.session_id === session.id || intro.written_at >= baseline.created_at),
    'invalid_state',
    'Submit the introduction with project_intro_submit first',
  );
  const round = (baseline.rounds?.length ?? 0) + 1;
  const directions = submitted.questions.filter((question) => question.kind === 'direction');
  requireThat(
    round > 1 ||
      !submitted.questions.length ||
      (directions.length === 1 &&
        directions[0]!.options.length <= 3 &&
        directions[0]!.options.every((option) => option.preview)),
    'invalid_input',
    'The first round asks exactly one question of kind direction, with 2 to 3 options that each have a preview',
  );
  requireThat(
    round < readAppSettings(ctx).baseline_rounds || !submitted.questions.length,
    'invalid_input',
    `Round ${round} is the last round; submit questions as an empty array`,
  );
  const runtimes = inventoryRuntimes(ctx);
  requireThat(
    (submitted.extensions ?? []).every((entry) => runtimes.includes(entry.runtime)),
    'invalid_input',
    `extensions runtime must be one of: ${runtimes.join(', ')}`,
  );
  return { submitted, baseline, session, project, folders };
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
    const confirmed = ctx.store
      .list<ProjectBaseline>('project_baselines')
      .filter((entry) => entry.project_id === target.id && entry.state === 'confirmed')
      .at(-1);
    const previous = !empty && confirmed?.result ? await previousScan(ctx, confirmed) : undefined;
    return (ctx, p, c) => start(ctx, p, c, facts, empty, previous);
  },
  'project.baseline.submit_folder': async (ctx, p, c) => {
    const { submitted, root } = submitFolderTarget(ctx, p, c);
    const check = await sourcing(
      [root],
      [
        ...submitted.gate.flatMap((entry) => entry.sources),
        ...Object.values(submitted.commands ?? {}).flatMap((entry) => entry!.sources),
      ],
    );
    return (ctx, p, c) => submitFolder(ctx, p, c, check);
  },
  'project.baseline.submit': async (ctx, p, c) => {
    const { submitted, project, folders } = submitTarget(ctx, p, c);
    const facts = await projectFacts(
      ctx,
      project,
      Object.fromEntries(folders.map((folder) => [folder.root, folder.context?.task_lists ?? []])),
    );
    const check = await sourcing(
      project.roots.map((root) => realpathSync(root)),
      [
        ...(submitted.brief?.sources ?? []),
        ...submitted.tasks.flatMap((task) => task.sources),
        ...submitted.workstreams.flatMap((stream) => stream.commits),
        ...submitted.contradictions.flatMap((entry) => entry.refs),
        ...submitted.findings.flatMap((entry) => entry.refs),
      ],
    );
    return (ctx, p, c) => submit(ctx, p, c, facts, check);
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
    const now = ctx.store.now();
    const commits = readAppSettings(ctx).baseline_range_story
      ? await rangeCommits(ctx, project, now - RECENT_MS, now)
      : [];
    // The start point of the lead a confirmation that plans the board starts.
    const opening = target.input.plan_board
      ? await readSessionOpening(ctx, { project_id: project.id })
      : undefined;
    return (ctx, p, c) => confirm(ctx, p, c, gitRoots, now, commits, opening);
  },
};

function start(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  facts: ProjectFacts,
  empty: boolean,
  previous: Awaited<ReturnType<typeof previousScan>> | undefined,
): ProjectBaseline {
  const { input, project } = startTarget(ctx, p, c);
  const snapshot = storeFacts(ctx, project, facts, c.command_id);
  const base = {
    id: id(),
    revision: 1,
    project_id: project.id,
    facts_id: snapshot.id,
    dropped: 0,
    ...(p.role === 'lead' && { lead_session_id: p.session_id }),
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
    renderScanSeed(project, snapshot.facts.folders, previous),
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

function submitFolder(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  sourced: (refs: string[]) => boolean,
): ProjectBaseline {
  const { submitted, baseline, session, root } = submitFolderTarget(ctx, p, c);
  let dropped = 0;
  const keep = <T>(items: T[], valid: (item: T) => boolean): T[] => {
    const kept = items.filter(valid);
    dropped += items.length - kept.length;
    return kept;
  };
  const { context, commands } = submitted;
  const folder: BaselineFolder = {
    ...submitted,
    ...(context && {
      context: {
        instructions: keep(context.instructions, (entry) => located(root, entry)),
        docs: keep(context.docs, (entry) => located(root, entry)),
        task_lists: keep(context.task_lists, (entry) => located(root, entry)),
      },
    }),
    gate: keep(submitted.gate, (entry) => sourced(entry.sources)),
    ...(commands && {
      commands: Object.fromEntries(
        keep(Object.entries(commands), ([, entry]) => sourced(entry!.sources)),
      ),
    }),
  };
  const folders = (baseline.folders ?? []).filter((entry) => entry.root !== folder.root);
  const next = ctx.store.update<ProjectBaseline>(
    'project_baselines',
    { ...baseline, folders: [...folders, folder], dropped: baseline.dropped + dropped },
    baseline.revision,
  );
  ctx.store.event(
    'project.baseline_folder_submitted',
    next,
    next.project_id,
    { session_id: session.id, root: folder.root, dropped },
    c.command_id,
  );
  return next;
}

function submit(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  collected: ProjectFacts,
  sourced: (refs: string[]) => boolean,
): ProjectBaseline {
  const { submitted, baseline, session, project, folders } = submitTarget(ctx, p, c);
  const { folders: _, ...rest } = baseline;
  const roots = project.roots.map((root) => realpathSync(root));
  const facts = storeFacts(ctx, project, collected, c.command_id);
  const lists = facts.facts.folders.map((folder) => ({
    root: folder.root,
    checklists: folder.checklists,
  }));
  let dropped = 0;
  const keep = <T>(items: T[], valid: (item: T) => boolean): T[] => {
    const kept = items.filter(valid);
    dropped += items.length - kept.length;
    return kept;
  };
  const resolve = (ref: string) => {
    const [, file, line] = /^file:(.+):([1-9][0-9]*)$/.exec(ref)!;
    return lists.flatMap(({ root, checklists }) =>
      checklists
        .filter((list) => list.path === file)
        .flatMap((list) => list.items.filter((item) => item.line === Number(line)))
        .map((item) => ({ root, path: file!, line: item.line, hash: item.hash })),
    );
  };
  // One match per root that has the section, so a section found in two folders is ambiguous.
  const resolveSection = (ref: string) => {
    const [, file, heading] = /^section:([^#]*)#([^]*)$/.exec(ref)!;
    return lists.flatMap(({ root, checklists }) =>
      checklists
        .filter((list) => list.path === file)
        .map((list) =>
          list.items
            .filter((item) => (item.section ?? '') === heading)
            .map((item) => ({ root, path: file!, line: item.line, hash: item.hash })),
        )
        .filter((items) => items.length),
    );
  };
  const brief = keep(submitted.brief ? [submitted.brief] : [], (entry) =>
    sourced(entry.sources),
  )[0];
  const streams = new Set(submitted.workstreams.map((stream) => stream.id));
  const tasks = keep(
    submitted.tasks,
    (task) => sourced(task.sources) && streams.has(task.workstream),
  );
  const taskIds = new Set(tasks.map((task) => task.id));
  const result: BaselineResult = {
    folders: project.roots.map((root) => folders.find((entry) => entry.root === root)!),
    workstreams: submitted.workstreams.map(({ sections, modules, depends_on, ...stream }) => {
      // A reference that matches nothing, or matches in more than one folder, is dropped.
      const single = <T>(refs: T[][]) =>
        keep(refs, (matches) => matches.length === 1).map((matches) => matches[0]!);
      const items = [
        ...single(stream.items.map(resolve)),
        ...single(sections.map(resolveSection)).flat(),
      ];
      return {
        ...stream,
        ...(modules && {
          modules: keep(modules, (entry) => roots.some((root) => located(root, entry))),
        }),
        ...(depends_on && {
          depends_on: depends_on.filter((key) => key !== stream.id && streams.has(key)),
        }),
        items: items.filter(
          (item, index) =>
            items.findIndex((entry) => entry.root === item.root && entry.hash === item.hash) ===
            index,
        ),
        commits: keep(stream.commits, (ref) => sourced([ref])),
      };
    }),
    contradictions: keep(submitted.contradictions, (entry) => sourced(entry.refs)),
    findings: keep(submitted.findings, (entry) => sourced(entry.refs)),
    ...(brief ? { brief } : {}),
    questions: submitted.questions,
    ...(submitted.extensions ? { extensions: submitted.extensions } : {}),
    tasks: tasks.map((task) => ({
      ...task,
      depends_on: task.depends_on.filter((dependency) => taskIds.has(dependency)),
    })),
  };
  const next = ctx.store.update<ProjectBaseline>(
    'project_baselines',
    {
      ...rest,
      facts_id: facts.id,
      state: 'submitted',
      result,
      dropped: baseline.dropped + dropped,
    },
    baseline.revision,
  );
  ctx.store.event(
    'project.baseline_submitted',
    next,
    next.project_id,
    { session_id: session.id, dropped: next.dropped },
    c.command_id,
  );
  const auto = [...(project.extension_auto ?? [])];
  const overrides = { ...project.extension_overrides };
  const changed = new Set<string>();
  for (const entry of submitted.extensions ?? []) {
    const index = auto.findIndex(
      (item) =>
        item.runtime === entry.runtime && item.kind === entry.kind && item.name === entry.name,
    );
    if (auto[index]?.restored) continue;
    const current = overrides[entry.runtime] ?? NO_OVERRIDES;
    const key = DISABLED[entry.kind];
    // One the user turned off stays the user's, so unchecking the suggestion leaves it off.
    if (index < 0 && current[key].includes(entry.name)) continue;
    const record = { ...entry, baseline_id: next.id };
    if (index < 0) auto.push(record);
    else auto[index] = record;
    overrides[entry.runtime] = { ...current, [key]: [...new Set([...current[key], entry.name])] };
    changed.add(entry.runtime);
  }
  if (changed.size) {
    const updated = ctx.store.update<Project>(
      'projects',
      { ...project, extension_overrides: overrides, extension_auto: auto },
      project.revision,
    );
    for (const runtime of changed)
      ctx.store.event(
        'project.extensions_set',
        updated,
        project.id,
        { runtime, overrides: overrides[runtime], source: 'baseline', baseline_id: next.id },
        c.command_id,
      );
  }
  return next;
}

function confirm(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  gitRoots: Set<string>,
  now: number,
  commits: RangeCommit[],
  opening?: SessionOpening,
): unknown {
  const { input, baseline } = confirmTarget(ctx, p, c);
  revision(ctx, c, baseline);
  requireThat(
    baseline.state === 'submitted' && baseline.result,
    'invalid_state',
    'Baseline must be submitted before confirmation',
  );
  const projectId = baseline.project_id;
  if (input.brief)
    projectFactHandlers['project.brief.set']!(ctx, p, {
      ...c,
      type: 'project.brief.set',
      input: { project_id: projectId, ...input.brief },
      expected_revision: ctx.store.get<ProjectBrief>('project_briefs', projectId)?.revision ?? null,
    });
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
  // Checked extensions stay off; ones this baseline turned off and the user unchecked go back on.
  const kept = input.extensions ?? [];
  const unchecked = (ctx.store.must<Project>('projects', projectId).extension_auto ?? []).filter(
    (entry) =>
      entry.baseline_id === baseline.id &&
      !entry.restored &&
      !kept.some(
        (item) =>
          item.runtime === entry.runtime && item.kind === entry.kind && item.name === entry.name,
      ),
  );
  for (const runtime of new Set([...kept, ...unchecked].map((entry) => entry.runtime))) {
    const project = ctx.store.must<Project>('projects', projectId);
    const overrides = { ...(project.extension_overrides?.[runtime] ?? NO_OVERRIDES) };
    for (const entry of unchecked.filter((item) => item.runtime === runtime)) {
      const key = DISABLED[entry.kind];
      overrides[key] = overrides[key].filter((name) => name !== entry.name);
    }
    for (const entry of kept.filter((item) => item.runtime === runtime)) {
      const key = DISABLED[entry.kind];
      overrides[key] = [...new Set([...overrides[key], entry.name])];
    }
    projectHandlers['project.extensions.set']!(ctx, p, {
      ...c,
      type: 'project.extensions.set',
      input: { project_id: projectId, runtime, overrides },
      expected_revision: project.revision,
    });
  }
  const next = ctx.store.update<ProjectBaseline>(
    'project_baselines',
    { ...baseline, state: 'confirmed' },
    baseline.revision,
  );
  ctx.store.event('project.baseline_confirmed', next, projectId, {}, c.command_id);
  const { result } = baseline;
  const rounds = [
    ...(baseline.rounds ?? []),
    { questions: result.questions, answers: input.answers },
  ];
  const gates = new Map(input.gates?.map((gate) => [resolvedPath(gate.root), gate.commands]));
  // Non-git folders are read-only; brief and decisions live with the first git folder.
  const writable = ctx.store
    .must<Project>('projects', projectId)
    .roots.filter((root) => gitRoots.has(root));
  for (const root of writable) {
    const folder = result.folders.find((entry) => entry.root === root);
    const gate = gates.get(root);
    const first = root === writable[0];
    if (!folder && !gate && !first) continue;
    writeProjectConfig(ctx, root, {
      ...(folder && { project: { stage: folder.stage, stack: folder.stack } }),
      ...(folder?.context && { context: folder.context }),
      ...(gate && { gate }),
      ...(folder?.commands && {
        commands: Object.fromEntries(
          Object.entries(folder.commands).map(([key, entry]) => [key, entry!.argv]),
        ),
      }),
      ...(first && {
        ...(input.brief && { brief: input.brief }),
        decisions: rounds
          .flatMap((round) => round.answers)
          .map(({ question, answer, by }) => ({
            question,
            answer:
              by === 'user'
                ? answer
                : answer
                  ? `${answer} (left to the model)`
                  : 'Left to the model',
          })),
      }),
    });
  }
  if (readAppSettings(ctx).baseline_visuals)
    for (const visual of ctx.store
      .list<Visual>('visuals')
      .filter((entry) => entry.session_id === baseline.session_id && !entry.pin))
      visualHandlers['visual.pin']!(ctx, p, {
        ...c,
        type: 'visual.pin',
        input: { visual_id: visual.id, size: 'M' },
      });
  if (readAppSettings(ctx).baseline_range_story) {
    try {
      startRangeStory(
        ctx,
        ctx.store.must<Project>('projects', projectId),
        now - RECENT_MS,
        now,
        c.command_id,
        commits,
      );
    } catch (error) {
      // A project with no commits in the window gets no story; the confirm still stands.
      if (!(error instanceof DomainError) || error.code !== 'invalid_input') throw error;
    }
  }
  if (!input.plan_board) return next;
  const brief = input.brief ?? result.brief;
  const starter = baseline.lead_session_id
    ? ctx.store.get<Session>('sessions', baseline.lead_session_id)
    : undefined;
  // A starter lead that no longer takes input leaves the result to a new lead.
  let takesInput = !!starter;
  try {
    if (starter) acceptInput(ctx, starter, starter.state === 'running' ? 'steer' : 'send');
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    takesInput = false;
  }
  if (starter && takesInput) {
    queueTurn(
      ctx,
      starter,
      firstPlanMessage(result, brief, rounds, true),
      'baseline',
      c.command_id,
    );
    return { ...next, lead_session_id: starter.id };
  }
  const lead = startLead(
    ctx,
    p,
    projectId,
    'Baseline plan',
    firstPlanMessage(result, brief, rounds),
    c.command_id,
    'baseline',
    opening!,
  );
  if (!lead) return next;
  const planned = ctx.store.update<ProjectBaseline>(
    'project_baselines',
    { ...next, plan_session_id: lead.id },
    next.revision,
  );
  return { ...planned, lead_session_id: lead.id };
}

export const baselineHandlers: Handlers = {
  'project.baseline.continue': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['project.baseline.continue'].parse(c.input);
    const baseline = ctx.store.must<ProjectBaseline>('project_baselines', input.baseline_id);
    projectAccess(ctx, p, baseline.project_id, c.type);
    revision(ctx, c, baseline);
    requireThat(
      baseline.state === 'submitted' && baseline.result,
      'invalid_state',
      'Baseline must be submitted before it continues',
    );
    const { result } = baseline;
    const round = (baseline.rounds?.length ?? 0) + 1;
    const limit = readAppSettings(ctx).baseline_rounds;
    requireThat(round < limit, 'invalid_state', 'This baseline has reached its last round');
    const unknown = input.answers.filter(
      (answer) => !result.questions.some((question) => question.id === answer.question_id),
    );
    requireThat(
      !unknown.length,
      'invalid_input',
      `answers name questions this round did not ask: ${unknown.map((answer) => answer.question_id).join(', ')}`,
    );
    const session = ctx.store.must<Session>('sessions', baseline.session_id!);
    acceptInput(ctx, session, session.state === 'running' ? 'steer' : 'send');
    const now = ctx.store.now();
    const next = ctx.store.update<ProjectBaseline>(
      'project_baselines',
      {
        ...baseline,
        state: 'running',
        folders: result.folders,
        deadline: now + BASELINE_WALL_TIME_MS,
        rounds: [
          ...(baseline.rounds ?? []),
          { questions: result.questions, answers: input.answers, at: now },
        ],
      },
      baseline.revision,
    );
    queueTurn(
      ctx,
      session,
      [
        `The user answered the questions of round ${round}:`,
        ...input.answers.map((answer) => `- ${answered(result.questions, answer)}`),
        `This is round ${round + 1} of at most ${limit}. Read files again where you need to, then submit the complete revised assessment with project_baseline_submit. In questions ask only about what is still undecided; submit an empty array when nothing is left to ask.`,
        ...(round + 1 === limit
          ? ['This is the last round: submit questions as an empty array.']
          : []),
      ].join('\n'),
      'baseline',
      c.command_id,
    );
    ctx.store.event(
      'project.baseline_continued',
      next,
      next.project_id,
      { round: round + 1 },
      c.command_id,
    );
    return next;
  },
};

/** One answered question; a choice left to the model names the recommended option. */
function answered(questions: BaselineQuestion[], answer: BaselineAnswer): string {
  const recommended =
    questions.find((question) => question.id === answer.question_id)?.recommended ??
    (answer.answer || undefined);
  const text =
    answer.by === 'user'
      ? answer.answer
      : `left to you${recommended ? `; the recommended option is ${recommended}` : ''}`;
  return `${answer.question} Answer: ${text}`;
}

const RESULT_LIMIT = 8000;

function firstPlanMessage(
  result: BaselineResult,
  brief: { goal: string; goals: string[]; non_goals: string[] } | undefined,
  rounds: { questions: BaselineQuestion[]; answers: BaselineAnswer[] }[],
  /** True when the message goes back to the lead that started the baseline. */
  rerun = false,
): string {
  // Workstreams go last so the length limit cuts them before the user's answers.
  const tasks = result.tasks ?? [];
  const title = (list: { id: string; title: string }[], key: string) =>
    list.find((entry) => entry.id === key)?.title ?? key;
  const summary = [
    ...(brief ? [`Goal: ${brief.goal}`] : []),
    ...(brief?.goals.length ? ['Goals:', ...brief.goals.map((goal) => `- ${goal}`)] : []),
    ...(brief?.non_goals.length
      ? ['Non-goals:', ...brief.non_goals.map((goal) => `- ${goal}`)]
      : []),
    ...rounds.flatMap((round, index) => [
      ...(round.questions.length
        ? [
            `Questions of round ${index + 1}:`,
            ...round.questions.map((entry) => `- ${entry.question}`),
          ]
        : []),
      ...(round.answers.length
        ? [
            `The user's answers in round ${index + 1}:`,
            ...round.answers.map((entry) => `- ${answered(round.questions, entry)}`),
          ]
        : []),
    ]),
    ...(tasks.length
      ? [
          'Next tasks:',
          ...tasks.map(
            (task) =>
              `- ${task.title} (workstream: ${title(result.workstreams, task.workstream)}): ${task.why} Scope: ${task.scope.join(', ')}${task.acceptance.length ? ` Acceptance: ${task.acceptance.join('; ')}` : ''}${task.depends_on.length ? ` Depends on: ${task.depends_on.map((key) => title(tasks, key)).join('; ')}` : ''}`,
          ),
        ]
      : []),
    ...(result.findings.length
      ? ['Findings:', ...result.findings.map((entry) => `- (${entry.severity}) ${entry.text}`)]
      : []),
    ...(result.contradictions.length
      ? ['Docs the code contradicts:', ...result.contradictions.map((entry) => `- ${entry.text}`)]
      : []),
    'Workstreams:',
    ...result.workstreams.map(
      (stream) =>
        `- ${stream.title} (${stream.status}): ${stream.reason}${stream.modules?.length ? ` Modules: ${stream.modules.join(', ')}` : ''}${stream.depends_on?.length ? ` Depends on: ${stream.depends_on.map((key) => title(result.workstreams, key)).join('; ')}` : ''}${stream.next.length ? ` Next: ${stream.next.join('; ')}` : ''}${stream.blockers.length ? ` Blockers: ${stream.blockers.join('; ')}` : ''}${stream.risks?.length ? ` Risks: ${stream.risks.join('; ')}` : ''}`,
    ),
  ].join('\n');
  return [
    ...(rerun
      ? [
          'This is the confirmed new baseline of the project that you started with rerun_baseline.',
          'Rewrite your plan from it with update_board: keep the ids of tasks that still apply, add tasks for the work still to do, and remove tasks that are no longer needed. Stages that can be accepted become milestones, the open questions become risks or assumptions, risk findings become risks and contradictions become assumptions.',
          'Each next task becomes a board task: quote its title as its source and copy its scope, acceptance and dependencies.',
        ]
      : [
          'This is the confirmed baseline of the project.',
          'Write the first plan of the board with update_board: workstreams become lanes, the work still to do becomes tasks with their dependencies, stages that can be accepted become milestones, the open questions become risks or assumptions, risk findings become risks and contradictions become assumptions.',
          'Each next task becomes a board task: quote its title as its source and copy its scope, acceptance and dependencies.',
        ]),
    'When the plan is written, end your turn; do not implement anything.',
    summary.length > RESULT_LIMIT ? `${summary.slice(0, RESULT_LIMIT)}…` : summary,
  ].join('\n\n');
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
