import { execFile } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  id,
  requireThat,
  DomainError,
  type Landing,
  type Project,
  type Session,
  type SessionDefaults,
  type ProjectBaseline,
  type Workspace,
  type Principal,
  type WorkflowPolicy,
} from '@pantheon/domain';
import {
  inputSchemas,
  pantheonConfigSchema,
  pantheonLocalConfigSchema,
  PROJECT_SETTING_KEYS,
  type Command,
  type ProjectBranch,
  type ProjectDefaultsRead,
  type ProjectSettingKey,
  type ProjectSettingOverview,
  type ProjectSettingValues,
} from '@pantheon/protocol';
import {
  inside,
  projectAccess,
  revision,
  gitFolderAsync,
  resolvedPath,
  userOnly,
  type ControlContext,
  type Handler,
  type Handlers,
  type Preparers,
} from './context.js';
import { ensureAgents } from './agents.js';
import { runGit } from './git.js';
import { projectFactHandlers } from './project-facts.js';
import { releaseIdleConversations } from './session.js';
import { dispatchQueue } from './task-dispatch.js';
import {
  autoGitInit,
  homeRuntime,
  projectDefaults,
  readUserConfig,
  userConfigDirectory,
  writeUserConfig,
} from './user-config.js';
import {
  checkPolicyDefaults,
  clearPolicyOverrides,
  DEFAULT_WORKFLOW_POLICY,
  inheritedPolicy,
  ownPolicySettings,
  writeGlobalPolicyChanges,
} from './workflow-policy.js';

export const DISABLED = {
  mcp_server: 'disabled_mcp_servers',
  plugin: 'disabled_plugins',
  skill: 'disabled_skills',
} as const;

/** Reads a `.pantheon/` file when present; unreadable JSON or a schema mismatch rejects the project. */
export function readPantheonFile<T>(
  file: string,
  schema: { parse(value: unknown): T },
): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return schema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new DomainError('invalid_project', `Invalid ${file}: ${(error as Error).message}`);
  }
}

function projectDirectory(ctx: ControlContext, target: string): string {
  const resolved = realpathSync(target);
  requireThat(statSync(resolved).isDirectory(), 'invalid_project', 'Project must be a directory');
  requireThat(
    ctx.store.file === ':memory:' || !inside(resolved, realpathSync(path.dirname(ctx.store.file))),
    'scope_violation',
    'Project cannot include the control database or credentials',
  );
  return resolved;
}

/** Real project roots, each listed once and disjoint from each other. */
function projectRoots(ctx: ControlContext, targets: string[]): string[] {
  const roots: string[] = [];
  for (const target of targets) {
    const resolved = projectDirectory(ctx, target);
    requireThat(!roots.includes(resolved), 'invalid_project', 'Project root is listed twice');
    for (const other of roots)
      requireThat(
        !inside(other, resolved) && !inside(resolved, other),
        'scope_violation',
        'Project roots overlap each other',
      );
    roots.push(resolved);
  }
  return roots;
}

const execFileAsync = promisify(execFile);

/** Writers work in linked worktrees, so each root becomes a git repository with a first commit made as the user. */
async function requireGitRoots(ctx: ControlContext, roots: string[]): Promise<void> {
  const autoInit = autoGitInit(ctx.userConfigDir);
  for (const root of roots) {
    // Two opens of one empty folder would each run init and make a first commit.
    let pending = gitRootChecks.get(root);
    if (!pending) {
      pending = requireGitRoot(root, autoInit).finally(() => gitRootChecks.delete(root));
      gitRootChecks.set(root, pending);
    }
    await pending;
  }
}

/** The root checks and first commits running now, by root. */
const gitRootChecks = new Map<string, Promise<void>>();

