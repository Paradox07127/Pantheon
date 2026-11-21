import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportCandidate, ProjectSummary } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  current: {} as any,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({ useShell: { getState: () => mock.shell } }));
vi.mock('@/data/current-project', () => ({
  useCurrentProject: Object.assign((selector: any) => selector(mock.current), {
    getState: () => mock.current,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/screens/projects/view', () => ({
  useProjectsView: () => ({ query: '', opening: false, setQuery() {}, setOpening() {} }),
}));
vi.mock('@/screens/sessions/model', async (actual) => {
  const real = await actual<typeof import('@/screens/sessions/model')>();
  return { ...real, groupWorkbenchSessions: vi.fn(real.groupWorkbenchSessions) };
});
import { NeedsPopover, SessionsPopover } from '@/components/NeedsPopover';
import type { NeedsYouItem } from '@/data/needs-you';
import type { DaemonEvent } from '@/data/sync';
import { keyText, shortcutKeys } from '@/lib/shortcuts';
import { groupWorkbenchSessions } from '@/screens/sessions/model';
import { sortProjects, useProjectsSummary } from '@/data/projects-summary';
import { forgetQuery } from '@/data/query-cache';
import {
  OpenProjectButton,
  ProjectRow,
  ProjectsScreen,
  SummaryPanel,
} from '@/screens/projects/ProjectsScreen';
import { zh, zhf } from './i18n-setup.js';

const count = (key: string, n: number) => `${zh(`projects.count.${key}`)} ${n}`;
const needsYou = zhf('projects.row.decisionsWaiting', { count: 4 });

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const MINUTE = 60_000;

const summary = (project_id: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  project_id,
  name: `name of ${project_id}`,
  counts: { running: 0, waiting: 0, ready: 0, failed: 0 },
  merged_today: 0,
  needs_you: 0,
  last_activity_at: null,
  ...extra,
});

const project = (id: string) => ({
  id,
  revision: 1,
  name: `name of ${id}`,
  roots: [`/work/${id}`],
});

const event = (sequence: number, project_id: string, kind: string): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: `session-${sequence}`,
  aggregate_revision: 1,
  project_id,
  causation_id: '',
  created_at: 1_000 + sequence,
  payload: {},
});

const row = (s: ProjectSummary | undefined, needs: NeedsYouItem[] = []) =>
  ProjectRow({
    project: project(s?.project_id ?? 'p') as any,
    summary: s,
    needs,
    now: NOW,
    onOpenSettings: () => {},
    onRemove: () => {},
  });

const cells = (tree: any) => [tree.props.children].flat().filter(Boolean);
const byLabel = (tree: any, label: string) => find(tree, (n) => n.props['aria-label'] === label);
const byText = (tree: any, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);
const buttons = (tree: any) => nodes(tree).filter((n) => n.type === 'button');
const opener = (tree: any) =>
  find(tree, (n) => n.type === 'button' && text(n) === 'name of project-b');

beforeEach(() => {
  mock.shell = {
    setScreen: vi.fn(),
    openSessionGroup: vi.fn(),
    followFirstSession: vi.fn(),
  };
  mock.current = { projectId: 'project-a', choose: vi.fn() };
});

describe('all projects order', () => {
  it('puts projects that need you first, then the most recent activity', () => {
    const listed = ['quiet', 'old', 'recent', 'asks', 'asks-old', 'unknown'].map(project);
    const summaries = [
      summary('quiet'),
      summary('old', { last_activity_at: '2026-11-01T00:00:00.000Z' }),
      summary('recent', { last_activity_at: '2026-11-03T00:00:00.000Z' }),
      summary('asks', { needs_you: 1, last_activity_at: '2026-11-02T00:00:00.000Z' }),
      summary('asks-old', { needs_you: 3, last_activity_at: '2026-10-01T00:00:00.000Z' }),
    ];
    expect(sortProjects(listed, summaries).map((p) => p.id)).toEqual([
      'asks',
      'asks-old',
      'recent',
      'old',
      'quiet',
      'unknown',
    ]);
  });
});

