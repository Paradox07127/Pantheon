import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  hash,
  type ChangeStory,
  type Principal,
  type Project,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const card = (title: string, hunks: string[], extra: Record<string, unknown> = {}) => ({
  title,
  kind: 'behavior',
  surface: 'internal',
  acceptance: [0],
  before: 'Line two reads the old text',
  after: 'Line two reads the new text',
  how: [],
  hunks,
  tests: [],
  ...extra,
});

/** A workbench session whose first turn has ended, with its ready worktree and the source HEAD it started from. */
async function idleWorkbenchSession(base: (source: string) => void = () => {}) {
  const w = await workbenchFixture();
  git(w.source, 'config', 'user.name', 'Source User');
  git(w.source, 'config', 'user.email', 'source@example.invalid');
  base(w.source);
  const sourceHead = git(w.source, 'rev-parse', 'HEAD');
  const session = await w.create();
  const workspace = await awaitWorkspaceReady(w.control, session.workspace_id!);
  await eventually(
    () =>
      w.turns(session.id)[0]!.state === 'completed' &&
      w.store.must<Session>('sessions', session.id).state === 'open',
    () => w.control.tick(),
  );
  const startStory = () =>
    w.call<Promise<ChangeStory>>('change_story.start', { session_id: session.id });
  return { w, session, workspace, sourceHead, startStory };
}

function commitAnswer(repository: string, contents: string) {
  writeFileSync(path.join(repository, 'answer.txt'), contents);
  git(repository, 'commit', '--quiet', '-am', 'Update the answer');
  return git(repository, 'rev-parse', 'HEAD');
}

it('explains an unmerged workbench session from its base commit to its worktree HEAD', async () => {
  const { w, session, workspace, startStory } = await idleWorkbenchSession();
  const head = commitAnswer(workspace.path, 'explained\n');
  const story = await startStory();
  expect(story).toMatchObject({
    project_id: w.project.id,
    workbench_session_id: session.id,
    source: w.source,
    from_sha: workspace.base_sha,
    to_sha: head,
    state: 'running',
  });
  expect(story.session_id).not.toBe(session.id);
  const brief = w.turns(story.session_id!)[0]!.input;
  expect(brief).toContain(`Goal: ${session.title}\nRename the answer file and explain why`);
  expect(brief).toContain('+explained');
  expect(await startStory()).toEqual(story);

  const ready = await w.call<Promise<ChangeStory>>(
    'change_story.submit',
    {
      story_id: story.id,
      overall: { before: ['The answer is base'], after: ['The answer is explained'] },
      cards: [card('Explain the answer', ['H1'], { acceptance: [] })],
      noise: [],
    },
    null,
    storyPrincipal(w, story),
  );
  expect(ready).toMatchObject({ state: 'ready', result: { hunk_total: 1, uninterpreted: [] } });
});

it('explains a merged workbench session from the range its merge fast-forwarded', async () => {
  const { w, session, workspace, sourceHead, startStory } = await idleWorkbenchSession();
  const head = commitAnswer(workspace.path, 'merged\n');
  w.call(
    'session.merge',
    { session_id: session.id },
    w.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => w.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => w.control.tick(),
  );
  const story = await startStory();
  expect(story).toMatchObject({
    workbench_session_id: session.id,
    source: w.source,
    from_sha: sourceHead,
    to_sha: head,
    state: 'running',
  });
  expect(w.turns(story.session_id!)[0]!.input).toContain('+merged');
});

it('refuses to explain a workbench session without committed changes', async () => {
  const { startStory } = await idleWorkbenchSession();
  await expect(startStory()).rejects.toMatchObject({
    code: 'invalid_state',
    message: 'No committed changes to explain',
  });
});

it('freezes exact commit/configuration command evidence for interpretation', async () => {
  const { w, session, workspace, startStory } = await idleWorkbenchSession();
  const head = commitAnswer(workspace.path, 'explained\n');
  await w.call(
    'project.gate.set',
    {
      project_id: w.project.id,
      root: w.source,
      commands: [{ name: 'Check answer', argv: ['node', 'check-answer.js'] }],
    },
    w.store.must<Project>('projects', w.project.id).revision,
  );
  const commands = [{ name: 'Check answer', argv: ['node', 'check-answer.js'] }];
  const event = w.store.event(
    'session.gate_checked',
    w.store.must<Session>('sessions', session.id),
    w.project.id,
    {
      commit: head,
      check_spec_hash: hash(commands),
      results: commands.map((cmd) => ({
        ...cmd,
        exit_code: 0,
        timed_out: false,
        duration_ms: 5,
        output: 'answer verified',
      })),
    },
  );
  const story = await startStory();
  expect(story.context).toMatchObject({
    checks: {
      state: 'recorded',
      commit: head,
      spec_hash: hash(commands),
      run_id: event.event_id,
      results: [{ exit_code: 0 }],
    },
  });
  const brief = w.turns(story.session_id!)[0]!.input;
  expect(brief).toContain('node","check-answer.js');
  expect(brief).toContain('answer verified');
  expect(brief).toContain('does not certify that requirement passed');
});