async function requireGitRoot(root: string, autoInit: boolean): Promise<void> {
  const git = (args: string[]) =>
    execFileAsync('git', args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  const read = (args: string[]) => runGit(root, args, undefined, true);
  const hasHead = async () =>
    (await read(['rev-parse', '--verify', '--quiet', 'HEAD'])).exit_code === 0;
  if (!autoInit && (!(await gitFolderAsync(root)) || !(await hasHead())))
    throw new DomainError('git_required', `${root} is not a git repository`);
  if (!(await gitFolderAsync(root))) {
    // A repository of its own would hide files the outer repository already tracks.
    const tracked = await read(['ls-files', '-z', '--', '.']);
    if (tracked.exit_code === 0 && tracked.stdout.length > 0)
      throw new DomainError(
        'invalid_project',
        `${root} holds files tracked by the git repository ${(await read(['rev-parse', '--show-toplevel'])).stdout.toString().trim()}; add that repository as the project folder`,
      );
    await git(['init', '--quiet']);
  }
  if (await hasHead()) return;
  try {
    await git(['add', '--all']);
    await git(['commit', '--quiet', '--allow-empty', '-m', 'Initial commit']);
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    throw new DomainError(
      'invalid_project',
      `Cannot make the first commit in ${root}: ${stderr?.trim() || message}`,
    );
  }
}

const overlaps = (a: string[], b: string[]): boolean =>
  a.some((x) => b.some((y) => inside(x, y) || inside(y, x)));

/** Rejects roots that equal, contain or lie inside a root of another project, removed or not. */
function disjointFromOthers(ctx: ControlContext, roots: string[], self?: string): void {
  const other = ctx.store
    .list<Project>('projects')
    .find((project) => project.id !== self && overlaps(project.roots, roots));
  requireThat(
    !other,
    'scope_violation',
    `Project roots overlap ${other?.removed_at === undefined ? '' : 'removed '}project "${other?.name}" (${other?.id})`,
  );
}

/** Project-level settings from every root's `.pantheon/` files, in root order. */
async function rootConfig(roots: string[]) {
  const gates: NonNullable<Project['gates']> = {};
  let extensions: Project['extension_overrides'];
  let brief: ReturnType<typeof pantheonConfigSchema.parse>['brief'];
  for (const root of roots) {
    const committed = readPantheonFile(
      path.join(root, '.pantheon', 'config.json'),
      pantheonConfigSchema,
    );
    const local = readPantheonFile(
      path.join(root, '.pantheon', 'config.local.json'),
      pantheonLocalConfigSchema,
    );
    const config = committed || local ? { ...committed, ...local } : undefined;
    if (config?.gate?.length && (await gitFolderAsync(root))) gates[root] = config.gate;
    for (const [runtime, overrides] of Object.entries(config?.extensions ?? {})) {
      const merged = extensions?.[runtime];
      extensions = {
        ...extensions,
        [runtime]: merged
          ? {
              disabled_mcp_servers: union(
                merged.disabled_mcp_servers,
                overrides.disabled_mcp_servers,
              ),
              disabled_plugins: union(merged.disabled_plugins, overrides.disabled_plugins),
              disabled_skills: union(merged.disabled_skills, overrides.disabled_skills),
              disable_apps: merged.disable_apps || overrides.disable_apps,
              disable_hooks: merged.disable_hooks || overrides.disable_hooks,
              ...Object.fromEntries(
                (
                  [
                    'enabled_user_mcp_servers',
                    'enabled_user_skills',
                    'enabled_user_connectors',
                  ] as const
                )
                  .filter((key) => merged[key] || overrides[key])
                  .map((key) => [key, union(merged[key] ?? [], overrides[key] ?? [])]),
              ),
            }
          : overrides,
      };
    }
    brief ??= config?.brief;
  }
  return { gates, extensions, brief };
}

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

/** Session defaults on available runtimes with models of their own, single_model kept only when on. */
function checkedSessionDefaults(
  ctx: ControlContext,
  input: ProjectSettingValues['session_defaults'],
): SessionDefaults {
  const { single_model, ...rest } = input,
    session_defaults = single_model ? { ...rest, single_model } : rest;
  const families = readUserConfig(ctx.userConfigDir).model_families;
  for (const choice of [
    session_defaults,
    rest.writer,
    rest.reviewer,
    ...Object.values(rest.fallbacks ?? {}),
  ]) {
    if (!choice) continue;
    requireThat(
      ctx.adapters.has(choice.runtime),
      'invalid_input',
      'Default runtime is not available',
    );
    requireThat(
      choice.model === undefined || homeRuntime(choice.model, families) === choice.runtime,
      'invalid_input',
      `Default model ${choice.model} does not belong to ${choice.runtime}`,
    );
  }
  requireThat(
    !single_model || session_defaults.model !== undefined,
    'invalid_input',
    'Choose a default model before running tasks and reviews on one model',
  );
  return session_defaults;
}

const BUILT_IN_SETTINGS: Partial<ProjectSettingValues> = {
  workflow_policy: DEFAULT_WORKFLOW_POLICY,
  usage_targets: {},
  external_events: 'off',
  auto_merge: false,
};

/** The project's own value of the setting; undefined when it follows the global one. */
function ownSetting(
  ctx: ControlContext,
  project: Project,
  key: ProjectSettingKey,
): ProjectSettingValues[ProjectSettingKey] | undefined {
  if (key !== 'workflow_policy') return project[key];
  const own = ownPolicySettings(ctx.store.get<WorkflowPolicy>('workflow_policies', project.id));
  return Object.keys(own).length ? (own as ProjectSettingValues['workflow_policy']) : undefined;
}

/** Each setting's global value and built-in default, and the projects that set their own. */
export function projectDefaultsRead(ctx: ControlContext): ProjectDefaultsRead {
  const defaults = projectDefaults(ctx.userConfigDir),
    projects = ctx.store
      .list<Project>('projects')
      .filter((project) => project.removed_at === undefined && project.kind !== 'personal');
  const settings = PROJECT_SETTING_KEYS.map((key) => ({
    key,
    ...(defaults[key] !== undefined && { global: defaults[key] }),
    ...(BUILT_IN_SETTINGS[key] !== undefined && {
      builtin: structuredClone(BUILT_IN_SETTINGS[key]),
    }),
    overrides: projects.flatMap((project) => {
      const value = ownSetting(ctx, project, key);
      return value === undefined ? [] : [{ project_id: project.id, name: project.name, value }];
    }),
  })) as ProjectSettingOverview[];
  return {
    settings,
    projects: projects.map((project) => ({
      project_id: project.id,
      name: project.name,
      overridden: PROJECT_SETTING_KEYS.filter((key) => ownSetting(ctx, project, key) !== undefined)
        .length,
    })),
    permission_rules: defaults.permission_rules ?? [],
  };
}

/** An idle conversation's process is not active work; it closes on demand. */
function liveSession(ctx: ControlContext, session: Session): boolean {
  if (ctx.idleConversations.has(session.id)) return false;
  return (
    session.stop_pending ||
    !!session.process_identity ||
    ['running', 'reconciling'].includes(session.state) ||
    [...ctx.handles.values()].some((handle) => handle.platform_session_id === session.id)
  );
}

export async function projectBranches(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  requestedRoot?: string,
): Promise<ProjectBranch[]> {
  projectAccess(ctx, p, projectId, 'project.read');
  const project = ctx.store.must<Project>('projects', projectId);
  const root = requestedRoot === undefined ? project.roots[0]! : resolvedPath(requestedRoot);
  requireThat(project.roots.includes(root), 'scope_violation', 'Branch root is not a project root');
  const result = await runGit(
    root,
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--count=200',
      '--format=%(refname:lstrip=2)%00%(objectname)%00%(committerdate:unix)%00%(HEAD)',
      'refs/heads/',
    ],
    undefined,
    true,
  );
  requireThat(result.exit_code === 0, 'invalid_project', result.error ?? result.stderr.toString());
  return result.stdout
    .toString()
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, time, head] = line.split('\0');
      return {
        name: name!,
        sha: sha!,
        commit_time: Number(time) * 1000,
        checked_out: head === '*',
      };
    });
}

