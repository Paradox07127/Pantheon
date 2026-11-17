import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { BoardPlan, ChangeStory, Principal, Project, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, countingGit, eventually, gitRunsOf, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

// Landings here count git runs; a gate command passes without a sandbox.
vi.mock('../../packages/control/dist/validation-executor.js', async (original) => ({
  ...(await original<typeof import('../../packages/control/dist/validation-executor.js')>()),
  runValidationCommand: vi.fn(async () => ({
    exit_code: 0,
    signal: null,
    duration_ms: 1,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    log: Buffer.alloc(0),
    tail: '',
    timedOut: false,
    stdout_sha256: '',
    stderr_sha256: '',
    output_truncated: false,
    boundary: {
      kind: 'macos-seatbelt',
      network: 'loopback',
      supported: true,
      stop_scope: 'process-group',
    },
  })),
}));

let counter: ReturnType<typeof countingGit> | undefined;
afterEach(() => {
  counter?.restore();
  counter = undefined;
});
const counting = () => (counter = countingGit());

/** Writes files, removing those set to null, and commits them all. */
function writeFiles(repository: string, files: Record<string, string | null>) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(repository, name);
    if (contents === null) rmSync(file);
    else {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
  }
  git(repository, 'add', '-A');
  git(repository, 'commit', '--quiet', '-m', 'Write files');
}

/** A workbench session whose first turn has ended, with its ready worktree. */
async function idleSession(base: Record<string, string> = {}) {
  const w = workbenchFixture();
  if (Object.keys(base).length) writeFiles(w.source, base);
  const session = w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  const startStory = () =>
    w.call<ChangeStory | Promise<ChangeStory>>('change_story.start', { session_id: session.id });
  return { w, session, workspace, startStory };
}

const card = (title: string, hunks: string[], extra: Record<string, unknown> = {}) => ({
  title,
  kind: 'behavior',
  surface: 'internal',
  acceptance: [],
  before: 'Before',
  after: 'After',
  how: [],
  hunks,
  tests: [],
  ...extra,
});

function storyPrincipal(w: ReturnType<typeof workbenchFixture>, story: ChangeStory): Principal {
  return {
    id: `session:${story.session_id}`,
    role: 'planner',
    project_id: w.project.id,
    session_id: story.session_id,
    expires_at: w.store.now() + 60000,
  };
}

const six = '1\n2\n3\n4\n5\n6\n';
const rangeBase = {
  'notes with space.txt': 'one\ntwo\n',
  'café.txt': 'old\n',
  'gone.txt': 'leaving\n',
  'moved.txt': six,
  'image.bin': 'bin\0x',
  'layout.js': 'function f() {\nreturn 1;\n}\n',
};
const rangeChange = {
  'notes with space.txt': 'one\nthree\n',
  'café.txt': 'new\n',
  'gone.txt': null,
  'moved.txt': null,
  'renamed.txt': `${six}7\n`,
  'image.bin': 'bin\0y',
  'layout.js': 'function f() {\n  return 1;\n}\n',
  'added.txt': 'new file\n',
};
const rangeFiles = [
  { path: 'added.txt', status: 'added', additions: 1, deletions: 0 },
  { path: 'café.txt', status: 'modified', additions: 1, deletions: 1 },
  { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 1 },
  { path: 'image.bin', status: 'modified', additions: null, deletions: null },
  { path: 'layout.js', status: 'modified', additions: 1, deletions: 1 },
  { path: 'notes with space.txt', status: 'modified', additions: 1, deletions: 1 },
  {
    path: 'renamed.txt',
    old_path: 'moved.txt',
    status: 'renamed',
    additions: 1,
    deletions: 0,
  },
];
const rangeHunks = [
  {
    id: 'H1',
    file: 'added.txt',
    header: '@@ -0,0 +1 @@',
    old_start: 0,
    old_lines: 0,
    new_start: 1,
    new_lines: 1,
    text: '+new file',
  },
  {
    id: 'H2',
    file: 'café.txt',
    header: '@@ -1 +1 @@',
    old_start: 1,
    old_lines: 1,
    new_start: 1,
    new_lines: 1,
    text: '-old\n+new',
  },
  {
    id: 'H3',
    file: 'gone.txt',
    header: '@@ -1 +0,0 @@',
    old_start: 1,
    old_lines: 1,
    new_start: 0,
    new_lines: 0,
    text: '-leaving',
  },
  {
    id: 'H4',
    file: 'layout.js',
    header: '@@ -1,3 +1,3 @@',
    old_start: 1,
    old_lines: 3,
    new_start: 1,
    new_lines: 3,
    text: ' function f() {\n-return 1;\n+  return 1;\n }',
    noise: 'whitespace',
  },
  {
    id: 'H5',
    file: 'notes with space.txt',
    header: '@@ -1,2 +1,2 @@',
    old_start: 1,
    old_lines: 2,
    new_start: 1,
    new_lines: 2,
    text: ' one\n-two\n+three',
  },
  {
    id: 'H6',
    file: 'renamed.txt',
    header: '@@ -4,3 +4,4 @@',
    old_start: 4,
    old_lines: 3,
    new_start: 4,
    new_lines: 4,
    text: ' 4\n 5\n 6\n+7',
  },
];

