import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionTurn, ToolItem, TranscriptItem, TurnView } from '@/data/transcript';
import {
  BREAK_SHARE,
  contextRing,
  packRows,
  ringTone,
  runWaterfall,
  sparkBars,
  turnTone,
} from '@/screens/sessions/run-model';
import { ActivitySpark, ContextMeter, TraceWaterfall } from '@/screens/sessions/RunCharts';
import { TraceTable } from '@/screens/sessions/trace';
import { zh } from './i18n-setup.js';

const turn = (id: string, extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id,
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-main',
  input: `input of ${id}`,
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  ...extra,
});

const view = (
  id: string,
  extra: Partial<TurnView> = {},
  turnExtra: Partial<SessionTurn> = {},
): TurnView => ({
  turn: turn(id, turnExtra),
  at: 1_000,
  started_at: 1_000,
  ended_at: 10_000,
  text: '',
  usage: null,
  end: { state: 'completed', error: null },
  items: [],
  ...extra,
});

const tool = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id,
  name: 'Bash',
  input: {},
  ok: true,
  ...extra,
});

const spans = (lane: { spans: { id: string; row: number }[] }) =>
  Object.fromEntries(lane.spans.map((s) => [s.id, s.row]));

describe('trace waterfall layout', () => {
  it('puts two parallel tools of one turn in two sub-rows', () => {
    const items: TranscriptItem[] = [
      tool('a', { started_at: 2_000, completed_at: 6_000 }),
      tool('b', { started_at: 3_000, completed_at: 5_000 }),
      tool('c', { started_at: 7_000, completed_at: 8_000 }),
    ];
    const lane = runWaterfall([view('turn-1', { items })], 20_000).lanes[0]!;
    expect(spans(lane)).toEqual({ a: 0, b: 1, c: 0 });
    expect(lane.rows).toBe(2);
  });

  it('sits a nested call in a sub-row under its parent', () => {
    expect(
      packRows([
        { id: 'child', parent: 'task', from: 3_000, to: 4_000 },
        { id: 'task', from: 2_000, to: 9_000 },
        { id: 'later', from: 5_000, to: 6_000 },
      ]),
    ).toEqual([1, 0, 1]);
    expect(
      packRows([
        { id: 'task', from: 2_000, to: 9_000 },
        { id: 'side', from: 2_500, to: 8_000 },
        { id: 'child', parent: 'task', from: 3_000, to: 4_000 },
      ]),
    ).toEqual([0, 1, 2]);
  });

  it('draws a tool with no completion as unknown up to the turn end', () => {
    const items = [tool('a', { started_at: 4_000, ok: undefined })];
    const lane = runWaterfall([view('turn-1', { items })], 50_000).lanes[0]!;
    expect(lane.spans[0]).toMatchObject({ from: 4_000, to: 10_000, unknown: true });
  });

  it('draws a tool with no completion as unknown up to now while the turn runs', () => {
    const items = [tool('a', { started_at: 4_000, ok: undefined })];
    const running = view('turn-1', { items, ended_at: null, end: null }, { state: 'running' });
    const chart = runWaterfall([running], 30_000);
    expect(chart.lanes[0]!.spans[0]).toMatchObject({ from: 4_000, to: 30_000, unknown: true });
    expect(chart.lanes[0]).toMatchObject({ tone: 'run', to: 30_000, unknown: false });
    expect(chart.to).toBe(30_000);
  });

  it('draws a turn with no start as unknown instead of dropping it', () => {
    const chart = runWaterfall(
      [view('turn-1'), view('turn-2', { at: null, started_at: null, ended_at: 14_000 })],
      50_000,
    );
    expect(chart.lanes).toHaveLength(2);
    expect(chart.lanes[1]).toMatchObject({ unknown: true, to: 14_000 });
    expect(chart.lanes[0]!.unknown).toBe(false);
    expect(chart).toMatchObject({ from: 1_000, to: 14_000 });
  });

  it('keeps a later turn with no end and no tool times on the axis', () => {
    const chart = runWaterfall(
      [
        view('turn-1', { ended_at: 2_000 }),
        view('turn-2', { at: 3_000, started_at: 3_000, ended_at: null }),
      ],
      50_000,
    );
    expect(chart.to).toBe(3_000);
    expect(chart.lanes[1]).toMatchObject({ from: 3_000, to: 3_000, unknown: true });
    expect(chart.position(chart.lanes[1]!.from)).toBeLessThanOrEqual(1);
  });

  it('marks a failed tool', () => {
    const items = [tool('a', { started_at: 2_000, completed_at: 3_000, ok: false })];
    const lane = runWaterfall([view('turn-1', { items })], 20_000).lanes[0]!;
    expect(lane.spans[0]).toMatchObject({ ok: false, unknown: false });
  });

  it('colours each turn by its end', () => {
    const ended = (state: string) => view('t', { end: { state, error: null } });
    expect(turnTone(ended('completed'))).toBe('ok');
    expect(turnTone(ended('failed'))).toBe('bad');
    expect(turnTone(ended('interrupted'))).toBe('idle');
    expect(turnTone(ended('cancelled'))).toBe('idle');
    expect(turnTone(view('t', { end: null }, { state: 'running' }))).toBe('run');
    expect(turnTone(view('t', { end: null }, { state: 'queued' }))).toBe('wait');
    const asking: TranscriptItem = {
      kind: 'request',
      id: 'r',
      tool: 'Bash',
      input: {},
      questions: [],
    };
    expect(turnTone(view('t', { end: null, items: [asking] }, { state: 'running' }))).toBe('wait');
  });

  it('renders one lane per turn with hatched unknown spans', () => {
    const items = [tool('a', { started_at: 4_000, ok: undefined })];
    const html = renderToStaticMarkup(
      createElement(TraceWaterfall, { turns: [view('turn-1', { items })], now: 20_000 }),
    );
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Trace 瀑布[^"]*"/);
    expect(html.match(/class="rn-lane"/g)).toHaveLength(1);
    expect(html).toMatch(/class="rn-span rn-unk"/);
    expect(html).toMatch(/class="rn-turn rn-k-ok"/);
  });
});

