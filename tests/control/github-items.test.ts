import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { id, type Session, type Workspace } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';
import { git } from './workbench-fixture.js';
import type { LocalCommand } from '../../packages/control/src/local-command.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});
const auth = {
  hosts: {
    'github.com': [
      { state: 'success', active: true, host: 'github.com', login: 'owner', scopes: 'repo' },
    ],
  },
};
async function setup(remote = 'git@github.com:owner/project.git') {
  let items: unknown = [],
    detail: unknown = {},
    threads: unknown = {};
  let authResult = { stdout: JSON.stringify(auth), stderr: '', exit_code: 0 };
  const run: LocalCommand = vi.fn(async (_file, args) =>
    args[0] === 'auth'
      ? authResult
      : {
          stdout: JSON.stringify(args[0] === 'api' ? threads : args[1] === 'view' ? detail : items),
          stderr: '',
          exit_code: 0,
        },
  );
  const f = await fixture({ controlOptions: { localCommand: run, externalSources: [] } });
  cleanups.push(() => f.close());
  execFileSync('git', ['init', '-q'], { cwd: f.projectRoot });
  if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: f.projectRoot });
  return {
    ...f,
    run,
    setItems: (next: unknown) => {
      items = next;
    },
    setAuth: (next: typeof authResult) => {
      authResult = next;
    },
    setDetail: (next: unknown) => {
      detail = next;
    },
    setThreads: (next: unknown) => {
      threads = next;
    },
  };
}
/** A session whose worktree is on pt/feature, and one without a worktree that opened pull request 7. */
function pullSessions(f: Awaited<ReturnType<typeof setup>>) {
  git(f.projectRoot, 'commit', '--quiet', '--allow-empty', '-m', 'Start');
  const tree = path.join(f.root, 'feature-tree');
  git(f.projectRoot, 'worktree', 'add', '--quiet', '-b', 'pt/feature', tree);
  const workspace = f.store.insert<Workspace>('workspaces', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    kind: 'linked_worktree',
    path: realpathSync(tree),
    source: realpathSync(f.projectRoot),
    owner: 'none',
    ownership_epoch: 0,
  });
  const session = (workspace_id?: string) =>
    f.store.insert<Session>('sessions', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      ...(workspace_id ? { workspace_id } : {}),
      state: 'open',
      turn_count: 0,
    });
  const onBranch = session(workspace.id),
    opener = session();
  f.store.event('session.pr_created', opener, f.project.id, {
    number: 7,
    url: 'https://github.com/owner/project/pull/7',
  });
  return { onBranch, opener };
}
const item = (number: number, updatedAt: string, extra = {}) => ({
  number,
  title: `Item ${number}`,
  url: `https://github.com/owner/project/pull/${number}`,
  state: 'OPEN',
  author: { login: 'writer' },
  updatedAt,
  ...extra,
});

it('lists open pull requests by latest update and summarizes their checks', async () => {
  const f = await setup();
  f.setItems([
    item(1, '2026-11-12T00:00:00Z', {
      statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }],
    }),
    item(2, '2026-11-14T00:00:00Z', { statusCheckRollup: [{ state: 'FAILURE' }] }),
    item(3, '2026-11-13T00:00:00Z', {
      statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }],
    }),
  ]);
  const result = await f.control.githubItems(user, f.project.id, 'pr');
  expect(result.repo).toBe('owner/project');
  expect(result.items.map(({ number, checks }) => ({ number, checks }))).toEqual([
    { number: 2, checks: 'failing' },
    { number: 3, checks: 'pending' },
    { number: 1, checks: 'passing' },
  ]);
  expect(result.items[0]).toMatchObject({
    state: 'open',
    author: 'writer',
    updated_at: '2026-11-14T00:00:00Z',
  });
  expect(f.run).toHaveBeenCalledWith(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      'github.com/owner/project',
      '--state',
      'open',
      '--limit',
      '30',
      '--search',
      'sort:updated-desc',
      '--json',
      'number,title,url,state,author,updatedAt,statusCheckRollup,reviewDecision,headRefName',
    ],
    realpathSync(f.projectRoot),
    60_000,
  );
});

