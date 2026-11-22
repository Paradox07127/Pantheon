import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchSession } from '@pantheon/protocol';
import {
  groupWorkbenchSessions,
  keepOrder,
  onlyWaiting,
  readSessionView,
  sidebarGroups,
  treeDepths,
  treeLines,
  unfoldEntered,
  type SessionListView,
} from '@/screens/sessions/model';
import { SessionListRow } from '@/screens/sessions/SessionsScreen';
import { SessionPreview } from '@/screens/sessions/SessionRow';
import { sessionStateLabel } from '@/components/SessionStateIcon';
import { zh } from './i18n-setup.js';

const group = (key: string) => zh(`sessions.model.group.${key}`);
const badge = (key: string) => zh(`sessions.row.badge.${key}`);
const fact = (key: string) => zh(`sessions.row.preview.${key}`);

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

const session = (
  id: string,
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
  id,
  created_at: at(0),
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: at(0),
  changes: null,
  merge: null,
  ...extra,
});

beforeAll(() => vi.stubGlobal('navigator', { userAgent: 'Macintosh' }));
afterAll(() => vi.unstubAllGlobals());

const ids = (list: readonly { session: WorkbenchSession }[]) => list.map((row) => row.session.id);
const view = (extra: Partial<SessionListView> = {}): SessionListView => ({
  grouping: 'state',
  sort: 'activity',
  archived: false,
  ...extra,
});

describe('session list groups by state', () => {
  const list = [
    session('idle', 'idle'),
    session('failed', 'failed'),
    session('gate-failed', 'ready', {
      gate: { state: 'failed', passed: 0, failed: 0, running: 0, finished_at: at(0) },
    }),
    session('blocked', 'ready', { merge: { state: 'blocked', reason: 'local_changes' } }),
    session('pinned-failed', 'failed', { pinned_at: at(0) }),
    session('archived-pinned', 'idle', { pinned_at: at(0), archived_at: at(0) }),
    session('waiting', 'waiting', { waiting: 1, waiting_kind: 'approval' }),
    session('reconciling', 'idle', { reconciling: true }),
    session('starting', 'starting'),
    session('running', 'running'),
    session('merging', 'merging'),
    session('stopping', 'idle', { stopping: true }),
    session('ready', 'ready'),
    session('merged', 'merged'),
    session('discarded', 'discarded'),
    session('done', 'done'),
  ];

  it('puts each session in the first group it qualifies for, in group order', () => {
    expect(
      groupWorkbenchSessions(list).map((g) => [
        g.key,
        g.label,
        g.folded,
        ids(g.sessions.map((s) => ({ session: s }))),
      ]),
    ).toEqual([
      [
        'waiting',
        group('waiting'),
        false,
        ['pinned-failed', 'failed', 'gate-failed', 'blocked', 'waiting', 'reconciling'],
      ],
      ['working', group('working'), false, ['starting', 'running', 'merging', 'stopping']],
      ['review', group('review'), false, ['ready']],
      ['merged', group('merged'), true, ['merged']],
      ['ended', group('ended'), true, ['idle', 'discarded', 'done']],
      ['archived', group('archived'), true, ['archived-pinned']],
    ]);
  });

  it('lists the pinned first, and the archived only when the view shows them', () => {
    const groups = (archived: boolean) =>
      sidebarGroups(list, view({ archived })).map((g) => [g.key, g.folded, ids(g.rows)]);
    expect(groups(false)[0]).toEqual(['pinned', false, ['pinned-failed']]);
    expect(groups(false).map(([key]) => key)).toEqual([
      'pinned',
      'waiting',
      'working',
      'review',
      'merged',
      'ended',
    ]);
    expect(groups(true).at(-1)).toEqual(['archived', true, ['archived-pinned']]);
  });

  it('leaves an ended session with an old failed gate among the ended', () => {
    const gate = { state: 'failed', passed: 0, failed: 0, running: 0, finished_at: at(0) } as const;
    const groups = groupWorkbenchSessions([
      session('merged', 'merged', { gate }),
      session('done', 'done', { gate }),
    ]);
    expect(groups.map((g) => [g.key, g.sessions.map((s) => s.id)])).toEqual([
      ['merged', ['merged']],
      ['ended', ['done']],
    ]);
  });

  it('lists no session twice', () => {
    const shown = groupWorkbenchSessions(list).flatMap((g) => g.sessions.map((s) => s.id));
    expect(shown).toHaveLength(list.length);
    expect(new Set(shown).size).toBe(list.length);
  });
});

