import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { id, type ProjectBaseline, type Session, type Workspace } from '@pantheon/domain';
import { querySchemas } from '@pantheon/protocol';
import { git, workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const HOUR = 60 * 60 * 1000,
  DAY = 24 * HOUR;

/** main at a second commit, a session worktree on feature one commit ahead, a detached external worktree at the first commit. */
function repoFixture() {
  const f = workbenchFixture();
  const first = git(f.source, 'rev-parse', 'HEAD');
  writeFileSync(path.join(f.source, 'answer.txt'), 'base\nsecond\n');
  git(f.source, 'commit', '--quiet', '-am', 'Second answer line');
  const second = git(f.source, 'rev-parse', 'HEAD');
  const sessionTree = path.join(f.root, 'session-tree'),
    outsideTree = path.join(f.root, 'outside-tree');
  git(f.source, 'worktree', 'add', '--quiet', '-b', 'feature', sessionTree);
  writeFileSync(path.join(sessionTree, 'notes.txt'), 'one\ntwo\n');
  git(sessionTree, 'add', 'notes.txt');
  git(sessionTree, 'commit', '--quiet', '-m', 'Add notes');
  const third = git(sessionTree, 'rev-parse', 'HEAD');
  git(f.source, 'worktree', 'add', '--quiet', '--detach', outsideTree, first);
  writeFileSync(path.join(outsideTree, 'answer.txt'), 'changed\n');
  writeFileSync(path.join(outsideTree, 'scratch.txt'), 'scratch\n');
  writeFileSync(path.join(f.source, 'answer.txt'), 'base\nsecond\nstaged\n');
  git(f.source, 'add', 'answer.txt');
  writeFileSync(path.join(f.source, 'draft.txt'), 'draft\n');
  const workspace = f.store.insert<Workspace>('workspaces', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    kind: 'linked_worktree',
    path: realpathSync(sessionTree),
    source: f.source,
    owner: 'none',
    ownership_epoch: 0,
  });
  const session = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
  });
  f.store.event('session.merged', session, f.project.id, { from_sha: second, to_sha: third });
  return {
    f,
    first,
    second,
    third,
    session,
    source: realpathSync(f.source),
    sessionTree: realpathSync(sessionTree),
    outsideTree: realpathSync(outsideTree),
  };
}

it('lists the checkout, a session worktree and an outside worktree with counts against the checkout', async () => {
  const r = repoFixture();
  const worktrees = await r.f.control.repoWorktrees(user, r.f.project.id);
  expect(worktrees).toHaveLength(3);
  expect(worktrees).toEqual(
    expect.arrayContaining([
      {
        path: r.source,
        branch: 'main',
        head_sha: r.second,
        kind: 'checkout',
        ahead: 0,
        behind: 0,
        uncommitted: 2,
        additions: 0,
        deletions: 0,
        conflicts: 0,
      },
      {
        path: r.sessionTree,
        branch: 'feature',
        head_sha: r.third,
        kind: 'session',
        session_id: r.session.id,
        ahead: 1,
        behind: 0,
        uncommitted: 0,
        additions: 2,
        deletions: 0,
        conflicts: 0,
      },
      {
        path: r.outsideTree,
        branch: null,
        head_sha: r.first,
        kind: 'external',
        ahead: 0,
        behind: 1,
        uncommitted: 2,
        additions: 0,
        deletions: 0,
        conflicts: 0,
      },
    ]),
  );
});

/** Changes the second answer line one way in the session worktree and another way on main. */
function conflictingSides(r: ReturnType<typeof repoFixture>) {
  writeFileSync(path.join(r.sessionTree, 'answer.txt'), 'base\nsession side\n');
  git(r.sessionTree, 'commit', '--quiet', '-am', 'Session side');
  writeFileSync(path.join(r.f.source, 'answer.txt'), 'base\nmain side\n');
  git(r.f.source, 'commit', '--quiet', '-am', 'Main side');
}