describe('trace waterfall reading', () => {
  const MIN = 60_000;
  const spaced = [0, 25 * MIN, 50 * MIN].map((at, i) =>
    view(`turn-${i + 1}`, {
      at,
      started_at: at,
      ended_at: at + 10_000,
      items: [tool(`tool-${i + 1}`, { started_at: at + 2_000, completed_at: at + 6_000 })],
    }),
  );

  it('lets the keyboard reach each turn and tool call with the details of its tip', () => {
    const html = renderToStaticMarkup(
      createElement(TraceWaterfall, { turns: spaced.slice(0, 1), now: 20_000 }),
    );
    expect(html).not.toMatch(/class="rn-lanes" role="img"/);
    expect(html).toMatch(/class="rn-lanes" role="group" aria-label="Trace 瀑布/);
    expect(html).toMatch(
      /<i role="img" tabindex="0" aria-label="回合 1，耗时 10\.0 秒，结果 完成" class="rn-turn rn-k-ok"/,
    );
    expect(html).toMatch(/<i role="img" tabindex="0" aria-label="Bash，耗时 4\.0 秒，结果 成功"/);
  });

  it('cuts idle stretches over five minutes to a fixed break so the turns can be read', () => {
    const chart = runWaterfall(spaced, 60 * MIN);
    expect(chart.breaks).toHaveLength(2);
    expect(chart.position(chart.from)).toBe(0);
    expect(chart.position(chart.to)).toBeCloseTo(1);
    for (const lane of chart.lanes)
      expect(chart.position(lane.to) - chart.position(lane.from)).toBeGreaterThan(0.25);
    expect(chart.breaks[0]!.at).toBeCloseTo(chart.position(10_000));
    expect(chart.position(25 * MIN) - chart.breaks[0]!.at).toBeCloseTo(BREAK_SHARE);
    const html = renderToStaticMarkup(createElement(TraceWaterfall, { turns: spaced, now: 0 }));
    expect(html.match(/class="rn-brk"/g)).toHaveLength(2 * 3);
  });

  it('keeps short idle stretches on the time axis', () => {
    const close = spaced.map((v, i) => ({ ...v, at: i * 2 * MIN, started_at: i * 2 * MIN }));
    const chart = runWaterfall(
      close.map((v) => ({ ...v, ended_at: v.started_at! + 10_000, items: [] })),
      0,
    );
    expect(chart.breaks).toEqual([]);
    expect(chart.position(2 * MIN)).toBeCloseTo((2 * MIN) / (chart.to - chart.from));
  });

  it('draws turns and tool calls at least 3px wide', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../apps/web/src/screens/sessions/run.css', import.meta.url)),
      'utf8',
    );
    for (const name of ['rn-turn', 'rn-span'])
      expect(css).toMatch(new RegExp(`\\.${name} \\{[^}]*min-width: 3px;`));
  });

  it('lists the tool calls of each turn with their time and result in the table', () => {
    const items = [
      tool('ok', { name: 'Read', started_at: 2_000, completed_at: 3_500 }),
      tool('bad', { name: 'Bash', started_at: 4_000, completed_at: 5_000, ok: false }),
      tool('open', { name: 'Edit', started_at: 6_000, ok: undefined }),
    ];
    const html = renderToStaticMarkup(
      createElement(TraceTable, { turns: [view('turn-1', { items })], now: 20_000 }),
    );
    const rows = [...html.matchAll(/<tr class="rn-call">(.*?)<\/tr>/g)].map(([, row]) =>
      [...row!.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(([, cell]) => cell),
    );
    expect(rows).toEqual([
      ['Read', '1.5 秒', zh('sessions.run.call.ok')],
      ['Bash', '1.0 秒', zh('sessions.run.call.failed')],
      ['Edit', '—', zh('sessions.run.call.unfinished')],
    ]);
  });
});