describe('session order inside a group', () => {
  const list = [
    session('b', 'running', { title: 'Beta', created_at: at(2), last_activity_at: at(5) }),
    session('a', 'running', { title: 'alpha', created_at: at(1), last_activity_at: at(9) }),
    session('c', 'running', { title: 'Gamma', created_at: at(3), last_activity_at: at(7) }),
  ];
  const order = (sort?: 'activity' | 'created' | 'title') =>
    ids(sidebarGroups(list, view({ sort: sort ?? 'activity' }))[0]!.rows);

  it('puts the newest activity first by default', () => {
    expect(order()).toEqual(['a', 'c', 'b']);
    expect(groupWorkbenchSessions(list)[0]!.sessions.map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts by title or by creation time, newest first', () => {
    expect(order('title')).toEqual(['a', 'b', 'c']);
    expect(order('created')).toEqual(['c', 'b', 'a']);
  });

  it('sorts the sessions forked from one session the same way', () => {
    const tasks = [
      session('lead', 'idle'),
      session('old', 'running', { forked_from: { session_id: 'lead' }, last_activity_at: at(1) }),
      session('new', 'running', { forked_from: { session_id: 'lead' }, last_activity_at: at(4) }),
    ];
    const [group] = sidebarGroups(tasks, view({ grouping: 'lead' }));
    expect(group!.rows.map((r) => [r.session.id, r.children.map((c) => c.id)])).toEqual([
      ['lead', ['new', 'old']],
    ]);
  });
});

describe('session list grouped by origin', () => {
  const list = [
    session('alone', 'idle', { last_activity_at: at(3) }),
    session('lead', 'idle', { title: 'Lead', last_activity_at: at(1) }),
    session('task', 'running', { forked_from: { session_id: 'lead' }, last_activity_at: at(2) }),
    session('review', 'running', { forked_from: { session_id: 'task' }, last_activity_at: at(1) }),
    session('fork', 'failed', { forked_from: { session_id: 'lead' }, last_activity_at: at(0) }),
    session('orphan', 'running', { forked_from: { session_id: 'gone' }, last_activity_at: at(4) }),
    session('merged', 'merged', { last_activity_at: at(5) }),
    session('shelved', 'merged', { archived_at: at(0) }),
  ];

  it('lists trees of who forked whom without a header, then the finished ones folded', () => {
    expect(
      sidebarGroups(list, view({ grouping: 'lead' })).map((g) => [
        g.key,
        g.label,
        g.folded,
        g.bare ?? false,
        g.rows.map((r) => [r.session.id, r.children.map((c) => c.id)]),
      ]),
    ).toEqual([
      [
        'tree',
        '',
        false,
        true,
        [
          ['orphan', []],
          ['alone', []],
          ['lead', ['task', 'review', 'fork']],
        ],
      ],
      ['ended', group('ended'), true, false, [['merged', []]]],
    ]);
  });

  it('adds the archived last when the view shows them', () => {
    const groups = sidebarGroups(list, view({ grouping: 'lead', archived: true }));
    expect(groups.at(-1)!.key).toBe('archived');
    expect(ids(groups.at(-1)!.rows)).toEqual(['shelved']);
  });

  it('draws each child at its depth, the line going on while a sibling follows', () => {
    const row = sidebarGroups(list, view({ grouping: 'lead' }))[0]!.rows[2]!;
    expect(treeDepths(row)).toEqual([1, 2, 1]);
    expect(treeLines([1, 2, 1])).toEqual([['more'], ['pass', 'end'], ['end']]);
    expect(treeLines([1, 2, 2, 1, 2])).toEqual([
      ['more'],
      ['pass', 'more'],
      ['pass', 'end'],
      ['end'],
      ['gap', 'end'],
    ]);
  });
});

describe('session list grouped by time', () => {
  const now = new Date(2026, 0, 10, 15, 0).getTime();
  const local = (day: number, hour = 9) => new Date(2026, 0, day, hour).toISOString();

  it('lists the sessions by local day of their activity, newest first, then the finished ones', () => {
    const list = [
      session('today', 'running', { last_activity_at: local(10) }),
      session('yesterday', 'idle', { last_activity_at: local(9, 23) }),
      session('week', 'failed', { last_activity_at: local(4) }),
      session('old', 'ready', { last_activity_at: local(1) }),
      session('done', 'done', { last_activity_at: local(10) }),
    ];
    expect(
      sidebarGroups(list, view({ grouping: 'time' }), undefined, now).map((g) => [
        g.label,
        g.folded,
        ids(g.rows),
      ]),
    ).toEqual([
      [group('today'), false, ['today']],
      [group('yesterday'), false, ['yesterday']],
      [group('week'), false, ['week']],
      [group('earlier'), false, ['old']],
      [group('ended'), true, ['done']],
    ]);
  });

  it('reads the creation day when sorted by creation', () => {
    const list = [session('a', 'running', { created_at: local(9), last_activity_at: local(10) })];
    const [group] = sidebarGroups(
      list,
      view({ grouping: 'time', sort: 'created' }),
      undefined,
      now,
    );
    expect(group!.key).toBe('yesterday');
  });
});

describe('only the sessions that need you', () => {
  it('keeps the sessions that need you, and a session above one that does', () => {
    const list = [
      session('lead', 'idle'),
      session('task', 'waiting', { forked_from: { session_id: 'lead' }, waiting: 1 }),
      session('busy', 'running', { forked_from: { session_id: 'lead' } }),
      session('failed', 'failed'),
      session('running', 'running'),
    ];
    const groups = onlyWaiting(sidebarGroups(list, view({ grouping: 'lead' })));
    expect(
      groups.map((g) => g.rows.map((r) => [r.session.id, r.children.map((c) => c.id)])),
    ).toEqual([
      [
        ['lead', ['task']],
        ['failed', []],
      ],
    ]);
    expect(onlyWaiting(sidebarGroups(list, view())).map((g) => [g.key, ids(g.rows)])).toEqual([
      ['waiting', ['task', 'failed']],
    ]);
  });
});

describe('stored list view', () => {
  it('reads the stored grouping, sort and archived switch, and the default for anything else', () => {
    const fallback = { grouping: 'lead', sort: 'activity', archived: false };
    expect(readSessionView(null)).toEqual(fallback);
    expect(readSessionView('{not json')).toEqual(fallback);
    expect(readSessionView('null')).toEqual(fallback);
    expect(readSessionView('{"grouping":"tree","sort":"size","archived":"yes"}')).toEqual(fallback);
    expect(readSessionView('{"grouping":"lead","sort":"title"}')).toEqual({
      grouping: 'lead',
      sort: 'title',
      archived: false,
    });
    expect(readSessionView('{"grouping":"time","archived":true}')).toEqual({
      grouping: 'time',
      sort: 'activity',
      archived: true,
    });
  });
});

describe('folded waiting and review groups', () => {
  const groups = (list: WorkbenchSession[]) => sidebarGroups(list, view());

  it('open when a new session enters them', () => {
    const before = groups([session('a', 'failed'), session('b', 'running')]);
    const after = groups([session('a', 'failed'), session('b', 'failed')]);
    const folded = new Set(['waiting', 'ended']);
    expect([...unfoldEntered(folded, before, after)]).toEqual(['ended']);
  });

  it('open when the group comes back with a session', () => {
    const before = groups([session('b', 'running')]);
    const after = groups([session('b', 'waiting', { waiting: 1 })]);
    expect([...unfoldEntered(new Set(['waiting']), before, after)]).toEqual([]);
  });

  it('open when an idle session gets news', () => {
    const list = [session('a', 'idle'), session('b', 'failed')];
    const before = sidebarGroups(list, view(), () => false);
    const after = sidebarGroups(list, view(), (s) => s.id === 'a');
    expect([...unfoldEntered(new Set(['review']), before, after)]).toEqual([]);
  });

  it('stay folded while the same sessions are in them, and on the first load', () => {
    const before = groups([session('a', 'failed'), session('b', 'running')]);
    const after = groups([
      session('a', 'failed', { last_activity_at: at(3) }),
      session('b', 'idle'),
    ]);
    const folded = new Set(['waiting']);
    expect(unfoldEntered(folded, before, after)).toBe(folded);
    expect(unfoldEntered(folded, null, after)).toBe(folded);
  });
});

describe('held order', () => {
  it('preserves keyboard row order without freezing a worker in its old state group', () => {
    const before = sidebarGroups(
      [
        session('lead', 'idle'),
        session('worker', 'running', { spawned_by: { session_id: 'lead' } }),
        session('other', 'running', { last_activity_at: at(1) }),
      ],
      view(),
    );
    const after = sidebarGroups(
      [
        session('lead', 'idle'),
        session('worker', 'merged', { spawned_by: { session_id: 'lead' } }),
        session('other', 'running', { last_activity_at: at(9) }),
      ],
      view(),
    );
    expect(keepOrder(before, after).map((group) => [group.key, ids(group.rows)])).toEqual([
      ['working', ['other']],
      ['merged', ['worker']],
      ['ended', ['lead']],
    ]);
  });
  it('keeps order within each current group while state changes move sessions truthfully', () => {
    const shown = sidebarGroups(
      [
        session('a', 'running', { last_activity_at: at(5) }),
        session('b', 'running', { last_activity_at: at(4) }),
        session('c', 'idle'),
      ],
      view(),
    );
    const next = sidebarGroups(
      [
        session('a', 'failed', { last_activity_at: at(5) }),
        session('b', 'running', { last_activity_at: at(9) }),
        session('d', 'running', { last_activity_at: at(1) }),
        session('e', 'failed'),
      ],
      view(),
    );
    const held = keepOrder(shown, next);
    expect(held.map((g) => [g.key, ids(g.rows)])).toEqual([
      ['waiting', ['a', 'e']],
      ['working', ['b', 'd']],
    ]);
    expect(held[0]!.rows[0]!.session.state).toBe('failed');
  });
});

describe('session row', () => {
  const render = (
    s: WorkbenchSession,
    extra: { on?: boolean; unread?: boolean; number?: number } = {},
  ) =>
    renderToStaticMarkup(
      createElement(SessionListRow, {
        session: s,
        on: extra.on ?? false,
        unread: extra.unread,
        number: extra.number,
        now: Date.parse(at(5)),
        onSelect() {},
      }),
    );
  const rowButton = (html: string) =>
    /<button[^>]*class="ss-row[^"]*"[^>]*>.*?<\/button>/.exec(html)![0];

  const busy = session('a', 'waiting', {
    runtime: 'codex',
    waiting: 2,
    waiting_kind: 'approval',
    changes: { files: 2, additions: 48, deletions: 12 },
    gate: { state: 'failed', passed: 0, failed: 0, running: 0, finished_at: at(1) },
    last_activity_at: at(3),
  });

  it('draws one line: the runtime glyph with its status mark, the title and the time', () => {
    const button = rowButton(render(busy, { on: true }));
    expect(button).toMatch(
      /^<button[^>]*><span class="ss-av"><svg aria-hidden="true" class="rtg".*?<title>Codex<\/title>.*?<\/svg><span class="ss-badge" role="img" aria-label="待批准" data-badge="approval"[^>]*><\/span><\/span><span class="ss-ttl">title of a<\/span><span class="ss-time">待批准<\/span><\/button>$/,
    );
    for (const gone of ['+48', 'dbar', 'ss-l2', '待处理 2<']) expect(button).not.toContain(gone);
  });

  const stateBadge = (s: WorkbenchSession) => [s, sessionStateLabel(s)] as const;
  it.each([
    ['running', ...stateBadge(session('r', 'running'))],
    ['starting', ...stateBadge(session('r', 'starting'))],
    ['stopping', ...stateBadge(session('r', 'idle', { stopping: true }))],
    ['waiting', ...stateBadge(session('w', 'waiting', { waiting: 1 }))],
    ['reconciling', ...stateBadge(session('w', 'idle', { reconciling: true }))],
    ['ready', ...stateBadge(session('v', 'ready'))],
    ['failed', ...stateBadge(session('f', 'failed'))],
    ['merge blocked', session('f', 'ready', { merge: { state: 'blocked' } }), badge('failed')],
    [
      'last turn failed',
      session('f', 'idle', { last_turn: { id: 't', state: 'failed' } }),
      badge('failed'),
    ],
    ['queued', session('q', 'idle', { last_turn: { id: 't', state: 'queued' } }), badge('queued')],
  ])('marks a %s session with its own named badge', (_name, listed, label) => {
    expect(rowButton(render(listed))).toMatch(
      new RegExp(`<span class="ss-badge" role="img" aria-label="${label}" data-badge="[a-z]+"`),
    );
  });

  it('draws no badge for an idle or ended session', () => {
    for (const state of ['idle', 'merged', 'discarded', 'done'] as const)
      expect(rowButton(render(session('e', state)))).not.toContain('ss-badge');
  });

  it('puts the hidden ⌘ number hint on the first nine rows', () => {
    expect(rowButton(render(session('n', 'running'), { number: 3 }))).toContain(
      '<span class="kbd hk" aria-hidden="true">⌘3</span>',
    );
    expect(rowButton(render(session('n', 'running')))).not.toContain('kbd');
  });

  it('names the row by title, runtime, state, waiting count and gate, and marks the selected one', () => {
    const button = rowButton(render(busy, { on: true }));
    expect(button).toContain('aria-label="title of a，Codex，待批准，待处理 2，门禁失败"');
    expect(button).toContain('aria-current="true"');
    expect(rowButton(render(busy))).not.toContain('aria-current');
  });

  it('keeps the menu button beside the row button, not inside it', () => {
    const html = render(busy);
    expect(rowButton(html)).not.toContain(zh('sessions.screen.sessionActions'));
    expect(html).toContain(`aria-label="${zh('sessions.screen.sessionActions')}"`);
  });

  it('marks an unread row in its name', () => {
    const button = rowButton(render(session('b', 'idle'), { unread: true }));
    expect(button).toContain('data-unread');
    expect(button).toContain('aria-label="title of b，Claude，空闲，未读"');
  });
});