it('counts the files a worktree would conflict on and previews again only once a HEAD moves', async () => {
  const r = repoFixture();
  conflictingSides(r);
  const session = async () =>
    (await r.f.control.repoWorktrees(user, r.f.project.id)).find(
      (worktree) => worktree.kind === 'session',
    );
  expect(await session()).toMatchObject({ additions: 3, deletions: 1, conflicts: 1 });
  // A union merge resolves the conflict, so only a fresh preview sees it gone.
  writeFileSync(path.join(r.f.source, '.git/info/attributes'), 'answer.txt merge=union\n');
  expect((await session())!.conflicts).toBe(1);
  writeFileSync(path.join(r.f.source, 'other.txt'), 'other\n');
  git(r.f.source, 'add', 'other.txt');
  git(r.f.source, 'commit', '--quiet', '-m', 'Other file');
  expect((await session())!.conflicts).toBe(0);
});

it('reads staged and untracked files of a worktree and refuses a folder that is not one', async () => {
  const r = repoFixture();
  expect(await r.f.control.repoStatus(user, r.f.project.id, r.f.source)).toEqual({
    path: r.source,
    branch: 'main',
    head_sha: r.second,
    files: [
      { path: 'answer.txt', index: 'M', worktree: null, untracked: false, conflicted: false },
      { path: 'draft.txt', index: null, worktree: null, untracked: true, conflicted: false },
    ],
  });
  expect(await r.f.control.repoStatus(user, r.f.project.id, r.outsideTree)).toMatchObject({
    branch: null,
    head_sha: r.first,
    files: [
      { path: 'answer.txt', index: null, worktree: 'M' },
      { path: 'scratch.txt', untracked: true },
    ],
  });
  await expect(r.f.control.repoStatus(user, r.f.project.id, r.f.root)).rejects.toMatchObject({
    code: 'scope_violation',
  });
});

it('lists untracked files when the repository hides them from status', async () => {
  const r = repoFixture();
  git(r.f.source, 'config', 'status.showUntrackedFiles', 'no');
  expect((await r.f.control.repoStatus(user, r.f.project.id, r.f.source)).files).toContainEqual({
    path: 'draft.txt',
    index: null,
    worktree: null,
    untracked: true,
    conflicted: false,
  });
});