type Opening = {
  input: ReturnType<(typeof inputSchemas)['project.open']['parse']>;
  roots: string[];
};

const sameRoots = (ctx: ControlContext, roots: string[]): Project | undefined =>
  ctx.store
    .list<Project>('projects')
    .find((x) => x.roots.length === roots.length && x.roots.every((r) => roots.includes(r)));

/** Restores or returns the project on these roots, or records a new one with the roots' config. */
function openProject(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  { input, roots }: Opening,
  config?: Awaited<ReturnType<typeof rootConfig>>,
): Project {
  const cause = c.command_id;
  const existing = sameRoots(ctx, roots);
  if (existing?.removed_at !== undefined) {
    const { removed_at, ...kept } = existing;
    const restored = ctx.store.update('projects', kept, existing.revision);
    ctx.store.event('project.restored', restored, restored.id, { removed_at }, cause);
    ensureAgents(ctx, restored.id);
    return restored;
  }
  if (existing) {
    ensureAgents(ctx, existing.id);
    return existing;
  }
  disjointFromOthers(ctx, roots);
  // The project seen before git ran no longer has these roots.
  requireThat(config, 'conflict', 'Projects changed while this one opened; open it again');
  const project: Project = {
    id: id(),
    revision: 1,
    name: input.name,
    roots,
    ...(Object.keys(config.gates).length ? { gates: config.gates } : {}),
    ...(config.extensions ? { extension_overrides: config.extensions } : {}),
    ...(input.env ? { env: input.env } : {}),
  };
  ctx.store.insert('projects', project);
  const { env, ...payload } = project;
  // Environment values stay out of the event log.
  ctx.store.event(
    'project.opened',
    project,
    project.id,
    env ? { ...payload, env_keys: Object.keys(env) } : payload,
    cause,
  );
  if (config.brief)
    projectFactHandlers['project.brief.set']!(ctx, p, {
      ...c,
      type: 'project.brief.set',
      input: { project_id: project.id, ...config.brief },
      expected_revision: null,
    });
  ensureAgents(ctx, project.id);
  return project;
}

