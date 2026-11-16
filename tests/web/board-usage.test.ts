import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, RuntimeStatus } from '@pantheon/protocol';
import type { QuotaWindow, RoleUsage } from '@pantheon/domain';
import { InsightsView } from '@/screens/insights/InsightsScreen';
import { KpiTiles } from '@/screens/board/KpiTiles';
import {
  QuotaBars,
  QuotaPanel,
  RoleUsageBars,
  UsageRings,
  UsageStackPanel,
} from '@/screens/board/UsageCharts';
import { parseUsageTarget, roleBars, usageRing, usageStack } from '@/screens/board/usage-model';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { SETTINGS_PAGES, useSettingsView } from '@/screens/settings/view';
import { useBoard } from '@/data/board';
import { useCurrentProject } from '@/data/current-project';
import { storeQuery } from '@/data/query-cache';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 86_400_000;

function model(patch: Partial<BoardModel> = {}): BoardModel {
  return {
    since: NOW - 7 * DAY,
    now: NOW,
    headline: null,
    counts: {
      running: 1,
      waiting: 0,
      ready: 0,
      failed: 0,
      merged: 0,
      reverted: 0,
      median_ms: null,
      tokens: 0,
      tokens_by_runtime: {},
      cost_usd: null,
      previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    },
    lanes: [],
    tasks: [],
    edges: [],
    milestones: [],
    burnup: [],
    task_progress: {
      totals: {
        done: 0,
        running: 1,
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
    ...patch,
  };
}

const usage = {
  models: [
    { runtime: 'codex', model: 'gpt-5', first_seen: 3 },
    { runtime: 'claude', model: 'opus', first_seen: 1 },
    { runtime: 'claude', model: 'sonnet', first_seen: 2 },
    { runtime: 'fixture', model: 'pro', first_seen: 4 },
  ],
  usage: [
    { day: '2026-11-01', runtime: 'codex', model: 'gpt-5', tokens: 200, cost_usd: 0.25 },
    { day: '2026-11-01', runtime: 'claude', model: 'sonnet', tokens: 50, cost_usd: null },
    { day: '2026-11-01', runtime: 'claude', model: 'opus', tokens: 100, cost_usd: 0.5 },
    { day: '2026-11-02', runtime: 'codex', model: 'gpt-5', tokens: 300, cost_usd: 1 },
    { day: '2026-11-02', runtime: 'fixture', model: 'pro', tokens: 40, cost_usd: null },
  ],
};

const render = (type: unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(type as never, props as never));
const legendOf = (html: string) => {
  const from = html.slice(html.indexOf('class="us-lgd"'));
  return from.slice(0, from.indexOf('</div>'));
};
const titles = (html: string) => [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('usage stack', () => {
  it('keeps a day without usage on the axis between used days, across a month end', () => {
    const { days } = usageStack(
      {
        models: [],
        usage: [
          { day: '2026-10-31', runtime: 'codex', model: 'gpt-5', tokens: 10, cost_usd: 0.1 },
          { day: '2026-11-02', runtime: 'codex', model: 'gpt-5', tokens: 20, cost_usd: 0.2 },
        ],
      },
      'tokens',
    );
    expect(days.map((d) => [d.day, d.total])).toEqual([
      ['2026-10-31', 10],
      ['2026-11-01', 0],
      ['2026-11-02', 20],
    ]);
  });

  it('stacks each day by runtime color with a different hatch per model of a runtime', () => {
    const { series, days } = usageStack(usage, 'tokens');
    expect(series.map((s) => [s.label, s.color, s.hatch])).toEqual([
      ['opus', 'var(--rt-claude)', null],
      ['sonnet', 'var(--rt-claude)', 'fwd'],
      ['gpt-5', 'var(--rt-codex)', null],
      ['pro', 'var(--mu)', null],
    ]);
    expect(
      usageStack(
        {
          models: [
            { runtime: 'grok', model: 'grok-4', first_seen: 1 },
            { runtime: 'fixture', model: 'pro', first_seen: 2 },
            { runtime: 'agy', model: 'flash', first_seen: 3 },
          ],
          usage: [
            { day: '2026-11-01', runtime: 'fixture', model: 'pro', tokens: 1, cost_usd: null },
            { day: '2026-11-01', runtime: 'grok', model: 'grok-4', tokens: 1, cost_usd: null },
            { day: '2026-11-01', runtime: 'agy', model: 'flash', tokens: 1, cost_usd: null },
          ],
        },
        'tokens',
      ).series.map((s) => [s.label, s.color]),
    ).toEqual([
      ['flash', 'var(--rt-agy)'],
      ['grok-4', 'var(--rt-grok)'],
      ['pro', 'var(--mu)'],
    ]);
    expect(
      days.map((d) => [d.day, d.total, d.parts.map((p) => [p.series.label, p.value])]),
    ).toEqual([
      [
        '2026-11-01',
        350,
        [
          ['opus', 100],
          ['sonnet', 50],
          ['gpt-5', 200],
        ],
      ],
      [
        '2026-11-02',
        340,
        [
          ['gpt-5', 300],
          ['pro', 40],
        ],
      ],
    ]);
  });

  it('stacks the known cost when switched to cost', () => {
    const { days } = usageStack(usage, 'cost');
    expect(days.map((d) => [d.total, d.parts.map((p) => [p.series.label, p.value])])).toEqual([
      [
        0.75,
        [
          ['opus', 0.5],
          ['gpt-5', 0.25],
        ],
      ],
      [1, [['gpt-5', 1]]],
    ]);
  });

  it('keeps a series whose cost is unknown on every day when switched to cost', () => {
    const { series, days } = usageStack(usage, 'cost');
    expect(series.map((s) => s.label)).toEqual(['opus', 'sonnet', 'gpt-5', 'pro']);
    const label = (key: string) => series.find((s) => s.key === key)?.label;
    expect(days.map((d) => d.unknown.map(label))).toEqual([['sonnet'], ['pro']]);
  });

  it('keeps a folded series unknown beside its known part when one of its models has no cost', () => {
    const { series, days } = usageStack(
      {
        models: [
          { runtime: 'codex', model: 'gpt-a', first_seen: 1 },
          { runtime: 'codex', model: 'gpt-b', first_seen: 2 },
          { runtime: 'codex', model: 'gpt-c', first_seen: 3 },
          { runtime: 'codex', model: 'gpt-d', first_seen: 4 },
        ],
        usage: [
          { day: '2026-11-01', runtime: 'codex', model: 'gpt-c', tokens: 10, cost_usd: 0.4 },
          { day: '2026-11-01', runtime: 'codex', model: 'gpt-d', tokens: 20, cost_usd: null },
        ],
      },
      'cost',
    );
    const label = (key: string) => series.find((s) => s.key === key)?.label;
    expect(days[0]!.parts.map((p) => [p.series.label, p.value])).toEqual([['Codex 其他', 0.4]]);
    expect(days[0]!.unknown.map(label)).toEqual(['Codex 其他']);
  });

  it('names the range in the title and lists each runtime with its total, past two as other', () => {
    const html = render(UsageStackPanel, { model: model(usage) });
    expect(titles(html)).toEqual([zh('board.usage.stackTitle')]);
    expect(html).toContain('aria-label="用量单位"');
    expect(html).toContain('>成本<');
    expect(html).toContain('aria-label="表格视图"');
    const legend = legendOf(html);
    const entries = [...legend.matchAll(/<\/i>([^<]+)<span class="us-lgn">([^<]+)</g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(entries).toEqual([
      ['Claude', '150'],
      ['Codex', '500'],
      [zh('insights.usage.otherRuntimes'), '40'],
    ]);
    expect(legend).toContain('style="background-color:var(--mu)"');
    expect(legend).not.toContain('opus');
  });

  it('keeps each runtime its own series with two runtimes or fewer', () => {
    const html = render(UsageStackPanel, {
      model: model({ ...usage, usage: usage.usage.filter((u) => u.runtime !== 'fixture') }),
    });
    const legend = legendOf(html);
    expect([...legend.matchAll(/<\/i>([^<]+)<span class="us-lgn">/g)].map((m) => m[1])).toEqual([
      'Claude',
      'Codex',
    ]);
  });

  it('shows the empty text without usage', () => {
    expect(render(UsageStackPanel, { model: model() })).toContain(zh('board.usage.empty'));
  });

  it('says the usage was not reported when no session in the range reported tokens', () => {
    const html = render(UsageStackPanel, {
      model: model({
        usage: [
          {
            day: '2026-11-01',
            runtime: 'agy',
            model: null,
            tokens: 0,
            cost_usd: null,
            sessions_without_usage: 1,
          },
        ],
      }),
    });
    expect(html).toContain(zh('board.usage.unreported'));
    expect(html).not.toContain(zh('board.usage.empty'));
  });
});

describe('usage by role', () => {
  const row = (role: RoleUsage['role'], input: number, cached: number | null, output: number) => ({
    role,
    sessions: 1,
    turns: 2,
    tool_calls: 0,
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    turn_ms: 60_000,
    turns_without_usage: 0,
  });

  it('draws cached input as a share of the input segment, not as extra length', () => {
    const bars = roleBars([row('reviewer', 300, null, 100), row('main', 800, 200, 200)]);
    expect(bars.map((b) => [b.label, b.input, b.output, b.cached])).toEqual([
      [zh('board.usageRoles.main'), 0.8, 0.2, 0.25],
      [zh('board.usageRoles.reviewer'), 0.3, 0.1, 0],
    ]);
    const html = render(RoleUsageBars, { rows: [row('main', 800, 200, 200)] });
    expect(html).toMatch(
      /class="us-in" style="width:80%[^"]*"><i class="us-cache" style="width:25%"/,
    );
    expect(html).toMatch(/class="us-out" style="width:20%/);
  });

  it('draws no segment for a zero input or zero output', () => {
    const html = render(RoleUsageBars, {
      rows: [row('main', 800, 0, 0), row('reviewer', 0, null, 0)],
    });
    expect(html.match(/class="us-in"/g)).toHaveLength(1);
    expect(html).not.toContain('us-out');
  });
});

describe('usage rings', () => {
  it('fills to the share of the target and shows the percent', () => {
    expect(usageRing(5_000_000, 20_000_000, 0)).toEqual({
      open: false,
      start: 0,
      sweep: 0.25,
      text: '25%',
    });
    expect(usageRing(30_000_000, 20_000_000, 0)).toMatchObject({ sweep: 1, text: '150%' });
  });

  it('draws an open ring with the absolute value without a target', () => {
    expect(usageRing(1_200_000, null, 0)).toEqual({
      open: true,
      start: 0.05,
      sweep: 0.9,
      text: '1.2M',
    });
  });

  it('draws a runtime that used nothing as an empty track', () => {
    expect(usageRing(0, null, 0)).toMatchObject({ open: true, sweep: 0, text: '0' });
    const html = render(UsageRings, { model: model() });
    expect(html).not.toContain('us-rarc');
    expect(html.match(/class="us-rtrk"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Claude 0"');
  });

  it("draws one ring per runtime from the project's targets", () => {
    const html = render(UsageRings, {
      targets: { claude: 20_000_000 },
      model: model({
        counts: {
          ...model().counts,
          tokens_by_runtime: { claude: 5_000_000, codex: 1_200_000 },
        },
      }),
    });
    expect(titles(html)).toEqual([zh('board.usage.byRuntime')]);
    expect(html).toContain('aria-label="Claude 5M / 20M，25%"');
    expect(html).toContain('aria-label="Codex 1.2M"');
    expect(html).toContain('>25%<');
    expect(html).toContain('>1.2M<');
  });

  it('adds a ring in table order for each other runtime that used tokens', () => {
    const html = render(UsageRings, {
      model: model({
        counts: {
          ...model().counts,
          tokens_by_runtime: { fixture: 30, grok: 0, agy: 2_000, codex: 10 },
        },
      }),
    });
    expect([...html.matchAll(/<figcaption[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual([
      'Claude',
      'Codex',
      'agy',
      'fixture',
    ]);
    expect(html).toContain('aria-label="agy 2k" style="color:var(--rt-agy)"');
  });

  it('writes a runtime whose sessions reported no tokens as unreported and a partial sum with a plus', () => {
    expect(usageRing(0, null, 2)).toMatchObject({
      open: true,
      sweep: 0,
      text: zh('board.usageRing.unreported'),
    });
    expect(usageRing(0, 20_000_000, 2)).toMatchObject({
      sweep: 0,
      text: zh('board.usageRing.unreported'),
    });
    expect(usageRing(5_000_000, 20_000_000, 1)).toMatchObject({ sweep: 0.25, text: '25%+' });
    expect(usageRing(1_200_000, null, 1)).toMatchObject({ sweep: 0.9, text: '1.2M+' });
    const html = render(UsageRings, {
      targets: { claude: 20_000_000 },
      model: model({
        counts: {
          ...model().counts,
          tokens_by_runtime: { claude: 5_000_000, codex: 1_200_000, grok: 0 },
          sessions_without_usage: 3,
          sessions_without_usage_by_runtime: { claude: 1, grok: 2 },
        },
      }),
    });
    expect([...html.matchAll(/<figcaption[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual([
      'Claude',
      'Codex',
      'grok',
    ]);
    expect(html).toContain('aria-label="grok 未上报"');
    expect(html).toContain('>未上报<');
    expect(html).toContain('aria-label="Claude 5M+ / 20M，25%+"');
    expect(html).toContain('aria-label="Codex 1.2M"');
  });
});

describe('usage targets setting', () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useSettingsView.setState({ page: 'general' });
    useBoard.setState({ board: null });
  });

  it('reads a typed target as a positive whole number and an empty one as none', () => {
    expect(parseUsageTarget('')).toBeNull();
    expect(parseUsageTarget(' 3000000 ')).toBe(3_000_000);
    expect(parseUsageTarget('3M')).toBeUndefined();
  });

  it('refuses a typed target too large to keep as an exact whole number', () => {
    expect(parseUsageTarget(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseUsageTarget('9007199254740993')).toBeUndefined();
    expect(parseUsageTarget('9'.repeat(400))).toBeUndefined();
  });

  it('lists the usage page among the pages for every project with one token input per runtime', () => {
    expect(SETTINGS_PAGES.find((p) => p.key === 'usage')).toEqual({
      key: 'usage',
      label: zh('settings.pages.usage'),
      group: 'global',
    });
    const project = {
      id: 'alpha',
      revision: 1,
      name: 'Alpha',
      roots: ['/work/alpha'],
      usage_targets: { claude: 20_000_000 },
    };
    useBoard.setState({ board: { cursor: 0, projects: [project], sessions: [] } as never });
    useSettingsView.setState({ page: 'usage' });
    const html = render(ProjectSettingsScreen, {});
    // The page every project follows shows the global targets, not a project's own.
    expect(html).toMatch(/aria-label="Claude token 目标"[^>]*value=""/);
    expect(html).toMatch(/aria-label="Codex token 目标"[^>]*value=""/);
  });
});

describe('usage overview', () => {
  const day = (time: number) => {
    const d = new Date(time);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const used = (merged: number) =>
    model({
      counts: { ...model().counts, merged, tokens: 1000 },
      usage: [{ day: day(NOW), runtime: 'claude', model: 'opus', tokens: 1000, cost_usd: 2 }],
    });
  afterEach(() => {
    useBoard.setState({ board: null });
    useCurrentProject.setState({ projectId: null });
  });

  it('divides the tokens of the range by its merges and shows a dash without a merge', () => {
    const html = render(KpiTiles, { model: used(4) });
    expect(html).toContain(zh('insights.kpi.perMerge'));
    expect(html).toContain('<b>250</b><span class="bd-kpi-n">共 4 次合并</span>');
    expect(html).not.toContain('本期花费');
    expect(html).not.toContain('日均 tokens');
    expect(html).not.toContain('最忙的运行时');
    const none = render(KpiTiles, { model: used(0) });
    expect(none).toMatch(/每次合并的 tokens<\/span><span class="bd-kpi-v"><b>—<\/b><\/span>/);
  });

  it('counts the sessions of the range that were compacted out of all of them', () => {
    useBoard.setState({
      board: {
        cursor: 0,
        projects: [{ id: 'compact-project', name: 'Compact', roots: [] }],
        sessions: [],
      } as never,
    });
    useCurrentProject.setState({ projectId: 'compact-project' });
    const at = (time: number) => new Date(time).toISOString();
    storeQuery(
      'session.list',
      'compact-project',
      [
        { id: 's1', last_activity_at: at(NOW - DAY), compaction_count: 2 },
        { id: 's2', last_activity_at: at(NOW - 2 * DAY), compaction_count: 0 },
        { id: 's3', last_activity_at: at(NOW - 3 * DAY) },
        { id: 's4', last_activity_at: at(NOW - 30 * DAY), compaction_count: 5 },
      ],
      NOW,
    );
    const html = render(KpiTiles, {
      model: model({ counts: { ...used(1).counts, compacted_sessions: 1 } }),
    });
    expect(html).toContain(
      '被压缩的会话</span><span class="bd-kpi-v"><b>1</b><span class="bd-kpi-n">共 3 个会话</span>',
    );
    const none = render(KpiTiles, { model: used(1) });
    expect(none).toContain(
      '被压缩的会话</span><span class="bd-kpi-v"><b>0</b><span class="bd-kpi-n">共 3 个会话</span>',
    );
  });

  it('draws the daily tokens beside the token total as one line', () => {
    const html = render(KpiTiles, { model: used(1) });
    const spark = /<svg class="bd-kpi-s"([^>]*)>(.*?)<\/svg>/.exec(html);
    expect(spark?.[1]).toContain('viewBox="0 0 100 28"');
    expect(spark?.[1]).toContain('preserveAspectRatio="none"');
    // The last day holds all the tokens, so the line ends at the top.
    expect(spark?.[2]).toMatch(/^<path d="M0 26( L[\d.]+ 26)* L100 2"><\/path>$/);
  });

  it('ranks the sessions of the project by their tokens over all turns, beside the daily chart', () => {
    const usage = (input_tokens: number, output_tokens: number) => ({
      input_tokens,
      output_tokens,
    });
    useBoard.setState({
      board: {
        cursor: 0,
        projects: [{ id: 'usage-project', name: 'Usage', roots: [] }],
        sessions: [
          { id: 's1', project_id: 'usage-project', title: 'Small', usage: usage(600, 200) },
          {
            id: 's2',
            project_id: 'usage-project',
            title: 'Lead',
            usage: usage(2_000_000, 600_000),
          },
          { id: 's3', project_id: 'other-project', title: 'Elsewhere', usage: usage(9e6, 0) },
          {
            id: 's4',
            project_id: 'usage-project',
            title: 'Reports',
            usage: usage(1_500_000, 50_000),
          },
          { id: 's5', project_id: 'usage-project', title: 'Silent' },
        ],
        session_turns: [],
      } as never,
    });
    useCurrentProject.setState({ projectId: 'usage-project' });
    const html = render(UsageStackPanel, { model: used(1) });
    const top = /<section class="us-top"[^>]*>(.*?)<\/section>/.exec(html)?.[1] ?? '';
    expect(top).toContain('用得最多的会话（累计）</h3>');
    expect([...top.matchAll(/class="us-tn" title="([^"]*)"/g)].map((m) => m[1])).toEqual([
      'Lead',
      'Reports',
      'Small',
    ]);
    expect(top).toContain('aria-label="Lead：2.6M tokens" style="--v:100%"');
    expect(top).toContain('<span class="us-n">800</span>');
  });

  it('leaves the session ranking out without a project', () => {
    expect(render(UsageStackPanel, { model: used(1) })).not.toContain('us-top');
  });
});

describe('subscription quota', () => {
  const status = (runtime: string, windows?: QuotaWindow[]) =>
    ({
      runtime,
      enabled: true,
      installed: true,
      auth: { state: 'logged_in' },
      ...(windows && { quota: { windows, seen_at: NOW } }),
    }) as unknown as RuntimeStatus;

  it('draws one row per runtime with quota data, its most used window and when it resets', () => {
    const html = render(QuotaBars, {
      statuses: [
        status('codex'),
        status('claude', [
          { window: 'seven_day', used_percent: 12 },
          { window: 'five_hour', used_percent: 38, resets_at: NOW + (2 * 60 + 14) * 60_000 },
        ]),
      ],
      now: NOW,
    });
    expect(titles(html)).toEqual([zh('insights.quota.title')]);
    expect(html).toContain('Claude');
    expect(html).not.toContain('Codex');
    expect(html).toContain('aria-valuenow="38"');
    expect(html).toContain('>38%<');
    expect(html).toContain('5 小时窗口，2 小时 14 分后重置');
  });

  it('draws nothing when no runtime reported quota or the status is still loading', () => {
    expect(render(QuotaBars, { statuses: [status('claude'), status('codex', [])], now: NOW })).toBe(
      '',
    );
    expect(render(QuotaPanel, {})).toBe('');
  });
});

describe('usage tab', () => {
  it('puts the rings first, then the stack, then the role bars', () => {
    const html = render(InsightsView, {
      model: model(usage),
      section: 'usage',
      projectId: 'alpha',
      loading: false,
      error: null,
      onRetry() {},
      days: 7,
      onDays() {},
      onSection() {},
      onOpenSession() {},
      onOpenStory() {},
    });
    expect(titles(html)).toEqual([
      zh('board.usage.byRuntime'),
      zh('board.usage.stackTitle'),
      zh('board.usage.byRole'),
    ]);
  });

  it("rings the runtimes against the shown project's targets", () => {
    const html = render(InsightsView, {
      usageTargets: { claude: 20_000_000 },
      model: model(usage),
      section: 'usage',
      projectId: 'alpha',
      loading: false,
      error: null,
      onRetry() {},
      days: 7,
      onDays() {},
      onSection() {},
      onOpenSession() {},
      onOpenStory() {},
    });
    expect(html).toMatch(/aria-label="Claude [^"]* \/ 20M，/);
  });
});