describe('activity sparkline', () => {
  const buckets = [0, 1, 2, 4, 0, 0, 8, 2, 0, 0, 4, 1];

  it('scales the 12 buckets to the largest one', () => {
    const { max, heights } = sparkBars(buckets, 32);
    expect(max).toBe(8);
    expect(heights).toEqual([0, 4, 8, 16, 0, 0, 32, 8, 0, 0, 16, 4]);
  });

  it('draws a flat baseline when every bucket is empty', () => {
    expect(sparkBars(new Array(12).fill(0), 32)).toEqual({
      max: 0,
      heights: new Array(12).fill(0),
    });
    const html = renderToStaticMarkup(
      createElement(ActivitySpark, {
        activity: {
          bucket_ms: 300000,
          from: '2026-11-03T00:00:00.000Z',
          tools_completed: new Array(12).fill(0),
        },
      }),
    );
    expect(html).toContain('class="rn-spk-base"');
    expect(html).toMatch(/aria-label="[^"]+"/);
  });

  it('shows the largest bucket as its only axis value', () => {
    const html = renderToStaticMarkup(
      createElement(ActivitySpark, {
        activity: { bucket_ms: 300000, from: '2026-11-03T00:00:00.000Z', tools_completed: buckets },
      }),
    );
    expect(html).toMatch(/class="rn-spk-max"[^>]*>8</);
    expect(html.match(/class="rn-spk-bar"/g)).toHaveLength(12);
  });

  it('shows unknown activity instead of an hour of zero buckets', () => {
    const html = renderToStaticMarkup(createElement(ActivitySpark, { activity: null }));
    expect(html).toContain(zh('sessions.run.unknown'));
    expect(html).not.toContain('rn-spk-bar');
    expect(html).not.toContain('完成工具数');
  });
});

describe('context ring', () => {
  it('shows 未知 without context', () => {
    expect(contextRing(null)).toMatchObject({ tone: 'none', text: zh('sessions.run.unknown') });
    const html = renderToStaticMarkup(createElement(ContextMeter, { usage: undefined }));
    expect(html).toContain(zh('sessions.run.unknown'));
    expect(html).toContain('rn-ring-none');
  });

  it('turns amber at 80% and red at 95%', () => {
    expect(ringTone(0.79)).toBe('ac2');
    expect(ringTone(0.8)).toBe('wait');
    expect(ringTone(0.95)).toBe('bad');
    expect(ringTone(null)).toBe('none');
  });

  it('shows the percent with the used and window tokens', () => {
    const usage = { context_tokens: 160_000, context_window: 200_000 };
    expect(contextRing(usage)).toMatchObject({ tone: 'wait', text: '80%' });
    const html = renderToStaticMarkup(createElement(ContextMeter, { usage }));
    expect(html).toContain('80%');
    expect(html).toContain('160k / 200k');
    expect(html).toContain('rn-ring-wait');
  });
});
