import { describe, expect, it, vi } from 'vitest';
vi.mock('@/components/Tip', async () => {
  const { createElement } = await import('react');
  return {
    Tip: ({ content, children }: { content: string; children: unknown }) =>
      createElement('span', { 'data-tip': content }, children as never),
  };
});
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import { KpiTiles } from '@/screens/board/KpiTiles';
import { kpis } from '@/screens/board/usage-model';
import { zh, zhf } from './i18n-setup.js';

type Row = BoardModel['usage'][number];

// Seven days, 11-05 through 11-11 local time; the six days before 11-05 back to 10-29 are the previous period.
const SINCE = new Date(2026, 10, 5).getTime();
const NOW = new Date(2026, 10, 11, 12).getTime();

const row = (day: string, runtime: string, tokens: number, cost_usd: number | null): Row => ({
  day,
  runtime,
  model: null,
  tokens,
  cost_usd,
});

const usage = (
  rows: Row[],
  previous: Pick<NonNullable<BoardModel['counts']['previous']>, 'tokens' | 'cost_usd'> = {
    tokens: 0,
    cost_usd: null,
  },
): Pick<BoardModel, 'usage' | 'since' | 'now' | 'counts'> => ({
  since: SINCE,
  now: NOW,
  usage: rows,
  counts: {
    running: 0,
    waiting: 0,
    ready: 0,
    failed: 0,
    merged: 0,
    reverted: 0,
    median_ms: null,
    tokens: 0,
    tokens_by_runtime: {},
    cost_usd: null,
    previous: { ...previous, merged: 0, median_ms: null },
  },
});

const CURRENT = [
  row('2026-11-05', 'claude', 100, 0.5),
  row('2026-11-07', 'codex', 250, null),
  row('2026-11-11', 'claude', 200, 1),
];
const PREVIOUS = [
  row('2026-10-20', 'claude', 1000, 9),
  row('2026-10-30', 'claude', 100, 0.25),
  row('2026-11-03', 'codex', 100, null),
];