it('reads a committed range with one git diff and returns the files and hunks it returned before', async () => {
  const { w, workspace, startStory } = await idleSession(rangeBase);
  writeFiles(workspace.path, rangeChange);
  const story = await startStory();
  const runs = counting();
  const diff = await w.control.changeStoryDiff(user, story.id);
  expect(gitRunsOf(runs.runs(), 'diff')).toHaveLength(1);
  expect(diff).toEqual({
    source: w.source,
    from_sha: story.from_sha,
    to_sha: story.to_sha,
    files: rangeFiles,
    hunks: rangeHunks,
    truncated: false,
  });

  writeFiles(w.source, rangeChange);
  runs.reset();
  const commit = await w.control.repoCommitDiff(user, w.project.id, 'HEAD');
  expect(gitRunsOf(runs.runs(), 'diff')).toHaveLength(1);
  expect(commit).toMatchObject({ files: rangeFiles, hunks: rangeHunks, truncated: false });
});

it('lists change stories without blocking the daemon while it reads worktree heads', async () => {
  const { w, workspace, startStory } = await idleSession();
  writeFiles(workspace.path, { 'answer.txt': 'explained\n' });
  const story = await startStory();
  const runs = counting();
  runs.slowOn('rev-parse --verify HEAD^{commit}');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 50);
  const listed = await w.control.changeStoryList(user, w.project.id);
  clearInterval(timer);
  expect(ticks).toBeGreaterThan(0);
  expect(listed.map((row) => [row.id, row.outdated])).toEqual([[story.id, false]]);
  expect(
    runs.runs().filter((run) => run.endsWith('rev-parse --verify HEAD^{commit}')),
  ).toHaveLength(1);
});

const storyBase = {
  'src/flow.js': 'start();\nold();\n',
  'src/types.ts': 'type A = { a: string };\n',
};
const storyChange = {
  'src/flow.js': 'start();\nfresh();\n',
  'src/types.ts': 'type A = { a: number };\n',
};
const flowDiagram = {
  type: 'flow',
  title: 'Calls',
  lanes: ['main'],
  nodes: [
    {
      id: 'start',
      label: 'Start',
      lane: 'main',
      side: 'both',
      anchor: { file: 'src/flow.js', quote: 'start();' },
    },
    {
      id: 'fresh',
      label: 'Fresh',
      lane: 'main',
      side: 'after',
      anchor: { file: 'src/flow.js', quote: 'fresh();' },
    },
    {
      id: 'old',
      label: 'Old',
      lane: 'main',
      side: 'before',
      anchor: { file: 'src/flow.js', quote: 'old();' },
    },
    {
      id: 'absent',
      label: 'Absent',
      lane: 'main',
      side: 'after',
      anchor: { file: 'src/absent.js', quote: 'absent();' },
    },
  ],
  edges: [{ from: 'start', to: 'fresh', side: 'after' }],
};
const typeDiagram = {
  type: 'type',
  name: 'A',
  file: 'src/types.ts',
  fields: [
    { name: 'a', type: 'string', side: 'before', quote: 'a: string' },
    { name: 'a', type: 'number', side: 'after', quote: 'a: number' },
  ],
};
const storySubmission = {
  overall: { before: ['Old calls'], after: ['New calls'] },
  cards: [
    card('Call fresh', ['H1'], {
      diagram: flowDiagram,
    }),
    card('Number the field', ['H2'], {
      diagram: typeDiagram,
    }),
  ],
  noise: [],
};
const storyCard = (title: string, hunks: string[]) => ({
  title,
  kind: 'behavior',
  surface: 'internal',
  acceptance: [],
  before: 'Before',
  after: 'After',
  how: [],
  hunks,
  tests: [],
  out_of_scope: false,
  evidence: [],
  shared_with: [],
});
const storyResult = {
  overall: { before: ['Old calls'], after: ['New calls'] },
  cards: [
    {
      ...storyCard('Call fresh', ['H1']),
      diagram: {
        spec: flowDiagram,
        inferred: ['absent'],
        hunks: { start: 'H1', fresh: 'H1', old: 'H1' },
      },
    },
    {
      ...storyCard('Number the field', ['H2']),
      diagram: {
        spec: typeDiagram,
        inferred: [],
        hunks: { 0: 'H2', 1: 'H2' },
      },
    },
  ],
  noise: [],
  uninterpreted: [],
  hunk_total: 2,
  unmatched_acceptance: [],
};
const storyPatch =
  'diff --git a/src/types.ts b/src/types.ts\n--- a/src/types.ts\n+++ b/src/types.ts\n@@ -1 +1 @@\n-type A = { a: string };\n+type A = { a: number };\n';

