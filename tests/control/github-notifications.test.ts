import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ExternalEvent, Project } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import {
  ghApi,
  githubSource,
  type GithubGet,
  type GithubResponse,
} from '../../packages/control/dist/github-notifications.js';
import { pollExternalSources } from '../../packages/control/dist/external-sources.js';
import { fixture } from '../helpers.js';
import { createVirtualClock } from '../acceptance/lib/clock.mjs';

const MINUTE = 60_000,
  API = 'https://api.github.com/repos/acme/reports',
  LIST = 'notifications?participating=true';

const ok = (body: unknown, headers: Record<string, string> = {}): GithubResponse => ({
  status: 200,
  headers,
  body,
});
const person = (login: string, type = 'User') => ({ login, type });

function notification(fields: Record<string, unknown> = {}) {
  return {
    id: '501',
    reason: 'assign',
    updated_at: '2026-11-14T08:00:00Z',
    repository: { full_name: 'acme/reports', private: true },
    subject: { type: 'Issue', url: `${API}/issues/12`, latest_comment_url: `${API}/issues/12` },
    ...fields,
  };
}

/** A project on github.com/acme/reports and a GitHub that answers taylor from the replies map. */
async function githubFixture(mode: 'approve' | 'auto' | null = 'approve') {
  const clock = createVirtualClock(1700000000000),
    requests: { path: string; headers: Record<string, string> }[] = [],
    replies = new Map<string, GithubResponse>();
  const get: GithubGet = async (path, headers = {}) => {
    requests.push({ path, headers });
    const reply = replies.get(path);
    if (!reply) throw new Error(`No reply for ${path}`);
    if (reply.headers.etag && headers['if-none-match'] === reply.headers.etag)
      return { status: 304, headers: { 'x-poll-interval': '60' }, body: null };
    return reply;
  };
  const f = await fixture({
      now: clock.now,
      controlOptions: { externalSources: [githubSource(get)] },
    }),
    ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  execFileSync('git', ['init', '-q'], { cwd: f.projectRoot });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/reports.git'], {
    cwd: f.projectRoot,
  });
  if (mode)
    f.call('project.externalEvents.set', { project_id: f.project.id, mode }, f.project.revision);
  replies.set('user', ok(person('taylor')));
  /** The notification list, and an issue 12 taylor wrote and assigned to themself. */
  const list = (items: unknown[], etag = '"v1"') =>
    replies.set(LIST, ok(items, { etag, 'x-poll-interval': '60' }));
  const issue = (author = person('taylor'), comments: unknown[] = []) => {
    replies.set(
      `${API}/issues/12`,
      ok({
        number: 12,
        title: 'Totals are wrong',
        body: 'The weekly total counts refunds twice.',
        html_url: 'https://github.com/acme/reports/issues/12',
        user: author,
        comments_url: `${API}/issues/12/comments`,
      }),
    );
    replies.set(`${API}/issues/12/comments?per_page=100`, ok(comments));
  };
  list([notification()]);
  issue();
  replies.set(
    'repos/acme/reports/issues/12/events?per_page=100',
    ok([{ event: 'assigned', assignee: person('taylor'), assigner: person('taylor') }]),
  );
  return {
    ...f,
    clock,
    requests,
    replies,
    list,
    issue,
    poll: () => pollExternalSources(ctx),
    stored: () => f.store.list<ExternalEvent>('external_events'),
  };
}

it('reports an issue the user assigned to themself as a pending event of the project', async () => {
  const f = await githubFixture();
  try {
    await f.poll();
    expect(f.stored()).toMatchObject([
      {
        project_id: f.project.id,
        source: 'github',
        subject_key: 'github:acme/reports#12',
        kind: 'issue_assigned',
        actor: 'taylor',
        actor_trust: 'self',
        title: 'Totals are wrong',
        url: 'https://github.com/acme/reports/issues/12',
        texts: [
          {
            author: 'taylor',
            own: true,
            text: 'Totals are wrong\n\nThe weekly total counts refunds twice.',
          },
        ],
        state: 'pending',
      },
    ]);
  } finally {
    await f.close();
  }
});