it('marks command evidence from another commit or configuration stale and never cites it as passed', async () => {
  const { w, session, workspace, startStory } = await idleWorkbenchSession(smallBase);
  const head = commitSmallChange(workspace.path);
  const command = { name: 'Test notes', argv: ['pnpm', 'test', 'notes.test.ts'] };
  await w.call(
    'project.gate.set',
    { project_id: w.project.id, root: w.source, commands: [command] },
    w.store.must<Project>('projects', w.project.id).revision,
  );
  w.store.event(
    'session.gate_checked',
    w.store.must<Session>('sessions', session.id),
    w.project.id,
    {
      commit: head,
      check_spec_hash: 'old-configuration',
      results: [
        {
          ...command,
          exit_code: 0,
          timed_out: false,
          duration_ms: 1,
          output: 'PASS notes.test.ts',
        },
      ],
    },
  );
  const story = await startStory();
  expect(story.context?.checks.state).toBe('stale');
  const ready = await submitStory(w, story, smallSubmission);
  expect(ready.result?.cards[0]!.evidence).toEqual([]);
  w.store.event(
    'session.gate_checked',
    w.store.must<Session>('sessions', session.id),
    w.project.id,
    { commit: workspace.base_sha, check_spec_hash: hash([command]), results: [] },
  );
  expect((await startStory()).context?.checks.state).toBe('stale');
});

