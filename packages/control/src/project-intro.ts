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
import type { inputSchemas, ProjectIntroRead } from '@pantheon/protocol';
import {
  gitFolder,
  inside,
  projectAccess,
  revision,
  sessionPrincipal,
  userOnly,
  type ControlContext,
  type Handlers,
} from './context.js';
import { baselineRuntime, sourced } from './baseline.js';
import { collectTextCounts } from './baseline-facts.js';
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

export function projectIntroRead(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): ProjectIntroRead {
  userOnly(p);
  projectAccess(ctx, p, projectId, 'project.read');
  ctx.store.must<Project>('projects', projectId);
  const intro = ctx.store.projectIntro(projectId) ?? null;
  let behind: number | null = 0;
  for (const head of intro?.heads ?? []) {
    const result = runGit(head.root, ['rev-list', '--count', `${head.sha}..HEAD`]);
    if (result.exit_code !== 0) {
      behind = null;
      break;
    }
    behind += Number(result.stdout.toString().trim());
  }
  return { intro, behind, writing_session_id: writingSession(ctx, projectId)?.id ?? null };
}

export const projectIntroHandlers: Handlers = {
  'project.intro.start': (ctx, p, c) => {
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
    const counts = collectTextCounts(
      project.roots.map((root) => ({ path: root, git: gitFolder(root) })),
    );
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
      input: renderIntroBrief(project, counts, baseline, ctx.store.projectIntro(project.id)),
      kind: 'send',
      delivery: 'pending',
      state: 'queued',
    };
    ctx.store.insert('session_turns', turn);
    ctx.store.enqueue('session.turn', { turn_id: turn.id });
    ctx.store.event('session.opened', session, project.id, { purpose: 'intro' }, c.command_id);
    ctx.store.event('turn.queued', turn, project.id, { purpose: 'intro' }, c.command_id);
    return { session_id: session.id };
  },
  'project.intro.submit': (ctx, p, c) => {
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
    const roots = project.roots.map((root) => realpathSync(root));
    for (const [field, refs] of [
      ['sources', input.sources],
      ...input.features.map(
        (feature, index) => [`features[${index}].sources`, feature.sources] as const,
      ),
    ] as const)
      requireThat(
        sourced(roots, refs),
        'invalid_input',
        `${field}: at least one source must resolve inside a project root`,
      );
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
    const gitRoots = roots.filter(gitFolder);
    const counts = collectTextCounts(
      roots.map((root) => ({ path: root, git: gitRoots.includes(root) })),
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
    const heads: ProjectIntro['heads'] = [];
    for (const root of gitRoots) {
      const head = runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      requireThat(
        head.exit_code === 0,
        'git_failed',
        `Cannot measure heads in ${root}: ${head.error ?? head.stderr.toString()}`,
      );
      const sha = head.stdout.toString().trim();
      heads.push({ root, sha });
      const log = runGit(root, [
        'log',
        sha,
        `--since=@${Math.floor((now - 56 * DAY) / 1000)}`,
        `--until=@${Math.floor(now / 1000)}`,
        '--format=%ct',
      ]);
      requireThat(
        log.exit_code === 0,
        'git_failed',
        `Cannot measure weeks in ${root}: ${log.error ?? log.stderr.toString()}`,
      );
      for (const time of log.stdout.toString().trim().split('\n').filter(Boolean)) {
        const index = Math.min(7, Math.floor((Number(time) * 1000 - (now - 56 * DAY)) / (7 * DAY)));
        weeks[index]!++;
      }
    }
    const intro: ProjectIntro = {
      ...input,
      project_id: project.id,
      modules: modules.map(({ module, root, directory }) => {
        let commits = 0;
        const head = heads.find((entry) => entry.root === root);
        if (head) {
          const result = runGit(root, [
            'rev-list',
            '--count',
            `--since=@${Math.floor((now - 30 * DAY) / 1000)}`,
            head.sha,
            '--',
            `:(literal)${path.relative(root, directory) || '.'}`,
          ]);
          requireThat(
            result.exit_code === 0,
            'git_failed',
            `Cannot measure modules.${module.path}.commits_30d: ${result.error ?? result.stderr.toString()}`,
          );
          commits = Number(result.stdout.toString().trim());
        }
        return {
          ...module,
          commits_30d: commits,
          lines: counts
            .find((folder) => folder.root === root)!
            .files.filter((file) => inside(directory, path.resolve(root, file.path)))
            .reduce((sum, file) => sum + file.lines, 0),
        };
      }),
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
  },
};