function gateTarget(ctx: ControlContext, p: Principal, c: Command) {
  requireThat(p.role === 'user', 'permission_denied', 'Only user can set the project gate');
  const { project_id, commands, ...input } = inputSchemas['project.gate.set'].parse(c.input),
    project = ctx.store.must<Project>('projects', project_id),
    root = resolvedPath(input.root);
  revision(ctx, c, project);
  requireThat(project.roots.includes(root), 'scope_violation', 'Gate root is not a project root');
  return { project, root, commands };
}

/** Sets one root's gate; gitRoots holds the project roots read as git folders before the transaction. */
export function setProjectGate(
  ctx: ControlContext,
  p: Principal,
  c: Command,
  gitRoots: ReadonlySet<string>,
): Project {
  const { project, root, commands } = gateTarget(ctx, p, c);
  return writeProjectGate(ctx, project, root, commands, gitRoots, c.command_id);
}

/** Writes one root's gate; gitRoots as for setProjectGate. */
function writeProjectGate(
  ctx: ControlContext,
  project: Project,
  root: string,
  commands: NonNullable<Project['gates']>[string],
  gitRoots: ReadonlySet<string>,
  commandId: string,
): Project {
  requireThat(project.roots.includes(root), 'scope_violation', 'Gate root is not a project root');
  requireThat(gitRoots.has(root), 'invalid_input', 'Gate root is not a git folder');
  const { [root]: _previous, ...others } = project.gates ?? {};
  const gates = commands.length ? { ...others, [root]: commands } : others;
  const { gates: _gates, ...rest } = project;
  const next = ctx.store.update(
    'projects',
    Object.keys(gates).length ? { ...rest, gates } : rest,
    project.revision,
  );
  ctx.store.event('project.gate_set', next, project.id, { root, commands }, commandId);
  return next;
}

/** Sets the project's worktree preparation, refusing a copy path outside a root. */
export function setProjectWorktree(
  ctx: ControlContext,
  project: Project,
  worktree: NonNullable<Project['worktree']>,
  commandId: string,
): Project {
  for (const root of project.roots)
    for (const entry of worktree.copy_paths)
      requireThat(
        inside(root, resolvedPath(path.resolve(root, entry))),
        'scope_violation',
        'Copy path escapes the project folder',
      );
  const next = ctx.store.update<Project>('projects', { ...project, worktree }, project.revision);
  ctx.store.event('project.worktree_set', next, project.id, worktree, commandId);
  return next;
}

