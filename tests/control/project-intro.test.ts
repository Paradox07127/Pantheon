import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Principal, Project, ProjectBaseline, Session, SessionTurn } from '@pantheon/domain';
import {
  purposeSessionInstructions,
  purposeSessionTools,
} from '../../packages/control/dist/context.js';
import { eventually, fixture, user } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});
const DAY = 86400000;
const now = Date.parse('2026-11-13T12:00:00Z');
async function setup() {
  const f = await fixture({ now: () => now });
  cleanups.push(() => f.close());
  const write = (name: string, contents: string | Buffer) => {
    const file = path.join(f.projectRoot, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  const git = (args: string[], days = 0) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: f.projectRoot,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Intro fixture',
        GIT_AUTHOR_EMAIL: 'intro@example.invalid',
        GIT_COMMITTER_NAME: 'Intro fixture',
        GIT_COMMITTER_EMAIL: 'intro@example.invalid',
        GIT_AUTHOR_DATE: new Date(now - days * DAY).toISOString(),
        GIT_COMMITTER_DATE: new Date(now - days * DAY).toISOString(),
      },
    }).trim();
  rmSync(path.join(f.projectRoot, '.git'), { recursive: true });
  git(['init', '--quiet', '--initial-branch=main']);
  write('README.md', '# Notes\n');
  write('src/index.ts', 'export const read = () => 1;\n');
  write('src/data.bin', Buffer.from([0, 10, 0]));
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'Create notes'], 50);
  write('src/index.ts', 'export const read = () => 1;\nexport const write = () => 2;\n');
  write('src/cli.ts', 'read();\n');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'Write notes'], 20);
  write('src/cli.ts', 'read();\nwrite();');
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'Use writer'], 1);
  write('src/untracked.ts', 'not counted\n');
  const baseline = await f.call<Promise<ProjectBaseline>>('project.baseline.start', {
    project_id: f.project.id,
  });
  const principal: Principal = {
    id: `session:${baseline.session_id}`,
    role: 'planner',
    project_id: f.project.id,
    session_id: baseline.session_id,
    expires_at: now + 60000,
  };
  const input = {
    summary: 'Reads and writes notes.',
    sources: ['file:README.md'],
    features: [{ title: 'Read notes', text: 'Read a note.', sources: ['file:src/index.ts:1'] }],
    modules: [{ path: 'src', role: 'Reads and writes notes.', entry: 'src/index.ts' }],
    architecture: {
      nodes: [
        { id: 'cli', label: 'CLI' },
        { id: 'library', label: 'Library' },
      ],
      edges: [{ from: 'cli', to: 'library' }],
    },
    body: '## Usage\nRead a note.',
  };
  const submit = async (patch = {}, by = principal) =>
    f.call('project.intro.submit', { ...input, ...patch }, null, by);
  const read = () => f.control.projectIntroRead(user, f.project.id);
  const end = () => {
    for (const turn of f.store.list<SessionTurn>('session_turns'))
      f.store.update('session_turns', { ...turn, state: 'completed' }, turn.revision);
    for (const session of f.store.list<Session>('sessions'))
      f.store.update('sessions', { ...session, state: 'open' }, session.revision);
    const current = f.store.must<ProjectBaseline>('project_baselines', baseline.id);
    f.store.update('project_baselines', { ...current, state: 'failed' }, current.revision);
    for (const job of f.store.pending()) f.store.mark(job.id, 'done');
  };
  return { ...f, write, git, baseline, principal, input, submit, read, end };
}

it('stores the measured introduction, emits its event and replaces the prior submission', async () => {
  const f = await setup();
  expect(await f.read()).toEqual({
    intro: null,
    behind: 0,
    writing_session_id: f.baseline.session_id,
  });
  expect(await f.submit()).toEqual({ written: true });
  expect(await f.read()).toEqual({
    intro: {
      ...f.input,
      project_id: f.project.id,
      modules: [{ ...f.input.modules[0], lines: 4, commits_30d: 2 }],
      languages: [
        { name: 'TypeScript', lines: 4 },
        { name: 'Markdown', lines: 1 },
      ],
      weeks: [1, 0, 0, 0, 0, 1, 0, 1],
      heads: [{ root: realpathSync(f.projectRoot), sha: f.git(['rev-parse', 'HEAD']) }],
      session_id: f.baseline.session_id,
      written_at: now,
    },
    behind: 0,
    writing_session_id: f.baseline.session_id,
  });
  expect(
    f.store.events(0, f.project.id).filter((event) => event.kind === 'project.intro.written'),
  ).toMatchObject([{ payload: { project_id: f.project.id } }]);
  await f.submit({ summary: 'A revised introduction.', body: undefined });
  expect((await f.read()).intro?.summary).toBe('A revised introduction.');
  expect((await f.read()).intro).not.toHaveProperty('body');
});