describe('project table row', () => {
  const full = summary('project-b', {
    counts: { running: 2, waiting: 1, ready: 0, failed: 3 },
    needs_you: 4,
    last_activity_at: '2026-11-03T11:00:00.000Z',
  });

  let listed: Record<string, unknown>[];
  beforeEach(() => {
    listed = [];
    vi.stubGlobal('window', {
      pantheon: { query: vi.fn(async () => ({ ok: true, value: listed })) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lays a project out as one region of mark, project, goal, sessions, needs-you and action cells', () => {
    const tree = row(full);
    expect(tree.props.role).toBe('region');
    const [, name, goal, sessions, needs, actions] = cells(tree);
    expect(cells(tree)).toHaveLength(6);
    const open = find(name, (n) => n.type === 'button');
    expect(text(open)).toBe('name of project-b');
    expect(nodes(name).some((n) => n.props.path === '/work/project-b')).toBe(true);
    expect(text(goal)).toContain('—');
    expect(buttons(sessions).length).toBeGreaterThan(0);
    expect(text(needs)).toContain('4');
    expect(byLabel(actions, zhf('projects.row.more', { name: 'name of project-b' }))).toBeTruthy();
  });

  it('opens the project sessions from the row', () => {
    opener(row(full)).props.onClick();
    expect(mock.current.choose).toHaveBeenCalledWith('project-b');
    expect(mock.shell.setScreen).toHaveBeenCalledWith('sessions');
  });

  it('ends the row with its menu and no arrow', () => {
    const actions = cells(row(full))[5]!;
    expect(nodes(actions).map((n: any) => n.type?.displayName)).not.toContain('ChevronRight');
    expect(buttons(actions)).toEqual([]);
    expect(byLabel(actions, zhf('projects.row.more', { name: 'name of project-b' }))).toBeTruthy();
  });

  it('keeps the count buttons outside the button that opens the row', () => {
    const open = opener(row(full));
    expect(nodes(open.props.children).some((n) => n.type === 'button')).toBe(false);
  });

  it('lifts the path above the row click target so its title and text reach the pointer', () => {
    const css = readFileSync(
      new URL('../../apps/web/src/screens/projects/projects.css', import.meta.url),
      'utf8',
    );
    const rule = (selector: string) =>
      css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.pr-open::after')).toContain('inset: 0');
    expect(rule('.pr-path')).toContain('position: relative');
    expect(rule('.pr-path')).toContain('z-index: 1');
  });

  it('counts running, ready and failed sessions with a glyph each and leaves zero and waiting out', () => {
    const sessions = cells(row(full))[3]!;
    expect(buttons(sessions).map((b) => b.props['aria-label'])).toEqual([
      count('running', 2),
      count('failed', 3),
    ]);
    expect(text(byLabel(sessions, count('running', 2)))).toBe('2');
    expect(named(byLabel(sessions, count('running', 2)), 'StateGlyph').props.name).toBe('running');
    expect(named(byLabel(sessions, count('failed', 3)), 'StateGlyph').props.name).toBe('failed');
    const ready = cells(row(summary('project-b', { counts: { ...full.counts, ready: 5 } })))[3]!;
    expect(named(byLabel(ready, count('ready', 5)), 'StateGlyph').props.name).toBe('ready');
  });

  it.each([
    [count('running', 2), 'working'],
    [count('failed', 3), 'inbox'],
  ])('opens the project sessions at the group of the %s count', async (label, group) => {
    await byLabel(row(full), label).props.onClick();
    expect(mock.current.choose).toHaveBeenCalledWith('project-b');
    expect(mock.shell.openSessionGroup).toHaveBeenCalledWith(group);
    expect(mock.shell.setScreen).not.toHaveBeenCalled();
  });

  it.each([
    [
      'opens the sessions that wait for you from the needs-you count',
      { id: 's1', state: 'waiting', reconciling: false, snoozed_at: 5, last_activity_at: '' },
      needsYou,
      'inbox',
    ],
    [
      'opens the needs-you group for a reconciling session counted as running',
      { id: 's1', state: 'running', reconciling: true, last_activity_at: '' },
      count('running', 2),
      'waiting',
    ],
  ])('%s', async (_name, session, label, group) => {
    listed = [session];
    const tree = row(full);
    await (label === needsYou ? byText(tree, label) : byLabel(tree, label)).props.onClick();
    expect(mock.shell.openSessionGroup).toHaveBeenCalledWith(group);
  });

  it('opens the snoozed group when the counted running session is snoozed', async () => {
    listed = [
      { id: 's1', state: 'running', reconciling: false, snoozed_at: 5, last_activity_at: '' },
      { id: 's2', state: 'idle', reconciling: false, last_activity_at: '' },
    ];
    await byLabel(row(full), count('running', 2)).props.onClick();
    expect(window.pantheon!.query).toHaveBeenCalledWith('session.list', {
      project_id: 'project-b',
    });
    expect(mock.shell.openSessionGroup).toHaveBeenCalledWith('snoozed');
  });

  it('groups the counted sessions with the unread marks the sidebar reads', async () => {
    const at = '2026-11-03T10:00:00.000Z';
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === 'pantheon.unread.project-b'
          ? JSON.stringify({ s1: { seen_at: '2026-11-01T00:00:00.000Z' } })
          : null,
    });
    listed = [{ id: 's1', state: 'running', reconciling: false, last_activity_at: at }];
    await byLabel(row(full), count('running', 2)).props.onClick();
    const unread = vi.mocked(groupWorkbenchSessions).mock.lastCall?.[2];
    expect(unread?.({ id: 's1', last_activity_at: at } as never)).toBe(true);
  });

  const waits = (
    longest_wait_ms: number,
    by_decision: NonNullable<ProjectSummary['waiting']>['by_decision'] = {},
  ) => ({ ...full, waiting: { by_decision, longest_wait_ms, blocked_tasks: 0 } });

  it('shows the decisions waiting count and how long the oldest item has waited', () => {
    const needs = cells(row(waits(18 * MINUTE)))[4]!;
    expect(text(byText(needs, needsYou))).toBe(needsYou);
    expect(text(needs)).toBe(`${needsYou}18 分钟`);
    expect(text(cells(row(full))[4])).toBe(needsYou);
  });

  const need = (
    decision: NeedsYouItem['decision'],
    id: string,
    extra: Partial<NeedsYouItem> = {},
  ): NeedsYouItem => ({
    source: { table: 'approvals', id, revision: 1 },
    kind: 'permission',
    project_id: 'project-b',
    status: 'pending',
    created_at: NOW - 5 * MINUTE,
    reason: 'permission_requested',
    decision,
    actions: [],
    ...extra,
  });
  const kindName = (key: string) => zh(`data.attention.decision.${key}`);
  const byKind = (tree: any) => byLabel(cells(tree)[4], zh('projects.row.byKind'));

  it("shows the daemon's first item and what waits by kind, the largest kind first", () => {
    const tree = row(waits(0, { question: 1, repeated_failure: 2 }), [
      need('repeated_failure', 'gate-1', {
        source: { table: 'sessions', id: 'gate-1', revision: 1 },
        kind: 'session.gate_failed',
        reason: 'gate_failed',
      }),
      need('question', 'question-1'),
    ]);
    const group = byKind(tree);
    expect(group.props.role).toBe('group');
    expect(buttons(group).map((b) => b.props['aria-label'])).toEqual([
      zhf('projects.row.kindWaiting', { kind: kindName('repeatedFailure'), count: 2 }),
      zhf('projects.row.kindWaiting', { kind: kindName('question'), count: 1 }),
    ]);
    const needs = text(cells(tree)[4]);
    expect(needs).toContain(zh('data.reason.gateFailed'));
    expect(needs).not.toContain(zh('data.reason.permissionRequested'));
    buttons(group)[1]!.props.onClick();
    expect(mock.current.choose).toHaveBeenCalledWith('project-b');
    expect(mock.shell.openSessionGroup).toHaveBeenCalledWith('inbox');
  });

  it('shows the four kinds it names, folds other into one count and leaves out kinds it does not offer', () => {
    const tree = row(
      waits(0, {
        plan_change: 6,
        question: 5,
        repeated_failure: 4,
        permission: 3,
        improvement: 2,
        other: 1,
      }),
    );
    const labels = buttons(byKind(tree)).map((b) => b.props['aria-label']);
    expect(labels).toEqual([
      zhf('projects.row.kindWaiting', { kind: kindName('question'), count: 5 }),
      zhf('projects.row.kindWaiting', { kind: kindName('repeatedFailure'), count: 4 }),
      zhf('projects.row.kindWaiting', { kind: kindName('permission'), count: 3 }),
      zhf('projects.row.kindWaiting', { kind: kindName('improvement'), count: 2 }),
      undefined,
    ]);
    expect(text(buttons(byKind(tree))[4])).toBe(zhf('projects.row.other', { count: 1 }));
  });

  it('leaves the wait out until the oldest item has waited a minute', () => {
    expect(text(cells(row(waits(20_000)))[4])).toBe(needsYou);
    expect(text(cells(row(waits(MINUTE)))[4])).toBe(`${needsYou}1 分钟`);
  });

  it('dims an idle project and puts its last activity in the goal column and dashes after it', () => {
    const idle = row(summary('project-b', { last_activity_at: '2026-10-28T12:00:00.000Z' }));
    expect(idle.props.className).toBe('pr-row pr-idle');
    const [, , goal, sessions, needs] = cells(idle);
    expect(text(goal)).toBe('上次活动 6 天');
    expect(text(sessions)).toBe('—');
    expect(text(needs)).toBe('—');
    expect(text(cells(row(summary('project-b')))[2])).toBe('—');
  });

  it('keeps a project with sessions undimmed, with a dash for the goal and for needs-you', () => {
    const busy = row(
      summary('project-b', {
        counts: { running: 0, waiting: 0, ready: 1, failed: 0 },
        last_activity_at: '2026-10-28T12:00:00.000Z',
      }),
    );
    expect(busy.props.className).toBe('pr-row');
    const [, , goal, , needs] = cells(busy);
    expect(text(goal)).toBe('—');
    expect(text(needs)).toBe('—');
  });
});

describe('project region', () => {
  const asking = summary('project-b', {
    needs_you: 5,
    brief: 'The refund audit log merged.',
    waiting: {
      by_decision: { question: 1, repeated_failure: 3, permission: 1 },
      longest_wait_ms: 25 * MINUTE,
      blocked_tasks: 0,
    },
  });
  const decisionsWaiting = (n: number) => zhf('projects.row.decisionsWaiting', { count: n });
  const kindWaiting = (key: string, n: number) =>
    zhf('projects.row.kindWaiting', { kind: zh(`data.attention.decision.${key}`), count: n });
  const byKind = (tree: any) => byLabel(tree, zh('projects.row.byKind'));

  let stored: [string, string][];
  beforeEach(() => {
    stored = [];
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: (key: string, value: string) => stored.push([key, value]),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is a region named after the project', () => {
    const tree = row(asking);
    expect(tree.props.role).toBe('region');
    expect(tree.props['aria-label']).toBe('name of project-b');
  });

  it('counts the decisions waiting and opens the project inbox from the count', () => {
    const count = find(row(asking), (n) => n.type === 'button' && text(n) === decisionsWaiting(5));
    count.props.onClick();
    expect(mock.current.choose).toHaveBeenCalledWith('project-b');
    expect(mock.shell.openSessionGroup).toHaveBeenCalledWith('inbox');
  });

  it('splits the decisions by kind, the most first, with the longest wait', () => {
    const tree = row(asking);
    expect(buttons(byKind(tree)).map((b) => b.props['aria-label'])).toEqual([
      kindWaiting('repeatedFailure', 3),
      kindWaiting('question', 1),
      kindWaiting('permission', 1),
    ]);
    expect(text(tree)).toContain('25 分钟');
  });

  it('leaves the kinds and the wait out without a waiting summary', () => {
    const tree = row({ ...asking, waiting: undefined });
    expect(() => byKind(tree)).toThrow();
    expect(text(tree)).not.toContain('25 分钟');
  });

  it('opens the project sessions from the brief line', () => {
    const line = byLabel(
      row(asking),
      zhf('projects.row.brief', { text: 'The refund audit log merged.' }),
    );
    expect(line.type).toBe('button');
    line.props.onClick();
    expect(mock.current.choose).toHaveBeenCalledWith('project-b');
    expect(mock.shell.setScreen).toHaveBeenCalledWith('sessions');
  });

  it('draws no brief line without a brief', () => {
    const tree = row({ ...asking, brief: undefined });
    expect(
      nodes(tree).some((n) => String(n.props['aria-label'] ?? '').startsWith('你离开后')),
    ).toBe(false);
  });
});

describe('summary panel', () => {
  const asks = [{ project_id: 'a', created_at: NOW }] as NeedsYouItem[];
  // The three counts that open a list are their popovers' triggers; merged today is a plain cell.
  const shown = (tree: any) => [
    ...nodes(tree)
      .filter((n) => n.props.trigger)
      .map((n) => n.props.trigger),
    find(tree, (n) => n.type === 'div' && n !== tree),
  ];

  it('adds up needs-you across projects, running, ready and merged today', () => {
    const tree = SummaryPanel({
      summaries: [
        summary('a', {
          needs_you: 3,
          counts: { running: 2, waiting: 0, ready: 1, failed: 0 },
          merged_today: 4,
        }),
        summary('b', {
          needs_you: 1,
          counts: { running: 1, waiting: 1, ready: 0, failed: 2 },
          merged_today: 5,
        }),
        summary('c', { counts: { running: 0, waiting: 0, ready: 2, failed: 0 } }),
      ],
      needs: asks,
    });
    const labels = ['needsYou', 'running', 'ready', 'mergedToday'].map((k) =>
      zh(`projects.summary.${k}`),
    );
    expect(shown(tree).map(text)).toEqual(
      ['4跨 2 个项目', '3', '3', '9'].map((value, i) => labels[i] + value),
    );
    expect(shown(tree).map((c) => c.type)).toEqual(['button', 'button', 'button', 'div']);
  });

  it.each([
    ['needs you', 'NeedsPopover', { items: asks }],
    ['running', 'running', { projectIds: ['a', 'b'] }],
    ['ready to merge', 'ready', { projectIds: ['a', 'c'] }],
  ])('opens the list of what %s counts from its cell', (_name, list, props) => {
    const tree = SummaryPanel({
      summaries: [
        summary('a', { counts: { running: 1, waiting: 0, ready: 1, failed: 0 } }),
        summary('b', { counts: { running: 1, waiting: 0, ready: 0, failed: 0 } }),
        summary('c', { counts: { running: 0, waiting: 0, ready: 3, failed: 0 } }),
      ],
      needs: asks,
    });
    const popover = find(tree, (n) =>
      list === 'NeedsPopover' ? n.type === NeedsPopover : n.props.show === list,
    );
    expect(popover.type === NeedsPopover || popover.type === SessionsPopover).toBe(true);
    expect(popover.props).toMatchObject(props);
  });

  it('says nothing about other projects or a queue when nothing needs you or waits', () => {
    const tree = SummaryPanel({ summaries: [summary('a')], needs: [] });
    expect(shown(tree).map(text)).toEqual(
      ['needsYou', 'running', 'ready', 'mergedToday'].map((k) => `${zh(`projects.summary.${k}`)}0`),
    );
  });
});

describe('projects screen', () => {
  let found: ImportCandidate[];
  beforeEach(() => {
    found = [];
    forgetQuery('import.candidates', 'all');
    mock.board = {
      board: { cursor: 1, projects: [project('alpha'), project('beta')], project_briefs: [] },
      events: [],
      status: { state: 'live' },
      resync: 0,
    };
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: {
        query: vi.fn(async (method: string) =>
          method === 'import.candidates'
            ? { ok: true, value: { indexing: null, candidates: found } }
            : method === 'needs_you.list'
              ? {
                  ok: true,
                  value: {
                    items: [
                      { project_id: 'alpha', created_at: NOW - 5 * MINUTE },
                      { project_id: 'alpha', created_at: NOW - 30 * MINUTE },
                      { project_id: 'gone', created_at: NOW - 90 * MINUTE },
                    ],
                  },
                }
              : {
                  ok: true,
                  value: {
                    projects: [
                      summary('alpha', { needs_you: 2 }),
                      summary('gone', { needs_you: 9 }),
                    ],
                  },
                },
        ),
      },
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('groups the project regions under all projects, each with its own needs-you items', async () => {
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    await h.flush();
    const table = byLabel(h.value, zh('projects.title'));
    expect(table.props.role).toBe('group');
    const rows = nodes(table).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'ProjectRow',
    );
    expect(rows.map((r) => [r.props.project.id, r.props.needs.length])).toEqual([
      ['alpha', 2],
      ['beta', 0],
    ]);
    expect(
      named(h.value, 'SummaryPanel').props.summaries.map((s: ProjectSummary) => s.project_id),
    ).toEqual(['alpha']);
  });

  it('lists no row for the personal agent’s home', async () => {
    mock.board.board.projects.push({ ...project('home'), roots: [], kind: 'personal' });
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    await h.flush();
    const table = byLabel(h.value, zh('projects.title'));
    expect(
      nodes(table)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'ProjectRow')
        .map((r) => r.props.project.id),
    ).toEqual(['alpha', 'beta']);
  });

  it.each([
    [14, 12, true],
    [12, 12, false],
  ])(
    'with %i projects shows %i rows and a switch to the rest: %s',
    async (total, first, folded) => {
      mock.board.board.projects = Array.from({ length: total }, (_, i) => project(`p${i}`));
      const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
      await h.flush();
      const rows = () =>
        nodes(h.value).filter((n) => typeof n.type === 'function' && n.type.name === 'ProjectRow');
      expect(rows()).toHaveLength(first);
      const label = zhf('projects.showAll', { count: total });
      const toggle = () => nodes(h.value).find((n) => n.type === 'button' && text(n) === label);
      if (!folded) return expect(toggle()).toBeUndefined();
      expect(toggle()!.props['aria-expanded']).toBe(false);
      toggle()!.props.onClick();
      h.render();
      expect(rows()).toHaveLength(total);
      const less = find(h.value, (n) => n.type === 'button' && text(n) === zh('projects.showLess'));
      expect(less.props['aria-expanded']).toBe(true);
    },
  );

  it('moves the focus between the rows with the up and down keys', async () => {
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    await h.flush();
    const table = byLabel(h.value, zh('projects.title'));
    const opens = [0, 1, 2].map(() => ({ focus: vi.fn() }));
    const press = (key: string, target: unknown) => {
      const e = {
        key,
        target,
        currentTarget: { querySelectorAll: () => opens },
        preventDefault: vi.fn(),
      };
      table.props.onKeyDown(e);
      return e;
    };
    expect(press('ArrowDown', opens[0]).preventDefault).toHaveBeenCalled();
    expect(opens[1]!.focus).toHaveBeenCalled();
    press('ArrowUp', opens[2]);
    expect(opens[1]!.focus).toHaveBeenCalledTimes(2);
    expect(press('ArrowDown', opens[2]).preventDefault).not.toHaveBeenCalled();
    expect(press('Enter', opens[0]).preventDefault).not.toHaveBeenCalled();
    expect(opens[0]!.focus).not.toHaveBeenCalled();
  });

  it.each([
    ['with no project yet', []],
    ['with projects', [project('alpha')]],
  ])('puts import and open in the bar and no filter %s', async (_name, projects) => {
    mock.board = { ...mock.board, board: { cursor: 1, projects, project_briefs: [] } };
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    await h.flush();
    expect(nodes(h.value).some((n) => n.type === 'input')).toBe(false);
    const bar = named(h.value, 'TopBar');
    expect(buttons(bar).map(text)).toEqual([zh('projects.import.open')]);
    expect(named(bar, 'OpenProjectButton')).toBeTruthy();
  });

  const candidate = (name: string, extra: Partial<ImportCandidate> = {}): ImportCandidate => ({
    root: `/work/${name}`,
    name,
    git: true,
    remote: null,
    sessions: 3,
    runtimes: ['claude'],
    last_active_at: null,
    preselected: false,
    ...extra,
  });

  it.each([
    ['the bar', () => zh('projects.import.open')],
    ['the line under the table', () => zh('projects.import.review')],
  ])(
    'opens the import dialog from %s with the folders that are no project yet',
    async (_name, label) => {
      found = [
        candidate('alpha'),
        candidate('gamma'),
        candidate('scratch', { excluded: 'temporary' }),
      ];
      const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
      await h.flush();
      expect(nodes(h.value).map(text)).toContain(zhf('projects.import.hint', { count: 1 }));
      expect(named(h.value, 'ImportDialog').props.open).toBe(false);
      find(h.value, (n) => n.type === 'button' && text(n) === label()).props.onClick();
      h.render();
      const dialog = named(h.value, 'ImportDialog');
      expect(dialog.props.open).toBe(true);
      expect(dialog.props.candidates.map((c: ImportCandidate) => c.name)).toEqual([
        'gamma',
        'scratch',
      ]);
    },
  );
});

describe('open project button', () => {
  it('names the action with a folder icon and keeps the keys out of the button, in its tip', () => {
    const tip = OpenProjectButton({ onClick() {} });
    const button = find(tip, (n) => n.type === 'button');
    expect(text(button)).toBe(zh('projects.open.title'));
    expect(nodes(button).some((n) => n.props.className?.includes?.('kbd'))).toBe(false);
    expect(button.props['aria-keyshortcuts']).toBe(shortcutKeys('open-project'));
    expect(tip.props.content).toBe(
      `${zh('projects.open.title')} ${keyText(shortcutKeys('open-project'))}`,
    );
  });
});

describe('summary refresh', () => {
  let reads: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    reads = [];
    mock.board = { board: null, events: [], status: { state: 'live' }, resync: 0 };
    vi.stubGlobal('window', {
      pantheon: {
        query: vi.fn(async (method: string) => {
          reads.push(method);
          return { ok: true, value: { projects: [summary('project-b')] } };
        }),
      },
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads the summary again after a session event of a project that is not current', async () => {
    const h = mount(() => useProjectsSummary());
    await h.flush();
    expect(reads).toEqual(['projects.summary']);
    expect(h.value.data!.map((s: ProjectSummary) => s.project_id)).toEqual(['project-b']);
    mock.board = { ...mock.board, events: [event(1, 'project-b', 'session.merged')] };
    h.render();
    await vi.advanceTimersByTimeAsync(2_500);
    await h.flush();
    expect(reads).toEqual(['projects.summary', 'projects.summary']);
  });
});

describe('projects screen while it is open', () => {
  let summaries: ProjectSummary[];
  let items: NeedsYouItem[];
  let reads: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    forgetQuery('projects.summary', 'all');
    reads = [];
    items = [];
    summaries = [
      summary('alpha', { last_activity_at: '2026-11-03T11:00:00.000Z' }),
      summary('beta', { last_activity_at: '2026-11-03T10:00:00.000Z' }),
    ];
    mock.board = {
      board: { cursor: 1, projects: [project('alpha'), project('beta')], project_briefs: [] },
      events: [],
      status: { state: 'live' },
      resync: 0,
    };
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: {
        query: vi.fn(async (method: string) => {
          reads.push(method);
          return method === 'needs_you.list'
            ? { ok: true, value: { items } }
            : method === 'import.candidates'
              ? { ok: true, value: { indexing: null, candidates: [] } }
              : { ok: true, value: { projects: summaries } };
        }),
      },
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('keeps its order while the summary changes, and takes it anew when opened again', async () => {
    const open = async () => {
      const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
      await h.flush();
      return h;
    };
    const order = (tree: any) =>
      nodes(tree)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'ProjectRow')
        .map((r) => r.props.project.id);
    const h = await open();
    expect(order(h.value)).toEqual(['alpha', 'beta']);

    summaries = [summaries[0]!, { ...summaries[1]!, needs_you: 1 }];
    vi.setSystemTime(NOW + 5 * MINUTE);
    mock.board = { ...mock.board, events: [event(1, 'beta', 'session.merged')] };
    h.render();
    await vi.advanceTimersByTimeAsync(2_500);
    await h.flush();
    expect(reads.filter((m) => m === 'projects.summary')).toHaveLength(2);
    expect(order(h.value)).toEqual(['alpha', 'beta']);

    unmountAll();
    const again = await open();
    expect(order(again.value)).toEqual(['beta', 'alpha']);
  });

  it('shows what needs you as it is now while the rows keep their places', async () => {
    const wait = (id: string, project_id: string) =>
      ({
        source: { table: 'approvals', id, revision: 1 },
        kind: 'permission',
        project_id,
        status: 'pending',
        created_at: NOW - 5 * MINUTE,
        reason: 'permission_requested',
        decision: 'permission',
        actions: [],
      }) as NeedsYouItem;
    mock.board.board.projects.push(project('gamma'));
    items = [wait('a1', 'alpha'), wait('a2', 'alpha'), wait('g1', 'gamma')];
    const waiting = (n: number) => ({
      by_decision: { permission: n },
      longest_wait_ms: 5 * MINUTE,
      blocked_tasks: 0,
    });
    summaries = [
      { ...summaries[0]!, needs_you: 2, waiting: waiting(2) },
      summaries[1]!,
      summary('gamma', {
        needs_you: 1,
        waiting: waiting(1),
        last_activity_at: '2026-11-03T09:00:00.000Z',
      }),
    ];
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    await h.flush();
    const rowNodes = () =>
      nodes(h.value).filter((n) => typeof n.type === 'function' && n.type.name === 'ProjectRow');
    const rowOf = (id: string) =>
      ProjectRow(rowNodes().find((r) => r.props.project.id === id)!.props);
    const asks = () =>
      find(SummaryPanel(named(h.value, 'SummaryPanel').props), (n) => n.type === NeedsPopover);
    const permissions = (n: number) =>
      zhf('projects.row.kindWaiting', {
        kind: zh('data.attention.decision.permission'),
        count: n,
      });
    const decisions = (n: number) => zhf('projects.row.decisionsWaiting', { count: n });
    expect(rowNodes().map((r) => r.props.project.id)).toEqual(['alpha', 'gamma', 'beta']);
    expect(text(byText(rowOf('alpha'), decisions(2)))).toBe(decisions(2));
    expect(text(asks().props.trigger)).toBe(
      `${zh('projects.summary.needsYou')}3${zhf('projects.summary.across', { count: 2 })}`,
    );

    items = [wait('a2', 'alpha')];
    summaries = [
      { ...summaries[0]!, needs_you: 1, waiting: waiting(1) },
      summaries[1]!,
      { ...summaries[2]!, needs_you: 0, waiting: undefined },
    ];
    mock.board = { ...mock.board, events: [event(1, 'gamma', 'approval.resolved')] };
    h.render();
    await vi.advanceTimersByTimeAsync(2_500);
    await h.flush();
    expect(rowNodes().map((r) => r.props.project.id)).toEqual(['alpha', 'gamma', 'beta']);
    const alpha = rowOf('alpha');
    expect(text(byText(alpha, decisions(1)))).toBe(decisions(1));
    expect(text(byLabel(alpha, permissions(1)))).toBe('1');
    expect(text(cells(rowOf('gamma'))[4])).toBe('—');
    expect(text(asks().props.trigger)).toBe(
      `${zh('projects.summary.needsYou')}1${zhf('projects.summary.across', { count: 1 })}`,
    );
    expect(asks().props.items.map((i: NeedsYouItem) => i.source.id)).toEqual(['a2']);
  });
});