function environmentTarget(ctx: ControlContext, p: Principal, c: Command) {
  requireThat(p.role === 'user', 'permission_denied', 'Only user can set the project environment');
  const input = inputSchemas['project.environment.set'].parse(c.input),
    project = ctx.store.must<Project>('projects', input.project_id);
  revision(ctx, c, project);
  return { input, project };
}

/** Refuses folder changes that would strand a session's work or overlap another project. */
function checkEnvironmentRoots(ctx: ControlContext, project: Project, roots: string[]): void {
  // A session's work lands in the folder its worktree came from, with that folder's gate.
  const held = ctx.store.list<Session>('sessions').flatMap((session) => {
    if (session.project_id !== project.id || !session.workspace_id || session.outcome) return [];
    const source = ctx.store.get<Workspace>('workspaces', session.workspace_id)?.source;
    return source && project.roots.includes(source) && !roots.includes(source)
      ? [`${session.id} (${source})`]
      : [];
  });
  requireThat(
    !held.length,
    'root_in_use',
    `Merge or discard the work of these sessions before removing their folders: ${held.join(', ')}`,
  );
  const landing = ctx.store
    .list<Landing>('landings')
    .filter(
      (row) =>
        row.project_id === project.id &&
        (row.state === 'queued' || row.state === 'running') &&
        !roots.includes(row.root),
    )
    .map((row) => `${row.id} (${row.root})`);
  requireThat(
    !landing.length,
    'root_in_use',
    `Wait for these landings to end before removing their folders: ${landing.join(', ')}`,
  );
  disjointFromOthers(ctx, roots, project.id);
}

function setEnvironment(ctx: ControlContext, p: Principal, c: Command, roots: string[]): Project {
  const { input, project } = environmentTarget(ctx, p, c);
  checkEnvironmentRoots(ctx, project, roots);
  const { gates: previous, ...rest } = project;
  const gates = Object.fromEntries(
    Object.entries(previous ?? {}).filter(([root]) => roots.includes(root)),
  );
  const next = ctx.store.update(
    'projects',
    {
      ...rest,
      name: input.name,
      roots,
      env: input.env,
      ...(Object.keys(gates).length ? { gates } : {}),
    },
    project.revision,
  );
  ctx.store.event(
    'project.environment_set',
    next,
    project.id,
    { name: input.name, roots, env_keys: Object.keys(input.env) },
    c.command_id,
  );
  // An idle process keeps the environment and folders it started with.
  releaseIdleConversations(ctx, project.id);
  return next;
}

/** Their git runs before the transaction; the checks ahead of it still throw synchronously. */
export const projectPreparers: Preparers = {
  'project.open': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can authorize a project');
    revision(ctx, c);
    const input = inputSchemas['project.open'].parse(c.input),
      opening = { input, roots: projectRoots(ctx, input.roots) };
    if (sameRoots(ctx, opening.roots)) return (ctx, p, c) => openProject(ctx, p, c, opening);
    disjointFromOthers(ctx, opening.roots);
    return requireGitRoots(ctx, opening.roots)
      .then(() => rootConfig(opening.roots))
      .then(
        (config): Handler =>
          (ctx, p, c) =>
            openProject(ctx, p, c, opening, config),
      );
  },
  'project.gate.set': (ctx, p, c) => {
    const { root } = gateTarget(ctx, p, c);
    return gitFolderAsync(root).then(
      (git): Handler =>
        (ctx, p, c) =>
          setProjectGate(ctx, p, c, new Set(git ? [root] : [])),
    );
  },
  'project.environment.set': (ctx, p, c) => {
    const { input, project } = environmentTarget(ctx, p, c);
    const roots = projectRoots(ctx, input.roots);
    checkEnvironmentRoots(ctx, project, roots);
    return requireGitRoots(ctx, roots).then(
      (): Handler => (ctx, p, c) => setEnvironment(ctx, p, c, roots),
    );
  },
};