it('keeps issue and pull request caches separate and expires them after sixty seconds', async () => {
  const f = await setup();
  let now = Date.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  f.setItems([item(1, '2026-11-14T00:00:00Z')]);
  expect((await f.control.githubItems(user, f.project.id, 'issue')).items[0]).not.toHaveProperty(
    'checks',
  );
  f.setItems([]);
  expect((await f.control.githubItems(user, f.project.id, 'issue')).items).toHaveLength(1);
  expect((await f.control.githubItems(user, f.project.id, 'pr')).items).toEqual([]);
  now += 60_000;
  expect((await f.control.githubItems(user, f.project.id, 'issue')).items).toEqual([]);
});

it('returns no repository without an eligible origin and accepts the signed-in enterprise host', async () => {
  for (const remote of ['', 'https://gitlab.com/owner/project.git']) {
    const f = await setup(remote);
    expect(await f.control.githubItems(user, f.project.id, 'issue')).toEqual({
      repo: null,
      items: [],
    });
  }
  const f = await setup('ssh://git@github.company/owner/project.git');
  f.setAuth({
    stdout: JSON.stringify({
      hosts: {
        'github.company': [{ ...auth.hosts['github.com'][0], host: 'github.company' }],
      },
    }),
    stderr: '',
    exit_code: 0,
  });
  expect((await f.control.githubItems(user, f.project.id, 'issue')).repo).toBe('owner/project');
});

it.each(['missing', 'timeout', 'signed_out'] as const)(
  'fails the query when gh is %s',
  async (state) => {
    const run: LocalCommand = async () => ({
      stdout: '',
      stderr: state,
      exit_code: 1,
      missing: state === 'missing',
      timed_out: state === 'timeout',
    });
    const f = await fixture({ controlOptions: { localCommand: run, externalSources: [] } });
    cleanups.push(() => f.close());
    execFileSync('git', ['init', '-q'], { cwd: f.projectRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], {
      cwd: f.projectRoot,
    });
    await expect(f.control.githubItems(user, f.project.id, 'pr')).rejects.toMatchObject({
      code: 'connection_check_failed',
    });
  },
);

it('rejects malformed GitHub output at the JSON boundary', async () => {
  const f = await setup();
  f.setItems([{ number: 'not a number' }]);
  await expect(f.control.githubItems(user, f.project.id, 'pr')).rejects.toThrow();
});

it('caps the list at thirty and omits absent authors and unconfigured checks', async () => {
  const f = await setup();
  f.setItems(
    Array.from({ length: 35 }, (_, index) =>
      item(index + 1, '2026-11-14T00:00:00Z', { author: null, statusCheckRollup: [] }),
    ),
  );
  const result = await f.control.githubItems(user, f.project.id, 'pr');
  expect(result.items).toHaveLength(30);
  expect(result.items[0]).not.toHaveProperty('author');
  expect(result.items[0]).not.toHaveProperty('checks');
});

