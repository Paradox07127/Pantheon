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
const needsYou = zhf('projects.row.needsYou', { count: 4 });

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const MINUTE = 60_000;

const summary = (project_id: string, extra: Partial<ProjectSummary> = {}): ProjectSummary => ({
  project_id,
  name: `name of ${project_id}`,
  counts: { running: 0, waiting: 0, ready: 0, failed: 0, queued: 0 },
  merged_today: 0,
  needs_you: 0,
  milestone: null,
  done_daily: Array.from({ length: 14 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    done: i,
  })),
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

const row = (
  s: ProjectSummary | undefined,
  oldestWait: number | null = null,
  needs: NeedsYouItem[] = [],
) =>
  ProjectRow({
    project: project(s?.project_id ?? 'p') as any,
    summary: s,
    needs,
    oldestWait,
    now: NOW,
    onOpenSettings: () => {},
    onRemove: () => {},
  });

const cells = (tree: any) => nodes(tree).filter((n) => n.props.role === 'cell');
const byLabel = (tree: any, label: string) => find(tree, (n) => n.props['aria-label'] === label);
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
    counts: { running: 2, waiting: 1, ready: 0, failed: 3, queued: 0 },
    needs_you: 4,
    milestone: {
      id: 'first-release',
      title: 'First release',
      done: 3,
      total: 4,
      running: 0,
      failed: 0,
    },
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

  it('lays a project out as one row of mark, project, goal, sessions, needs-you and action cells', () => {
    const tree = row(full);
    expect(tree.props.role).toBe('row');
    const [, name, goal, sessions, needs, actions] = cells(tree);
    expect(cells(tree)).toHaveLength(6);
    const open = find(name, (n) => n.type === 'button');
    expect(text(open)).toBe('name of project-b');
    expect(nodes(name).some((n) => n.props.path === '/work/project-b')).toBe(true);
    expect(text(goal)).toContain('First release');
    expect(buttons(sessions).length).toBeGreaterThan(0);
    expect(text(needs)).toContain('4');
    expect(byLabel(actions, zhf('projects.row.more', { name: 'name of project-b' }))).toBeTruthy();
  });

  it('opens the project board from the row', () => {
    opener(row(full)).props.onClick();
    expect(mock.current.choose).toHaveBeenCalledWith('project-b');
    expect(mock.shell.setScreen).toHaveBeenCalledWith('board');
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

  it('lifts the path and the goal title above the row click target so their titles and text reach the pointer', () => {
    const css = readFileSync(
      new URL('../../apps/web/src/screens/projects/projects.css', import.meta.url),
      'utf8',
    );
    const rule = (selector: string) =>
      css.match(new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.pr-open::after')).toContain('inset: 0');
    for (const selector of ['.pr-path', '.pr-mt']) {
      expect(rule(selector), selector).toContain('position: relative');
      expect(rule(selector), selector).toContain('z-index: 1');
    }
  });

  it('shows the goal title, done over total and a done and a remaining segment', () => {
    const goal = cells(row(full))[2]!;
    expect(text(goal)).toContain('3 / 4');
    const segments = nodes(find(goal, (n) => n.props.role === 'img').props.children);
    expect(segments.map((s) => s.props.style.flexGrow)).toEqual([3, 1]);
  });

  it('splits the goal bar into merged, running, failed and not started and names the four counts', () => {
    const mixed = summary('project-b', {
      milestone: { id: 'm', title: 'Refunds', done: 7, total: 12, running: 3, failed: 1 },
    });
    const bar = find(cells(row(mixed))[2], (n) => n.props.role === 'img');
    const segments = nodes(bar.props.children);
    expect(segments.map((s) => [s.props.className, s.props.style.flexGrow])).toEqual([
      ['pr-done', 7],
      ['pr-run', 3],
      ['pr-bad', 1],
      [undefined, 1],
    ]);
    expect(bar.props['aria-label']).toBe(
      zhf('projects.row.goalBar', { done: 7, running: 3, failed: 1, rest: 1 }),
    );
  });

  it('keeps the trend of the last 14 days of done tasks', () => {
    const line = find(row(full), (n) => n.type === 'polyline');
    expect(line.props.points.trim().split(/\s+/)).toHaveLength(14);
    expect(find(row(full), (n) => n.type === 'svg').props['aria-label']).toContain('13');
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
    await byLabel(row(full), label).props.onClick();
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

  it('shows the needs-you count with the waiting glyph and how long the oldest item has waited', () => {
    const needs = cells(row(full, NOW - 18 * MINUTE))[4]!;
    expect(text(byLabel(needs, needsYou))).toBe('4');
    expect(named(byLabel(needs, needsYou), 'StateGlyph').props.name).toBe('approval');
    expect(text(needs)).toBe('418 分钟');
    expect(text(cells(row(full))[4])).toBe('4');
  });

  const need = (
    decision: NeedsYouItem['decision'],
    blocks: number,
    extra: Partial<NeedsYouItem> = {},
  ): NeedsYouItem => ({
    source: { table: 'approvals', id: `${decision}-${blocks}`, revision: 1 },
    kind: 'permission',
    project_id: 'project-b',
    status: 'pending',
    created_at: NOW - 5 * MINUTE,
    reason: 'permission_requested',
    decision,
    blocks,
    actions: [],
    ...extra,
  });
  const kindName = (key: string) => zh(`data.attention.decision.${key}`);
  const byKind = (tree: any) => byLabel(cells(tree)[4], zh('projects.row.byKind'));

  it('shows the item blocking the most and what waits by kind, the kind blocking the most first', () => {
    const tree = row(full, null, [
      need('question', 2),
      need('plan_change', 3, {
        kind: 'board.lane.approval',
        reason: 'lane_plan_awaiting_approval',
        lane_title: 'Refund audit log',
      }),
    ]);
    const group = byKind(tree);
    expect(group.props.role).toBe('group');
    expect(buttons(group).map((b) => b.props['aria-label'])).toEqual([
      zhf('projects.row.kindCount', { kind: kindName('planChange'), count: 1, blocks: 3 }),
      zhf('projects.row.kindCount', { kind: kindName('question'), count: 1, blocks: 2 }),
    ]);
    const needs = text(cells(tree)[4]);
    expect(needs).toContain('Refund audit log');
    expect(needs).toContain(zhf('data.attention.blocks', { count: 3 }));
    buttons(group)[1]!.props.onClick();
    expect(mock.current.choose).toHaveBeenCalledWith('project-b');
    expect(mock.shell.openSessionGroup).toHaveBeenCalledWith('inbox');
  });

  it('shows four kinds and names the rest in one count', () => {
    const tree = row(
      full,
      null,
      (
        [
          'plan_change',
          'question',
          'repeated_failure',
          'permission',
          'budget',
          'agent_proposal',
        ] as const
      ).map((decision, i) => need(decision, 6 - i)),
    );
    const labels = buttons(byKind(tree)).map((b) => b.props['aria-label']);
    expect(labels).toHaveLength(5);
    expect(labels[3]).toBe(
      zhf('projects.row.kindCount', { kind: kindName('permission'), count: 1, blocks: 3 }),
    );
    expect(labels[4]).toBe(
      zhf('projects.row.otherKinds', {
        count: 2,
        kinds: [kindName('budget'), kindName('agentProposal')].join('，'),
      }),
    );
    expect(text(buttons(byKind(tree))[4])).toBe(zhf('projects.row.other', { count: 2 }));
  });

  it('leaves the wait out until the oldest item has waited a minute', () => {
    expect(text(cells(row(full, NOW - 20_000))[4])).toBe('4');
    expect(text(cells(row(full, NOW - MINUTE))[4])).toBe('41 分钟');
  });

  it('dims an idle project and puts its last activity in the goal column and dashes after it', () => {
    const idle = row(summary('project-b', { last_activity_at: '2026-10-28T12:00:00.000Z' }));
    expect(idle.props.className).toBe('pr-row pr-idle');
    const [, , goal, sessions, needs] = cells(idle);
    expect(text(goal)).toBe('上次活动 6 天');
    expect(text(sessions)).toBe('—');
    expect(text(needs)).toBe('—');
    expect(text(cells(row(summary('project-b')))[2])).toBe(zh('projects.row.noGoal'));
  });

  it('keeps a project with sessions undimmed, without a goal and with a dash for needs-you', () => {
    const busy = row(
      summary('project-b', {
        counts: { running: 0, waiting: 0, ready: 1, failed: 0, queued: 0 },
        last_activity_at: '2026-10-28T12:00:00.000Z',
      }),
    );
    expect(busy.props.className).toBe('pr-row');
    const [, , goal, , needs] = cells(busy);
    expect(text(goal)).toBe(zh('projects.row.noGoal'));
    expect(text(needs)).toBe('—');
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

  it('adds up needs-you across projects, running with the queue, ready and merged today', () => {
    const tree = SummaryPanel({
      summaries: [
        summary('a', {
          needs_you: 3,
          counts: { running: 2, waiting: 0, ready: 1, failed: 0, queued: 1 },
          merged_today: 4,
        }),
        summary('b', {
          needs_you: 1,
          counts: { running: 1, waiting: 1, ready: 0, failed: 2, queued: 2 },
          merged_today: 5,
        }),
        summary('c', { counts: { running: 0, waiting: 0, ready: 2, failed: 0, queued: 0 } }),
      ],
      needs: asks,
    });
    const labels = ['needsYou', 'running', 'ready', 'mergedToday'].map((k) =>
      zh(`projects.summary.${k}`),
    );
    expect(shown(tree).map(text)).toEqual(
      ['4跨 2 个项目', '3排队 3', '3', '9'].map((value, i) => labels[i] + value),
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
        summary('a', { counts: { running: 1, waiting: 0, ready: 1, failed: 0, queued: 0 } }),
        summary('b', { counts: { running: 0, waiting: 0, ready: 0, failed: 0, queued: 2 } }),
        summary('c', { counts: { running: 0, waiting: 0, ready: 3, failed: 0, queued: 0 } }),
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

  it('heads the table with the project, goal, sessions and needs-you columns', async () => {
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    await h.flush();
    const table = find(h.value, (n) => n.props.role === 'table');
    expect(
      nodes(table)
        .filter((n) => n.props.role === 'columnheader')
        .map(text)
        .filter(Boolean),
    ).toEqual(['project', 'goal', 'sessions', 'needsYou'].map((k) => zh(`projects.table.${k}`)));
    const rows = nodes(table).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'ProjectRow',
    );
    expect(rows.map((r) => [r.props.project.id, r.props.oldestWait])).toEqual([
      ['alpha', NOW - 30 * MINUTE],
      ['beta', null],
    ]);
    expect(
      named(h.value, 'SummaryPanel').props.summaries.map((s: ProjectSummary) => s.project_id),
    ).toEqual(['alpha']);
  });

  it('lists no row for the personal agent’s home and opens the personal agent from the bar', async () => {
    mock.board.board.projects.push({ ...project('home'), roots: [], kind: 'personal' });
    mock.board.refresh = () => {};
    mock.shell.openPersonal = vi.fn();
    const command = vi.fn(async () => ({ ok: true, value: { id: 'personal-1' } }));
    window.pantheon!.command = command as never;
    const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
    await h.flush();
    const table = find(h.value, (n) => n.props.role === 'table');
    expect(
      nodes(table)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'ProjectRow')
        .map((r) => r.props.project.id),
    ).toEqual(['alpha', 'beta']);
    expect(zh('projects.personalAgent')).toBe('个人级智能体');
    // Two items wait in alpha; the one of a project not listed is not counted.
    const entry = byLabel(
      h.value,
      [zh('projects.personalAgent'), zhf('projects.personalAgentWaits', { count: 2 })].join(
        zh('sessions.screen.separator'),
      ),
    );
    expect(text(entry)).toBe(`${zh('projects.personalAgent')}2`);
    entry.props.onClick();
    await h.flush();
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resident.open', input: { kind: 'personal' } }),
    );
    expect(mock.shell.openPersonal).toHaveBeenCalledWith('personal-1');
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
    const table = find(h.value, (n) => n.props.role === 'table');
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
  ])(
    'puts the personal agent, import and open in the bar and no filter %s',
    async (_name, projects) => {
      mock.board = { ...mock.board, board: { cursor: 1, projects, project_briefs: [] } };
      const h = mount(() => ProjectsScreen({ onOpenSettings() {}, onOpenProject() {} }));
      await h.flush();
      expect(nodes(h.value).some((n) => n.type === 'input')).toBe(false);
      const bar = named(h.value, 'TopBar');
      // The personal agent's button counts the two items waiting in alpha once alpha is listed.
      expect(buttons(bar).map(text)).toEqual([
        `${zh('projects.personalAgent')}${projects.length ? '2' : ''}`,
        zh('projects.import.open'),
      ]);
      expect(named(bar, 'OpenProjectButton')).toBeTruthy();
    },
  );

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

  it.each(['board.plan_updated', 'board.plan_transferred'])(
    'reads the summary again after %s, which changes the progress',
    async (kind) => {
      const h = mount(() => useProjectsSummary());
      await h.flush();
      mock.board = { ...mock.board, events: [event(1, 'project-b', kind)] };
      h.render();
      await vi.advanceTimersByTimeAsync(2_500);
      await h.flush();
      expect(reads).toEqual(['projects.summary', 'projects.summary']);
    },
  );

  it('reads the summary again at the next local midnight, for the new day', async () => {
    vi.setSystemTime(new Date(2026, 10, 3, 23, 59, 0));
    const h = mount(() => useProjectsSummary());
    await h.flush();
    await vi.advanceTimersByTimeAsync(59_000);
    await h.flush();
    expect(reads).toEqual(['projects.summary']);
    await vi.advanceTimersByTimeAsync(1_000);
    await h.flush();
    expect(reads).toEqual(['projects.summary', 'projects.summary']);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await h.flush();
    expect(reads).toHaveLength(3);
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
        blocks: 0,
        actions: [],
      }) as NeedsYouItem;
    mock.board.board.projects.push(project('gamma'));
    items = [wait('a1', 'alpha'), wait('a2', 'alpha'), wait('g1', 'gamma')];
    summaries = [
      { ...summaries[0]!, needs_you: 2 },
      summaries[1]!,
      summary('gamma', { needs_you: 1, last_activity_at: '2026-11-03T09:00:00.000Z' }),
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
      zhf('projects.row.kindCount', {
        kind: zh('data.attention.decision.permission'),
        count: n,
        blocks: 0,
      });
    expect(rowNodes().map((r) => r.props.project.id)).toEqual(['alpha', 'gamma', 'beta']);
    expect(text(byLabel(rowOf('alpha'), zhf('projects.row.needsYou', { count: 2 })))).toBe('2');
    expect(text(asks().props.trigger)).toBe(
      `${zh('projects.summary.needsYou')}3${zhf('projects.summary.across', { count: 2 })}`,
    );

    items = [wait('a2', 'alpha')];
    summaries = [
      { ...summaries[0]!, needs_you: 1 },
      summaries[1]!,
      { ...summaries[2]!, needs_you: 0 },
    ];
    mock.board = { ...mock.board, events: [event(1, 'gamma', 'approval.resolved')] };
    h.render();
    await vi.advanceTimersByTimeAsync(2_500);
    await h.flush();
    expect(rowNodes().map((r) => r.props.project.id)).toEqual(['alpha', 'gamma', 'beta']);
    const alpha = rowOf('alpha');
    expect(text(byLabel(alpha, zhf('projects.row.needsYou', { count: 1 })))).toBe('1');
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
    const bodyRows = () =>
      nodes(find(h.value, (n) => n.props.role === 'table')).filter(
        (n) =>
          (n.props.role === 'row' && !nodes(n).some((c) => c.props.role === 'columnheader')) ||
          (typeof n.type === 'function' && n.type.name === 'ProjectRow'),
      );
    expect(named(h.value, 'SummaryPanel')).toBeTruthy();
    expect(bodyRows()).toHaveLength(2);
    expect(projectRows()).toEqual([]);
    await h.flush();
    expect(bodyRows()).toHaveLength(2);
    expect(projectRows().map((r) => r.props.project.id)).toEqual(['beta', 'alpha']);
  });
});
