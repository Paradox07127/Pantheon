import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import type { RoleUsage } from '@pantheon/domain';
import { type HookHost, find, mount, named, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  events: [] as { sequence: number; kind: string }[],
  ticks: [] as number[],
  rows: null as unknown,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: ':r0:' }),
);
vi.mock('@/data/board', () => {
  const state = () => ({ events: mock.events });
  return { useBoard: Object.assign((selector: any) => selector(state()), { getState: state }) };
});
vi.mock('@/data/workbench-sessions', async (actual) => ({
  ...(await actual<object>()),
  useQuery: (_method: string, _key: string, _params: unknown, _accept: unknown, tick: number) => {
    mock.ticks.push(tick);
    return { data: mock.rows, loading: false, error: null, reload() {} };
  },
}));
vi.mock('@/screens/board/Charts', async (actual) => ({
  ...(await actual<object>()),
  useSize: () => [() => {}, { w: 400, h: 200 }],
}));
import { RoleUsageBars, RoleUsagePanel, UsageStackPanel } from '@/screens/board/UsageCharts';
import { zh } from './i18n-setup.js';

beforeEach(() => {
  mock.events = [];
  mock.ticks = [];
  mock.rows = null;
  // A shown tooltip listens for Escape.
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
});
afterEach(() => {
  unmountAll();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const models: BoardModel['models'] = [
  { runtime: 'claude', model: 'opus', first_seen: 1 },
  { runtime: 'codex', model: 'gpt-5', first_seen: 2 },
];

/** Mounts the usage stack chart switched to cost. */
function costChart(usage: BoardModel['usage']) {
  const panel = mount(() => UsageStackPanel({ model: { usage, models } as BoardModel }));
  find(
    panel.value.props.tools,
    (n) => n.props['aria-label'] === zh('board.usage.metric'),
  ).props.onValueChange('cost');
  panel.render();
  const chart = named(panel.value, 'StackChart');
  return mount(() => (chart.type as (props: unknown) => any)(chart.props));
}

/** The tooltip rows of one of two stack chart days, by its index. */
function dayTip(chart: HookHost<any>, index: number) {
  const svg = find(chart.value, (n) => n.type === 'svg');
  // The plot is 400px wide minus 48px on the left and 16px on the right, split over two days.
  svg.props.onPointerMove({
    clientX: 48 + 1 + index * 168,
    clientY: 0,
    currentTarget: { getBoundingClientRect: () => ({ left: 0 }) },
  });
  chart.render();
  return named(chart.value, 'FloatTip').props.content.rows as { label: string; value: string }[];
}

describe('usage stack with unknown costs', () => {
  const usage: BoardModel['usage'] = [
    { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: 0.5 },
    { day: '2026-11-02', runtime: 'codex', model: 'gpt-5', tokens: 200, cost_usd: null },
  ];

  it('shows a dash for the total of a day whose costs are all unknown', () => {
    const rows = dayTip(costChart(usage), 1);
    expect(rows.at(-1)).toEqual({ label: zh('board.charts.total'), value: '—' });
  });

  it('calls a total that leaves unknown costs out a known total', () => {
    const chart = costChart([
      ...usage,
      { day: '2026-11-02', runtime: 'claude', model: 'opus', tokens: 50, cost_usd: 0.25 },
    ]);
    expect(dayTip(chart, 1).at(-1)).toEqual({
      label: zh('board.charts.knownTotal'),
      value: '$0.25',
    });
    expect(dayTip(chart, 0).at(-1)).toEqual({ label: zh('board.charts.total'), value: '$0.50' });
    expect(find(chart.value, (n) => n.type === 'svg').props['aria-label']).toBe(
      '用量，按天堆叠各运行时的成本，已知合计 $0.75',
    );
  });
});

/** Mounts the usage stack panel on tokens, as a chart or as its table. */
function tokenPanel(usage: BoardModel['usage'], table = false) {
  const panel = mount(() => UsageStackPanel({ model: { usage, models } as BoardModel }));
  if (table) {
    find(panel.value.props.tools, (n) => typeof n.props.onToggle === 'function').props.onToggle();
    panel.render();
  }
  return panel;
}
const tokenChart = (usage: BoardModel['usage']) => {
  const chart = named(tokenPanel(usage).value, 'StackChart');
  return mount(() => (chart.type as (props: unknown) => any)(chart.props));
};
const tableRows = (usage: BoardModel['usage']) =>
  named(tokenPanel(usage, true).value, 'DataTable').props.rows as string[][];

describe('usage stack with sessions that reported no tokens', () => {
  const usage: BoardModel['usage'] = [
    { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: 0.5 },
    {
      day: '2026-11-02',
      runtime: 'codex',
      model: 'gpt-5',
      tokens: 200,
      cost_usd: null,
      sessions_without_usage: 1,
    },
  ];

  it('writes the totals that leave such sessions out with a plus', () => {
    const chart = tokenChart(usage);
    expect(dayTip(chart, 1).at(-1)).toEqual({ label: zh('board.charts.total'), value: '200+' });
    expect(dayTip(chart, 0).at(-1)).toEqual({ label: zh('board.charts.total'), value: '100' });
    expect(find(chart.value, (n) => n.type === 'svg').props['aria-label']).toBe(
      '用量，按天堆叠各运行时的 token，合计 300+',
    );
    expect(tableRows(usage).map((row) => row.at(-1))).toEqual(['100', '200+']);
  });

  it('writes the totals as before when every session reported its tokens', () => {
    const reported = usage.map(({ sessions_without_usage: _, ...row }) => row);
    const chart = tokenChart(reported);
    expect(dayTip(chart, 1).at(-1)).toEqual({ label: zh('board.charts.total'), value: '200' });
    expect(find(chart.value, (n) => n.type === 'svg').props['aria-label']).toBe(
      '用量，按天堆叠各运行时的 token，合计 300',
    );
    expect(tableRows(reported).map((row) => row.at(-1))).toEqual(['100', '200']);
  });
});

const roleRow = (cached: number | null): RoleUsage => ({
  role: 'main',
  sessions: 1,
  turns: 2,
  tool_calls: 0,
  input_tokens: 800,
  cached_input_tokens: cached,
  output_tokens: 200,
  turn_ms: 60_000,
  turns_without_usage: 0,
});

describe('usage by role with an unknown cache count', () => {
  it('says the cache is unknown in the tooltip and the label instead of zero', () => {
    const h = mount(() => RoleUsageBars({ rows: [roleRow(null)] }));
    const bar = find(h.value, (n) => n.props.role === 'img');
    expect(bar.props['aria-label']).toBe('会话：输入 800（缓存未知），输出 200');
    find(h.value, (n) => n.props.className === 'us-rrow').props.onPointerMove({
      clientX: 0,
      clientY: 0,
    });
    h.render();
    expect(named(h.value, 'FloatTip').props.content.rows[1]).toEqual({
      label: zh('board.usage.cachedInput'),
      value: '—',
    });
  });

  it('keeps a reported zero cache count as zero', () => {
    const h = mount(() => RoleUsageBars({ rows: [roleRow(0)] }));
    expect(find(h.value, (n) => n.props.role === 'img').props['aria-label']).toBe(
      '会话：输入 800（缓存 0），输出 200',
    );
  });

  it('shows a dash in the table for an unknown cache count', () => {
    mock.rows = [roleRow(null)];
    const h = mount(() => RoleUsagePanel({ projectId: 'project-a' }));
    named(h.value.props.tools, 'ViewToggle').props.onToggle();
    h.render();
    const body = named(h.value, 'QueryBody');
    const table = named(body.props.children(mock.rows), 'DataTable');
    expect(table.props.rows[0][4]).toBe('—');
  });
});

describe('usage by role refresh', () => {
  it.each(['turn.queued', 'agent.usage.updated', 'session.deleted'])(
    'reads role usage again after a %s event',
    (kind) => {
      vi.useFakeTimers();
      const h = mount(() => RoleUsagePanel({ projectId: 'project-a' }));
      const before = mock.ticks.at(-1);
      mock.events = [{ sequence: 5, kind }];
      h.render();
      vi.advanceTimersByTime(5000);
      h.render();
      expect(mock.ticks.at(-1)).not.toBe(before);
    },
  );
});