it('asks again with the entity tag once the poll interval passed, and a 304 answer stores nothing', async () => {
  const f = await githubFixture();
  try {
    await f.poll();
    const asked = f.requests.length;
    f.clock.advance(MINUTE / 2);
    await f.poll();
    expect(f.requests).toHaveLength(asked);
    f.replies.set(LIST, { status: 304, headers: { 'x-poll-interval': '60' }, body: null });
    f.clock.advance(MINUTE / 2);
    await f.poll();
    expect(f.requests.slice(asked)).toEqual([{ path: LIST, headers: { 'if-none-match': '"v1"' } }]);
    expect(f.stored()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('reads the issue of a notification once', async () => {
  const f = await githubFixture();
  try {
    await f.poll();
    const asked = f.requests.length;
    f.list([notification(), notification({ id: '777', reason: 'subscribed' })], '"v2"');
    f.clock.advance(MINUTE);
    await f.poll();
    expect(f.requests.slice(asked).map((request) => request.path)).toEqual([LIST, 'user']);
  } finally {
    await f.close();
  }
});

it('asks GitHub nothing while no project takes external events', async () => {
  const f = await githubFixture(null);
  try {
    await f.poll();
    expect(f.requests).toEqual([]);
  } finally {
    await f.close();
  }
});

it('skips a notification about a repository no project has', async () => {
  const f = await githubFixture();
  try {
    f.list([notification({ repository: { full_name: 'acme/other', private: false } })]);
    await f.poll();
    expect(f.requests.map((request) => request.path)).toEqual([LIST, 'user']);
    expect(f.stored()).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each([
  {
    who: 'someone who may write',
    author: person('robin'),
    permission: ok({ permission: 'write' }),
    trust: 'write',
    state: 'pending',
  },
  {
    who: 'someone who may only read',
    author: person('robin'),
    permission: ok({ permission: 'read' }),
    trust: 'other',
    state: 'dropped',
  },
  {
    who: 'someone whose permission GitHub does not tell',
    author: person('robin'),
    permission: { status: 403, headers: {}, body: {} },
    trust: 'other',
    state: 'dropped',
  },
  {
    who: 'a bot',
    author: person('robin', 'Bot'),
    permission: undefined,
    trust: 'bot',
    state: 'dropped',
  },
] as const)('a mention by $who is $state', async ({ author, permission, trust, state }) => {
  const f = await githubFixture();
  try {
    f.list([
      notification({
        reason: 'mention',
        subject: {
          type: 'Issue',
          url: `${API}/issues/12`,
          latest_comment_url: `${API}/issues/comments/9911`,
        },
      }),
    ]);
    f.issue(person('taylor'), [{ user: author, body: '@taylor see this' }]);
    f.replies.set(`${API}/issues/comments/9911`, ok({ user: author }));
    if (permission) f.replies.set('repos/acme/reports/collaborators/robin/permission', permission);
    await f.poll();
    expect(f.stored()).toMatchObject([
      {
        kind: 'mention',
        actor: 'robin',
        actor_trust: trust,
        texts: [{ author: 'taylor' }, { author: 'robin', own: false, text: '@taylor see this' }],
        state,
      },
    ]);
  } finally {
    await f.close();
  }
});

it('keeps the text of the issue and of each comment with who wrote it', async () => {
  const f = await githubFixture();
  try {
    f.issue(person('sam'), [
      { user: person('robin'), body: 'Same here.' },
      { user: person('taylor'), body: 'I will take it.' },
      { user: null, body: 'Me too.' },
    ]);
    await f.poll();
    expect(f.stored()[0]!.texts.map(({ author, own }) => [author, own])).toEqual([
      ['sam', false],
      ['robin', false],
      ['taylor', true],
      ['ghost', false],
    ]);
  } finally {
    await f.close();
  }
});

it('reports a review request under the pull request number', async () => {
  const f = await githubFixture();
  try {
    f.list([
      notification({
        reason: 'review_requested',
        subject: { type: 'PullRequest', url: `${API}/pulls/12`, latest_comment_url: null },
      }),
    ]);
    f.replies.set(
      `${API}/pulls/12`,
      ok({
        number: 12,
        title: 'Fix totals',
        body: null,
        html_url: 'https://github.com/acme/reports/pull/12',
        user: person('robin'),
        comments_url: `${API}/issues/12/comments`,
      }),
    );
    f.replies.set(
      'repos/acme/reports/issues/12/events?per_page=100',
      ok([
        {
          event: 'review_requested',
          requested_reviewer: person('sam'),
          review_requester: person('sam'),
        },
        {
          event: 'review_requested',
          requested_reviewer: person('taylor'),
          review_requester: person('robin'),
        },
      ]),
    );
    f.replies.set('repos/acme/reports/collaborators/robin/permission', ok({ permission: 'admin' }));
    await f.poll();
    expect(f.stored()).toMatchObject([
      {
        subject_key: 'github:acme/reports#12',
        kind: 'review_requested',
        actor: 'robin',
        actor_trust: 'write',
        texts: [{ author: 'robin', own: false, text: 'Fix totals' }],
      },
    ]);
  } finally {
    await f.close();
  }
});

it('lets only the user set how a project takes external events, and stores off as its own value', async () => {
  const f = await githubFixture('auto');
  try {
    const project = () => f.store.must<Project>('projects', f.project.id);
    expect(project().external_events).toBe('auto');
    expect(() =>
      f.call(
        'project.externalEvents.set',
        { project_id: f.project.id, mode: 'approve' },
        project().revision,
        { id: 'writer-session', role: 'writer' },
      ),
    ).toThrow('Only user');
    f.call(
      'project.externalEvents.set',
      { project_id: f.project.id, mode: 'off' },
      project().revision,
    );
    expect(project().external_events).toBe('off');
  } finally {
    await f.close();
  }
});

it('reads the account again after gh answers for another one', async () => {
  const f = await githubFixture('auto');
  try {
    await f.poll();
    f.replies.set('user', ok(person('robin')));
    f.list(
      [
        notification({
          id: '502',
          reason: 'mention',
          subject: {
            type: 'Issue',
            url: `${API}/issues/13`,
            latest_comment_url: `${API}/issues/13`,
          },
        }),
      ],
      '"v2"',
    );
    f.replies.set(
      `${API}/issues/13`,
      ok({
        number: 13,
        title: 'Export is slow',
        body: '@robin please look',
        html_url: 'https://github.com/acme/reports/issues/13',
        user: person('taylor'),
        comments_url: `${API}/issues/13/comments`,
      }),
    );
    f.replies.set(`${API}/issues/13/comments?per_page=100`, ok([]));
    f.replies.set('repos/acme/reports/collaborators/taylor/permission', ok({ permission: 'read' }));
    f.clock.advance(MINUTE);
    await f.poll();
    expect(
      f.stored().find((event) => event.subject_key === 'github:acme/reports#13'),
    ).toMatchObject({
      actor: 'taylor',
      actor_trust: 'other',
      state: 'dropped',
      texts: [{ author: 'taylor', own: false }],
    });
  } finally {
    await f.close();
  }
});

const next = (url: string) => ({ link: `<${url}>; rel="next", <${url}>; rel="last"` });

it('follows the next page of the notification list', async () => {
  const f = await githubFixture();
  try {
    f.replies.set(
      LIST,
      ok([notification({ id: '777', reason: 'subscribed' })], {
        etag: '"v1"',
        'x-poll-interval': '60',
        ...next('https://api.github.com/notifications?page=2'),
      }),
    );
    f.replies.set('https://api.github.com/notifications?page=2', ok([notification()]));
    await f.poll();
    expect(f.stored()).toMatchObject([{ subject_key: 'github:acme/reports#12', state: 'pending' }]);
  } finally {
    await f.close();
  }
});

it('follows the next pages of the comments and of the issue events', async () => {
  const f = await githubFixture();
  try {
    f.replies.set(
      `${API}/issues/12/comments?per_page=100`,
      ok([{ user: person('robin'), body: 'Same here.' }], next(`${API}/issues/12/comments?page=2`)),
    );
    f.replies.set(
      `${API}/issues/12/comments?page=2`,
      ok([{ user: person('taylor'), body: 'I will take it.' }]),
    );
    f.replies.set(
      'repos/acme/reports/issues/12/events?per_page=100',
      ok(
        Array.from({ length: 100 }, () => ({ event: 'labeled' })),
        next(`${API}/issues/12/events?page=2`),
      ),
    );
    f.replies.set(
      `${API}/issues/12/events?page=2`,
      ok([{ event: 'assigned', assignee: person('taylor'), assigner: person('taylor') }]),
    );
    await f.poll();
    expect(f.stored()).toMatchObject([
      {
        subject_key: 'github:acme/reports#12',
        actor: 'taylor',
        actor_trust: 'self',
        state: 'pending',
        texts: [
          { author: 'taylor' },
          { author: 'robin' },
          { author: 'taylor', text: 'I will take it.' },
        ],
      },
    ]);
  } finally {
    await f.close();
  }
});

it('reads the whole notification list again once another repository takes external events', async () => {
  const f = await githubFixture();
  try {
    const otherRoot = path.join(f.root, 'other');
    mkdirSync(otherRoot);
    execFileSync('git', ['init', '-q'], { cwd: otherRoot });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/other.git'], {
      cwd: otherRoot,
    });
    const other = await f.call<Project>('project.open', { name: 'other', roots: [otherRoot] }),
      OTHER = 'https://api.github.com/repos/acme/other';
    f.list([
      notification({
        repository: { full_name: 'acme/other', private: false },
        subject: { type: 'Issue', url: `${OTHER}/issues/12`, latest_comment_url: null },
      }),
    ]);
    f.replies.set(
      `${OTHER}/issues/12`,
      ok({
        number: 12,
        title: 'Totals are wrong',
        body: null,
        html_url: 'https://github.com/acme/other/issues/12',
        user: person('taylor'),
        comments_url: `${OTHER}/issues/12/comments`,
      }),
    );
    f.replies.set(`${OTHER}/issues/12/comments?per_page=100`, ok([]));
    f.replies.set(
      'repos/acme/other/issues/12/events?per_page=100',
      ok([{ event: 'assigned', assignee: person('taylor'), assigner: person('taylor') }]),
    );
    await f.poll();
    expect(f.stored()).toEqual([]);
    f.call('project.externalEvents.set', { project_id: other.id, mode: 'approve' }, other.revision);
    const asked = f.requests.length;
    f.clock.advance(MINUTE);
    await f.poll();
    expect(f.requests[asked]).toEqual({ path: LIST, headers: {} });
    expect(f.stored()).toMatchObject([
      { project_id: other.id, subject_key: 'github:acme/other#12', state: 'pending' },
    ]);
  } finally {
    await f.close();
  }
});

it('rejects a response whose body is cut off', async () => {
  const bin = mkdtempSync(path.join(os.tmpdir(), 'pantheon-gh-')),
    PATH = process.env.PATH;
  try {
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/bin/sh\nprintf 'HTTP/2.0 200 OK\\r\\ncontent-type: application/json\\r\\n\\r\\n[{"id":'\n`,
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${PATH}`;
    await expect(ghApi('notifications')).rejects.toThrow('notifications');
  } finally {
    process.env.PATH = PATH;
    rmSync(bin, { recursive: true, force: true });
  }
});