it('keeps story hunks bound to the explained range and flags later commits or checks as outdated', async () => {
  const { w, workspace, startStory } = await idleWorkbenchSession();
  const head = commitAnswer(workspace.path, 'first change\n');
  const story = await startStory();
  commitAnswer(workspace.path, 'later change\n');
  const diff = await w.control.changeStoryDiff(user, story.id);
  expect(diff.to_sha).toBe(head);
  expect(diff.hunks[0]!.text).toContain('+first change');
  expect(diff.hunks[0]!.text).not.toContain('later change');
  expect(
    (await w.control.changeStoryList(user, w.project.id)).find((row) => row.id === story.id)
      ?.outdated,
  ).toBe(true);
  expect(() =>
    w.control.changeStoryDiff({ id: 'other', role: 'lead', project_id: 'other-project' }, story.id),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
});

it('allows fresh command evidence to produce a new interpretation of the same commit', async () => {
  const { w, session, workspace, startStory } = await idleWorkbenchSession();
  const head = commitAnswer(workspace.path, 'explained\n');
  const first = await startStory();
  const command = { name: 'Check', argv: ['node', 'check.js'] };
  await w.call(
    'project.gate.set',
    { project_id: w.project.id, root: w.source, commands: [command] },
    w.store.must<Project>('projects', w.project.id).revision,
  );
  w.store.event(
    'session.gate_checked',
    w.store.must<Session>('sessions', session.id),
    w.project.id,
    {
      commit: head,
      check_spec_hash: hash([command]),
      results: [{ ...command, exit_code: 0, timed_out: false, duration_ms: 1, output: 'checked' }],
    },
  );
  expect(
    (await w.control.changeStoryList(user, w.project.id)).find((row) => row.id === first.id)
      ?.outdated,
  ).toBe(true);
  const second = await startStory();
  expect(second.id).not.toBe(first.id);
  expect(second.to_sha).toBe(first.to_sha);
  expect(second.context?.checks.state).toBe('recorded');
});

const twentyLines = (edit: (n: number) => string = (n) => `line ${n}`) =>
  Array.from({ length: 20 }, (_, i) => edit(i + 1)).join('\n') + '\n';

function smallBase(source: string) {
  writeFileSync(path.join(source, 'notes.txt'), twentyLines());
  writeFileSync(path.join(source, 'readme.txt'), 'hello\n');
  git(source, 'add', '-A');
  git(source, 'commit', '--quiet', '-m', 'Base notes');
}

/** H1 adds notes.test.ts, H2 and H3 change notes.txt, H4 changes readme.txt. */
function commitSmallChange(repository: string) {
  writeFileSync(path.join(repository, 'notes.test.ts'), "it('reads line two');\n");
  writeFileSync(
    path.join(repository, 'notes.txt'),
    twentyLines((n) => (n === 2 ? 'changed 2' : n === 18 ? 'changed 18' : `line ${n}`)),
  );
  writeFileSync(path.join(repository, 'readme.txt'), 'hello world\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '--quiet', '-m', 'Change the notes');
  return git(repository, 'rev-parse', 'HEAD');
}

const smallSubmission = {
  overall: { before: ['Old notes'], after: ['New notes'] },
  cards: [
    card('Change line two', ['H1', 'H2'], { acceptance: [], tests: ['H1'] }),
    card('Greet the world', ['H4'], { acceptance: [] }),
  ],
  noise: [],
};

/** The principal of the session bound to a story. */
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

function submitStory(
  w: Awaited<ReturnType<typeof workbenchFixture>>,
  story: ChangeStory,
  submission: unknown,
  by: Principal = storyPrincipal(w, story),
) {
  return w.call<Promise<ChangeStory>>(
    'change_story.submit',
    { story_id: story.id, ...(submission as object) },
    null,
    by,
  );
}

const storySessions = (w: Awaited<ReturnType<typeof workbenchFixture>>) =>
  w.store.list<Session>('sessions').filter((s) => s.change_story);

it('keeps a change story session that never started queued across a restart and starts it on the next tick', async () => {
  const { w, workspace, startStory } = await idleWorkbenchSession();
  commitAnswer(workspace.path, 'explained\n');
  const story = await startStory();
  const turnJob = () =>
    w.store
      .pending()
      .filter((job) => job.kind === 'session.turn')
      .map((job) => (JSON.parse(job.payload) as { turn_id: string }).turn_id);
  const [turn] = w.turns(story.session_id!);
  expect(turnJob()).toEqual([turn!.id]);
  await w.control.recover();
  expect(w.store.must<Session>('sessions', story.session_id!).state).toBe('running');
  expect(turnJob()).toEqual([turn!.id]);
  await eventually(
    () => w.turns(story.session_id!)[0]!.delivery !== 'pending',
    () => w.control.tick(),
  );
});

it('records a workbench session diff too large to interpret as failed without opening a session', async () => {
  const { w, session, workspace, startStory } = await idleWorkbenchSession();
  writeFileSync(
    path.join(workspace.path, 'big.txt'),
    Array.from({ length: 40000 }, (_, i) => `generated line ${i} ${'x'.repeat(20)}`).join('\n'),
  );
  git(workspace.path, 'add', '-A');
  git(workspace.path, 'commit', '--quiet', '-m', 'Generate a large file');
  expect(await startStory()).toMatchObject({
    workbench_session_id: session.id,
    state: 'failed',
    reason: 'diff_too_large',
  });
  expect(storySessions(w)).toHaveLength(0);
});

it('refuses a workbench session story submission naming an unknown hunk and keeps a checked one', async () => {
  const { w, workspace, startStory } = await idleWorkbenchSession(smallBase);
  commitSmallChange(workspace.path);
  const story = await startStory();
  const wrong = { ...smallSubmission, cards: [card('Change line two', ['H1', 'H9'])] };
  await expect(submitStory(w, story, wrong)).rejects.toMatchObject({
    code: 'invalid_input',
    message: expect.stringContaining('H9'),
  });
  expect(w.store.must<ChangeStory>('change_stories', story.id).state).toBe('running');

  const ready = await submitStory(w, story, smallSubmission);
  expect(ready.state).toBe('ready');
  expect(ready.result).toMatchObject({ uninterpreted: ['H3'], hunk_total: 4 });
});

it('refuses a workbench session story submission from anyone but the bound session', async () => {
  const { w, session, workspace, startStory } = await idleWorkbenchSession(smallBase);
  commitSmallChange(workspace.path);
  const story = await startStory();
  const explained: Principal = {
    id: `session:${session.id}`,
    role: 'planner',
    project_id: w.project.id,
    session_id: session.id,
    expires_at: w.store.now() + 60000,
  };
  for (const by of [user, explained])
    await expect(async () => submitStory(w, story, smallSubmission, by)).rejects.toMatchObject({
      code: 'permission_denied',
    });
  expect(w.store.must<ChangeStory>('change_stories', story.id).state).toBe('running');
});

it('writes a patch that reverts only one card of a merged workbench session and refuses a card that shares hunks', async () => {
  const { w, session, workspace, startStory } = await idleWorkbenchSession(smallBase);
  const head = commitSmallChange(workspace.path);
  w.call(
    'session.merge',
    { session_id: session.id },
    w.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => w.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => w.control.tick(),
  );
  const story = await submitStory(w, await startStory(), smallSubmission);
  const { path: file, commands } = await w.call<{ path: string; commands: string[] }>(
    'change_story.revert_patch',
    { story_id: story.id, card: 1 },
  );
  expect(file).toBe(path.join(w.root, 'state', 'change-story-patches', `${story.id}-card2.patch`));
  expect(existsSync(file)).toBe(true);
  // Paths with spaces, such as macOS Application Support, come back quoted for the shell.
  const shell = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value}'`);
  expect(commands).toEqual([
    [
      `test -z "$(git -C ${shell(w.source)} status --porcelain)"`,
      `git -C ${shell(w.source)} switch -c pantheon/revert-${head.slice(0, 7)}-card2`,
      `git -C ${shell(w.source)} apply -R --3way ${shell(file)}`,
      `git -C ${shell(w.source)} commit -m 'revert: Greet the world'`,
    ].join(' && '),
  ]);
  git(w.source, 'apply', '-R', '--check', file);

  const other = await idleWorkbenchSession(smallBase);
  commitSmallChange(other.workspace.path);
  const shared = await submitStory(other.w, await other.startStory(), {
    ...smallSubmission,
    cards: [
      card('Change line two', ['H1', 'H2', 'H4'], { acceptance: [] }),
      card('Greet the world', ['H4'], { acceptance: [] }),
    ],
  });
  await expect(
    other.w.call('change_story.revert_patch', { story_id: shared.id, card: 1 }),
  ).rejects.toThrow(
    expect.objectContaining({ code: 'invalid_state', message: expect.stringContaining('card 1') }),
  );
});

/** Runs each command the way a shell runs pasted lines: the next one runs whatever the last returned. */
function paste(cwd: string, commands: string[]) {
  for (const command of commands)
    spawnSync('sh', ['-c', command], {
      cwd,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore',
    });
}

it('gives revert commands that stop on a dirty source checkout and commit only the reverted card', async () => {
  const { w, session, workspace, startStory } = await idleWorkbenchSession(smallBase);
  const head = commitSmallChange(workspace.path);
  w.call(
    'session.merge',
    { session_id: session.id },
    w.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () => w.store.must<Workspace>('workspaces', workspace.id).removed_at !== undefined,
    () => w.control.tick(),
  );
  const story = await submitStory(w, await startStory(), smallSubmission);
  const { commands } = await w.call<{ path: string; commands: string[] }>(
    'change_story.revert_patch',
    {
      story_id: story.id,
      card: 1,
    },
  );
  const notes = path.join(w.source, 'notes.txt');
  writeFileSync(notes, 'local edit\n');
  paste(w.source, commands);
  expect(git(w.source, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  expect(git(w.source, 'rev-parse', 'HEAD')).toBe(head);
  expect(readFileSync(notes, 'utf8')).toBe('local edit\n');

  git(w.source, 'checkout', '--', 'notes.txt');
  paste(w.source, commands);
  expect(git(w.source, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
    `pantheon/revert-${head.slice(0, 7)}-card2`,
  );
  expect(git(w.source, 'show', '--name-only', '--format=%s', 'HEAD')).toBe(
    'revert: Greet the world\n\nreadme.txt',
  );
  expect(git(w.source, 'status', '--porcelain')).toBe('');
});

/** Each hunk header in a story brief as its file and its noise mark. */
function briefHunks(brief: string) {
  return brief
    .split('\n')
    .filter((line) => /^H\d+ /.test(line))
    .map((line) => [/^H\d+ (.+?) @@ /.exec(line)![1], / noise: (\w+)$/.exec(line)?.[1]]);
}

function writeFiles(repository: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repository, name)), { recursive: true });
    writeFileSync(path.join(repository, name), contents);
  }
  git(repository, 'add', '-A');
  git(repository, 'commit', '--quiet', '-m', 'Write files');
}