it('adds check counts, the review decision, the head branch and the session to each pull request', async () => {
  const f = await setup();
  const { onBranch, opener } = pullSessions(f);
  f.setItems([
    item(7, '2026-11-14T00:00:00Z', {
      headRefName: 'pt/other',
      reviewDecision: 'APPROVED',
      statusCheckRollup: [
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
      ],
    }),
    item(8, '2026-11-13T00:00:00Z', {
      headRefName: 'pt/feature',
      reviewDecision: 'CHANGES_REQUESTED',
      statusCheckRollup: [
        { state: 'SUCCESS' },
        { state: 'PENDING' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
    }),
    item(9, '2026-11-12T00:00:00Z', {
      headRefName: 'pt/unknown',
      reviewDecision: '',
      statusCheckRollup: [],
    }),
  ]);
  const result = await f.control.githubItems(user, f.project.id, 'pr');
  expect(result.items).toEqual([
    expect.objectContaining({
      number: 7,
      checks_passed: 1,
      checks_total: 2,
      review_decision: 'approved',
      head: 'pt/other',
      session_id: opener.id,
    }),
    expect.objectContaining({
      number: 8,
      checks_passed: 1,
      checks_total: 3,
      review_decision: 'changes_requested',
      head: 'pt/feature',
      session_id: onBranch.id,
    }),
    expect.objectContaining({ number: 9, head: 'pt/unknown' }),
  ]);
  for (const field of ['checks_total', 'review_decision', 'session_id'])
    expect(result.items[2]).not.toHaveProperty(field);
});

it('reads one pull request with mapped checks, unresolved review threads first and the session on its branch', async () => {
  const f = await setup();
  const { onBranch } = pullSessions(f);
  const url = 'https://github.com/owner/project/pull/8';
  f.setDetail({
    number: 8,
    title: 'Tolerate clock skew',
    url,
    state: 'OPEN',
    reviewDecision: 'CHANGES_REQUESTED',
    headRefName: 'pt/feature',
    baseRefName: 'main',
    additions: 96,
    deletions: 8,
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'unit-tests',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        startedAt: '2026-11-14T00:00:00Z',
        completedAt: '2026-11-14T00:02:40Z',
        detailsUrl: 'https://ci.example/unit',
      },
      {
        __typename: 'CheckRun',
        name: 'e2e',
        status: 'IN_PROGRESS',
        conclusion: '',
        startedAt: '2026-11-14T00:00:00Z',
        completedAt: '0001-01-01T00:00:00Z',
        detailsUrl: 'https://ci.example/e2e',
      },
      {
        __typename: 'CheckRun',
        name: 'docs',
        status: 'COMPLETED',
        conclusion: 'SKIPPED',
        startedAt: '2026-11-14T00:00:00Z',
        completedAt: '2026-11-14T00:00:01Z',
        detailsUrl: '',
      },
      {
        __typename: 'StatusContext',
        context: 'build',
        state: 'SUCCESS',
        startedAt: '2026-11-14T00:00:00Z',
        targetUrl: 'https://ci.example/build',
      },
    ],
  });
  const thread = (
    isResolved: boolean,
    path: string,
    line: number | null,
    login: string | null,
    body: string,
  ) => ({
    isResolved,
    path,
    line,
    comments: { nodes: [{ author: login ? { login } : null, body }] },
  });
  f.setThreads({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              thread(true, 'fixtures/webhook.ts', 4, 'kai', 'Use a placeholder key.'),
              thread(false, 'signature.ts', 18, 'mei', 'Make the skew configurable.'),
              thread(false, 'old.ts', null, null, 'Outdated remark.'),
            ],
          },
        },
      },
    },
  });
  expect(await f.control.githubPullDetail(user, f.project.id, 8)).toEqual({
    number: 8,
    title: 'Tolerate clock skew',
    url,
    state: 'open',
    review_decision: 'changes_requested',
    head: 'pt/feature',
    base: 'main',
    additions: 96,
    deletions: 8,
    session_id: onBranch.id,
    checks: [
      { name: 'unit-tests', state: 'failed', duration_ms: 160_000, url: 'https://ci.example/unit' },
      { name: 'e2e', state: 'running', duration_ms: null, url: 'https://ci.example/e2e' },
      { name: 'docs', state: 'skipped', duration_ms: 1000, url: null },
      { name: 'build', state: 'passed', duration_ms: null, url: 'https://ci.example/build' },
    ],
    threads: [
      {
        path: 'signature.ts',
        line: 18,
        author: 'mei',
        body: 'Make the skew configurable.',
        resolved: false,
      },
      { path: 'old.ts', line: null, author: '', body: 'Outdated remark.', resolved: false },
      {
        path: 'fixtures/webhook.ts',
        line: 4,
        author: 'kai',
        body: 'Use a placeholder key.',
        resolved: true,
      },
    ],
  });
  expect(f.run).toHaveBeenCalledWith(
    'gh',
    expect.arrayContaining(['api', 'graphql', '--hostname', 'github.com', 'number=8']),
    realpathSync(f.projectRoot),
    60_000,
  );
  const calls = vi.mocked(f.run).mock.calls.length;
  await f.control.githubPullDetail(user, f.project.id, 8);
  expect(f.run).toHaveBeenCalledTimes(calls);
});

it('refuses the pull request detail without a GitHub repository', async () => {
  const f = await setup('');
  await expect(f.control.githubPullDetail(user, f.project.id, 8)).rejects.toMatchObject({
    code: 'invalid_input',
  });
});
