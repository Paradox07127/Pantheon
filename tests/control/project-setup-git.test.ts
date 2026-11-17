import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Principal, ProjectBaseline, ProjectIntro, RangeStory } from '@pantheon/domain';
import { countingGit, fixture, gitRunsOf, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const DAY = 86400000;
const now = Date.parse('2026-11-13T12:00:00Z');

async function setup() {
  const f = await fixture({ now: () => now });
  cleanups.push(() => f.close());
  const runs = countingGit();
  cleanups.push(() => runs.restore());
  const write = (name: string, contents: string) => {
    const file = path.join(f.projectRoot, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  const git = (args: string[], days = 0) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: f.projectRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Setup fixture',
        GIT_AUTHOR_EMAIL: 'setup@example.invalid',
        GIT_COMMITTER_NAME: 'Setup fixture',
        GIT_COMMITTER_EMAIL: 'setup@example.invalid',
        GIT_AUTHOR_DATE: new Date(now - days * DAY).toISOString(),
        GIT_COMMITTER_DATE: new Date(now - days * DAY).toISOString(),
      },
    }).trim();
  const commit = (message: string, days: number, files: Record<string, string>) => {
    for (const [name, contents] of Object.entries(files)) write(name, contents);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', message], days);
  };
  /** A project with three files in one commit, so a baseline opens a session. */
  const populate = () => {
    rmSync(path.join(f.projectRoot, '.git'), { recursive: true });
    git(['init', '--quiet', '--initial-branch=main']);
    commit('Create notes', 50, {
      'README.md': '# Notes\n',
      'src/a/index.ts': 'export const a = 1;\n',
      'src/b/index.ts': 'export const b = 1;\n',
      'docs/guide.md': '# Guide\n',
    });
    return git(['rev-parse', 'HEAD']);
  };
  const as = (sessionId: string): Principal => ({
    id: `session:${sessionId}`,
    role: 'planner',
    project_id: f.project.id,
    session_id: sessionId,
    expires_at: now + 60000,
  });
  const startBaseline = () =>
    f.call<ProjectBaseline | Promise<ProjectBaseline>>('project.baseline.start', {
      project_id: f.project.id,
    });
  /** Counts the 50 ms ticks the event loop runs until the run settles. */
  const ticksDuring = async (run: () => unknown) => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    try {
      await run();
    } finally {
      clearInterval(timer);
    }
    return ticks;
  };
  return { ...f, runs, write, git, commit, populate, as, startBaseline, ticksDuring };
}

it('collects the baseline facts without blocking and reads HEAD only with them', async () => {
  const f = await setup();
  f.runs.slowOn('ls-files -z -t');
  let baseline: ProjectBaseline | undefined;
  expect(await f.ticksDuring(async () => (baseline = await f.startBaseline()))).toBeGreaterThan(0);
  expect(baseline).toMatchObject({ state: 'empty' });
  expect(
    gitRunsOf(f.runs.runs(), 'rev-parse').filter((args) => args.includes('--verify --quiet HEAD')),
  ).toEqual([]);
});

it('refreshes the facts and tells an empty project without blocking', async () => {
  const f = await setup();
  f.runs.slowOn('ls-files -z -t');
  expect(
    await f.ticksDuring(() => f.call('project.facts.refresh', { project_id: f.project.id })),
  ).toBeGreaterThan(0);
  f.runs.slowOn('rev-parse --verify --quiet HEAD');
  let empty: boolean | undefined;
  expect(
    await f.ticksDuring(
      async () => (empty = (await f.control.projectFactsRead(user, f.project.id)).empty),
    ),
  ).toBeGreaterThan(0);
  expect(empty).toBe(true);
});

it('checks every commit a submitted folder cites with one git run', async () => {
  const f = await setup();
  const head = f.populate();
  const baseline = await f.startBaseline();
  f.runs.reset();
  const submitted = await f.call<ProjectBaseline | Promise<ProjectBaseline>>(
    'project.baseline.submit_folder',
    {
      baseline_id: baseline.id,
      root: f.project.roots[0]!,
      stage: 'active',
      stack: ['TypeScript'],
      gate: [
        { name: 'build', argv: ['pnpm', 'build'], sources: [`commit:${head}`] },
        { name: 'lint', argv: ['pnpm', 'lint'], sources: ['commit:deadbee'] },
      ],
      commands: {
        build: { argv: ['pnpm', 'build'], sources: [`commit:${head.slice(0, 7)}`] },
        test: { argv: ['pnpm', 'test'], sources: ['commit:abcdef1'] },
      },
    },
    null,
    f.as(baseline.session_id!),
  );
  expect(submitted.dropped).toBe(2);
  expect(gitRunsOf(f.runs.runs(), 'cat-file')).toEqual(['cat-file --batch-check']);
});

