import path from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
import {
  id,
  requireThat,
  type Principal,
  type Project,
  type ProjectBaseline,
  type ProjectIntro,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import type { Command, inputSchemas, ProjectIntroRead } from '@pantheon/protocol';
import {
  gitFolderAsync,
  inside,
  projectAccess,
  revision,
  sessionPrincipal,
  userOnly,
  type ControlContext,
  type Preparers,
} from './context.js';
import { baselineRuntime, sourceReasons } from './baseline.js';
import { collectTextCounts, READ_LIMIT } from './baseline-facts.js';
import { measureCodeDeps } from './code-deps.js';
import { runtime } from './admission.js';
import { runGit } from './git.js';
import { renderIntroBrief } from './project-intro-brief.js';

const DAY = 86400000;
type Input<K extends keyof typeof inputSchemas> = ReturnType<(typeof inputSchemas)[K]['parse']>;

function writingSession(
  ctx: ControlContext,
  projectId: string,
  introOnly = false,
): Session | undefined {
  const active = new Set(
    ctx.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.state === 'queued' || turn.state === 'running')
      .map((turn) => turn.session_id),
  );
  return ctx.store
    .list<Session>('sessions')
    .find(
      (session) =>
        session.project_id === projectId &&
        (session.intro || (!introOnly && session.baseline)) &&
        active.has(session.id),
    );
}

export async function projectIntroRead(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): Promise<ProjectIntroRead> {
  userOnly(p);
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  const intro = ctx.store.projectIntro(projectId) ?? null;
  const counts = await Promise.all(
    (intro?.heads ?? []).map((head) =>
      runGit(head.root, ['rev-list', '--count', `${head.sha}..HEAD`], undefined, true),
    ),
  );
  const behind = counts.every((result) => result.exit_code === 0)
    ? counts.reduce((sum, result) => sum + Number(result.stdout.toString().trim()), 0)
    : null;
  return { intro, behind, writing_session_id: writingSession(ctx, projectId)?.id ?? null };
}

function startTarget(ctx: ControlContext, p: Principal, c: Command) {
  userOnly(p);
  const input = c.input as Input<'project.intro.start'>;
  revision(ctx, c);
  projectAccess(ctx, p, input.project_id, c.type);
  const project = ctx.store.must<Project>('projects', input.project_id);
  requireThat(
    !writingSession(ctx, project.id, true),
    'invalid_input',
    'An introduction session turn is already running for this project',
  );
  const runtimeName = baselineRuntime(ctx, project);
  runtime(ctx, runtimeName, 'reviewer');
  return { project, runtimeName };
}

function submitTarget(ctx: ControlContext, p: Principal, c: Command) {
  const input = c.input as Input<'project.intro.submit'>;
  revision(ctx, c);
  const session = sessionPrincipal(ctx, p);
  requireThat(
    session.baseline || session.intro,
    'permission_denied',
    'Assessment or introduction session required',
  );
  projectAccess(ctx, p, session.project_id, c.type);
  const project = ctx.store.must<Project>('projects', session.project_id);
  return { input, session, project, roots: project.roots.map((root) => realpathSync(root)) };
}

/** A commit with the files it changed against each parent, or against nothing for a root commit. */
interface WalkedCommit {
  parents: string[];
  at: number;
  changes: string[][];
}

/**
 * The commits since `since` that `git rev-list --count --since` counts for the directory's
 * pathspec. History simplification walks only the first parent a commit leaves the directory
 * unchanged against, and counts the commit only when there is no such parent.
 */
function directoryCommits(
  commits: Map<string, WalkedCommit>,
  head: string,
  since: number,
  directory: string,
): number {
  const touches = (files: string[]) =>
    files.some(
      (file) => directory === '.' || file === directory || file.startsWith(`${directory}/`),
    );
  const seen = new Set([head]),
    pending = [head];
  let count = 0;
  for (let sha = pending.pop(); sha !== undefined; sha = pending.pop()) {
    const commit = commits.get(sha);
    // As with --since, an older commit ends the walk along its line.
    if (!commit || commit.at < since) continue;
    const same = commit.changes.findIndex((files) => !touches(files));
    if (same < 0) count++;
    for (const parent of same < 0 ? commit.parents : commit.parents.slice(same, same + 1))
      if (!seen.has(parent)) {
        seen.add(parent);
        pending.push(parent);
      }
  }
  return count;
}

