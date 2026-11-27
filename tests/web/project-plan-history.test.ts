import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LandingRecord, PlanItem } from '@pantheon/domain';
import type {
  PlanItemView,
  PlanRevision,
  ProjectPlanView,
  WorkbenchSession,
} from '@pantheon/protocol';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const mock = vi.hoisted(() => ({
  plan: { read: null, error: null, loading: false, unavailable: false, stale: false } as any,
  history: { read: null, error: null, loading: false } as any,
  landings: { read: null, error: null, loading: false } as any,
  reloads: [] as string[],
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/project-plan', () => ({
  useProjectPlan: () => ({ ...mock.plan, reload() {} }),
}));
vi.mock('@/data/project-resident', () => ({
  // Read, with no resident: the main agent is the one active last.
  useProjectResident: () => ({
    read: {
      session_id: null,
      since: null,
      turns: { pantheon: 0, user: 0 },
      budget: null,
      wakes: [],
    },
    error: null,
    loading: false,
    reload() {},
  }),
}));
vi.mock('@/data/projects-summary', () => ({
  useProjectsSummary: () => ({ data: [], loading: false, error: null }),
}));
vi.mock('@/data/project-overlap', () => ({
  useProjectOverlap: () => ({ read: null, error: null, reload() {} }),
}));
vi.mock('@/data/plan-history', () => ({
  usePlanHistory: () => ({ ...mock.history, reload: () => mock.reloads.push('history') }),
  useLandingRecords: () => ({ ...mock.landings, reload: () => mock.reloads.push('landings') }),
}));
vi.mock('@/data/needs-you', async (actual) => ({
  ...(await actual<object>()),
  useNow: () => Date.parse('2026-11-26T12:00:00.000Z'),
}));
import { Clip } from '@/components/Clip';
import { Failure } from '@/components/PanelBoundary';
import { dayText } from '@/lib/time-text';
import { ItemInspector } from '@/screens/project/ItemInspector';
import { PlanHistory } from '@/screens/project/PlanHistory';
import { PlanList } from '@/screens/project/PlanList';
import { planTimeline } from '@/screens/project/plan-timeline';
import { ProjectScreen } from '@/screens/project/ProjectScreen';
import { zh, zhf } from './i18n-setup.js';

const T1 = Date.parse('2026-11-26T09:00:00.000Z');
const T2 = Date.parse('2026-11-26T09:30:00.000Z');
const T3 = Date.parse('2026-11-26T10:00:00.000Z');
const time = (at: number) => dayText(at, NOW, { time: true });

const planned = (id: string, extra: Partial<PlanItem> = {}): PlanItem => ({
  id,
  title: `Title of ${id}`,
  ...extra,
});
const revision = (
  number: number,
  at: number,
  items: PlanItem[],
  extra: Partial<PlanRevision> = {},
): PlanRevision => ({
  revision: number,
  updated_at: new Date(at).toISOString(),
  author: 'lead',
  milestones: [{ id: 'signatures', title: 'Signature checks' }],
  items,
  changes: { added: [], removed: [], status_changed: [], moved: [] },
  replan: false,
  ...extra,
});
const landing = (
  session_id: string,
  ended_at: number,
  state: LandingRecord['state'],
): LandingRecord => ({
  id: `landing-${session_id}-${ended_at}`,
  revision: 1,
  project_id: 'alpha',
  session_id,
  state,
  reason: null,
  ended_at,
  landed_sha: state === 'landed' ? 'a41c9e2f' : null,
  gate_runs: 1,
  first_gate_passed: true,
  review_rounds: 0,
  turns: 1,
  input_tokens: 0,
  output_tokens: 0,
  wall_ms: null,
});