describe('projects screen before the summary lands', () => {
  beforeEach(() => {
    forgetQuery('projects.summary', 'all');
    mock.board = {
      board: { cursor: 1, projects: [project('alpha'), project('beta')], project_briefs: [] },
      events: [],
      status: { state: 'live' },
      resync: 0,
    };
    vi.stubGlobal('window', {
      addEventListener() {},
      removeEventListener() {},
      pantheon: {
        query: vi.fn(async (method: string) =>
          method === 'needs_you.list'
            ? { ok: true, value: { items: [] } }
            : {
                ok: true,
                value: { projects: [summary('alpha'), summary('beta', { needs_you: 1 })] },
              },
        ),
      },
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('draws the summary and one row per project from the first frame, none in a place the summary moves', async () => {
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    const projectRows = () =>
      nodes(h.value).filter((n) => typeof n.type === 'function' && n.type.name === 'ProjectRow');
    const bodyRows = () => [byLabel(h.value, zh('projects.title')).props.children].flat();
    expect(named(h.value, 'SummaryPanel')).toBeTruthy();
    expect(bodyRows()).toHaveLength(2);
    expect(projectRows()).toEqual([]);
    await h.flush();
    expect(bodyRows()).toHaveLength(2);
    expect(projectRows().map((r) => r.props.project.id)).toEqual(['beta', 'alpha']);
  });
});