describe('session preview', () => {
  const now = Date.parse(at(40));
  const render = (s: WorkbenchSession, extra: Partial<Parameters<typeof SessionPreview>[0]> = {}) =>
    renderToStaticMarkup(createElement(SessionPreview, { session: s, now, ...extra }));
  const facts = (html: string) =>
    [...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map(([, label, value]) => [
      label,
      value!.replace(/<[^>]*>/g, ''),
    ]);

  it('lists model and effort, permissions, changes, checks, where it came from and its time', () => {
    const html = render(
      session('a', 'waiting', {
        model: 'gpt-5-codex',
        runtime: 'codex',
        effort: 'high',
        permission_mode: 'auto_edit',
        waiting: 1,
        changes: { files: 3, additions: 61, deletions: 19 },
        gate: { state: 'failed', passed: 0, failed: 0, running: 0, finished_at: at(1) },
        forked_from: { session_id: 'lead' },
        created_at: at(0),
      }),
      { source: 'Lead' },
    );
    expect(html).toContain('<b class="ss-hc-cut">title of a</b>');
    expect(html).toContain('待批准，待处理 1');
    const line = `gpt-5-codex，高，${zh('components.runtime.codexWorkspaceWrite')}`;
    expect(html).toContain(`title="${line}">${line}</span>`);
    expect(facts(html)).toEqual([
      [fact('changes'), '+61 −193 个文件'],
      [fact('checks'), zh('sessions.screen.gateFailed')],
      [fact('source'), expect.stringMatching(/^分叉自 Lead，/)],
      [fact('elapsed'), '40 分钟'],
    ]);
    expect(html).toContain('aria-label="新增 61 行，删除 19 行"');
    expect(html).not.toContain('<button');
  });

  it('draws no row for a field the list does not carry', () => {
    const html = render(session('b', 'merged', { last_activity_at: at(10) }));
    expect(facts(html).map(([label]) => label)).toEqual([fact('elapsed')]);
    expect(facts(html).at(-1)).toEqual([fact('elapsed'), '10 分钟']);
    for (const missing of [fact('branch'), fact('context'), '<button'])
      expect(html).not.toContain(missing);
  });

  it('names a run that no longer counts beside its counts, and a current run by its counts alone', () => {
    const checks = (state: NonNullable<WorkbenchSession['gate']>['state']) =>
      facts(
        render(session('g', 'ready', { gate: { state, passed: 3, failed: 0, running: 0 } })),
      ).find(([label]) => label === fact('checks'))![1];
    expect(checks('stale')).toBe(`${zh('sessions.screen.gateStale')}3 / 3`);
    expect(checks('cancelled')).toBe(`${zh('sessions.screen.gateCancelled')}3 / 3`);
    expect(checks('cancelling')).toBe(`${zh('sessions.screen.gateCancelling')}3 / 3`);
    expect(checks('passed')).toBe('3 / 3');
  });

  it('names a fork, the last failed turn, a session in its own folder and a blocked merge', () => {
    const html = render(
      session('c', 'idle', {
        forked_from: { session_id: 'src' },
        workspace_kind: 'in_place',
        last_turn: { id: 't', state: 'failed', error: 'boom' },
        merge: { state: 'blocked' },
      }),
      { source: 'Source' },
    );
    expect(html).toContain('空闲，boom');
    expect(facts(html)).toContainEqual([fact('source'), expect.stringMatching(/^分叉自 Source，/)]);
    expect(facts(html)).toContainEqual([fact('where'), zh('sessions.screen.inPlace')]);
    expect(facts(html)).toContainEqual([fact('merge'), zh('sessions.screen.mergeBlocked')]);
  });
});
