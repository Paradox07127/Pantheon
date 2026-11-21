import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  collectFacts,
  localDate,
  type ChecklistItem,
  type FolderFacts,
  type ProjectFacts,
} from '../../packages/control/src/baseline-facts.js';

const now = Date.now();
const daysAgo = (days: number) => {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
};

function write(root: string, relative: string, content: string) {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
}

function git(cwd: string, args: string[], at = daysAgo(0)) {
  const date = new Date(at).toISOString();
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Baseline Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Baseline Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
    encoding: 'utf8',
  });
}

const commit = (cwd: string, message: string, at: number) => {
  git(cwd, ['add', '.'], at);
  git(cwd, ['commit', '--quiet', '-m', message], at);
};

const tasks = [
  '# Release plan',
  '',
  '## Storage',
  '- [x] Create the schema',
  '- [ ] Migrate old rows',
  '',
  '## Interface',
  '* [X] Draw the board',
  '  - [ ] Wire the filter control',
  '',
  '```',
  '- [ ] Example inside a fence',
  '```',
  '',
].join('\n');

function repositoryFixture() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'baseline-facts-'));
  const repository = path.join(base, 'repository');
  mkdirSync(repository);
  git(repository, ['init', '--quiet', '-b', 'main']);
  write(
    repository,
    'package.json',
    JSON.stringify({
      name: 'fixture',
      scripts: { build: 'tsc -b', test: 'vitest run' },
      dependencies: { lodash: '4.0.0' },
      devDependencies: { vitest: '1.0.0' },
    }),
  );
  write(repository, 'README.md', '# Fixture\n\n## Usage\n');
  write(repository, '.gitignore', 'node_modules/\n');
  commit(repository, 'Add the package manifest', daysAgo(40));
  write(repository, 'docs/a.md', '# Alpha\n\n## Beta\n\n### Gamma\n');
  write(repository, 'src/app.ts', 'export const app = 1;\n');
  commit(repository, 'Write the alpha document', daysAgo(10));
  write(repository, 'src/app.ts', 'export const app = 2;\n');
  write(repository, 'src/app.test.ts', 'test("app", () => undefined);\n');
  write(repository, 'CLAUDE.md', 'Rule one\nRule two\nRule three\n');
  write(
    repository,
    '.github/workflows/ci.yml',
    [
      'jobs:',
      '  test:',
      '    steps:',
      '      - run: pnpm install',
      '      - name: Check',
      '        run: |',
      '          pnpm build',
      '          pnpm test',
      '      - uses: actions/cache@v4',
      '',
    ].join('\n'),
  );
  write(repository, 'vitest.config.ts', 'export default {};\n');
  commit(repository, 'Add tests and CI', daysAgo(2));
  write(repository, 'src/app.ts', 'export const app = 3;\n');
  commit(repository, 'Tune the app', daysAgo(2));
  git(repository, ['branch', 'base', 'HEAD~2']);
  git(repository, ['branch', '--quiet', '--set-upstream-to=base']);

  appendFileSync(path.join(repository, '.git/info/exclude'), '.notes/\nnested/\n');
  write(repository, '.notes/tasks/x.md', tasks);
  const notesTime = daysAgo(1);
  utimesSync(path.join(repository, '.notes/tasks/x.md'), notesTime / 1000, notesTime / 1000);
  write(repository, 'nested/inner.md', '# Inner\n- [ ] Hidden nested item\n');
  git(path.join(repository, 'nested'), ['init', '--quiet']);
  write(repository, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
  write(repository, 'README.md', '# Fixture\n\n## Usage\n\nChanged.\n');

  const plain = path.join(base, 'plain');
  mkdirSync(plain);
  write(plain, 'notes.md', '# Ideas\n- [ ] Sketch the plan\n- [x] Pick a name\n');
  write(plain, 'Makefile', '.PHONY: all\nall: build\nbuild:\n\tcc main.c\n');
  write(
    plain,
    'pyproject.toml',
    [
      '[project]',
      'name = "plain"',
      'dependencies = [',
      '  "requests>=2",',
      '  "click",',
      ']',
      '[project.scripts]',
      'plain = "plain.cli:main"',
      '',
    ].join('\n'),
  );
  write(plain, 'test_plain.py', 'def test_one():\n    pass\n');
  write(plain, 'big.md', `- [ ] First item\n${'x'.repeat(300 * 1024)}\n- [ ] Beyond the limit\n`);
  return { repository, plain };
}

