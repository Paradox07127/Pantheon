import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, BoardTaskStatus } from '@pantheon/protocol';
import { Milestones, spreadLabels } from '../../apps/web/src/screens/board/Charts.js';
import {
  FindingRow,
  FindingsPanel,
  MergesPanel,
  RisksPanel,
} from '../../apps/web/src/screens/board/Lists.js';
import { TrendPanel } from '../../apps/web/src/screens/board/ProgressCharts.js';
import { ProgressTable } from '../../apps/web/src/screens/board/ProgressTable.js';
import { UsageStackPanel } from '../../apps/web/src/screens/board/UsageCharts.js';
import { usageStack } from '../../apps/web/src/screens/board/usage-model.js';
import { dayText } from '@/lib/time-text';
import {
  groupTasks,
  tickLabels,
  timeTicks,
  usageSeries,
  visibleFindings,
  visibleMilestones,
} from '../../apps/web/src/screens/board/panels-model.js';
import { zh, zhf } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 1, 12);
const DAY = 86_400_000;

function emptyModel(): BoardModel {
  return {
    since: NOW - 7 * DAY,
    now: NOW,
    headline: null,
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
      previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
      cost_usd: null,
    },
    lanes: [],
    tasks: [],
    edges: [],
    milestones: [],
    burnup: [],
    goals: [],
    task_progress: {
      totals: {
        done: 0,
        running: 0,
        waiting: 0,
        idle: 0,
        ready: 0,
        failed: 0,
        discarded: 0,
        not_started: 0,
      },
      daily: [],
      cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
    },
    usage: [],
    models: [],
    merges: [],
    findings: [],
    risks: [],
  };
}

const task = (
  id: string,
  lane_id: string | null,
  status: BoardTaskStatus,
): BoardModel['tasks'][number] => ({
  id,
  title: id,
  goal: '',
  scope: [],
  lane_id,
  milestone_id: null,
  status,
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
});

const render = (type: unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(type as never, props as never));
const noop = () => {};

describe('board progress table model', () => {
  it('groups tasks by lane with unlaned tasks last and orders each group by status', () => {
    const model = {
      ...emptyModel(),
      lanes: [
        { id: 'adapters', title: '适配器' },
        { id: 'empty-lane', title: '空' },
        { id: 'board', title: '看板' },
      ],
      tasks: [
        task('loose', null, 'todo'),
        task('a-done', 'adapters', 'done'),
        task('a-discarded', 'adapters', 'discarded'),
        task('a-todo', 'adapters', 'todo'),
        task('a-ready', 'adapters', 'ready'),
        task('a-running', 'adapters', 'running'),
        task('a-failed', 'adapters', 'failed'),
        task('a-waiting', 'adapters', 'waiting'),
        task('b-done', 'board', 'done'),
      ],
    };
    const groups = groupTasks(model);
    expect(groups.map((g) => [g.id, g.title, g.done, g.total])).toEqual([
      ['adapters', '适配器', 1, 7],
      ['board', '看板', 1, 1],
      [null, zh('board.taskGroups.other'), 0, 1],
    ]);
    expect(groups[0]!.tasks.map((t) => t.status)).toEqual([
      'waiting',
      'failed',
      'running',
      'ready',
      'todo',
      'done',
      'discarded',
    ]);
  });
});

describe('board usage fills', () => {
  const models: BoardModel['models'] = [
    { runtime: 'codex', model: 'gpt-5', first_seen: 5 },
    { runtime: 'claude', model: 'sonnet', first_seen: 3 },
    { runtime: 'claude', model: 'opus', first_seen: 1 },
    { runtime: 'claude', model: 'haiku', first_seen: 7 },
    { runtime: 'claude', model: null, first_seen: 9 },
  ];

  it('gives the first model a solid fill, the second a hatch and folds the rest into other', () => {
    expect(usageSeries(models).map((s) => [s.label, s.fill])).toEqual([
      ['opus', 'solid'],
      ['sonnet', 'hatch'],
      [zhf('board.models.other', { runtime: 'Claude' }), 'other'],
      ['gpt-5', 'solid'],
    ]);
  });

  it('keeps fills when the range only holds later models', () => {
    const later = usageStack(
      {
        models,
        usage: [
          { day: '10-31', runtime: 'claude', model: 'sonnet', tokens: 10, cost_usd: null },
          { day: '10-31', runtime: 'claude', model: 'haiku', tokens: 5, cost_usd: 0.1 },
          { day: '10-31', runtime: 'claude', model: null, tokens: 5, cost_usd: null },
        ],
      },
      'tokens',
    );
    expect(later.series.map((s) => s.label)).toEqual([
      'sonnet',
      zhf('board.models.other', { runtime: 'Claude' }),
    ]);
    expect(later.days[0]!.parts.map((p) => [p.series.label, p.value])).toEqual([
      ['sonnet', 10],
      [zhf('board.models.other', { runtime: 'Claude' }), 10],
    ]);
  });

  it('names an unreported model after its runtime', () => {
    expect(usageSeries([{ runtime: 'codex', model: null, first_seen: 1 }])[0]!.label).toBe(
      zhf('board.models.unknown', { runtime: 'Codex' }),
    );
  });

  it('orders agy and grok after Codex and before another runtime, under their own names', () => {
    const series = usageSeries([
      { runtime: 'fixture', model: null, first_seen: 1 },
      { runtime: 'grok', model: null, first_seen: 2 },
      { runtime: 'agy', model: null, first_seen: 3 },
      { runtime: 'codex', model: 'gpt-5', first_seen: 4 },
    ]);
    expect(series.map((s) => s.label)).toEqual([
      'gpt-5',
      zhf('board.models.unknown', { runtime: 'agy' }),
      zhf('board.models.unknown', { runtime: 'grok' }),
      zhf('board.models.unknown', { runtime: 'fixture' }),
    ]);
  });
});