it('marks whitespace as noise only where it cannot change behavior and keeps lockfile changes', async () => {
  const { w, workspace, startStory } = await idleWorkbenchSession((source) =>
    writeFiles(source, {
      'p.py': 'if x:\n    a()\nb()\n',
      'config.yaml': 'a:\n  b: 1\nc: 2\n',
      Makefile: 'build:\n\techo hi\n',
      'm.js': 'const msg = "hello world";\n',
      'layout.js': 'function f() {\nreturn 1;\n}\n',
      'pnpm-lock.yaml': 'lockfileVersion: 1\n',
      'dist/out.js': 'built(1);\n',
    }),
  );
  writeFiles(workspace.path, {
    'p.py': 'if x:\n    a()\n    b()\n',
    'config.yaml': 'a:\n  b: 1\n  c: 2\n',
    Makefile: 'build:\n        echo hi\n',
    'm.js': 'const msg = "helloworld";\n',
    'layout.js': 'function f() {\n  return 1;\n}\n',
    'pnpm-lock.yaml': 'lockfileVersion: 2\n',
    'dist/out.js': 'built(2);\n',
  });
  const brief = w.turns((await startStory()).session_id!)[0]!.input;
  expect(Object.fromEntries(briefHunks(brief))).toEqual({
    'p.py': undefined,
    'config.yaml': undefined,
    Makefile: undefined,
    'm.js': undefined,
    'layout.js': 'whitespace',
    'pnpm-lock.yaml': undefined,
    'dist/out.js': 'generated',
  });
});