it.each([
  ['modules[0].path', { modules: [{ path: '../', role: 'Outside' }] }],
  [
    'path',
    {
      modules: [
        { path: 'src', role: 'Code' },
        { path: 'src', role: 'Again' },
      ],
    },
  ],
  ['modules[0].entry', { modules: [{ path: 'src', role: 'Code', entry: 'README.md' }] }],
  [
    'architecture',
    {
      architecture: {
        nodes: [{ id: 'cli', label: 'CLI' }],
        edges: [{ from: 'cli', to: 'missing' }],
      },
    },
  ],
  ['summary', { summary: 'x'.repeat(281) }],
  ['lines', { modules: [{ path: 'src', role: 'Code', lines: 99 }] }],
  ['sources', { sources: ['file:missing.md'] }],
  [
    'features[0].sources',
    { features: [{ title: 'Unsupported', text: 'No evidence', sources: ['file:missing.md'] }] },
  ],
  [
    'sources',
    { sources: ['file:src/index.ts:9'] },
    'sources: file:src/index.ts:9 is past the end of src/index.ts (2 lines)',
  ],
  [
    'sources',
    { sources: ['file:missing.ts:3', 'file:README.md'] },
    'sources: file:missing.ts:3 does not exist',
  ],
  [
    'sources',
    { sources: ['file:src/untracked.ts'] },
    'sources: file:src/untracked.ts is not tracked by git at HEAD',
  ],
  [
    'features[0].sources',
    {
      features: [
        {
          title: 'Read notes',
          text: 'Read a note.',
          sources: ['file:src/index.ts:1', 'file:README.md:2'],
        },
      ],
    },
    'features[0].sources: file:README.md:2 is past the end of README.md (1 lines)',
  ],
  [
    'features[0].sources',
    {
      features: [
        {
          title: 'Read notes',
          text: 'Read a note.',
          sources: ['file:README.md', 'file:src/untracked.ts:1'],
        },
      ],
    },
    'features[0].sources: file:src/untracked.ts:1 is not tracked by git at HEAD',
  ],
])(
  'refuses invalid %s with a field-specific reason and keeps the stored introduction',
  async (field, patch, reason?: string) => {
    const f = await setup();
    await expect(() => f.submit(patch)).rejects.toThrow(reason ?? field);
    expect((await f.read()).intro).toBeNull();
  },
);

it('counts commits since the saved heads and reports a removed commit as unknown', async () => {
  const f = await setup();
  await f.submit();
  expect((await f.read()).behind).toBe(0);
  f.git(['commit', '--allow-empty', '--quiet', '-m', 'First later commit']);
  f.git(['commit', '--allow-empty', '--quiet', '-m', 'Second later commit']);
  expect((await f.read()).behind).toBe(2);
  f.git(['checkout', '--orphan', 'replacement']);
  f.git(['commit', '--quiet', '-m', 'Replace history']);
  f.git(['branch', '-D', 'main']);
  f.git(['reflog', 'expire', '--expire=now', '--all']);
  f.git(['gc', '--prune=now']);
  expect((await f.read()).behind).toBeNull();
});

it('starts a read-only introduction session with baseline runtime selection, facts and purpose-scoped memory tools', async () => {
  const f = await setup();
  await f.submit();
  f.end();
  const baseline = f.store.must<ProjectBaseline>('project_baselines', f.baseline.id);
  f.store.update(
    'project_baselines',
    {
      ...baseline,
      state: 'confirmed',
      result: {
        folders: [
          {
            root: realpathSync(f.projectRoot),
            stage: 'active',
            stack: ['TypeScript'],
            gate: [],
            commands: { test: { argv: ['pnpm', 'test'], sources: ['file:README.md'] } },
          },
        ],
        workstreams: [],
        contradictions: [],
        findings: [],
        questions: [],
      },
    },
    baseline.revision,
  );
  const starts = vi.spyOn(f.adapter, 'resume');
  const { session_id } = await f.call<Promise<{ session_id: string }>>('project.intro.start', {
    project_id: f.project.id,
  });
  const session = f.store.must<Session>('sessions', session_id);
  expect(session.intro).toBe(true);
  expect(session.runtime).toBe(f.store.must<Session>('sessions', f.baseline.session_id!).runtime);
  expect(session.requested_model).toBe(
    f.store.must<Session>('sessions', f.baseline.session_id!).requested_model,
  );
  expect(session.workspace_id).toBeUndefined();
  expect(purposeSessionTools(session)).toEqual([
    'memory.context',
    'memory.search',
    'memory.related',
    'memory.get',
    'memory.propose',
    'project.read',
    'project.intro.submit',
  ]);
  expect((await f.read()).writing_session_id).toBe(session_id);
  await expect(async () =>
    f.call('project.intro.start', { project_id: f.project.id }),
  ).rejects.toThrow(expect.objectContaining({ code: 'invalid_input' }));
  const brief = f.store
    .list<SessionTurn>('session_turns')
    .find((turn) => turn.session_id === session_id)!.input;
  for (const text of [
    f.projectRoot,
    'src',
    '4',
    'TypeScript',
    'pnpm',
    'Reads and writes notes.',
    'file:',
  ])
    expect(brief).toContain(text);
  await eventually(
    () => starts.mock.calls.length > 0,
    () => f.control.tick(),
  );
  expect(starts.mock.calls[0]![0]).toMatchObject({
    cwd: realpathSync(f.projectRoot),
    role: 'planner',
    extensions: { mode: 'none' },
  });
  expect(await f.submit({}, { ...f.principal, id: `session:${session_id}`, session_id })).toEqual({
    written: true,
  });
});