describe('board milestones', () => {
  type Status = BoardModel['milestones'][number]['status'];
  const ms = (id: string, merged: number, total: number, status: Status) => ({
    id,
    title: id,
    session_ids: Array.from({ length: total }, (_, n) => `${id}-${n}`),
    merged,
    status,
    criteria: [],
  });

  it('keeps creation order with accepted milestones last and folds rows past four', () => {
    const milestones = [
      ms('accepted', 3, 3, 'completed'),
      ms('first', 0, 2, 'active'),
      ms('stale', 1, 4, 'stale'),
      ms('ready', 1, 1, 'ready_for_acceptance'),
      ms('second', 1, 2, 'active'),
      ms('third', 0, 3, 'active'),
    ];
    const folded = visibleMilestones(milestones, false);
    expect(folded.rows.map((m) => m.id)).toEqual(['first', 'stale', 'ready', 'second']);
    expect(folded.hidden).toBe(2);
    const expanded = visibleMilestones(milestones, true);
    expect(expanded.rows.map((m) => m.id).slice(-2)).toEqual(['third', 'accepted']);
    expect(expanded.hidden).toBe(0);

    const html = render(Milestones, { model: { ...emptyModel(), milestones } });
    expect(html).toContain(zhf('board.milestones.more', { count: 2 }));
    const trend = render(TrendPanel, {
      model: {
        ...emptyModel(),
        task_progress: {
          ...emptyModel().task_progress,
          daily: [{ day: '11-01', scope: 3, done: 1, added: 0, removed: 0 }],
        },
        milestones,
      },
    });
    expect(trend).not.toContain('first');
  });

  it('labels lead milestones as in progress, awaiting the lead, or accepted', () => {
    const lead = (id: string, done: number, total: number, status: Status) => ({
      ...ms(id, 0, 0, status),
      owner_session_id: 'lead-1',
      tasks: { done, total },
    });
    const row = (html: string, title: string) => {
      const start = html.indexOf(`<span class="clip-1 nm" data-clip="">${title}</span>`);
      const end = html.indexOf('<span class="clip-1 nm"', start + 1);
      return html.slice(start, end < 0 ? undefined : end);
    };
    const html = render(Milestones, {
      model: {
        ...emptyModel(),
        milestones: [
          lead('building', 1, 3, 'active'),
          lead('awaiting', 2, 2, 'ready_for_acceptance'),
          lead('accepted', 4, 4, 'completed'),
          ms('user-ready', 2, 5, 'ready_for_acceptance'),
        ],
      },
    });
    expect(row(html, 'building')).toContain(zh('board.milestones.inProgress'));
    expect(row(html, 'building')).toContain('1/3');
    expect(row(html, 'awaiting')).toContain(zh('board.milestones.awaitingLead'));
    expect(row(html, 'awaiting')).toContain('2/2');
    expect(row(html, 'accepted')).toContain(zh('board.milestones.accepted'));
    expect(row(html, 'accepted')).toContain('4/4');
    expect(row(html, 'user-ready')).toContain('2/5');
    expect(row(html, 'user-ready')).toContain(zh('board.milestones.awaiting'));
    expect(row(html, 'user-ready')).not.toContain(zh('board.milestones.awaitingLead'));
  });
});