export const projectHandlers: Handlers = {
  'project.worktree.set': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can set worktree preparation');
    const { project_id, ...worktree } = c.input as ReturnType<
      (typeof inputSchemas)['project.worktree.set']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    const project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    return setProjectWorktree(ctx, project, worktree, c.command_id);
  },
  'project.sessionDefaults.set': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can set the session defaults');
    const { project_id, ...input } = c.input as ReturnType<
        (typeof inputSchemas)['project.sessionDefaults.set']['parse']
      >,
      project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    projectAccess(ctx, p, project_id, c.type);
    const session_defaults = checkedSessionDefaults(ctx, input);
    const next = ctx.store.update('projects', { ...project, session_defaults }, project.revision);
    ctx.store.event(
      'project.session_defaults_set',
      next,
      project.id,
      session_defaults,
      c.command_id,
    );
    return next;
  },
  'project.sessionDefaults.clear': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can clear the session defaults');
    const { project_id } = c.input as ReturnType<
      (typeof inputSchemas)['project.sessionDefaults.clear']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    const project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    const { session_defaults: _, ...rest } = project;
    const next = ctx.store.update('projects', rest, project.revision);
    ctx.store.event('project.session_defaults_cleared', next, project.id, {}, c.command_id);
    return next;
  },
  'project.usageTargets.set': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can set token targets');
    const { project_id, targets } = c.input as ReturnType<
      (typeof inputSchemas)['project.usageTargets.set']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    const project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    const usage_targets = { ...project.usage_targets };
    for (const [runtime, target] of Object.entries(targets)) {
      if (target === null) delete usage_targets[runtime];
      else usage_targets[runtime] = target;
    }
    const { usage_targets: _, ...rest } = project;
    const next = ctx.store.update(
      'projects',
      Object.keys(usage_targets).length ? { ...rest, usage_targets } : rest,
      project.revision,
    );
    ctx.store.event('project.usage_targets_set', next, project.id, { targets }, c.command_id);
    return next;
  },
  'project.autoMerge.set': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can set auto-merge');
    const { project_id, enabled } = inputSchemas['project.autoMerge.set'].parse(c.input),
      project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    const next = ctx.store.update(
      'projects',
      { ...project, auto_merge: enabled },
      project.revision,
    );
    ctx.store.event('project.auto_merge_set', next, project.id, { enabled }, c.command_id);
    return next;
  },
  'project.gateGpu.set': (ctx, p, c) => {
    requireThat(
      p.role === 'user',
      'permission_denied',
      'Only user can let gate commands use the GPU',
    );
    const { project_id, enabled } = inputSchemas['project.gateGpu.set'].parse(c.input),
      project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    const next = ctx.store.update('projects', { ...project, gate_gpu: enabled }, project.revision);
    ctx.store.event('project.gate_gpu_set', next, project.id, { enabled }, c.command_id);
    return next;
  },
  'project.externalEvents.set': (ctx, p, c) => {
    requireThat(
      p.role === 'user',
      'permission_denied',
      'Only user can set how a project takes external events',
    );
    const { project_id, mode } = inputSchemas['project.externalEvents.set'].parse(c.input),
      project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    const next = ctx.store.update(
      'projects',
      { ...project, external_events: mode },
      project.revision,
    );
    ctx.store.event('project.external_events_set', next, project.id, { mode }, c.command_id);
    return next;
  },
  'project.defaults.set': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['project.defaults.set'].parse(c.input),
      dir = userConfigDirectory(ctx);
    if (input.key === 'workflow_policy') checkPolicyDefaults(ctx, input.value);
    const value =
      input.key === 'session_defaults' ? checkedSessionDefaults(ctx, input.value) : input.value;
    const before = inheritedPolicy(ctx);
    writeUserConfig(dir, { project_defaults: { ...projectDefaults(dir), [input.key]: value } });
    if (input.key === 'workflow_policy') writeGlobalPolicyChanges(ctx, before, c.command_id);
    ctx.store.event(
      'project.defaults_set',
      { id: 'project.defaults', revision: 1 },
      '',
      { key: input.key, value },
      c.command_id,
    );
    return projectDefaultsRead(ctx);
  },
  'project.defaults.clear': (ctx, p, c) => {
    userOnly(p);
    const { key } = inputSchemas['project.defaults.clear'].parse(c.input),
      dir = userConfigDirectory(ctx);
    const { [key]: _previous, ...rest } = projectDefaults(dir);
    const before = inheritedPolicy(ctx);
    writeUserConfig(dir, { project_defaults: rest });
    if (key === 'workflow_policy') writeGlobalPolicyChanges(ctx, before, c.command_id);
    ctx.store.event(
      'project.defaults_cleared',
      { id: 'project.defaults', revision: 1 },
      '',
      { key },
      c.command_id,
    );
    return projectDefaultsRead(ctx);
  },
  'project.override.clear': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can clear a project setting');
    const { project_id, key, param } = inputSchemas['project.override.clear'].parse(c.input);
    requireThat(
      param === undefined || key === 'workflow_policy',
      'invalid_input',
      'Only workflow_policy names a param',
    );
    projectAccess(ctx, p, project_id, c.type);
    const project = ctx.store.must<Project>('projects', project_id);
    if (key === 'workflow_policy') {
      revision(ctx, c, ctx.store.get<WorkflowPolicy>('workflow_policies', project_id));
      return clearPolicyOverrides(ctx, project_id, c.command_id, param);
    }
    revision(ctx, c, project);
    if (project[key] === undefined) return project;
    const { [key]: _previous, ...rest } = project;
    const next = ctx.store.update('projects', rest, project.revision);
    ctx.store.event('project.override_cleared', next, project.id, { key }, c.command_id);
    return next;
  },
  'project.remove': (ctx, p, c) => {
    requireThat(p.role === 'user', 'permission_denied', 'Only user can remove a project');
    const { project_id } = inputSchemas['project.remove'].parse(c.input),
      project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    requireThat(
      !ctx.store
        .list<Session>('sessions')
        .some((session) => session.project_id === project_id && liveSession(ctx, session)) &&
        !ctx.store
          .list<ProjectBaseline>('project_baselines')
          .some((baseline) => baseline.project_id === project_id && baseline.state === 'running') &&
        !ctx.store
          .list<Landing>('landings')
          .some(
            (row) =>
              row.project_id === project_id && (row.state === 'queued' || row.state === 'running'),
          ),
      'resource_busy',
      'Project has active work',
    );
    requireThat(
      !dispatchQueue(ctx, project_id).length,
      'resource_busy',
      'Tasks of the project wait to start; have the lead stop them first',
    );
    const next = ctx.store.update(
      'projects',
      { ...project, removed_at: ctx.store.now() },
      project.revision,
    );
    ctx.store.event(
      'project.removed',
      next,
      project.id,
      { removed_at: next.removed_at },
      c.command_id,
    );
    ctx.store.db.prepare('DELETE FROM project_intros WHERE project_id=?').run(project.id);
    releaseIdleConversations(ctx, project.id);
    return next;
  },
  'project.extensions.set': (ctx, p, c) => {
    requireThat(
      p.role === 'user',
      'permission_denied',
      'Only user can override project extensions',
    );
    const { project_id, runtime, overrides } = inputSchemas['project.extensions.set'].parse(
        c.input,
      ),
      project = ctx.store.must<Project>('projects', project_id);
    revision(ctx, c, project);
    requireThat(
      ctx.adapters.get(runtime)?.inventory,
      'unsupported_capability',
      'Runtime does not support extension inventory',
    );
    const auto = project.extension_auto?.map((entry) => {
      if (entry.runtime !== runtime) return entry;
      const closed = overrides[DISABLED[entry.kind]].includes(entry.name);
      if (!closed) return { ...entry, restored: true as const };
      const { restored: _, ...kept } = entry;
      return kept;
    });
    const next = ctx.store.update(
      'projects',
      {
        ...project,
        extension_overrides: { ...project.extension_overrides, [runtime]: overrides },
        ...(auto && { extension_auto: auto }),
      },
      project.revision,
    );
    ctx.store.event(
      'project.extensions_set',
      next,
      project.id,
      { runtime, overrides },
      c.command_id,
    );
    return next;
  },
};