it('pages the log, names the session whose merge landed a commit and refuses an option as ref', async () => {
  const r = repoFixture();
  const log = await r.f.control.repoLog(user, { project_id: r.f.project.id, limit: 200, skip: 0 });
  expect(log.has_more).toBe(false);
  expect(log.commits.map((commit) => commit.sha)).toEqual([r.second, r.first]);
  expect(log.commits[0]).toMatchObject({
    parents: [r.first],
    refs: ['HEAD -> main'],
    author: 'Workbench Fixture',
    subject: 'Second answer line',
  });
  expect(log.commits[0]!.committed_at % 1000).toBe(0);
  expect(log.commits[1]).toMatchObject({ parents: [], subject: 'Initial files' });
  const page = await r.f.control.repoLog(user, { project_id: r.f.project.id, limit: 1, skip: 1 });
  expect(page).toMatchObject({ has_more: false, commits: [{ sha: r.first }] });
  const feature = await r.f.control.repoLog(user, {
    project_id: r.f.project.id,
    ref: 'feature',
    limit: 1,
    skip: 0,
  });
  expect(feature.has_more).toBe(true);
  expect(feature.commits).toEqual([
    expect.objectContaining({ sha: r.third, session_id: r.session.id }),
  ]);
  expect(log.commits.every((commit) => commit.session_id === undefined)).toBe(true);
  await expect(
    r.f.control.repoLog(user, { project_id: r.f.project.id, ref: '--all', limit: 1, skip: 0 }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});

it('diffs a commit against its parent, and a root commit against the empty tree', async () => {
  const r = repoFixture();
  const root = await r.f.control.repoCommitDiff(user, r.f.project.id, r.first);
  expect(root).toMatchObject({
    from_sha: EMPTY_TREE,
    to_sha: r.first,
    files: [{ path: 'answer.txt', status: 'added', additions: 1, deletions: 0 }],
    truncated: false,
  });
  const second = await r.f.control.repoCommitDiff(user, r.f.project.id, r.second.slice(0, 10));
  expect(second).toMatchObject({
    from_sha: r.first,
    to_sha: r.second,
    files: [{ path: 'answer.txt', status: 'modified', additions: 1, deletions: 0 }],
  });
  expect(second.hunks).toHaveLength(1);
  expect(second.hunks[0]!.text).toContain('+second');
});

it('compares two commits from their merge base with counts on both sides', async () => {
  const r = repoFixture();
  expect(await r.f.control.repoCompare(user, r.f.project.id, 'main', 'feature')).toMatchObject({
    merge_base: r.second,
    ahead: 1,
    behind: 0,
    from_sha: r.second,
    to_sha: r.third,
    files: [{ path: 'notes.txt', status: 'added', additions: 2, deletions: 0 }],
    conflicts: [],
    previewed_at: expect.any(Number),
    single_owner_files: 1,
  });
  expect(await r.f.control.repoCompare(user, r.f.project.id, 'feature', r.first)).toMatchObject({
    merge_base: r.first,
    ahead: 0,
    behind: 2,
    files: [],
    hunks: [],
  });
});

it('gives the first conflict of each file and counts the files no other session changes', async () => {
  const r = repoFixture();
  conflictingSides(r);
  // A worktree made outside Pantheon is no session, so its change to answer.txt does not count.
  git(r.outsideTree, 'commit', '--quiet', '-am', 'Outside change');
  const otherTree = path.join(r.f.root, 'other-tree');
  git(r.f.source, 'worktree', 'add', '--quiet', '-b', 'other', otherTree, r.second);
  writeFileSync(path.join(otherTree, 'notes.txt'), 'other\n');
  git(otherTree, 'add', 'notes.txt');
  git(otherTree, 'commit', '--quiet', '-m', 'Other notes');
  const workspace = r.f.store.insert<Workspace>('workspaces', {
    id: id(),
    revision: 1,
    project_id: r.f.project.id,
    kind: 'linked_worktree',
    path: realpathSync(otherTree),
    source: r.f.source,
    owner: 'none',
    ownership_epoch: 0,
  });
  r.f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: r.f.project.id,
    runtime: r.f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
  });
  const before = Date.now();
  const compare = await r.f.control.repoCompare(user, r.f.project.id, 'main', 'feature');
  expect(compare.conflicts).toEqual([
    { path: 'answer.txt', line: 2, base_lines: ['main side'], head_lines: ['session side'] },
  ]);
  expect(compare.previewed_at).toBeGreaterThanOrEqual(before);
  expect(compare.previewed_at).toBeLessThanOrEqual(Date.now());
  expect(compare.files.map((file) => file.path)).toEqual(['answer.txt', 'notes.txt']);
  expect(compare.single_owner_files).toBe(1);
});