describe('board findings', () => {
  const finding = (id: string, state: 'open' | 'adopted' | 'dismissed') => ({
    id,
    review_id: 'r1',
    review_revision: 2,
    severity: 'major' as const,
    text: `finding ${id}`,
    path: 'apps/web/src/a.ts',
    line: 3,
    reviewer: 'codex',
    session_id: 's1',
    state,
  });

  it('lists only open findings by default', () => {
    const findings = [
      finding('one', 'open'),
      finding('two', 'adopted'),
      finding('three', 'dismissed'),
    ];
    expect(visibleFindings(findings, false).map((f) => f.id)).toEqual(['one']);
    expect(visibleFindings(findings, true)).toHaveLength(3);
    const html = render(FindingsPanel, {
      model: { ...emptyModel(), findings },
      onOpenSession: noop,
    });
    expect(html).toContain('finding one');
    expect(html).not.toContain('finding two');
    expect(html).toContain('a.ts:3');
  });

  it('keeps an adopted finding out of the open list and in the full list', () => {
    const findings = [finding('one', 'adopted')];
    expect(visibleFindings(findings, false)).toEqual([]);
    expect(visibleFindings(findings, true).map((f) => f.state)).toEqual(['adopted']);
  });

  it('offers adopt and dismiss only on open findings and only with a resolver', () => {
    const onResolve = async () => null;
    const model = { ...emptyModel(), findings: [finding('one', 'open')] };
    const html = render(FindingsPanel, { model, onOpenSession: noop, onResolve });
    expect(html).toContain(
      `aria-label="${zhf('board.findings.adoptLabel', { finding: 'finding one' })}"`,
    );
    expect(html).toContain(
      `aria-label="${zhf('board.findings.dismissLabel', { finding: 'finding one' })}"`,
    );
    expect(render(FindingsPanel, { model, onOpenSession: noop })).not.toContain('采纳 finding');
    for (const state of ['adopted', 'dismissed'] as const) {
      const row = render(FindingRow, {
        finding: finding('two', state),
        onOpenSession: noop,
        onResolve,
      });
      expect(row).toContain('finding two');
      expect(row).not.toContain('采纳 finding');
      expect(row).not.toContain('忽略 finding');
    }
  });
});

describe('board panel empty states', () => {
  it('shows one line per empty panel', () => {
    const model = emptyModel();
    expect(render(ProgressTable, { model, onOpenTask: noop })).toContain(
      zh('board.progress.empty'),
    );
    expect(render(TrendPanel, { model })).toContain(zh('board.trend.empty'));
    expect(render(UsageStackPanel, { model })).toContain(zh('board.usage.empty'));
    expect(render(MergesPanel, { model, onOpenSession: noop, onOpenStory: noop })).toContain(
      zh('board.merges.empty'),
    );
    expect(render(FindingsPanel, { model, onOpenSession: noop })).toContain(
      zh('board.findings.empty'),
    );
    expect(render(RisksPanel, { model })).toContain(zh('board.risks.empty'));
  });
});

describe('merge history counts', () => {
  it('counts the reverted merges beside the merged ones, writing 0 as the merged count does', () => {
    const model = emptyModel();
    const counted = (merged: number, reverted: number) =>
      render(MergesPanel, {
        model: { ...model, counts: { ...model.counts, merged, reverted } },
        onOpenSession: noop,
        onOpenStory: noop,
      });
    expect(counted(3, 1)).toMatch(/已合并 <b>3<\/b>.*被回退 <b>1<\/b>/);
    expect(counted(0, 0)).toMatch(/已合并 <b>0<\/b>.*被回退 <b>0<\/b>/);
  });
});

describe('chart edges', () => {
  it.each([
    ['keeps two end labels at the top of the chart apart', 4],
    ['keeps two end labels at the bottom of the chart apart and inside it', 200],
  ])('%s', (_name, y) => {
    const [a, b] = spreadLabels([{ y }, { y }], 8, 200);
    expect(a!.y).toBeGreaterThanOrEqual(8);
    expect(b!.y).toBeLessThanOrEqual(200);
    expect(b!.y - a!.y).toBeGreaterThanOrEqual(14);
  });

  it('keeps every label at or below the top after making room at the bottom', () => {
    const ys = spreadLabels([{ y: 12 }, { y: 186 }, { y: 187 }, { y: 188 }], 12, 188).map(
      (l) => l.y,
    );
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...ys)).toBeLessThanOrEqual(188);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(14);
  });

  it('shows the empty usage text when every reported turn used no tokens', () => {
    const html = renderToStaticMarkup(
      createElement(UsageStackPanel, {
        model: {
          ...emptyModel(),
          usage: [{ day: '2026-11-01', runtime: 'claude', model: null, tokens: 0, cost_usd: null }],
          models: [{ runtime: 'claude', model: null, first_seen: 1 }],
        },
      }),
    );
    expect(html).toContain(zh('board.usage.empty'));
  });
});