it('limits submission to assessment and introduction sessions and shares their authoring instructions', async () => {
  const f = await setup();
  const baseline = f.store.must<Session>('sessions', f.baseline.session_id!);
  expect(purposeSessionTools(baseline)).toContain('project.intro.submit');
  const intro: Session = { ...baseline, baseline: undefined, intro: true };
  expect(purposeSessionTools(intro)).toContain('project.intro.submit');
  for (const session of [
    { ...intro, intro: undefined },
    { ...intro, intro: undefined, review_id: 'review' },
    { ...intro, intro: undefined, change_story: { story_id: 'story' } },
  ])
    expect(purposeSessionTools(session) ?? []).not.toContain('project.intro.submit');
  for (const session of [baseline, intro]) {
    const instructions = purposeSessionInstructions(session, { rounds: 5, visuals: true })!;
    for (const text of [
      'first time',
      'summary',
      'features',
      'modules',
      'architecture',
      'mermaid',
      'vega-lite',
      'kline',
      'project_intro_submit',
    ])
      expect(instructions).toContain(text);
  }
  await expect(() => f.submit({}, user)).rejects.toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
  f.store.update('sessions', { ...baseline, baseline: undefined }, baseline.revision);
  for (const role of ['planner', 'lead', 'worker', 'reviewer'] as const)
    await expect(() => f.submit({}, { ...f.principal, role })).rejects.toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
});

it.each(['assessment', 'introduction', 'discarded assessment'])(
  'keeps the introduction when its %s session is deleted and removes it with the project',
  async (purpose) => {
    const f = await setup();
    let sessionId = f.baseline.session_id!;
    if (purpose === 'introduction') {
      f.end();
      sessionId = (
        await f.call<Promise<{ session_id: string }>>('project.intro.start', {
          project_id: f.project.id,
        })
      ).session_id;
    }
    await f.submit({}, { ...f.principal, id: `session:${sessionId}`, session_id: sessionId });
    f.end();
    const session = f.store.must<Session>('sessions', sessionId);
    f.call(
      purpose === 'discarded assessment' ? 'session.discard' : 'session.delete',
      { session_id: sessionId },
      session.revision,
    );
    expect((await f.read()).intro?.session_id).toBeNull();
    expect((await f.read()).intro?.summary).toBe(f.input.summary);
    f.call(
      'project.remove',
      { project_id: f.project.id },
      f.store.must<Project>('projects', f.project.id).revision,
    );
    expect(f.store.projectIntro(f.project.id)).toBeUndefined();
  },
);

it('sums git roots and uses baseline-scanned files for non-git roots, with at most eight language rows', async () => {
  const f = await setup();
  const extra = path.join(f.root, 'extra');
  mkdirSync(path.join(extra, 'lib'), { recursive: true });
  writeFileSync(path.join(extra, 'lib/tool.py'), 'print(1)\nprint(2)\n');
  mkdirSync(path.join(extra, 'node_modules'));
  writeFileSync(path.join(extra, 'node_modules/ignored.js'), 'ignored\n');
  const secondGit = path.join(f.root, 'second-git');
  execFileSync('git', ['clone', '--quiet', f.projectRoot, secondGit]);
  const project = f.store.must<Project>('projects', f.project.id);
  f.store.update(
    'projects',
    { ...project, roots: [...project.roots, extra, secondGit] },
    project.revision,
  );
  await f.submit({ modules: [{ path: 'lib', role: 'Python tool', entry: 'lib/tool.py' }] });
  const intro = (await f.read()).intro!;
  expect(intro.modules).toMatchObject([{ lines: 2, commits_30d: 0 }]);
  expect(intro.languages).toEqual([
    { name: 'TypeScript', lines: 8 },
    { name: 'Markdown', lines: 2 },
    { name: 'Python', lines: 2 },
  ]);
  expect(intro.weeks).toEqual([2, 0, 0, 0, 0, 2, 0, 2]);
  expect(intro.heads).toHaveLength(2);
  for (const ext of ['js', 'rs', 'go', 'swift', 'c', 'cpp', 'java', 'css', 'html'])
    writeFileSync(path.join(extra, `extra.${ext}`), 'one\n');
  await f.submit();
  expect((await f.read()).intro!.languages).toHaveLength(8);
  expect((await f.read()).intro!.languages.find((entry) => entry.name === 'other')?.lines).toBe(5);
});