describe('after a commit', () => {
  const result = (exit_code: number, duration_ms: number, state?: 'skipped') => ({
    name: 'step',
    argv: ['true'],
    exit_code,
    duration_ms,
    timed_out: false,
    output: '',
    ...(state ? { state } : {}),
  });

  it('gives the gate of the session merge that ended at the commit and of the one before on its branch', async () => {
    const r = repoFixture();
    const project = r.f.project.id;
    const after = (sha: string) => r.f.control.repoCommitAfter(user, { project_id: project, sha });
    expect(await after(r.second)).toMatchObject({ gate: null, previous_gate_ms: null });
    expect(await after(r.third)).toMatchObject({ gate: null, previous_gate_ms: null });
    const gate = (session: Session, results: ReturnType<typeof result>[]) =>
      r.f.store.event('session.gate_checked', session, project, {
        workspace_id: session.workspace_id,
        commit: r.third,
        check_spec_hash: 'spec',
        results,
      });
    gate(r.session, [result(0, 4000)]);
    r.f.store.event('session.merged', r.session, project, { branch: 'main', to_sha: r.first });
    const other = r.f.store.insert<Session>('sessions', {
      id: id(),
      revision: 1,
      project_id: project,
      runtime: r.f.adapter.name,
      state: 'open',
      turn_count: 0,
    });
    gate(other, [result(0, 9000)]);
    r.f.store.event('session.merged', other, project, {
      branch: 'release',
      to_sha: 'f'.repeat(40),
    });
    // A skipped step that exited 0 still is no pass.
    gate(r.session, [result(0, 1000), result(1, 500), result(0, 0, 'skipped')]);
    r.f.store.event('session.merged', r.session, project, { branch: 'main', to_sha: r.second });
    expect(await after(r.second)).toMatchObject({
      gate: { passed: 1, failed: 1, skipped: 1, sha: r.third, duration_ms: 1500 },
      previous_gate_ms: 4000,
    });
    expect(await after(r.first)).toMatchObject({
      gate: { passed: 1, failed: 0, skipped: 0, duration_ms: 4000 },
      previous_gate_ms: null,
    });
  });

  it('counts the dependency entries a commit changes over every package.json', async () => {
    const f = workbenchFixture();
    const after = async () =>
      (
        await f.control.repoCommitAfter(user, {
          project_id: f.project.id,
          sha: git(f.source, 'rev-parse', 'HEAD'),
        })
      ).dependencies;
    expect(await after()).toBe(0);
    const write = (file: string, manifest: object) => {
      mkdirSync(path.dirname(path.join(f.source, file)), { recursive: true });
      writeFileSync(path.join(f.source, file), JSON.stringify(manifest));
      git(f.source, 'add', file);
    };
    write('package.json', { dependencies: { a: '1', b: '1' }, scripts: { x: 'x' } });
    git(f.source, 'commit', '--quiet', '-m', 'Add the manifest');
    expect(await after()).toBe(2);
    write('package.json', {
      dependencies: { a: '2', c: '1' },
      devDependencies: { d: '1' },
      scripts: { x: 'y' },
    });
    write('packages/x/package.json', {
      peerDependencies: { e: '1' },
      optionalDependencies: { f: '1' },
    });
    git(f.source, 'commit', '--quiet', '-m', 'Change the dependencies');
    expect(await after()).toBe(6);
  });

  it('lists later commits that change the lines a commit added, newest first, not those that only move them', async () => {
    const f = workbenchFixture();
    const commit = (content: string, message: string) => {
      writeFileSync(path.join(f.source, 'later.txt'), content);
      git(f.source, 'add', 'later.txt');
      git(f.source, 'commit', '--quiet', '-m', message);
      return git(f.source, 'rev-parse', 'HEAD');
    };
    const top = Array.from({ length: 20 }, (_, index) => `top ${index}\n`).join('');
    const added = commit('one\ntwo\nthree\n', 'Add three lines');
    const two = commit('one\nTWO\nthree\n', 'Change two');
    writeFileSync(path.join(f.source, 'other.txt'), 'other\n');
    git(f.source, 'add', 'other.txt');
    git(f.source, 'commit', '--quiet', '-m', 'Other file');
    commit(`${top}one\nTWO\nthree\n`, 'Add twenty lines on top');
    const three = commit(`${top}one\nTWO\nTHREE\n`, 'Change three');
    const after = (sha: string) =>
      f.control.repoCommitAfter(user, { project_id: f.project.id, sha });
    expect((await after(added)).later).toEqual([
      { sha: three, at: expect.any(Number), subject: 'Change three' },
      { sha: two, at: expect.any(Number), subject: 'Change two' },
    ]);
    expect((await after(three)).later).toEqual([]);
  });

  it('gives the upstream of the branch and how far HEAD is ahead of it', async () => {
    const f = workbenchFixture();
    const upstream = async () =>
      (await f.control.repoCommitAfter(user, { project_id: f.project.id, sha: 'HEAD' })).upstream;
    expect(await upstream()).toBeNull();
    git(f.source, 'branch', 'base');
    writeFileSync(path.join(f.source, 'answer.txt'), 'ahead\n');
    git(f.source, 'commit', '--quiet', '-am', 'Ahead of base');
    git(f.source, 'branch', '--set-upstream-to=base', 'main');
    expect(await upstream()).toEqual({ name: 'base', ahead: 1 });
    // A push moves the upstream while HEAD stays.
    git(f.source, 'branch', '--force', 'base', 'main');
    expect(await upstream()).toEqual({ name: 'base', ahead: 0 });
  });
});