it('measures the introduction with one history read per folder, counting modules as rev-list does', async () => {
  const f = await setup();
  f.populate();
  f.commit('Old module change', 40, { 'src/a/index.ts': 'export const a = 2;\n' });
  f.commit('Main module change', 20, { 'src/a/index.ts': 'export const a = 3;\n' });
  f.git(['checkout', '--quiet', '-b', 'side']);
  f.commit('Side change in b', 15, { 'src/b/index.ts': 'export const b = 2;\n' });
  f.commit('Side change in a', 12, { 'src/a/extra.ts': 'export const extra = 1;\n' });
  f.git(['checkout', '--quiet', 'main']);
  f.commit('Main change in a and docs', 10, {
    'src/a/index.ts': 'export const a = 4;\n',
    'docs/guide.md': '# Guide\n\nMore.\n',
  });
  f.git(['merge', '--quiet', '--no-ff', '-m', 'Merge side', 'side'], 5);
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Empty'], 2);
  const baseline = await f.startBaseline();
  const modules = ['src/a', 'src/b', 'docs', '.'];
  f.runs.reset();
  await f.call(
    'project.intro.submit',
    {
      summary: 'Notes.',
      sources: ['file:README.md'],
      features: [],
      modules: modules.map((module) => ({ path: module, role: 'Code' })),
    },
    null,
    f.as(baseline.session_id!),
  );
  const runs = f.runs.runs();
  expect(gitRunsOf(runs, 'rev-list')).toEqual([]);
  expect(gitRunsOf(runs, 'log')).toHaveLength(1);
  expect(gitRunsOf(runs, 'diff-tree')).toHaveLength(1);
  const intro = (await f.control.projectIntroRead(user, f.project.id)).intro as ProjectIntro;
  const head = f.git(['rev-parse', 'HEAD']);
  const since = Math.floor((now - 30 * DAY) / 1000);
  expect(intro.modules.map((module) => module.commits_30d)).toEqual(
    modules.map((module) =>
      Number(
        f.git(['rev-list', '--count', `--since=@${since}`, head, '--', `:(literal)${module}`]),
      ),
    ),
  );
  // The merge counts for src/a, changed on both sides, and is left out where one side kept the module.
  expect(intro.modules.map((module) => module.commits_30d)).toEqual([4, 1, 1, 5]);
  const weeks = Array<number>(8).fill(0);
  for (const time of f
    .git([
      'log',
      head,
      `--since=@${Math.floor((now - 56 * DAY) / 1000)}`,
      `--until=@${Math.floor(now / 1000)}`,
      '--format=%ct',
    ])
    .split('\n'))
    weeks[Math.min(7, Math.floor((Number(time) * 1000 - (now - 56 * DAY)) / (7 * DAY)))]!++;
  expect(intro.weeks).toEqual(weeks);
  expect(intro.heads).toEqual([{ root: realpathSync(f.projectRoot), sha: head }]);
});

it('reads how far the introduction is behind without blocking', async () => {
  const f = await setup();
  f.populate();
  const baseline = await f.startBaseline();
  await f.call(
    'project.intro.submit',
    { summary: 'Notes.', sources: ['file:README.md'], features: [], modules: [] },
    null,
    f.as(baseline.session_id!),
  );
  f.commit('Later change', 0, { 'README.md': '# Notes\n\nLater.\n' });
  f.runs.slowOn('rev-list --count');
  let behind: number | null | undefined;
  expect(
    await f.ticksDuring(
      async () => (behind = (await f.control.projectIntroRead(user, f.project.id)).behind),
    ),
  ).toBeGreaterThan(0);
  expect(behind).toBe(1);
});

it('reads the main-line commits of a range story with one git run per folder without blocking', async () => {
  const f = await setup();
  f.populate();
  f.commit('Recent change', 0, { 'README.md': '# Notes\n\nRecent.\n' });
  f.runs.reset();
  f.runs.slowOn('--first-parent');
  let story: RangeStory | undefined;
  expect(
    await f.ticksDuring(
      async () =>
        (story = await f.call<RangeStory | Promise<RangeStory>>('range_story.start', {
          project_id: f.project.id,
          from: now - DAY,
          to: now + DAY,
        })),
    ),
  ).toBeGreaterThan(0);
  expect(story).toMatchObject({ state: 'running', source: 'commits' });
  expect(gitRunsOf(f.runs.runs(), 'rev-parse').filter((args) => args.includes('--verify'))).toEqual(
    [],
  );
  expect(gitRunsOf(f.runs.runs(), 'log')).toHaveLength(1);
});