describe('usage key figures', () => {
  it('sums tokens and known cost, averages tokens per day and names the busiest runtime', () => {
    const k = kpis(usage(CURRENT));
    expect(k.days).toEqual([
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10',
      '2026-11-11',
    ]);
    expect(k.tokens.value).toBe(550);
    expect(k.tokens.bars).toEqual([100, 0, 250, 0, 0, 0, 200]);
    expect(k.cost.value).toBe(1.5);
    expect(k.cost.bars).toEqual([0.5, 0, 0, 0, 0, 0, 1]);
    expect(k.daily.value).toBeCloseTo(550 / 7);
    expect(k.runtime.runtime).toBe('claude');
    expect(k.runtime.value).toBe(300);
    expect(k.runtime.bars).toEqual([100, 0, 0, 0, 0, 0, 200]);
  });

  it('compares each figure with the same number of days before the range', () => {
    const k = kpis(usage([...PREVIOUS, ...CURRENT], { tokens: 200, cost_usd: 0.25 }));
    expect(k.tokens.change).toBeCloseTo(1.75);
    expect(k.cost.change).toBeCloseTo(5);
    expect(k.daily.change).toBeCloseTo(1.75);
    expect(k.runtime.change).toBeCloseTo(2);
    expect(k.tokens.value).toBe(550);
  });

  it.each<[string, Partial<Record<'tokens' | 'cost' | 'daily', number>>]>([
    [
      'compares tokens and cost when usage contains only the current range',
      { tokens: 1.75, cost: 5 },
    ],
    [
      'compares the daily average with previous counts when usage contains only the current range',
      { daily: 1.75 },
    ],
  ])('%s', (_name, changes) => {
    const k = kpis(usage(CURRENT, { tokens: 200, cost_usd: 0.25 }));
    for (const [figure, change] of Object.entries(changes))
      expect(k[figure as keyof typeof changes].change).toBeCloseTo(change);
  });

  it('uses previous counts when older usage rows disagree', () => {
    const k = kpis(usage([...PREVIOUS, ...CURRENT], { tokens: 1100, cost_usd: 3 }));
    expect(k.tokens.change).toBe(-0.5);
    expect(k.cost.change).toBe(-0.5);
  });

  it.each([null, 0])('omits changes for zero tokens and %s previous cost', (cost_usd) => {
    const k = kpis(usage([...PREVIOUS, ...CURRENT], { tokens: 0, cost_usd }));
    expect(k.tokens.change).toBeNull();
    expect(k.cost.change).toBeNull();
  });

  it('reports a complete decrease when current usage is zero', () => {
    const k = kpis(usage([row('2026-11-05', 'claude', 0, 0)], { tokens: 100, cost_usd: 1 }));
    expect(k.tokens.change).toBe(-1);
    expect(k.cost.change).toBe(-1);
  });

  it('leaves the comparison out when the days before the range have no usage', () => {
    const k = kpis(usage([row('2026-10-20', 'claude', 1000, 9), ...CURRENT]));
    expect(k.tokens.change).toBeNull();
    expect(k.cost.change).toBeNull();
    expect(k.daily.change).toBeNull();
    expect(k.runtime.change).toBeNull();
  });

  it('has no cost when every cost in the range is unknown', () => {
    const k = kpis(usage([row('2026-11-06', 'codex', 50, null)], { tokens: 100, cost_usd: 0.25 }));
    expect(k.cost.value).toBeNull();
    expect(k.cost.change).toBeNull();
    expect(k.tokens.value).toBe(50);
  });

  it('has no busiest runtime without usage in the range', () => {
    const k = kpis(usage([]));
    expect(k.tokens.value).toBe(0);
    expect(k.runtime.runtime).toBeNull();
    expect(k.runtime.value).toBeNull();
  });

  it('leaves the cost out of the key figures', () => {
    const model = usage(CURRENT, { tokens: 200, cost_usd: 0.25 }) as BoardModel;
    expect(renderToStaticMarkup(createElement(KpiTiles, { model }))).not.toContain('$');
  });

  it('writes the known tokens with a plus while sessions in the range reported none', () => {
    const tiles = (sessions_without_usage?: number) => {
      const model = usage(CURRENT) as BoardModel;
      model.counts.sessions_without_usage = sessions_without_usage;
      return renderToStaticMarkup(createElement(KpiTiles, { model }));
    };
    const partial = tiles(2);
    expect(partial).toContain(
      '<span data-tip="2 个会话没上报用量"><b tabindex="0">550+</b></span>',
    );
    const reported = tiles(undefined);
    expect(reported).toContain('<b>550</b>');
    expect(reported).not.toContain('data-tip');
  });

  it('writes a dash with the reason and no line or change for both token figures while no session reported usage', () => {
    const model = usage([], { tokens: 400, cost_usd: null }) as BoardModel;
    model.counts.sessions_without_usage = 3;
    model.counts.merged = 2;
    const html = renderToStaticMarkup(createElement(KpiTiles, { model }));
    const dash = '<span data-tip="3 个会话没上报用量"><b tabindex="0">—</b></span>';
    expect(html.split(dash)).toHaveLength(3);
    expect(html).not.toContain('0+');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain(zhf('board.kpi.down', { pct: '100%' }));
  });

  it('shows the share of input read from cache as the second of four cells, with last week beside it', () => {
    const tiles = (counts: Partial<BoardModel['counts']>) => {
      const model = usage(CURRENT) as BoardModel;
      Object.assign(model.counts, counts);
      return renderToStaticMarkup(createElement(KpiTiles, { model }));
    };
    const cache = (html: string) =>
      /缓存命中<\/span><span class="bd-kpi-v">(.*?)<\/span><\/div>/.exec(html)?.[1];
    const both = tiles({
      cache_read_share: 0.714,
      previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null, cache_read_share: 0.636 },
    });
    expect([...both.matchAll(/class="bd-kpi-k">([^<]+)</g)].map((m) => m[1])).toEqual([
      zh('board.kpi.tokens'),
      zh('board.kpi.cacheHits'),
      zh('insights.kpi.perMerge'),
      zh('insights.kpi.compacted'),
    ]);
    expect(cache(both)).toBe('<b>71%</b><span class="bd-kpi-n">上周 64%</span>');
    expect(cache(tiles({ cache_read_share: 0.5 }))).toBe('<b>50%</b>');
    expect(cache(tiles({}))).toBe('<b>—</b>');
  });
});
