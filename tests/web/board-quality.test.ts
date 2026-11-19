import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel, ProjectGatesHistory } from '@pantheon/protocol';
import type { ReviewMetrics } from '@pantheon/domain';
import { find, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  openSession: (_id: string, _tab?: string, _run?: string) => {},
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/store', () => ({
  useShell: (selector: any) =>
    selector({
      openSession: (id: string, tab?: string, run?: string) => mock.openSession(id, tab, run),
      openSessionGroup() {},
      openTaskSession() {},
    }),
}));
import { InsightsView } from '@/screens/insights/InsightsScreen';
import { dayText } from '@/lib/time-text';
import {
  GateFailures,
  GateTracker,
  MergeTrack,
  QualityKpis,
  ReviewMatrix,
} from '@/screens/board/QualityCharts';
import { GATE_RUNS, gateTracker, mergeTrack, reviewMatrix } from '@/screens/board/quality-model';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 86_400_000;
const noop = () => {};
beforeEach(() => {
  mock.openSession = vi.fn();
});
afterEach(() => {
  unmountAll();
});

const metrics = (runtime: string, counts: Partial<ReviewMetrics>): ReviewMetrics => ({
  runtime,
  reviews: 1,
  reviews_without_findings: 0,
  findings: 0,
  adopted: 0,
  dismissed: 0,
  unresolved: 0,
  invalid: 0,
  ...counts,
});

describe('review matrix', () => {
  const rows = [
    metrics('codex', { findings: 10, unresolved: 2, adopted: 5, dismissed: 1, invalid: 2 }),
    metrics('claude', { findings: 4, adopted: 3, invalid: 1 }),
    metrics('gemini', {}),
  ];

  it('puts each runtime in a row with its outcomes as shares of its own findings', () => {
    const matrix = reviewMatrix(rows);
    expect(matrix.map((r) => r.runtime)).toEqual(['claude', 'codex', 'gemini']);
    const shares = (runtime: string) =>
      matrix.find((r) => r.runtime === runtime)!.cells.map((c) => [c.label, c.count, c.share]);
    expect(shares('codex')).toEqual([
      [zh('board.reviewMatrix.unresolved'), 2, 0.2],
      [zh('board.reviewMatrix.adopted'), 5, 0.5],
      [zh('board.reviewMatrix.dismissed'), 1, 0.1],
      [zh('board.reviewMatrix.invalid'), 2, 0.2],
    ]);
    expect(shares('claude')).toEqual([
      [zh('board.reviewMatrix.unresolved'), 0, 0],
      [zh('board.reviewMatrix.adopted'), 3, 0.75],
      [zh('board.reviewMatrix.dismissed'), 0, 0],
      [zh('board.reviewMatrix.invalid'), 1, 0.25],
    ]);
    expect(shares('gemini').map(([, , share]) => share)).toEqual([0, 0, 0, 0]);
    expect(matrix[0]!.cells.map((c) => c.color)).toEqual([
      'var(--wait)',
      'var(--ok)',
      'var(--idle)',
      'var(--bad)',
    ]);
  });

  it('draws each cell as a labelled bar as wide as its share', () => {
    const tree = ReviewMatrix({ rows });
    const bars = nodes(tree).filter((n) => n.props.className === 'ql-mxb');
    expect(bars.map((b) => b.props.style.width)).toEqual([
      '0%',
      '75%',
      '0%',
      '25%',
      '20%',
      '50%',
      '10%',
      '20%',
      '0%',
      '0%',
      '0%',
      '0%',
    ]);
    find(tree, (n) => n.props['aria-label'] === 'Codex 采纳 5 / 10');
  });
});

const merge = (
  session_id: string,
  merged_at: number,
  additions: number,
  deletions: number,
): BoardModel['merges'][number] => ({
  session_id,
  title: `session ${session_id}`,
  merged_at,
  from_sha: null,
  sha: `${session_id}abcdef0123456789`,
  additions,
  deletions,
  story_id: null,
});