describe('baseline facts', () => {
  const { repository, plain } = repositoryFixture();
  let facts: ProjectFacts, repo: FolderFacts, folder: FolderFacts;
  beforeAll(async () => {
    facts = await collectFacts(
      [
        { path: repository, git: true },
        { path: plain, git: false },
      ],
      now,
    );
    [repo, folder] = facts.folders as [FolderFacts, FolderFacts];
  });

  it('reads branch, head, dirty count and upstream distance from git', () => {
    expect(facts.collected_at).toBe(now);
    expect(repo).toMatchObject({
      root: repository,
      git: true,
      branch: 'main',
      ahead: 2,
      behind: 0,
    });
    expect(repo.head).toBe(git(repository, ['rev-parse', 'HEAD']).trim());
    expect(repo.dirty_files).toBe(1);
    expect(repo.last_commit_at).toBe(daysAgo(2));
    expect(repo.recent_commits.map((entry) => entry.subject)).toEqual([
      'Tune the app',
      'Add tests and CI',
      'Write the alpha document',
      'Add the package manifest',
    ]);
  });

  it('counts commits per local day over ninety days and hotspots over thirty', () => {
    expect(repo.commits_per_day).toHaveLength(90);
    expect(repo.commits_per_day.at(-1)!.date).toBe(localDate(now));
    const count = (days: number) =>
      repo.commits_per_day.find((day) => day.date === localDate(daysAgo(days)))!.count;
    expect([count(40), count(10), count(2), count(5)]).toEqual([1, 1, 2, 0]);
    expect(repo.commits_per_day.reduce((sum, day) => sum + day.count, 0)).toBe(4);
    expect(repo.hotspots[0]).toEqual({ path: 'src/app.ts', commits: 3 });
    expect(repo.hotspots.map((spot) => spot.path)).not.toContain('package.json');
  });

  it('skips a checklist in an ignored folder and counts only tracked files', () => {
    expect(repo.checklists).toEqual([]);
    expect(repo.directories).toEqual([
      { path: '.github', files: 1 },
      { path: '.github/workflows', files: 1 },
      { path: 'docs', files: 1 },
      { path: 'src', files: 2 },
    ]);
    expect(repo.file_types).toContainEqual({ ext: '.md', count: 3 });
    expect(repo.file_types).toContainEqual({ ext: '.ts', count: 3 });
    expect(repo.file_types.find((type) => type.ext === '.js')).toBeUndefined();
  });

  it('parses checklists with sections, line numbers and stable hashes', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'baseline-facts-'));
    try {
      write(base, 'plan.md', tasks);
      utimesSync(path.join(base, 'plan.md'), daysAgo(1) / 1000, daysAgo(1) / 1000);
      const [folder] = (await collectFacts([{ path: base, git: false }], now)).folders;
      const list = folder!.checklists[0]!;
      expect(list.modified_at).toBe(daysAgo(1));
      expect(list.items.map(({ hash, ...item }) => item)).toEqual<Omit<ChecklistItem, 'hash'>[]>([
        { line: 4, done: true, text: 'Create the schema', section: 'Storage' },
        { line: 5, done: false, text: 'Migrate old rows', section: 'Storage' },
        { line: 8, done: true, text: 'Draw the board', section: 'Interface' },
        { line: 9, done: false, text: 'Wire the filter control', section: 'Interface' },
      ]);
      expect(list.items[1]!.hash).toMatch(/^[0-9a-f]{12}$/);
      expect(new Set(list.items.map((item) => item.hash)).size).toBe(4);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('collects manifests, agent instructions, docs, tests and CI', () => {
    expect(repo.manifests).toEqual([
      {
        path: 'package.json',
        scripts: { build: 'tsc -b', test: 'vitest run' },
        dependencies: ['lodash', 'vitest'],
      },
    ]);
    expect(repo.agent_instructions).toEqual([{ path: 'CLAUDE.md', lines: 3 }]);
    expect(repo.docs).toEqual([
      {
        path: 'README.md',
        headings: ['Fixture', 'Usage'],
        // The README has uncommitted changes, so its own time counts.
        modified_at: statSync(path.join(repository, 'README.md')).mtimeMs,
      },
      { path: 'docs/a.md', headings: ['Alpha', 'Beta'], modified_at: daysAgo(10) },
    ]);
    expect(repo.tests).toEqual({ files: 1, configs: ['vitest.config.ts'] });
    expect(repo.ci).toEqual([
      { path: '.github/workflows/ci.yml', commands: ['pnpm install', 'pnpm build', 'pnpm test'] },
    ]);
    expect(repo.truncated).toEqual([]);
    expect(repo.code_deps).toEqual({
      packages: [{ dir: '.', name: 'fixture', depends_on: [] }],
      modules: [],
      languages: ['TypeScript'],
      not_measured: [],
      external_imports: 0,
    });
  });

  it('collects only file facts in a folder without git and records read limits', () => {
    expect(folder).toMatchObject({
      git: false,
      commits_per_day: [],
      hotspots: [],
      recent_commits: [],
    });
    expect(folder.branch).toBeUndefined();
    expect(folder.dirty_files).toBeUndefined();
    expect(folder.manifests).toEqual([
      { path: 'Makefile', scripts: { all: '', build: 'cc main.c' }, dependencies: [] },
      {
        path: 'pyproject.toml',
        scripts: { plain: 'plain.cli:main' },
        dependencies: ['requests', 'click'],
      },
    ]);
    expect(folder.tests).toEqual({ files: 1, configs: [] });
    const notes = folder.checklists.find((list) => list.path === 'notes.md')!;
    expect(notes.items.map((item) => [item.text, item.done])).toEqual([
      ['Sketch the plan', false],
      ['Pick a name', true],
    ]);
    const big = folder.checklists.find((list) => list.path === 'big.md')!;
    expect(big.items.map((item) => item.text)).toEqual(['First item']);
    expect(folder.truncated).toEqual([`big.md: read only the first ${256 * 1024} bytes`]);
  });
});

describe('checklist identity and time', () => {
  it('dates a tracked checklist with uncommitted changes by the file, not its last commit', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'baseline-facts-'));
    try {
      git(base, ['init', '--quiet', '-b', 'main']);
      write(base, 'TODO.md', '# Plan\n- [ ] Old item\n');
      commit(base, 'Add the plan', daysAgo(30));
      appendFileSync(path.join(base, 'TODO.md'), '- [ ] New item written today\n');
      utimesSync(path.join(base, 'TODO.md'), daysAgo(1) / 1000, daysAgo(1) / 1000);
      const [repository] = (await collectFacts([{ path: base, git: true }], now)).folders;
      expect(repository!.checklists).toMatchObject([{ path: 'TODO.md', modified_at: daysAgo(1) }]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('gives checklist items with the same text their own hash', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'baseline-facts-'));
    try {
      write(base, 'TODO.md', '# Plan\n- [x] Run tests\n- [ ] Write docs\n- [ ] Run tests\n');
      const [folder] = (await collectFacts([{ path: base, git: false }], now)).folders;
      const [first, other, again] = folder!.checklists[0]!.items;
      expect(first!.text).toBe(again!.text);
      expect(new Set([first!.hash, other!.hash, again!.hash]).size).toBe(3);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