// Two items, then a third under a second milestone, then the second removed and the first moved.
const REVISIONS = [
  revision(1, T1, [
    planned('parser', { milestone: 'signatures', session_ids: ['s-parser'] }),
    planned('printer', { milestone: 'signatures', session_ids: ['s-printer'] }),
  ]),
  revision(
    2,
    T2,
    [
      planned('parser', { milestone: 'signatures', session_ids: ['s-parser'] }),
      planned('printer', { milestone: 'signatures', session_ids: ['s-printer'] }),
      planned('audit', { milestone: 'audit', session_ids: ['s-audit'] }),
    ],
    {
      milestones: [
        { id: 'signatures', title: 'Signature checks' },
        { id: 'audit', title: 'Audit log' },
      ],
    },
  ),
  revision(
    3,
    T3,
    [
      planned('parser', { milestone: 'audit', session_ids: ['s-parser'] }),
      planned('audit', { milestone: 'audit', session_ids: ['s-audit'] }),
    ],
    {
      milestones: [
        { id: 'signatures', title: 'Signature checks' },
        { id: 'audit', title: 'Audit log' },
      ],
      changes: {
        added: [],
        removed: ['printer'],
        status_changed: [],
        moved: [{ id: 'parser', from: 'signatures', to: 'audit' }],
      },
      replan: true,
    },
  ),
].reverse();

const LANDINGS = [
  landing('s-parser', Date.parse('2026-11-26T09:45:00.000Z'), 'landed'),
  landing('s-audit', Date.parse('2026-11-26T10:30:00.000Z'), 'blocked'),
  // The printer's session lands after the revision that removed its item.
  landing('s-printer', Date.parse('2026-11-26T11:00:00.000Z'), 'landed'),
  landing('s-unnamed', Date.parse('2026-11-26T11:15:00.000Z'), 'landed'),
];

const view = (id: string, extra: Partial<PlanItemView> = {}): PlanItemView => ({
  id,
  title: `Title of ${id}`,
  stage: 'plan',
  status: 'not_started',
  gate_runs: [],
  ...extra,
});
const PLAN: NonNullable<ProjectPlanView['plan']> = {
  session_id: 'lead',
  conductor_open: true,
  revision: 3,
  updated_at: new Date(T3).toISOString(),
  milestones: [
    { id: 'signatures', title: 'Signature checks' },
    { id: 'audit', title: 'Audit log' },
  ],
  items: [view('parser', { milestone: 'audit' }), view('audit', { milestone: 'audit' })],
};

beforeEach(() => {
  mock.plan = { read: null, error: null, loading: false, unavailable: false, stale: false };
  mock.history = { read: { revisions: REVISIONS }, error: null, loading: false };
  mock.landings = { read: { landings: LANDINGS }, error: null, loading: false };
  mock.reloads = [];
});
afterEach(() => unmountAll());

const drawn = (onSelect: (id: string) => void = () => {}) =>
  mount(
    () => PlanHistory({ projectId: 'alpha', plan: PLAN, selected: null, onSelect }) as ReactElement,
  );
const rowsOf = (tree: unknown) => nodes(tree as ReactElement).filter((n) => n.type === 'li');
const imagesOf = (tree: unknown) =>
  nodes(tree as ReactElement)
    .filter((n) => n.props.role === 'img')
    .map((n) => n.props['aria-label'] as string);
const clipped = (tree: unknown) =>
  nodes(tree as ReactElement)
    .filter((n) => n.type === Clip)
    .map((n) => n.props.text as string);
// Axis shares compared to six places.
const share = (x: number) => Math.round(x * 1e6) / 1e6;

