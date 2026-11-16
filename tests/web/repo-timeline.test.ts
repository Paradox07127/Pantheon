import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { RepoLane, RepoTimeline } from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
const reads = vi.hoisted(() => {
  const landed = <T>(data: T) => ({
    data,
    read: data,
    loading: false,
    refreshing: false,
    stale: false,
    unavailable: false,
    error: null,
    reload() {},
  });
  const state = { timeline: null as unknown, stories: landed([] as unknown[]) };
  return {
    landed,
    state,
    useRepoTimeline: vi.fn(() => state.timeline),
    useProjectQuery: vi.fn((method: string) =>
      method === 'range_story.list' ? state.stories : landed(null),
    ),
    sendProjectCommand: vi.fn(),
    openRepoView: vi.fn(),
  };
});
vi.mock('@/data/repo', async (actual) => ({
  ...(await actual<object>()),
  useRepoTimeline: reads.useRepoTimeline,
}));
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: reads.useProjectQuery,
  sendProjectCommand: reads.sendProjectCommand,
}));
vi.mock('@/screens/repo/route', async (actual) => ({
  ...(await actual<object>()),
  openRepoView: reads.openRepoView,
}));
import { runtimeName } from '@/components/RuntimeGlyph';
import { RepoLanes } from '@/screens/repo/timeline/RepoLanes';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 15, 16);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const lane = (over: Partial<RepoLane> & Pick<RepoLane, 'key' | 'label' | 'kind'>): RepoLane => ({
  spans: [],
  gates: [],
  ...over,
});
const timeline = (lanes: RepoLane[]): RepoTimeline => ({
  from: NOW - 14 * DAY,
  to: NOW,
  bin_ms: DAY,
  lanes,
  releases: [],
  totals: { commits: 12, merges: 3, gate_runs: 4, gate_first_pass: null },
  overview: Array.from({ length: 20 }, (_, i) => ({
    start: NOW - (20 - i) * WEEK,
    agent: i,
    user: 2,
  })),
  extent: { first: NOW - 30 * DAY, last: NOW - 2 * DAY },
});
const refundSpan = {
  session_id: 'refund-list',
  title: 'Refund list page',
  branch: 'pt/refund-list',
  start: NOW - 5 * DAY,
  end: null,
  state: 'review' as const,
};
const lanes = [
  lane({
    key: 'main',
    label: 'main',
    kind: 'main',
    bins: [
      { start: NOW - 14 * DAY, commits: 4, merges: 2 },
      { start: NOW - 13 * DAY, commits: 1, merges: 1 },
    ],
  }),
  lane({
    key: 'refunds',
    label: 'Refunds v2',
    kind: 'workstream',
    spans: [refundSpan],
    points: [{ sha: 'a'.repeat(40), at: NOW - 2 * DAY, kind: 'commit', session_id: 'refund-list' }],
  }),
  lane({ key: 'other', label: 'other', kind: 'other', merged_lanes: 3, bins: [] }),
];

let stored: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  stored = new Map();
  reads.state.timeline = reads.landed(timeline(lanes));
  reads.state.stories = reads.landed([]);
  reads.useRepoTimeline.mockClear();
  reads.sendProjectCommand.mockReset();
  reads.openRepoView.mockClear();
  mock.board = { board: null, status: { state: 'live' } };
  mock.shell = {};
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const lanesOf = (projectId: string, onOpenSession = vi.fn()) =>
  mount(() => RepoLanes({ projectId, onOpenSession }));
const laneGroup = (tree: unknown, name: string) =>
  find(tree as never, (n) => n.props.role === 'group' && n.props['aria-label'] === name);
const button = (tree: unknown, label: string) =>
  nodes(tree as never).find((n) => n.type === 'button' && text(n.props.children) === label);
const zoomGroup = (tree: unknown) =>
  find(tree as never, (n) => n.props['aria-label'] === zh('repo.timeline.zoom'));
const groupRadios = (tree: unknown) =>
  find(tree as never, (n) => n.props['aria-label'] === zh('repo.timeline.group'));
const lastRange = () => reads.useRepoTimeline.mock.calls.at(-1);
const ranges = () => new Set(reads.useRepoTimeline.mock.calls.map((c) => JSON.stringify(c)));

