import { readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import type { ChangeStory, Principal, Project, Session } from '@pantheon/domain';
import { awaitWorkspaceReady, countingGit, eventually, gitRunsOf, user } from '../helpers.js';
import { forgetWorktreeReads } from '../../packages/control/dist/workbench-session.js';
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
  const w = await workbenchFixture();
  if (Object.keys(base).length) writeFiles(w.source, base);
  const session = await w.create();
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

function storyPrincipal(
  w: Awaited<ReturnType<typeof workbenchFixture>>,
  story: ChangeStory,
): Principal {
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

it('reads the diff of a card it reverts while other work goes on', async () => {
  const { w, workspace, startStory } = await idleSession(storyBase);
  writeFiles(workspace.path, storyChange);
  const story = await startStory();
  await w.call(
    'change_story.submit',
    { story_id: story.id, ...storySubmission },
    null,
    storyPrincipal(w, story),
  );
  const runs = counting();
  runs.slowOn('diff');
  let fired = false;
  const timer = setTimeout(() => (fired = true), 50);
  onTestFinished(() => clearTimeout(timer));
  const { path: patch } = await w.call<{ path: string } | Promise<{ path: string }>>(
    'change_story.revert_patch',
    { story_id: story.id, card: 1 },
  );
  expect(fired).toBe(true);
  expect(readFileSync(patch, 'utf8')).toBe(storyPatch);
  expect(gitRunsOf(runs.runs(), 'diff')).toHaveLength(1);
});

it('reads the source HEAD once before it gates a landing and once before it merges', async () => {
  const w = await workbenchFixture();
  await w.call(
    'project.gate.set',
    { project_id: w.project.id, root: w.source, commands: [{ name: 'Check', argv: ['true'] }] },
    w.store.must<Project>('projects', w.project.id).revision,
  );
  const session = await w.create();
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

/** The directory and arguments of each `git status --porcelain=v2` run. */
const statusReads = (runs: string[]) =>
  runs
    .map((run) => run.split('|'))
    .filter((fields) => fields.slice(2).join('|').includes('status --porcelain=v2'))
    .map((fields) => `${realpathSync(fields[0]!)} ${fields.slice(2).join('|')}`);

/** An idle session whose merge is blocked, so the needs-you prefetch reads its repositories too. */
async function blockedSession() {
  const { w, session: started, workspace } = await idleSession();
  writeFiles(workspace.path, { 'change.txt': 'change\n' });
  const session = w.store.must<Session>('sessions', started.id);
  const blocked = w.store.update<Session>(
    'sessions',
    { ...session, merge: { state: 'blocked', reason: 'rebase_conflict' } },
    session.revision,
  );
  w.store.event('session.merge_blocked', blocked, blocked.project_id, blocked.merge);
  forgetWorktreeReads(workspace.id);
  return { w, session: blocked, workspace };
}

it('shares one status run per repository between the list, needs-you, preflight and project HEAD reads', async () => {
  const { w, session } = await blockedSession();
  const runs = counting();
  const [, preflight, head] = await Promise.all([
    w.control.prefetchWorktreeReads(user, w.project.id),
    w.control.sessionPreflight(user, session.id),
    w.control.projectHead(user, w.project.id),
  ]);
  expect(preflight).toMatchObject({ commit_count: 1, worktree_clean: true, source_clean: true });
  expect(head).toMatchObject({ branch: 'main', sha: git(w.source, 'rev-parse', 'HEAD') });
  const reads = statusReads(runs.runs());
  expect(reads.length).toBe(new Set(reads).size);
  expect(reads).toHaveLength(3);
});

it('reads both repository states afresh to admit a merge after a prefetch read them', async () => {
  const { w, session, workspace } = await idleSession();
  writeFiles(workspace.path, { 'change.txt': 'change\n' });
  forgetWorktreeReads(workspace.id);
  await Promise.all([
    w.control.prefetchWorktreeReads(user, w.project.id),
    w.control.sessionPreflight(user, session.id),
  ]);
  const runs = counting();
  const queued = await w.call<Session | Promise<Session>>(
    'session.merge',
    { session_id: session.id },
    w.store.must<Session>('sessions', session.id).revision,
  );
  expect(queued.merge?.state).toBe('running');
  const reads = statusReads(runs.runs());
  expect(reads.filter((read) => read.startsWith(`${realpathSync(workspace.path)} `))).toHaveLength(
    1,
  );
  expect(reads.filter((read) => read.startsWith(`${realpathSync(w.source)} `))).toHaveLength(1);
});