/** HEAD of a git root, the times of its commits of the last 8 weeks and the 30-day count of a directory. */
async function measureRoot(root: string, now: number, modules: boolean) {
  const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, true);
  requireThat(
    head.exit_code === 0,
    'git_failed',
    `Cannot measure heads in ${root}: ${head.error ?? head.stderr.toString()}`,
  );
  const sha = head.stdout.toString().trim();
  const log = await runGit(
    root,
    [
      'log',
      sha,
      `--since=@${Math.floor((now - 56 * DAY) / 1000)}`,
      '-z',
      '--format=%x1e%H%x1f%P%x1f%ct',
      '--name-only',
      '--no-renames',
      '--diff-merges=first-parent',
    ],
    undefined,
    true,
  );
  requireThat(
    log.exit_code === 0,
    'git_failed',
    `Cannot measure weeks in ${root}: ${log.error ?? log.stderr.toString()}`,
  );
  // Each entry is its header, then the changed files, the first after a newline.
  const files = (fields: string[]) => fields.map((file, index) => (index ? file : file.slice(1)));
  const commits = new Map<string, WalkedCommit>();
  for (const entry of log.stdout.toString().split('\x1e').slice(1)) {
    const [header, ...changed] = entry.split('\0');
    const [commit, parents, at] = header!.split('\x1f');
    commits.set(commit!, {
      parents: parents ? parents.split(' ') : [],
      at: Number(at),
      changes: [files(changed).filter(Boolean)],
    });
  }
  const since = Math.floor((now - 30 * DAY) / 1000);
  // A merge also needs the files it changed against each later parent.
  const sides = [...commits].flatMap(([commit, entry]) =>
    entry.at < since ? [] : entry.parents.slice(1).map((parent) => ({ commit, parent })),
  );
  if (modules && sides.length) {
    const diff = await runGit(
      root,
      [
        'diff-tree',
        '--stdin',
        '--always',
        '-r',
        '-z',
        '--name-only',
        '--no-renames',
        '--format=%x1e',
      ],
      Buffer.from(sides.map((side) => `${side.commit} ${side.parent}\n`).join('')),
      true,
    );
    requireThat(
      diff.exit_code === 0,
      'git_failed',
      `Cannot measure modules in ${root}: ${diff.error ?? diff.stderr.toString()}`,
    );
    diff.stdout
      .toString()
      .split('\x1e')
      .slice(1)
      .forEach((entry, index) =>
        commits
          .get(sides[index]!.commit)!
          .changes.push(files(entry.split('\0').slice(1)).filter(Boolean)),
      );
  }
  const until = Math.floor(now / 1000);
  return {
    sha,
    times: [...commits.values()].flatMap((entry) => (entry.at <= until ? [entry.at] : [])),
    commitsIn: (directory: string) => directoryCommits(commits, sha, since, directory),
  };
}