it('starts and checks a story with one diff each and one object read, with the result it had before', async () => {
  const { w, workspace, startStory } = await idleSession(storyBase);
  writeFiles(workspace.path, storyChange);
  const runs = counting();
  const story = await startStory();
  const started = runs.runs();
  runs.reset();
  const ready = await w.call<ChangeStory | Promise<ChangeStory>>(
    'change_story.submit',
    { story_id: story.id, ...storySubmission },
    null,
    storyPrincipal(w, story),
  );
  const submitted = runs.runs();
  const { path: patch } = await w.call<{ path: string } | Promise<{ path: string }>>(
    'change_story.revert_patch',
    { story_id: story.id, card: 1 },
  );
  expect(ready.result).toEqual(storyResult);
  expect(readFileSync(patch, 'utf8')).toBe(storyPatch);
  expect(gitRunsOf(started, 'diff')).toHaveLength(1);
  expect(gitRunsOf(submitted, 'diff')).toHaveLength(1);
  expect(gitRunsOf(submitted, 'show')).toEqual([]);
  expect(gitRunsOf(submitted, 'cat-file')).toHaveLength(1);
});

it('reads the source HEAD once before it gates a landing and once before it merges', async () => {
  const w = workbenchFixture();
  w.call(
    'project.gate.set',
    { project_id: w.project.id, root: w.source, commands: [{ name: 'Check', argv: ['true'] }] },
    w.store.must<Project>('projects', w.project.id).revision,
  );
  const session = w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () => w.turns(session.id).every((turn) => turn.state === 'completed'),
    () => w.control.tick(),
  );
  writeFiles(workspace.path, { 'answer.txt': 'landed\n' });
  const runs = counting();
  w.call(
    'session.merge',
    { session_id: session.id },
    w.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => w.store.must<Session>('sessions', session.id).outcome === 'merged',
    () => w.control.tick(),
    10000,
  );
  const sourceHeads = runs
    .runs()
    .filter(
      (run) => run.split('|')[1] === 'file' && run.endsWith('rev-parse --verify HEAD^{commit}'),
    );
  expect(sourceHeads).toHaveLength(2);
});