describe('board usage cost', () => {
  it('adds the cost of a row that used no tokens to its day', () => {
    const { days } = usageStack(
      {
        usage: [
          { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 0, cost_usd: 0.5 },
          { day: '2026-11-01', runtime: 'codex', model: 'gpt', tokens: 100, cost_usd: 0.25 },
        ],
        models: [
          { runtime: 'claude', model: 'opus', first_seen: 1 },
          { runtime: 'codex', model: 'gpt', first_seen: 2 },
        ],
      },
      'cost',
    );
    expect(days[0]!.total).toBe(0.75);
  });
});

describe('board time text', () => {
  it.each([
    [
      'shows the date of a timestamp from the same day of another year',
      2025,
      '2025年11月1日 09:30',
    ],
    ['shows only the clock for a timestamp from today', 2026, '09:30'],
  ])('%s', (_name, year, shown) => {
    expect(
      dayText(new Date(year, 10, 1, 9, 30).getTime(), new Date(2026, 10, 1, 12).getTime(), {
        time: true,
      }),
    ).toBe(shown);
  });
});

describe('board time ticks across a daylight saving change', () => {
  const zone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it('marks each three-hour point once on the day clocks spring forward', () => {
    // 2027-03-14 is the spring-forward day in America/New_York: 02:00 does not exist.
    const since = new Date(2027, 2, 14, 0).getTime();
    const now = new Date(2027, 2, 14, 8).getTime();
    expect(now - since).toBe(7 * 3_600_000);
    const ticks = timeTicks(since, now);
    expect(new Set(ticks.map((t) => t.at)).size).toBe(ticks.length);
    expect(ticks.map((t) => t.label)).toEqual(['00:00', '03:00', '06:00']);
  });
});

describe('board gantt segments', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lets the keyboard reach each segment and names its start, end and tokens', () => {
    const start = NOW - 2 * 3_600_000;
    const html = render(ProgressTable, {
      model: {
        ...emptyModel(),
        tasks: [
          {
            ...task('t1', null, 'running'),
            segments: [
              {
                id: 'seg-1',
                session_id: 's1',
                title: 'session one',
                runtime: 'claude',
                model: 'opus',
                status: 'done',
                started_at: start,
                ended_at: start + 3_600_000,
                tokens: 12_000,
              },
            ],
          },
        ],
      },
      onOpenTask: noop,
    });
    const seg = html.slice(html.indexOf('class="bp-gseg"'));
    const tag = seg.slice(0, seg.indexOf('>'));
    expect(tag).toContain('tabindex="0"');
    expect(tag).toContain(
      `aria-label="${zhf('board.progress.segmentLabel', { start: dayText(start, NOW, { time: true }), end: dayText(start + 3_600_000, NOW, { time: true }), tokens: '12k' })}"`,
    );
  });
});

describe('board gantt axis labels', () => {
  const now = new Date(2026, 10, 3, 0, 48).getTime();
  const since = new Date(2026, 9, 28).getTime();
  const span = (now - since) * 1.03;
  const ticks = timeTicks(since, now);

  it('keeps the label of the day still running inside the axis', () => {
    const labels = tickLabels(ticks, since, span, 400);
    expect(labels.at(-1)!.label).toBe('11-03');
    expect(labels.at(-1)!.x + 22).toBeLessThanOrEqual(400);
    expect(labels[0]!.x - 22).toBeGreaterThanOrEqual(0);
  });

  it('leaves out an older label that would run into a newer one', () => {
    const labels = tickLabels(ticks, since, span, 250);
    for (let i = 1; i < labels.length; i++)
      expect(labels[i]!.x - labels[i - 1]!.x).toBeGreaterThanOrEqual(44);
    expect(labels.length).toBeLessThan(ticks.length);
  });

  it('keeps the previous day labelled just after midnight', () => {
    expect(
      tickLabels(ticks, since, span, 400)
        .slice(-2)
        .map((l) => l.label),
    ).toEqual(['11-02', '11-03']);
    expect(tickLabels(ticks, since, span, 250).at(-1)!.label).toBe('11-02');
  });

  it('labels every day when the axis has room', () => {
    expect(tickLabels(ticks, since, span, 1200).map((l) => l.label)).toEqual([
      '10-28',
      '10-29',
      '10-30',
      '10-31',
      '11-01',
      '11-02',
      '11-03',
    ]);
  });
});