describe('the plan history', () => {
  it('draws a row per item from the revision that added it to the one that removed it', () => {
    const rows = rowsOf(drawn().value);
    expect(rows.map((row) => text(row))).toEqual([
      'Title of parser',
      'Title of printer',
      'Title of audit',
    ]);
    expect(rows.map((row) => imagesOf(row)[0])).toEqual([
      zhf('project.history.span.open', { added: time(T1) }),
      zhf('project.history.span.removed', { added: time(T1), ended: time(T3) }),
      zhf('project.history.span.open', { added: time(T2) }),
    ]);
    const timeline = planTimeline(REVISIONS, LANDINGS, NOW);
    expect(
      timeline.rows.map((row) => row.spans.map((span) => [share(span.x1), share(span.x2)])),
    ).toEqual([[[0, 1]], [[0, share(1 / 3)]], [[share(1 / 6), 1]]]);
  });

  it('ends the row of an item marked dropped at the revision that dropped it', () => {
    const dropped = [
      revision(1, T1, [planned('parser'), planned('printer')]),
      revision(2, T2, [planned('parser'), planned('printer', { dropped: true })]),
    ];
    const [parser, printer] = planTimeline(dropped, [], NOW).rows;
    expect(parser!.ended).toBeNull();
    expect(printer!.ended).toEqual({ at: T2, kind: 'dropped' });
    expect(share(printer!.spans[0]!.x2)).toBe(share(1 / 6));
  });

  it.each([
    ['removed', [planned('printer')], [planned('parser')], 'removed'],
    [
      'dropped',
      [planned('printer')],
      [planned('parser'), planned('printer', { dropped: true })],
      'dropped',
    ],
  ] as const)(
    'draws an item %s and later restored as two spans with the gap between them',
    (_, first, gap, kind) => {
      const back = [
        revision(1, T1, [planned('parser'), ...first]),
        revision(2, T2, [...gap]),
        revision(3, T3, [planned('parser'), planned('printer')]),
      ];
      const printer = planTimeline(back, [], NOW).rows.find((row) => row.id === 'printer')!;
      expect(printer.spans.map((span) => [span.added, span.ended])).toEqual([
        [T1, { at: T2, kind }],
        [T3, null],
      ]);
      expect(printer.ended).toBeNull();
    },
  );

  it('marks the replanning revision with the items it removed and moved', () => {
    const marks = nodes(drawn().value).filter(
      (n) => n.type === 'button' && n.props['aria-label'] !== undefined,
    );
    const lines = [
      zhf('project.history.replan', { time: time(T3) }),
      zhf('project.history.replan.removed', { items: 'Title of printer' }),
      zhf('project.history.replan.moved', {
        item: 'Title of parser',
        from: 'Signature checks',
        to: 'Audit log',
      }),
    ];
    expect(marks.map((mark) => mark.props['aria-label'])).toEqual([lines.join('，')]);
    const replans = planTimeline(REVISIONS, LANDINGS, NOW).replans;
    expect(replans.map((r) => [r.revision, share(r.x)])).toEqual([[3, share(1 / 3)]]);
  });

  it('puts a landing on the row of the item that named its session at the time', () => {
    const rows = rowsOf(drawn().value);
    expect(rows.map((row) => imagesOf(row).slice(1))).toEqual([
      [
        zhf('project.history.landing.landed', {
          time: time(Date.parse('2026-11-26T09:45:00.000Z')),
        }),
      ],
      [],
      [
        zhf('project.history.landing.blocked', {
          time: time(Date.parse('2026-11-26T10:30:00.000Z')),
        }),
      ],
    ]);
  });

  it('names each milestone where it first appears, above the rows', () => {
    expect(clipped(drawn().value)).toEqual([
      'Signature checks',
      'Audit log',
      'Title of parser',
      'Title of printer',
      'Title of audit',
      time(T1),
      time(NOW),
    ]);
    const milestones = planTimeline(REVISIONS, LANDINGS, NOW).milestones;
    expect(milestones.map((m) => [share(m.x), m.titles])).toEqual([
      [0, ['Signature checks']],
      [share(1 / 6), ['Audit log']],
    ]);
  });

  it('keeps a line per milestone and names milestones brought in a minute apart on one label', () => {
    const close = [
      revision(1, T1, [planned('parser')]),
      revision(2, T1 + 60_000, [planned('parser')], {
        milestones: [
          { id: 'signatures', title: 'Signature checks' },
          { id: 'audit', title: 'Audit log' },
        ],
      }),
    ];
    const milestones = planTimeline(close, [], NOW).milestones;
    expect(milestones.map((m) => [m.at, m.titles])).toEqual([
      [T1, ['Signature checks']],
      [T1 + 60_000, ['Audit log']],
    ]);
    mock.history = { read: { revisions: close }, error: null, loading: false };
    const tree = drawn().value;
    expect(nodes(tree).filter((n) => n.props.className === 'pj-hs-ml')).toHaveLength(2);
    expect(clipped(tree).filter((name) => name.includes('Audit log'))).toEqual([
      expect.stringMatching(/^Signature checks.+Audit log$/),
    ]);
  });

  it('names the milestones of a move as they were titled at the time', () => {
    const renamed = [
      ...REVISIONS,
      revision(4, NOW - 60_000, [planned('parser', { milestone: 'audit' })], {
        milestones: [
          { id: 'signatures', title: 'Signature checks' },
          { id: 'audit', title: 'Archive' },
        ],
      }),
    ];
    const [replan] = planTimeline(renamed, [], NOW).replans;
    expect(replan!.moved).toEqual([
      { title: 'Title of parser', from: 'Signature checks', to: 'Audit log' },
    ]);
  });

  it('selects the item of a row that is still in the plan, and offers no row of a removed item', () => {
    const picked: string[] = [];
    const rows = rowsOf(drawn((id) => picked.push(id)).value);
    // A click on the title button bubbles to the row unless the button stops it.
    const click = (row: ReactElement<any>, target: ReactElement<any>) => {
      const event = { stopped: false, stopPropagation: () => void (event.stopped = true) };
      target.props.onClick(event);
      if (!event.stopped && target !== row) row.props.onClick(event);
    };
    click(rows[0]!, rows[0]!);
    click(
      rows[2]!,
      find(rows[2], (n) => n.type === 'button'),
    );
    expect(picked).toEqual(['parser', 'audit']);
    expect(rows[1]!.props.onClick).toBeUndefined();
    expect(nodes(rows[1]).some((n) => n.type === 'button')).toBe(false);
  });

  it('says there are no revisions instead of drawing an empty chart', () => {
    mock.history = { read: { revisions: [] }, error: null, loading: false };
    const tree = drawn().value;
    expect(text(tree)).toContain(zh('project.history.empty'));
    expect(rowsOf(tree)).toEqual([]);
    expect(imagesOf(tree)).toEqual([]);
  });

  it('shows one failure line with a retry that reads both again when a read fails', () => {
    mock.landings = { read: null, error: 'The daemon did not answer', loading: false };
    const tree = drawn().value;
    const failures = nodes(tree).filter((n) => n.type === Failure);
    expect(failures.map((n) => n.props.error)).toEqual(['The daemon did not answer']);
    failures[0]!.props.onRetry();
    expect(mock.reloads).toEqual(['history', 'landings']);
    expect(rowsOf(tree)).toEqual([]);
  });
});