describe('merge track', () => {
  const since = NOW - 8 * DAY;
  const merges = [merge('b', NOW - 2 * DAY, 20, 200), merge('a', NOW - 6 * DAY, 100, 50)];

  it('places each merge at its time and scales its ticks to the largest change', () => {
    const { marks } = mergeTrack(merges, since, NOW);
    expect(marks.map((m) => [m.session_id, m.sha, m.x, m.add, m.del])).toEqual([
      ['a', 'aabcdef', 0.25, 0.5, 0.25],
      ['b', 'babcdef', 0.75, 0.1, 1],
    ]);
  });

  it('opens the merged session from its mark', () => {
    const onOpenSession = vi.fn();
    const tree = mount(() => MergeTrack({ merges, since, now: NOW, onOpenSession })).value;
    const mark = find(
      tree,
      (n) => n.type === 'button' && n.props['aria-label']?.includes('babcdef'),
    );
    expect(mark.props.style.left).toBe('75%');
    mark.props.onClick();
    expect(onOpenSession).toHaveBeenCalledWith('b');
  });

  it('names the mark of a deleted session by its id and opens nothing from it', () => {
    const onOpenSession = vi.fn();
    const gone = { ...merge('deleted-session-1', NOW - DAY, 3, 1), title: '' };
    const tree = mount(() => MergeTrack({ merges: [gone], since, now: NOW, onOpenSession })).value;
    const mark = find(tree, (n) => n.type === 'button');
    expect(mark.props['aria-label']).toMatch(/^会话 deleted-/);
    expect(mark.props['aria-disabled']).toBe(true);
    mark.props.onClick?.();
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it('centres a day tick on the part of the day inside the range', () => {
    const HOUR = 3_600_000;
    const from = new Date(2026, 10, 10, 18).getTime();
    const to = new Date(2026, 10, 13, 6).getTime();
    const { ticks } = mergeTrack([], from, to);
    const span = to - from;
    expect(ticks.map((t) => t.x)).toEqual([
      (3 * HOUR) / span,
      (new Date(2026, 10, 11, 12).getTime() - from) / span,
      (new Date(2026, 10, 12, 12).getTime() - from) / span,
      (to - 3 * HOUR - from) / span,
    ]);
  });
});

type GateRun = ProjectGatesHistory['runs'][number];
const run = (id: string, results: GateRun['results']): GateRun => ({
  run_id: id,
  commit: `${id}0123456789abcdef`,
  started_at: new Date(NOW - DAY).toISOString(),
  finished_at: new Date(NOW - DAY + 60_000).toISOString(),
  results,
  session_id: `session-${id}`,
  session_title: `title ${id}`,
});
const result = (name: string, patch: Partial<GateRun['results'][number]>) => ({
  name,
  command: ['pnpm', name],
  ...patch,
});

describe('gate history', () => {
  const mixed = run('r2', [
    result('lint', { exit_code: 0, duration_ms: 1000 }),
    result('test', { exit_code: 1, duration_ms: 4000 }),
    result('e2e', { timed_out: true, exit_code: null, duration_ms: 2000 }),
    result('build', { skipped: true }),
  ]);
  const older = run('r1', [result('lint', { exit_code: 0, duration_ms: 500 })]);
  const cells = (tree: unknown) =>
    nodes(tree as never).filter((n) => String(n.props.className).startsWith('ql-tc'));

  it('keeps a row per command and the latest thirty runs, the newest at the right', () => {
    const { columns, rows } = gateTracker([mixed, older]);
    expect(columns.map((c) => c.run_id)).toEqual(['r1', 'r2']);
    expect(rows.map((r) => r.name)).toEqual(['lint', 'test', 'e2e', 'build']);
    const many = Array.from({ length: 40 }, (_, i) =>
      run(`n${i}`, [result('lint', { exit_code: 0, duration_ms: 100 })]),
    );
    const latest = gateTracker(many).columns;
    expect(GATE_RUNS).toBe(30);
    expect(latest).toHaveLength(30);
    expect(latest.at(-1)!.run_id).toBe('n0');
    expect(latest[0]!.run_id).toBe('n29');
  });

  it('draws only the latest thirty runs but rates each command over every run read', () => {
    const runs = [
      ...Array.from({ length: GATE_RUNS }, (_, i) =>
        run(`new${i}`, [result('lint', { exit_code: 0 })]),
      ),
      ...Array.from({ length: 10 }, (_, i) => run(`old${i}`, [result('lint', { exit_code: 1 })])),
    ];
    const { columns, rows } = gateTracker(runs);
    expect(columns).toHaveLength(GATE_RUNS);
    expect(rows[0]!.cells.every((c) => c.state === 'passed')).toBe(true);
    expect(rows[0]!.rate).toBe(GATE_RUNS / (GATE_RUNS + 10));
  });

  it('fills each cell by its outcome, leaves skipped and missing runs empty and ends rows with the pass rate', () => {
    const tree = mount(() => GateTracker({ runs: [mixed, older] })).value;
    expect(cells(tree).map((c) => c.props.className)).toEqual([
      'ql-tc ql-tc-ok',
      'ql-tc ql-tc-ok',
      'ql-tc ql-tc-none',
      'ql-tc ql-tc-bad',
      'ql-tc ql-tc-none',
      'ql-tc ql-tc-bad',
      'ql-tc ql-tc-none',
      'ql-tc ql-tc-none',
    ]);
    const rates = find(tree, (n) => n.props.className === 'ql-gtp');
    expect(nodes(rates.props.children).map((n) => text(n))).toEqual(['100%', '0%', '0%', '—']);
  });

  it('names the time and exit code of a cell in its tip', () => {
    const tree = mount(() => GateTracker({ runs: [mixed, older] })).value;
    const tips = nodes(tree)
      .filter((n) => typeof n.type === 'function' && n.type.name === 'Tip')
      .map((n) => n.props.content);
    const at = dayText(Date.parse(mixed.finished_at), Date.now(), { time: true });
    expect(tips.slice(0, 2)).toEqual([`${at}，退出码 0`, `${at}，退出码 0`]);
    expect(tips.slice(2, 6)).toEqual([
      `${at}，未跑`,
      `${at}，退出码 1`,
      `${at}，未跑`,
      `${at}，超时`,
    ]);
    expect(tips.at(-1)).toBe(`${at}，跳过`);
  });

  it('draws 8px cells 2px apart and scrolls many runs to the newest at the right', () => {
    const css = readFileSync(
      new URL('../../apps/web/src/screens/board/quality.css', import.meta.url),
      'utf8',
    );
    const rule = (name: string) => new RegExp(`\\n${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    expect(rule('\\.ql-tc')).toMatch(/width: 8px/);
    expect(rule('\\.ql-gtr')).toMatch(/gap: 2px/);
    // An end-aligned row that overflows puts its oldest runs before the scroll origin.
    expect(rule('\\.ql-gtg')).toMatch(/margin-left: auto/);
    const tree = mount(() => GateTracker({ runs: [mixed, older] })).value;
    const row = find(tree, (n) => n.props.className === 'ql-gts');
    const el = { scrollLeft: 0, scrollWidth: 900 };
    row.props.ref(el);
    expect(el.scrollLeft).toBe(900);
  });

  it('keeps a row for each of two commands that share a name', () => {
    const twice = run('r3', [
      result('test', { exit_code: 0, duration_ms: 100 }),
      result('test', { exit_code: 1, duration_ms: 100 }),
    ]);
    const { rows } = gateTracker([twice]);
    expect(rows.map((r) => [r.name, r.cells.map((c) => c.state), r.rate])).toEqual([
      ['test', ['passed'], 1],
      ['test', ['failed'], 0],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("opens the run's session on its checks tab with that run chosen", () => {
    const tree = mount(() => GateTracker({ runs: [mixed, older] })).value;
    const cell = find(
      tree,
      (n) => n.type === 'button' && n.props['aria-label']?.startsWith('test，r201234'),
    );
    cell.props.onClick();
    expect(mock.openSession).toHaveBeenCalledWith('session-r2', 'checks', 'r2');
  });
});

type Task = BoardModel['tasks'][number];
const task = (id: string, retrospective?: Task['retrospective']) =>
  ({ id, title: `task ${id}`, segments: [], retrospective }) as unknown as Task;
const quality = (
  tasks: Task[],
  cycle: { median_ms: number | null; sample_count: number },
  counts: Partial<BoardModel['counts']> = {},
  days = 7,
) =>
  ({
    since: new Date(2026, 10, 3 + 1 - days).getTime(),
    now: new Date(2026, 10, 3, 12).getTime(),
    counts: { merged: 0, ...counts },
    tasks,
    task_progress: { cycle: { ...cycle, p90_ms: null, buckets: [] } },
    usage: [],
    merges: [],
  }) as unknown as BoardModel;
const html = (type: unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(type as never, props as never));
const recorded_at = new Date(2026, 10, 3, 10).getTime();

describe('quality overview', () => {
  it('rates first-pass gates and rework over the tasks with a retrospective, each with its count', () => {
    const out = html(QualityKpis, {
      model: quality(
        [
          task('a', { outcome: 'merged', gate_passed_on_attempt: 1, handbacks: 0, recorded_at }),
          task('b', { outcome: 'merged', gate_passed_on_attempt: 2, handbacks: 2, recorded_at }),
          task('c', { outcome: 'failed', handbacks: 1, recorded_at }),
          task('d'),
        ],
        { median_ms: 47 * 60_000, sample_count: 5 },
        { gate_first_pass: { tasks: 3, passed: 1 } },
      ),
    });
    expect(out).toContain(`aria-label="${zh('insights.quality.label')}"`);
    const cells = [
      ...out.matchAll(
        /class="bd-kpi-k">([^<]+)<\/span><span class="bd-kpi-v">(.*?)<\/span><\/div>/g,
      ),
    ].map((m) => [
      m[1],
      m[2]!
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ]);
    expect(cells).toEqual([
      [zh('insights.quality.firstPass'), '33% 共 3 个任务'],
      [zh('insights.quality.rework'), '1.0 轮 / 任务，共 3 个任务'],
      [zh('insights.quality.cycle'), '47 分钟 中位数，共 5 个任务'],
      [zh('insights.quality.merged'), '0'],
    ]);
  });

  it('shows a dash for each figure with nothing to count', () => {
    const out = html(QualityKpis, {
      model: quality([task('d')], { median_ms: null, sample_count: 0 }),
    });
    expect(out.match(/<b>—<\/b>/g)).toHaveLength(3);
    expect(out).not.toContain('共');
  });

  it('averages rework over the retrospectives recorded in the range only', () => {
    const out = html(QualityKpis, {
      model: quality(
        [
          task('a', { outcome: 'merged', handbacks: 1, recorded_at }),
          task('b', {
            outcome: 'failed',
            handbacks: 5,
            recorded_at: new Date(2026, 9, 1).getTime(),
          }),
        ],
        { median_ms: null, sample_count: 0 },
        {},
        1,
      ),
    });
    expect(out).toMatch(/合并前返工<\/span><span class="bd-kpi-v"><b>1\.0<\/b>[^]*?共 1 个任务/);
  });

  const firstPassCell = (out: string) =>
    /门禁首次通过<\/span><span class="bd-kpi-v">(.*?)<\/span><\/div>/
      .exec(out)![1]!
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  it("rates first-pass gates from the range's count, not from the tasks on the board", () => {
    const retro = task('a', { outcome: 'merged', gate_passed_on_attempt: 2, handbacks: 1 });
    const cycle = { median_ms: null, sample_count: 0 };
    const counted = quality([retro], cycle, { gate_first_pass: { tasks: 9, passed: 7 } });
    expect(firstPassCell(html(QualityKpis, { model: counted }))).toBe('78% 共 9 个任务');
    expect(firstPassCell(html(QualityKpis, { model: quality([retro], cycle) }))).toBe('—');
  });

  it("shows the first-pass rate of the days before the range beside this range's", () => {
    const cycle = { median_ms: null, sample_count: 0 };
    const counts = (previous?: { tasks: number; passed: number }) => ({
      gate_first_pass: { tasks: 9, passed: 7 },
      ...(previous && {
        previous: {
          tokens: 0,
          cost_usd: null,
          merged: 0,
          median_ms: null,
          gate_first_pass: previous,
        },
      }),
    });
    const cell = (days: number, previous?: { tasks: number; passed: number }) =>
      firstPassCell(html(QualityKpis, { model: quality([], cycle, counts(previous), days) }));
    expect(cell(7, { tasks: 7, passed: 5 })).toBe('78% 共 9 个任务 上周 71%');
    expect(cell(1, { tasks: 2, passed: 1 })).toBe('78% 共 9 个任务 昨天 50%');
    expect(cell(30, { tasks: 4, passed: 3 })).toBe('78% 共 9 个任务 前 30 天 75%');
    // All time has no days before it, and an earlier range without such tasks has no rate.
    expect(cell(7)).toBe('78% 共 9 个任务');
    const none = quality([], cycle, {
      gate_first_pass: { tasks: 9, passed: 7 },
      previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
    });
    expect(firstPassCell(html(QualityKpis, { model: none }))).toBe('78% 共 9 个任务');
  });
});

describe('most failed gate steps', () => {
  const failing = (id: string, names: string[], passing: string[] = []) =>
    run(id, [
      ...names.map((name) => result(name, { exit_code: 1, duration_ms: 31_000 })),
      ...passing.map((name) => result(name, { exit_code: 0 })),
    ]);

  it('lists the five steps that failed most, most first, with the batch size and median time', () => {
    const runs = [
      failing('r1', ['test', 'lint', 'types'], ['format']),
      failing('r2', ['test', 'lint', 'e2e']),
      failing('r3', ['test', 'build', 'docs']),
      failing('r4', ['test', 'lint']),
      run('r5', [result('format', { timed_out: true, exit_code: null })]),
    ];
    const out = html(GateFailures, { runs, range: '7 天' });
    expect(out).toContain(zh('insights.gateFailures.title'));
    expect(out).toContain('<span class="bp-hn">7 天，共 5 次门禁</span>');
    const rows = [...out.matchAll(/class="ql-fn"[^>]*>([^<]+)<.*?class="ql-fc">([^<]+)</g)].map(
      (m) => [m[1], m[2]],
    );
    expect(rows).toEqual([
      ['test', '4 次'],
      ['lint', '3 次'],
      ['build', '1 次'],
      ['docs', '1 次'],
      ['e2e', '1 次'],
    ]);
    expect(out).toContain('style="width:75%"');
    expect(out).toContain('31 秒');
  });

  it('marks the steps that both passed and failed on one commit as flaky', () => {
    const runs = [failing('r1', ['test', 'lint', 'types']), failing('r2', ['test', 'lint'])];
    const out = html(GateFailures, { runs, range: '7 天', flaky: ['lint', 'e2e'] });
    const names = [...out.matchAll(/<div class="ql-fr">(.*?)<span class="ql-ft"/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual([
      '<span class="ql-fk"><span class="ql-fn" title="lint">lint</span><span class="chip">时过时不过</span></span>',
      '<span class="ql-fn" title="test">test</span>',
      '<span class="ql-fn" title="types">types</span>',
    ]);
  });

  it('draws nothing when no step failed', () => {
    expect(
      html(GateFailures, { runs: [run('ok', [result('lint', { exit_code: 0 })])], range: '7 天' }),
    ).toBe('');
  });
});

describe('quality tab layout', () => {
  it('puts the overview first, then the completion trend, the cycle time beside the merges per day, the failed steps, findings beside the matrix, the merge history and the gate history', () => {
    const model = {
      since: NOW - 7 * DAY,
      now: NOW,
      headline: null,
      counts: { running: 1, waiting: 0, ready: 0, failed: 0, merged: 0 },
      tasks: [],
      edges: [],
      lanes: [],
      milestones: [],
      burnup: [],
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
      },
      merges: [],
      findings: [],
      risks: [],
    } as unknown as BoardModel;
    const tree = mount(() =>
      InsightsView({
        model,
        loading: false,
        error: null,
        onRetry: noop,
        days: 7,
        onDays: noop,
        section: 'quality',
        onSection: noop,
        projectId: 'project-a',
        onOpenSession: noop,
        onOpenStory: noop,
      }),
    ).value;
    const panel = find(
      tree,
      (n) => n.props.value === 'quality' && n.props.className?.includes('bd-sub'),
    );
    const slots = nodes(panel.props.children).filter((n) => n.props.title);
    expect(slots.map((n) => n.props.title)).toEqual([
      zh('insights.quality.label'),
      zh('board.trend.title'),
      zh('board.cycle.title'),
      zh('insights.mergesPerDay.title'),
      zh('insights.gateFailures.title'),
      zh('board.findings.title'),
      zh('board.reviewMatrix.title'),
      zh('board.merges.title'),
      zh('board.gateHistory.title'),
    ]);
    const widths = nodes(panel.props.children)
      .filter((n) => n.type === 'div')
      .map((n) => [
        n.props.className,
        nodes(n.props.children).find((c) => c.props.title)!.props.title,
      ]);
    expect(widths).toEqual([
      ['bd-s12', zh('insights.quality.label')],
      ['bd-s12', zh('board.trend.title')],
      ['bd-s6', zh('board.cycle.title')],
      ['bd-s6', zh('insights.mergesPerDay.title')],
      ['bd-s12', zh('insights.gateFailures.title')],
      ['bd-s6', zh('board.findings.title')],
      ['bd-s6', zh('board.reviewMatrix.title')],
      ['bd-s12', zh('board.merges.title')],
      ['bd-s12', zh('board.gateHistory.title')],
    ]);
    expect(text(panel)).not.toContain('审查指标');
  });
});
