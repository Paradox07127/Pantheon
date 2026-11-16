import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { UsageStackPanel } from '@/screens/board/UsageCharts';
import { zh } from './i18n-setup.js';

afterEach(() => unmountAll());

const models: BoardModel['models'] = [
  { runtime: 'claude', model: 'opus', first_seen: 1 },
  { runtime: 'codex', model: 'gpt-5', first_seen: 2 },
];

/** Mounts the usage stack switched to cost, as a table when asked. */
function costView(usage: BoardModel['usage'], table: boolean) {
  const h = mount(() => UsageStackPanel({ model: { usage, models } as BoardModel }));
  find(
    h.value.props.tools,
    (n) => n.props['aria-label'] === zh('board.usage.metric'),
  ).props.onValueChange('cost');
  h.render();
  if (table) {
    named(h.value.props.tools, 'ViewToggle').props.onToggle();
    h.render();
  }
  return h.value;
}

describe('usage cost', () => {
  const head = [zh('board.charts.date'), 'Claude', 'Codex', zh('board.charts.total')];
  it.each<[string, BoardModel['usage'], string[] | null, string[][]]>([
    [
      'shows an unknown cost as a dash, a known zero as $0.00 and a day without usage as $0.00',
      [
        { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: 0 },
        { day: '2026-11-01', runtime: 'codex', model: 'gpt-5', tokens: 200, cost_usd: null },
        { day: '2026-11-02', runtime: 'codex', model: 'gpt-5', tokens: 50, cost_usd: 0.5 },
      ],
      head,
      [
        ['2026-11-01', '$0.00', '—', '$0.00'],
        ['2026-11-02', '$0.00', '$0.50', '$0.50'],
      ],
    ],
    [
      'shows the dash for the total of a day whose costs are all unknown',
      [
        { day: '2026-11-01', runtime: 'codex', model: 'gpt-5', tokens: 200, cost_usd: null },
        { day: '2026-11-02', runtime: 'codex', model: 'gpt-5', tokens: 50, cost_usd: 0.5 },
      ],
      null,
      [
        ['2026-11-01', '—', '—'],
        ['2026-11-02', '$0.50', '$0.50'],
      ],
    ],
    [
      'keeps a model whose costs are all unknown as a column of dashes',
      [
        { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: 0.5 },
        { day: '2026-11-02', runtime: 'codex', model: 'gpt-5', tokens: 200, cost_usd: null },
      ],
      head,
      [
        ['2026-11-01', '$0.50', '$0.00', '$0.50'],
        ['2026-11-02', '$0.00', '—', '—'],
      ],
    ],
  ])('%s', (_name, usage, columns, rows) => {
    const table = named(costView(usage, true), 'DataTable');
    if (columns) expect(table.props.head).toEqual(columns);
    expect(table.props.rows).toEqual(rows);
  });

  it('charts known zero costs instead of saying no cost is known', () => {
    const tree = costView(
      [{ day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: 0 }],
      false,
    );
    expect(text(tree)).not.toContain(zh('board.usage.noKnownCost'));
    expect(named(tree, 'StackChart').props.days).toHaveLength(1);
  });

  it('says no cost is known when every cost is unknown', () => {
    const tree = costView(
      [{ day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: null }],
      false,
    );
    expect(named(tree, 'Empty').props.text).toBe(zh('board.usage.noKnownCost'));
  });

  it("keeps a runtime's cost unknown when one of its models has no cost that day", () => {
    const tree = costView(
      [
        { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: 1 },
        { day: '2026-11-01', runtime: 'claude', model: 'sonnet', tokens: 50, cost_usd: null },
      ],
      false,
    );
    const [day] = named(tree, 'StackChart').props.days;
    expect(day.parts.map((p: any) => [p.series.label, p.value])).toEqual([['Claude', 1]]);
    expect(day.unknown).toEqual([day.parts[0].series.key]);
  });

  it('keeps other runtimes unknown when one folded runtime has a cost and another has none', () => {
    const tree = costView(
      [
        { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 300, cost_usd: 1 },
        { day: '2026-11-01', runtime: 'codex', model: 'gpt-5', tokens: 200, cost_usd: 1 },
        { day: '2026-11-01', runtime: 'agy', model: null, tokens: 20, cost_usd: 0.1 },
        { day: '2026-11-01', runtime: 'grok', model: null, tokens: 10, cost_usd: null },
      ],
      false,
    );
    const [day] = named(tree, 'StackChart').props.days;
    const other = day.parts.find((p: any) => p.series.label === zh('insights.usage.otherRuntimes'));
    expect(other.value).toBe(0.1);
    expect(day.unknown).toEqual([other.series.key]);
  });

  it('shows a dash in the legend for a runtime whose costs are all unknown', () => {
    const tree = costView(
      [
        { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: 0.5 },
        { day: '2026-11-01', runtime: 'codex', model: 'gpt-5', tokens: 200, cost_usd: null },
        { day: '2026-11-02', runtime: 'codex', model: 'gpt-5', tokens: 50, cost_usd: null },
      ],
      false,
    );
    const legend = nodes(tree)
      .filter((n) => n.props.className === 'us-lgn')
      .map((n) => n.props.children);
    expect(legend).toEqual(['$0.50', '—']);
  });
});