describe('the history view on the project screen', () => {
  const stored = new Map<string, string>();
  beforeEach(() => {
    stored.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
    mock.plan = { ...mock.plan, read: { plan: PLAN, unplanned: [] } };
  });
  afterEach(() => vi.unstubAllGlobals());

  const screen = () =>
    mount(
      () =>
        ProjectScreen({ projectId: 'alpha', sessions: [] as WorkbenchSession[] }) as ReactElement,
    );
  const radios = (tree: unknown) =>
    nodes(
      nodes(tree as ReactElement).find((n) => n.props['aria-label'] === zh('project.plan.view')),
    )
      .filter((n) => n.props.value !== undefined && n.props.onValueChange === undefined)
      .map((n) => n.props.value);

  it('offers the history beside the list without dependencies and keeps the choice per project', () => {
    const h = screen();
    expect(radios(h.value)).toEqual(['list', 'history']);
    nodes(h.value)
      .find((n) => n.props['aria-label'] === zh('project.plan.view'))!
      .props.onValueChange('history');
    h.render();
    expect(stored.get('pantheon.planView.alpha')).toBe('history');
    expect(nodes(h.value).some((n) => n.type === PlanList)).toBe(false);
    expect(find(h.value, (n) => n.type === PlanHistory).props.projectId).toBe('alpha');
  });

  it('opens the item inspector for the row picked in the history', () => {
    stored.set('pantheon.planView.alpha', 'history');
    const h = screen();
    find(h.value, (n) => n.type === PlanHistory).props.onSelect('audit');
    h.render();
    expect(find(h.value, (n) => n.type === ItemInspector).props.item.id).toBe('audit');
    expect(find(h.value, (n) => n.type === PlanHistory).props.selected).toBe('audit');
  });
});