/** Appends one commit per time to main in a single git process; returns main's shas, oldest first. */
function commitsAt(source: string, times: number[]): string[] {
  let stream = '';
  times.forEach((at, index) => {
    const message = `Count ${index}\n`,
      content = `${index}\n`;
    stream +=
      `commit refs/heads/main\n` +
      `committer Workbench Fixture <fixture@example.invalid> ${Math.floor(at / 1000)} +0000\n` +
      `data ${message.length}\n${message}` +
      (index === 0 ? `from ${git(source, 'rev-parse', 'HEAD')}\n` : '') +
      `M 100644 inline count.txt\ndata ${content.length}\n${content}\n`;
  });
  execFileSync('git', ['fast-import', '--quiet'], {
    cwd: source,
    input: stream,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  return git(source, 'log', '--format=%H', '--reverse', 'main').split('\n');
}

describe('repository timeline', () => {
  it('gives a lane with more than 200 commits as day bins instead of points', async () => {
    const f = workbenchFixture();
    const start = Math.ceil(Date.now() / HOUR) * HOUR + HOUR;
    commitsAt(
      f.source,
      Array.from({ length: 250 }, (_, index) => start + index * HOUR),
    );
    const timeline = await f.control.repoTimeline(user, {
      project_id: f.project.id,
      from: start,
      to: start + 250 * HOUR,
      group: 'branch',
    });
    expect(timeline.bin_ms).toBe(DAY);
    const [main] = timeline.lanes;
    expect(main).toMatchObject({ key: 'main', label: 'main', kind: 'main' });
    expect(main!.points).toBeUndefined();
    expect(main!.bins).toHaveLength(11);
    expect(main!.bins![0]).toEqual({ start, commits: 24, merges: 0 });
    expect(main!.bins!.reduce((sum, bin) => sum + bin.commits, 0)).toBe(250);
    expect(timeline.totals).toEqual({
      commits: 250,
      merges: 0,
      gate_runs: 0,
      gate_first_pass: null,
    });
    expect(timeline.overview.reduce((sum, week) => sum + week.agent + week.user, 0)).toBe(251);
  });

  it('keeps main and the six busiest of nine session lanes and folds the other three', async () => {
    const f = workbenchFixture();
    const now = Date.now();
    // Session index lands index + 1 commits, so the first three are the quietest.
    const shas = commitsAt(
      f.source,
      Array.from({ length: 45 }, (_, index) => now - HOUR + index * 1000),
    );
    let landed = 0;
    const sessions = Array.from({ length: 9 }, (_, index) => {
      const workspace = f.store.insert<Workspace>('workspaces', {
        id: id(),
        revision: 1,
        project_id: f.project.id,
        kind: 'linked_worktree',
        path: path.join(f.root, `gone-tree-${index}`),
        source: f.source,
        owner: 'none',
        ownership_epoch: 0,
      });
      const session = f.store.insert<Session>('sessions', {
        id: id(),
        revision: 1,
        project_id: f.project.id,
        runtime: f.adapter.name,
        workspace_id: workspace.id,
        state: 'open',
        turn_count: 0,
        title: `Session ${index}`,
      });
      f.store.event('session.opened', session, f.project.id, session);
      f.store.event('session.merged', session, f.project.id, {
        from_sha: shas[landed],
        to_sha: shas[(landed += index + 1)],
      });
      return session;
    });
    const timeline = await f.control.repoTimeline(user, {
      project_id: f.project.id,
      from: now - DAY,
      to: now + DAY,
      group: 'branch',
    });
    expect(timeline.lanes).toHaveLength(8);
    expect(timeline.lanes.map((lane) => lane.key)).toEqual([
      'main',
      ...sessions
        .slice(3)
        .reverse()
        .map((session) => session.id),
      'other',
    ]);
    const other = timeline.lanes.at(-1)!;
    expect(other).toMatchObject({ kind: 'other', merged_lanes: 3 });
    expect(other.points).toHaveLength(6);
    expect(other.spans.map((span) => span.title).sort()).toEqual([
      'Session 0',
      'Session 1',
      'Session 2',
    ]);
    expect(timeline.lanes[1]).toMatchObject({
      kind: 'branch',
      label: 'Session 8',
      spans: [{ session_id: sessions[8]!.id, branch: null, state: 'merged' }],
      turns: [],
    });
    expect(timeline.lanes[1]!.points).toHaveLength(9);
    // Fast-forward merges make no merge commits; each recorded merge's last commit stands for it.
    expect(timeline.totals.merges).toBe(9);
    expect(timeline.lanes[0]!.points!.filter((point) => point.kind === 'merge')).toHaveLength(9);
  });

  it('reuses the merged-commit mapping while HEAD stays and rebuilds it once HEAD moves', async () => {
    const r = repoFixture();
    const range = {
      project_id: r.f.project.id,
      from: Date.now() - DAY,
      to: Date.now() + DAY,
      group: 'branch' as const,
    };
    const mainPoint = async () =>
      (await r.f.control.repoTimeline(user, range)).lanes[0]!.points!.find(
        (point) => point.sha === r.second,
      );
    expect(await mainPoint()).toEqual({ sha: r.second, at: expect.any(Number), kind: 'commit' });
    const other = r.f.store.insert<Session>('sessions', {
      id: id(),
      revision: 1,
      project_id: r.f.project.id,
      runtime: r.f.adapter.name,
      workspace_id: r.session.workspace_id!,
      state: 'open',
      turn_count: 0,
    });
    // Only a fresh rev-list over the merge records would see this merge.
    r.f.store.event('session.merged', other, r.f.project.id, {
      from_sha: r.first,
      to_sha: r.second,
    });
    expect((await mainPoint())!.session_id).toBeUndefined();
    git(r.f.source, 'commit', '--quiet', '-m', 'Staged answer line');
    expect((await mainPoint())!.session_id).toBe(other.id);
  });

  it('puts a commit in the workstream of a non-ASCII file it touches', async () => {
    const f = workbenchFixture();
    writeFileSync(path.join(f.source, '说明.md'), 'one\n');
    writeFileSync(path.join(f.source, 'notes.md'), 'one\n');
    git(f.source, 'add', '--all');
    git(f.source, 'commit', '--quiet', '-m', 'Add the notes');
    const sha = git(f.source, 'rev-parse', 'HEAD');
    f.store.insert<ProjectBaseline>('project_baselines', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      state: 'submitted',
      facts_id: 'facts',
      dropped: 0,
      created_at: f.store.now(),
      result: {
        folders: [],
        workstreams: [
          {
            id: 'docs',
            title: 'Docs',
            status: 'running',
            reason: '',
            items: [],
            commits: [],
            next: [],
            blockers: [],
            modules: ['说明.md'],
          },
        ],
        contradictions: [],
        findings: [],
        questions: [],
      },
    });
    const timeline = await f.control.repoTimeline(user, {
      project_id: f.project.id,
      from: Date.now() - DAY,
      to: Date.now() + DAY,
      group: 'workstream',
    });
    const docs = timeline.lanes.find((lane) => lane.key === 'docs');
    expect(docs?.points?.map((point) => point.sha)).toEqual([sha]);
  });

  it('lanes commits by git author, and the commits and span of a session under its runtime', async () => {
    const r = repoFixture();
    git(
      r.f.source,
      'commit',
      '--quiet',
      '--author=Ana Example <ana@example.invalid>',
      '-m',
      'Staged by Ana',
    );
    const ana = git(r.f.source, 'rev-parse', 'HEAD');
    const timeline = await r.f.control.repoTimeline(user, {
      project_id: r.f.project.id,
      from: Date.now() - DAY,
      to: Date.now() + DAY,
      group: 'author',
    });
    const laneOf = (key: string) => timeline.lanes.find((lane) => lane.key === key);
    const shas = (key: string) => laneOf(key)?.points?.map((point) => point.sha);
    expect(timeline.lanes[0]!.key).toBe('main');
    const runtime = `runtime:${r.f.adapter.name}`;
    expect(laneOf(runtime)).toMatchObject({
      kind: 'runtime',
      label: r.f.adapter.name,
      spans: [{ session_id: r.session.id }],
    });
    expect(shas(runtime)).toEqual([r.third]);
    expect(laneOf('author:Ana Example')).toMatchObject({ kind: 'author', label: 'Ana Example' });
    expect(shas('author:Ana Example')).toEqual([ana]);
    expect(shas('author:Workbench Fixture')).toContain(r.second);
    expect(shas('author:Workbench Fixture')).not.toContain(r.third);
  });

  it('groups by branch over a day or less and by workstream over longer when no grouping is given', async () => {
    const r = repoFixture();
    const now = Date.now();
    const read = (from: number, to: number) =>
      r.f.control.repoTimeline(user, { project_id: r.f.project.id, from, to });
    const short = await read(now - 12 * HOUR, now + 12 * HOUR);
    const long = await read(now - DAY, now + DAY);
    expect(short.lanes.every((lane) => Array.isArray(lane.turns))).toBe(true);
    expect(long.lanes.every((lane) => lane.turns === undefined)).toBe(true);
  });

  it('gives the times of the first and last commit of the whole history', async () => {
    const f = workbenchFixture();
    const start = Math.ceil(Date.now() / HOUR) * HOUR + HOUR;
    commitsAt(f.source, [start + 5 * HOUR, start]);
    const times = git(f.source, 'log', '--format=%ct', 'main')
      .split('\n')
      .map((time) => Number(time) * 1000);
    const timeline = await f.control.repoTimeline(user, {
      project_id: f.project.id,
      from: start - DAY,
      to: start + DAY,
    });
    expect(timeline.extent).toEqual({ first: Math.min(...times), last: start + 5 * HOUR });
  });

  it('takes no grouping, or workstream, branch or author, and refuses any other', () => {
    const schema = querySchemas['repo.timeline'];
    const range = { project_id: 'project', from: 1000, to: 2000 };
    expect(schema.safeParse(range).success).toBe(true);
    for (const group of ['workstream', 'branch', 'author'])
      expect(schema.safeParse({ ...range, group }).success).toBe(true);
    expect(schema.safeParse({ ...range, group: 'team' }).success).toBe(false);
  });

  it('refuses a range that does not end after it starts or spans more than 400 days', () => {
    const schema = querySchemas['repo.timeline'];
    const range = { project_id: 'project', group: 'branch' };
    expect(schema.safeParse({ ...range, from: 1000, to: 2000 }).success).toBe(true);
    expect(schema.safeParse({ ...range, from: 2000, to: 2000 }).success).toBe(false);
    expect(schema.safeParse({ ...range, from: 3000, to: 2000 }).success).toBe(false);
    expect(schema.safeParse({ ...range, from: 0, to: 400 * DAY + 1 }).success).toBe(false);
  });
});

describe('file blame and history', () => {
  it('blames each line to its commit and gives the lines a session worktree changes', async () => {
    const r = repoFixture();
    r.f.store.event('session.merged', r.session, r.f.project.id, {
      from_sha: r.first,
      to_sha: r.second,
    });
    writeFileSync(path.join(r.sessionTree, 'answer.txt'), 'base\nchanged\n');
    git(r.sessionTree, 'commit', '--quiet', '-am', 'Change the second line');
    const blame = await r.f.control.repoBlame(user, {
      project_id: r.f.project.id,
      path: 'answer.txt',
    });
    // The checkout's staged third line is not in the blamed commit.
    expect(blame).toMatchObject({
      path: 'answer.txt',
      sha: r.second,
      text: 'base\nsecond\n',
      truncated: false,
    });
    expect(blame.chunks).toEqual([
      { start: 1, count: 1, sha: r.first, author: 'Workbench Fixture', at: expect.any(Number) },
      {
        start: 2,
        count: 1,
        sha: r.second,
        author: 'Workbench Fixture',
        at: expect.any(Number),
        session_id: r.session.id,
      },
    ]);
    expect(blame.pending).toEqual([{ session_id: r.session.id, ranges: [{ start: 2, count: 1 }] }]);
  });

  it('moves the lines a session changes onto the blamed commit when main changed above them', async () => {
    const r = repoFixture();
    writeFileSync(path.join(r.sessionTree, 'answer.txt'), 'base\nchanged\n');
    git(r.sessionTree, 'commit', '--quiet', '-am', 'Change the second line');
    const above = Array.from({ length: 20 }, (_, index) => `top ${index}\n`).join('');
    writeFileSync(path.join(r.f.source, 'answer.txt'), `${above}base\nsecond\n`);
    git(r.f.source, 'commit', '--quiet', '-am', 'Add twenty lines on top');
    const blame = await r.f.control.repoBlame(user, {
      project_id: r.f.project.id,
      path: 'answer.txt',
    });
    expect(blame.pending).toEqual([
      { session_id: r.session.id, ranges: [{ start: 22, count: 1 }] },
    ]);
  });

  it('reads only the named file when its name holds pathspec characters', async () => {
    const r = repoFixture();
    writeFileSync(path.join(r.f.source, 'test[1].json'), '1\n');
    writeFileSync(path.join(r.f.source, 'test1.json'), '1\n');
    git(r.f.source, '--literal-pathspecs', 'add', 'test[1].json', 'test1.json');
    git(r.f.source, 'commit', '--quiet', '-m', 'Add both');
    writeFileSync(path.join(r.f.source, 'test1.json'), '2\n');
    git(r.f.source, 'commit', '--quiet', '-m', 'Change the other', '--', 'test1.json');
    writeFileSync(path.join(r.sessionTree, 'test1.json'), '3\n');
    git(r.sessionTree, 'add', 'test1.json');
    git(r.sessionTree, 'commit', '--quiet', '-m', 'Add the other in the session');
    const input = { project_id: r.f.project.id, path: 'test[1].json' };
    const history = await r.f.control.repoFileHistory(user, input);
    expect(history.changes.map((change) => change.subject)).toEqual(['Add both']);
    const blame = await r.f.control.repoBlame(user, input);
    expect(blame.text).toBe('1\n');
    expect(blame.pending).toEqual([]);
  });

  it('names a non-ASCII file changed together with this one as it is', async () => {
    const f = workbenchFixture();
    writeFileSync(path.join(f.source, '说明.md'), 'one\n');
    writeFileSync(path.join(f.source, 'notes.md'), 'one\n');
    git(f.source, 'add', '--all');
    git(f.source, 'commit', '--quiet', '-m', 'Add the notes');
    const history = await f.control.repoFileHistory(user, {
      project_id: f.project.id,
      path: 'notes.md',
    });
    expect(history.cochange).toEqual([{ path: '说明.md', together: 1 }]);
  });

  it.each(['../x', '/etc/passwd', '-x'])('refuses the path %s', async (file) => {
    const r = repoFixture();
    await expect(
      r.f.control.repoBlame(user, { project_id: r.f.project.id, path: file }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      r.f.control.repoFileHistory(user, { project_id: r.f.project.id, path: file }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('lists the commits that changed a file, its weekly counts and the files changed with it', async () => {
    const f = workbenchFixture();
    const commit = (files: Record<string, string>, message: string) => {
      for (const [name, content] of Object.entries(files))
        writeFileSync(path.join(f.source, name), content);
      git(f.source, 'add', '--all');
      git(f.source, 'commit', '--quiet', '-m', message);
    };
    commit({ 'a.txt': '1\n', 'b.txt': '1\n' }, 'One');
    commit({ 'a.txt': '2\n', 'b.txt': '2\n', 'c.txt': '2\n' }, 'Two');
    commit({ 'c.txt': '3\n' }, 'Three');
    commit({ 'a.txt': '4\n', 'b.txt': '4\n' }, 'Four');
    const history = await f.control.repoFileHistory(user, {
      project_id: f.project.id,
      path: 'a.txt',
    });
    expect(history.changes.map((change) => change.subject)).toEqual(['Four', 'Two', 'One']);
    expect(history.changes[0]).toMatchObject({
      author: 'Workbench Fixture',
      refs: ['HEAD -> main'],
    });
    expect(history.cochange).toEqual([
      { path: 'b.txt', together: 3 },
      { path: 'c.txt', together: 1 },
    ]);
    expect(history.scanned).toBe(5);
    expect(history.weekly).toHaveLength(26);
    expect(history.weekly.at(-1)!.count).toBe(3);
    expect(history.weekly.reduce((sum, week) => sum + week.count, 0)).toBe(3);
  });
});