it('marks a block as moved only when the same lines leave and arrive once in the same order', async () => {
  const filler = (name: string) =>
    Array.from({ length: 10 }, (_, i) => `${name}(${i});`).join('\n') + '\n';
  const block = (...calls: string[]) => calls.map((call) => `${call}();\n`).join('');
  const { w, workspace, startStory } = await idleWorkbenchSession((source) =>
    writeFiles(source, {
      'moved.js': block('alpha', 'beta', 'gamma') + filler('keep'),
      'reordered.js': block('one', 'two', 'three') + filler('stay'),
      'copied.js': block('red', 'green', 'blue') + filler('first') + filler('second'),
    }),
  );
  writeFiles(workspace.path, {
    'moved.js': filler('keep') + block('alpha', 'beta', 'gamma'),
    'reordered.js': filler('stay') + block('three', 'two', 'one'),
    'copied.js':
      filler('first') +
      block('red', 'green', 'blue') +
      filler('second') +
      block('red', 'green', 'blue'),
  });
  const brief = w.turns((await startStory()).session_id!)[0]!.input;
  expect(briefHunks(brief)).toEqual([
    ['copied.js', 'moved'],
    ['copied.js', 'moved'],
    ['copied.js', undefined],
    ['moved.js', 'moved'],
    ['moved.js', 'moved'],
    ['reordered.js', undefined],
    ['reordered.js', undefined],
  ]);
});

it('splits a file that turns into a symlink into hunks of that file and keeps later files aligned', async () => {
  const { w, workspace, startStory } = await idleWorkbenchSession((source) =>
    writeFiles(source, {
      'link.txt': 'plain\n',
      'café.txt': 'old\n',
      'notes with space.txt': 'old\n',
    }),
  );
  rmSync(path.join(workspace.path, 'link.txt'));
  symlinkSync('answer.txt', path.join(workspace.path, 'link.txt'));
  writeFiles(workspace.path, { 'café.txt': 'new\n', 'notes with space.txt': 'new\n' });
  const brief = w.turns((await startStory()).session_id!)[0]!.input;
  expect(briefHunks(brief).map(([file]) => file)).toEqual([
    'café.txt',
    'link.txt',
    'link.txt',
    'notes with space.txt',
  ]);
});

it('splits hunks of a quoted file name with an emoji when the project turns off core.quotePath', async () => {
  const name = 'say "hi" 🎉.txt';
  const { w, workspace, startStory } = await idleWorkbenchSession((source) => {
    git(source, 'config', 'core.quotePath', 'false');
    writeFiles(source, { [name]: 'old\n', 'plain.txt': 'old\n' });
  });
  writeFiles(workspace.path, { [name]: 'new\n', 'plain.txt': 'new\n' });
  const brief = w.turns((await startStory()).session_id!)[0]!.input;
  expect(briefHunks(brief).map(([file]) => file)).toEqual(['plain.txt', name]);
});