it('checks the verification files of a task landing with one diff and one object lookup', async () => {
  const f = workbenchFixture();
  writeFiles(f.source, {
    'tests/a.test.ts': "it('a', () => {\n  expect(a).toBe(1);\n});\n",
    'tests/b.test.ts': "it('b', () => {});\n",
    'tests/c.test.ts': "it('c', () => {});\n",
    'tests/d e.test.ts': "it('d', () => {\n  expect(d).toBe(1);\n});\n",
    'tests/ü.test.ts': "it('u', () => {});\n",
    'checks/one.mjs': 'process.exit(1);\n',
  });
  const lead = f.create('Maintain the checks');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  f.store.insert<BoardPlan>('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Maintain the checks',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'checks',
        title: 'Checks',
        goal: 'Maintain the checks',
        lane: 'core',
        depends_on: [],
        source: [],
        scope: ['tests', 'checks'],
        acceptance: ['node checks/one.mjs checks/three.mjs'],
      },
    ],
    risks: [],
    assumptions: [],
    plan_version: 0,
    pending_edits: [],
    inbox: [],
    notified: {},
    updated_at: f.store.now(),
  });
  const worker = f.create();
  const workspace = await awaitWorkspaceReady(f.control, worker.workspace_id!);
  await eventually(
    () => f.turns(worker.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  const idle = f.store.must<Session>('sessions', worker.id);
  f.store.update(
    'sessions',
    { ...idle, task: { lead_session_id: lead.id, id: 'checks' } },
    idle.revision,
  );
  writeFiles(workspace.path, {
    'tests/a.test.ts': "it('a', () => {});\n",
    'tests/b.test.ts': "it('b', () => {});\nit('b2', () => {});\n",
    'tests/c.test.ts': null,
    'tests/d e.test.ts': "it('d', () => {});\n",
    'tests/ü.test.ts': "it('u', () => {});\nit('u2', () => {});\n",
    'checks/one.mjs': 'process.exit(0);\n',
    'checks/three.mjs': 'process.exit(0);\n',
  });
  const runs = counting();
  f.call(
    'session.merge',
    { session_id: worker.id, allow_out_of_scope: true },
    f.store.must<Session>('sessions', worker.id).revision,
  );
  await eventually(
    () =>
      f.store.must<Session>('sessions', worker.id).merge?.state === 'blocked' ||
      f.store.must<Session>('sessions', worker.id).outcome === 'merged',
    () => f.control.tick(),
    10000,
  );
  expect(f.store.must<Session>('sessions', worker.id).merge).toMatchObject({
    state: 'blocked',
    reason: 'verification_changed',
    // A patch's `--- a/tests/….test.ts` line reads as a removed test, so every changed test file counts.
    conflicts: [
      'checks/one.mjs',
      'tests/a.test.ts',
      'tests/b.test.ts',
      'tests/c.test.ts',
      'tests/d e.test.ts',
      'tests/ü.test.ts',
    ],
  });
  const landed = runs.runs();
  expect(gitRunsOf(landed, 'diff').filter((args) => args.includes('--unified=0'))).toHaveLength(1);
  expect(gitRunsOf(landed, 'cat-file')).toHaveLength(1);
});

it('reads the changed paths once for all before-merge steps a story context filters', async () => {
  const { w, session, workspace, startStory } = await idleSession();
  writeFiles(workspace.path, { 'answer.txt': 'explained\n' });
  const step = (id: string, changed: string) => ({
    id,
    title: `Check ${id}`,
    kind: { type: 'command', command: 'true', timeout_seconds: 30 },
    when: { changed_paths: [changed] },
  });
  w.call('workflow.definition.set', {
    project_id: w.project.id,
    definition: {
      slots: {
        before_dispatch: [],
        before_merge: [step('one', '*.txt'), step('two', 'answer.*'), step('three', 'docs/**')],
        after_merge: [],
      },
      plan_review: { tiers: ['t3'] },
      review: { max_rounds: 3 },
    },
    base_version: 0,
  });
  const plan: BoardPlan = {
    id: 'story-lead',
    revision: 1,
    project_id: w.project.id,
    headline: 'Explain work',
    lanes: [{ id: 'work', title: 'Work' }],
    tasks: [
      {
        id: 'answer',
        title: 'Answer',
        goal: 'Explain the committed answer',
        lane: 'work',
        source: [],
        scope: ['answer.txt'],
        acceptance: [],
        depends_on: [],
      },
    ],
    plan_version: 0,
    pending_edits: [],
    inbox: [],
    notified: {},
    risks: [],
    assumptions: [],
    updated_at: w.store.now(),
  };
  w.store.insert('board_plans', plan);
  w.store.event('board.plan_updated', plan, w.project.id, plan);
  const bound = w.store.must<Session>('sessions', session.id);
  w.store.update(
    'sessions',
    {
      ...bound,
      task: { lead_session_id: plan.id, id: 'answer', generation: 1, definition_version: 1 },
    },
    bound.revision,
  );
  const runs = counting();
  const story = await startStory();
  expect(story.context?.checks.commands.map((command) => command.name)).toEqual([
    'one: Check one',
    'two: Check two',
  ]);
  expect(gitRunsOf(runs.runs(), 'merge-base')).toHaveLength(1);
});