export const projectIntroPreparers: Preparers = {
  'project.intro.start': async (ctx, p, c) => {
    const { project: target } = startTarget(ctx, p, c);
    const git = await Promise.all(target.roots.map(gitFolderAsync));
    const counts = await collectTextCounts(
      target.roots.map((root, index) => ({ path: root, git: git[index]! })),
    );
    const deps = counts.map(
      (folder) =>
        measureCodeDeps(
          folder.root,
          folder.files.map((file) => file.path),
          READ_LIMIT,
        ).deps,
    );
    return (ctx, p, c) => {
      const { project, runtimeName } = startTarget(ctx, p, c);
      const baseline = ctx.store
        .list<ProjectBaseline>('project_baselines')
        .filter((entry) => entry.project_id === project.id && entry.state === 'confirmed')
        .at(-1);
      const session: Session = {
        id: id(),
        revision: 1,
        project_id: project.id,
        runtime: runtimeName,
        device_id: 'local',
        state: 'running',
        turn_count: 1,
        intro: true,
      };
      ctx.store.insert('sessions', session);
      const turn: SessionTurn = {
        id: id(),
        revision: 1,
        project_id: project.id,
        session_id: session.id,
        model: session.reported_model ?? session.requested_model ?? null,
        input: renderIntroBrief(
          project,
          counts,
          baseline,
          ctx.store.projectIntro(project.id),
          deps,
        ),
        kind: 'send',
        delivery: 'pending',
        state: 'queued',
      };
      ctx.store.insert('session_turns', turn);
      ctx.store.enqueue('session.turn', { turn_id: turn.id });
      ctx.store.event('session.opened', session, project.id, { purpose: 'intro' }, c.command_id);
      ctx.store.event('turn.queued', turn, project.id, { purpose: 'intro' }, c.command_id);
      return { session_id: session.id };
    };
  },
  'project.intro.submit': async (ctx, p, c) => {
    const { input, roots } = submitTarget(ctx, p, c);
    const fields = [
      ['sources', input.sources],
      ...input.features.map(
        (feature, index) => [`features[${index}].sources`, feature.sources] as const,
      ),
    ] as const;
    const reason = await sourceReasons(
      roots,
      fields.flatMap(([, refs]) => refs),
    );
    for (const [field, refs] of fields) {
      requireThat(refs.length > 0, 'invalid_input', `${field}: at least one source is required`);
      for (const ref of refs) {
        const refused = reason(ref);
        requireThat(refused === undefined, 'invalid_input', `${field}: ${refused}`);
      }
    }
    const modules = input.modules.map((module, index) => {
      const root =
        !path.isAbsolute(module.path) &&
        roots.find((root) => {
          const target = path.resolve(root, module.path);
          return (
            existsSync(target) &&
            inside(root, realpathSync(target)) &&
            statSync(target).isDirectory()
          );
        });
      requireThat(
        root,
        'invalid_input',
        `modules[${index}].path: ${module.path} must be a directory inside a project root`,
      );
      const directory = realpathSync(path.resolve(root, module.path));
      if (module.entry !== undefined) {
        const entry = path.resolve(root, module.entry);
        requireThat(
          !path.isAbsolute(module.entry) &&
            existsSync(entry) &&
            inside(directory, realpathSync(entry)) &&
            statSync(entry).isFile(),
          'invalid_input',
          `modules[${index}].entry: ${module.entry} must be a file inside ${module.path}, relative to ${root}`,
        );
      }
      return { module, root, directory };
    });
    const now = ctx.store.now();
    const git = await Promise.all(roots.map(gitFolderAsync));
    const gitRoots = roots.filter((_, index) => git[index]);
    const counts = await collectTextCounts(
      roots.map((root) => ({ path: root, git: gitRoots.includes(root) })),
    );
    const measured = await Promise.all(
      gitRoots.map((root) =>
        measureRoot(
          root,
          now,
          modules.some((entry) => entry.root === root),
        ),
      ),
    );
    const byLanguage = new Map<string, number>();
    for (const folder of counts)
      for (const file of folder.files)
        byLanguage.set(file.language, (byLanguage.get(file.language) ?? 0) + file.lines);
    const descending = (a: { name: string; lines: number }, b: { name: string; lines: number }) =>
      b.lines - a.lines || a.name.localeCompare(b.name);
    let languages = [...byLanguage].map(([name, lines]) => ({ name, lines })).sort(descending);
    if (languages.length > 8) {
      const named = languages.filter((entry) => entry.name !== 'other');
      languages = [
        ...named.slice(0, 7),
        {
          name: 'other',
          lines:
            (byLanguage.get('other') ?? 0) +
            named.slice(7).reduce((sum, entry) => sum + entry.lines, 0),
        },
      ].sort(descending);
    }
    const weeks = Array<number>(8).fill(0);
    const heads: ProjectIntro['heads'] = gitRoots.map((root, index) => ({
      root,
      sha: measured[index]!.sha,
    }));
    for (const time of measured.flatMap((entry) => entry.times)) {
      const index = Math.min(7, Math.floor((time * 1000 - (now - 56 * DAY)) / (7 * DAY)));
      weeks[index]!++;
    }
    return (ctx, p, c) => {
      const { input, session, project } = submitTarget(ctx, p, c);
      const intro: ProjectIntro = {
        ...input,
        project_id: project.id,
        modules: modules.map(({ module, root, directory }) => ({
          ...module,
          commits_30d:
            measured[gitRoots.indexOf(root)]?.commitsIn(path.relative(root, directory) || '.') ?? 0,
          lines: counts
            .find((folder) => folder.root === root)!
            .files.filter((file) => inside(directory, path.resolve(root, file.path)))
            .reduce((sum, file) => sum + file.lines, 0),
        })),
        languages,
        weeks,
        heads,
        session_id: session.id,
        written_at: now,
      };
      ctx.store.saveProjectIntro(intro);
      ctx.store.event(
        'project.intro.written',
        project,
        project.id,
        { project_id: project.id },
        c.command_id,
      );
      return { written: true };
    };
  },
};