describe('repository timeline lanes', () => {
  it('reads each zoom over its span ending now, grouped as it groups, and keeps it per project', () => {
    const host = lanesOf('lanes-zoom');
    expect(zoomGroup(host.value).props.value).toBe('fortnight');
    expect(lastRange()).toEqual(['lanes-zoom', NOW - 14 * DAY, NOW, 'workstream']);
    zoomGroup(host.value).props.onValueChange('quarter');
    host.render();
    expect(lastRange()).toEqual(['lanes-zoom', NOW - 90 * DAY, NOW, 'workstream']);
    zoomGroup(host.value).props.onValueChange('today');
    host.render();
    expect(lastRange()).toEqual(['lanes-zoom', NOW - 4 * HOUR, NOW, 'branch']);
    expect(stored.get('pantheon.repo.timeline-zoom.lanes-zoom')).toBe('today');
    expect(zoomGroup(lanesOf('lanes-zoom').value).props.value).toBe('today');
    expect(zoomGroup(lanesOf('lanes-zoom-other').value).props.value).toBe('fortnight');
  });

  it('groups lanes as the zoom does until a grouping is picked, then keeps it per project', () => {
    const host = lanesOf('lanes-group');
    const radios = () => groupRadios(host.value);
    expect(text(radios())).toBe(
      zh('repo.timeline.groupWorkstream') +
        zh('repo.timeline.groupBranch') +
        zh('repo.timeline.groupAuthor'),
    );
    expect(radios().props.value).toBe('workstream');
    zoomGroup(host.value).props.onValueChange('today');
    host.render();
    expect(radios().props.value).toBe('branch');
    radios().props.onValueChange('author');
    host.render();
    expect(lastRange()).toEqual(['lanes-group', NOW - 4 * HOUR, NOW, 'author']);
    expect(stored.get('pantheon.repo.timeline-group.lanes-group')).toBe('author');
    zoomGroup(host.value).props.onValueChange('quarter');
    host.render();
    expect(lastRange()).toEqual(['lanes-group', NOW - 90 * DAY, NOW, 'author']);
    expect(groupRadios(lanesOf('lanes-group').value).props.value).toBe('author');
    expect(groupRadios(lanesOf('lanes-group-other').value).props.value).toBe('workstream');
  });

  it('fits the range to the first and last commit of the history until a zoom is picked', () => {
    const host = lanesOf('lanes-fit');
    const fit = () => button(host.value, zh('repo.timeline.fitAll'))!;
    expect(fit().props.disabled).toBe(false);
    fit().props.onClick();
    host.render();
    expect(lastRange()).toEqual(['lanes-fit', NOW - 30 * DAY, NOW - 2 * DAY + 1, 'workstream']);
    expect(zoomGroup(host.value).props.value).toBe('');
    zoomGroup(host.value).props.onValueChange('fortnight');
    host.render();
    expect(lastRange()).toEqual(['lanes-fit', NOW - 14 * DAY, NOW, 'workstream']);
    expect(zoomGroup(host.value).props.value).toBe('fortnight');
    reads.state.timeline = reads.landed({ ...timeline(lanes), extent: null });
    host.render();
    expect(fit().props.disabled).toBe(true);
  });

  it('opens on the history from its first commit to now while it is younger than two weeks', () => {
    reads.state.timeline = reads.landed({
      ...timeline(lanes),
      extent: { first: NOW - 6 * HOUR, last: NOW - HOUR },
    });
    const host = lanesOf('lanes-young');
    const [, from, to] = lastRange() as unknown as [string, number, number];
    expect(to).toBe(NOW);
    expect(from).toBeLessThanOrEqual(NOW - 6 * HOUR);
    expect(from).toBeGreaterThan(NOW - 7 * HOUR);
    expect(zoomGroup(host.value).props.value).toBe('');
    const picked = lanesOf('lanes-young-picked');
    zoomGroup(picked.value).props.onValueChange('fortnight');
    picked.render();
    expect(lastRange()).toEqual(['lanes-young-picked', NOW - 14 * DAY, NOW, 'workstream']);
    expect(zoomGroup(lanesOf('lanes-young-picked').value).props.value).toBe('fortnight');
  });

  it('writes no gate first-pass rate for a range without merges', () => {
    reads.state.timeline = reads.landed({
      ...timeline(lanes),
      totals: { commits: 20, merges: 0, gate_runs: 1, gate_first_pass: 0 },
    });
    const host = lanesOf('lanes-no-merges');
    const cell = find(host.value, (n) =>
      text(n.props.children).startsWith(zh('repo.timeline.kpiGate')),
    );
    expect(text(cell.props.children)).toBe(`${zh('repo.timeline.kpiGate')}—`);
  });

  it('names a runtime lane by its runtime and heads lanes by author as authors', () => {
    reads.state.timeline = reads.landed(
      timeline([
        lanes[0]!,
        lane({ key: 'runtime:claude', label: 'claude', kind: 'runtime', points: [] }),
        lane({ key: 'author:Ana Example', label: 'Ana Example', kind: 'author', points: [] }),
      ]),
    );
    const tree = lanesOf('lanes-author').value;
    expect(laneGroup(tree, runtimeName('claude'))).toBeDefined();
    expect(laneGroup(tree, 'Ana Example')).toBeDefined();
    expect(
      nodes(tree).some(
        (n) => n.type === 'span' && text(n.props.children) === zh('repo.timeline.byAuthor'),
      ),
    ).toBe(true);
  });

  it('draws a binned lane as bars and no commit points, and a lane with points as points', () => {
    const tree = lanesOf('lanes-bins').value;
    const main = laneGroup(tree, 'main');
    const marks = find(main.props.children, (n) => n.props.role === 'img');
    const titled = nodes(marks).filter((n) => typeof n.props.title === 'string');
    expect(titled).toHaveLength(2);
    expect(titled[0]!.props.title.endsWith(zhf('repo.timeline.merges', { count: 2 }))).toBe(true);
    expect(titled[1]!.props.title.endsWith(zhf('repo.timeline.merges', { count: 1 }))).toBe(true);
    expect(nodes(main.props.children).some((n) => n.type === 'button')).toBe(false);
    const refunds = laneGroup(tree, 'Refunds v2');
    const points = nodes(refunds.props.children).filter(
      (n) => n.type === 'button' && String(n.props['aria-label']).includes('aaaaaaa'),
    );
    expect(points).toHaveLength(1);
    expect(points[0]!.props.title).toBe(points[0]!.props['aria-label']);
    const chart = find(refunds.props.children, (n) => n.props.role === 'img');
    expect(chart.props['aria-label']).toContain('Refunds v2');
  });

  it('titles a lane’s name with its whole text and keeps it as the lane’s name', () => {
    const long = 'Refund list page with its ledger export and the settlement report';
    reads.state.timeline = reads.landed(
      timeline([lane({ key: 'long', label: long, kind: 'workstream', points: [] })]),
    );
    const group = laneGroup(lanesOf('lanes-title').value, long);
    expect(text(find(group.props.children, (n) => n.props.title === long))).toBe(long);
  });

  it('names the folded lane and how many lanes it holds', () => {
    const other = laneGroup(lanesOf('lanes-other').value, zh('repo.timeline.otherLane'));
    expect(text(other.props.children)).toContain(zhf('repo.timeline.mergedLanes', { count: 3 }));
  });

  it('moves the range only once the overview frame is let go', () => {
    const host = lanesOf('lanes-drag');
    const brush = () => find(host.value, (n) => n.props.role === 'slider');
    expect(brush().props['aria-label']).toBe(zh('repo.timeline.brush'));
    const before = ranges();
    brush().props.onPointerDown({
      pointerId: 1,
      clientX: 400,
      currentTarget: { setPointerCapture() {}, parentElement: { clientWidth: 500 } },
    });
    host.render();
    brush().props.onPointerMove({ clientX: 350 });
    host.render();
    brush().props.onPointerMove({ clientX: 300 });
    host.render();
    expect(ranges()).toEqual(before);
    brush().props.onPointerUp({});
    host.render();
    host.render();
    // 100px of a 500px strip over 20 weeks is four weeks back.
    const end = NOW - 4 * WEEK;
    expect(lastRange()).toEqual(['lanes-drag', end - 14 * DAY, end, 'workstream']);
    expect(ranges().size).toBe(before.size + 1);
  });

  it('interprets the range only when asked, and drops the interpretation once the range moves', async () => {
    const host = lanesOf('lanes-story');
    const start = () => button(host.value, zh('repo.timeline.storyStart'));
    expect(start()).toBeDefined();
    reads.sendProjectCommand.mockResolvedValue({ ok: true, receipt: {}, value: {} });
    start()!.props.onClick();
    await host.flush();
    expect(reads.sendProjectCommand).toHaveBeenCalledTimes(1);
    expect(reads.sendProjectCommand).toHaveBeenCalledWith(
      'range_story.start',
      { project_id: 'lanes-story', from: NOW - 14 * DAY, to: NOW },
      null,
    );

    reads.state.stories = reads.landed([
      {
        id: 'story-1',
        project_id: 'lanes-story',
        from: NOW - 14 * DAY,
        to: NOW,
        state: 'ready',
        session_id: 'story-session',
        created_at: new Date(NOW - 12 * 60_000).toISOString(),
        lines: ['Refunds v2 split into six branches.'],
      },
    ]);
    host.render();
    expect(text(host.value)).toContain('Refunds v2 split into six branches.');
    expect(start()).toBeUndefined();
    expect(button(host.value, zh('repo.timeline.storyAgain'))).toBeDefined();

    zoomGroup(host.value).props.onValueChange('quarter');
    host.render();
    expect(text(host.value)).not.toContain('Refunds v2 split into six branches.');
    expect(start()).toBeDefined();
    expect(reads.sendProjectCommand).toHaveBeenCalledTimes(1);
  });

  it('holds Interpret again while its request is out', async () => {
    reads.state.stories = reads.landed([
      {
        id: 'story-1',
        project_id: 'lanes-story-again',
        from: NOW - 14 * DAY,
        to: NOW,
        state: 'ready',
        session_id: 'story-session',
        created_at: new Date(NOW - 12 * 60_000).toISOString(),
        lines: ['Refunds v2 split into six branches.'],
      },
    ]);
    let answer!: (result: unknown) => void;
    reads.sendProjectCommand.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const host = lanesOf('lanes-story-again');
    const again = () => button(host.value, zh('repo.timeline.storyAgain'))!;
    expect(again().props.disabled).toBe(false);
    again().props.onClick();
    host.render();
    expect(again().props.disabled).toBe(true);
    answer({ ok: true, receipt: {}, value: {} });
    await host.flush();
    expect(again().props.disabled).toBe(false);
    expect(reads.sendProjectCommand).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['commits and no merges', 3, 0, false],
    ['merges', 0, 2, false],
    ['no commits or merges', 0, 0, true],
  ])('holds Interpret this range off only in a range with %s', (_name, commits, merges, off) => {
    reads.state.timeline = reads.landed({
      ...timeline([
        lane({
          key: 'main',
          label: 'main',
          kind: 'main',
          bins: [{ start: NOW - DAY, commits, merges: 0 }],
        }),
      ]),
      totals: { commits, merges, gate_runs: 0, gate_first_pass: null },
    });
    const host = lanesOf('lanes-story-empty');
    expect(button(host.value, zh('repo.timeline.storyStart'))!.props.disabled).toBe(off);
  });

  it.each([
    ['commits', 'commits', zh('repo.timeline.storyFromCommits')],
    ['merges', 'merges', zh('repo.timeline.storyFromMerges')],
    ['merges for a story without a source', undefined, zh('repo.timeline.storyFromMerges')],
  ])('names a story told from %s', (_name, source, chip) => {
    reads.state.stories = reads.landed([
      {
        id: 'story-1',
        project_id: 'lanes-story-source',
        from: NOW - 14 * DAY,
        to: NOW,
        state: 'ready',
        session_id: 'story-session',
        created_at: new Date(NOW - 12 * 60_000).toISOString(),
        lines: ['Refunds v2 split into six branches.'],
        ...(source ? { source } : {}),
      },
    ]);
    const tree = lanesOf('lanes-story-source').value;
    const story = nodes(tree).filter((n) => text(n.props.children) === chip);
    expect(story.length).toBeGreaterThan(0);
    const other =
      chip === zh('repo.timeline.storyFromCommits')
        ? zh('repo.timeline.storyFromMerges')
        : zh('repo.timeline.storyFromCommits');
    expect(text(tree)).not.toContain(other);
  });

  it.each([
    ['a new interpretation', [], 'repo.timeline.storyStart'],
    [
      'an interpretation again',
      [
        {
          id: 'story-1',
          project_id: 'lanes-story-fail',
          from: NOW - 14 * DAY,
          to: NOW,
          state: 'ready',
          session_id: 'story-session',
          created_at: new Date(NOW - 12 * 60_000).toISOString(),
          lines: ['Refunds v2 split into six branches.'],
          source: 'merges',
        },
      ],
      'repo.timeline.storyAgain',
    ],
  ])('shows why %s was refused at the story', async (_name, stories, id) => {
    reads.state.stories = reads.landed(stories);
    reads.sendProjectCommand.mockResolvedValue({
      ok: false,
      error: 'No merges or commits in the range',
    });
    const host = lanesOf('lanes-story-fail');
    button(host.value, zh(id))!.props.onClick();
    await host.flush();
    const alert = find(host.value, (n) => n.props.role === 'alert');
    expect(text(alert)).toBe('No merges or commits in the range');
  });

  it('opens the branch passage of a clicked span', () => {
    const onOpenSession = vi.fn();
    const host = lanesOf('lanes-pick', onOpenSession);
    const span = find(
      host.value,
      (n) => n.type === 'button' && String(n.props['aria-label']).startsWith(refundSpan.title),
    ) as ReactElement<any>;
    expect(span.props.title).toBe(span.props['aria-label']);
    span.props.onClick();
    host.render();
    const picked = find(host.value, (n) => n.props['aria-label'] === zh('repo.timeline.picked'));
    expect(text(picked)).toContain(refundSpan.title);
    expect(text(picked)).toContain(refundSpan.branch);
    expect(text(picked)).toContain(zh('repo.timeline.state.review'));
    button(picked, zh('repo.timeline.openPassage'))!.props.onClick();
    expect(reads.openRepoView).toHaveBeenCalledWith('lanes-pick', {
      kind: 'session',
      sessionId: refundSpan.session_id,
    });
    button(picked, zh('repo.timeline.openSession'))!.props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith(refundSpan.session_id);
  });
});
