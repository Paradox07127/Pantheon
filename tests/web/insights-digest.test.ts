import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BoardModel } from '@pantheon/protocol';
import type { ImprovementFinding } from '@/data/workflow-policy';
import { zh } from './i18n-setup.js';
import { find, text } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  signals: {
    read: null as ImprovementFinding[] | null,
    loading: false,
    error: null as string | null,
  },
  retros: [] as unknown[][],
}));
vi.mock('@/data/workflow-policy', async (actual) => ({
  ...(await actual<object>()),
  useImprovementSignals: () => ({ ...mock.signals, unavailable: false, stale: false, reload() {} }),
}));
vi.mock('@/screens/settings/settings-jump', async (actual) => ({
  ...(await actual<object>()),
  openRetrospective: (...args: unknown[]) => void mock.retros.push(args),
}));
import {
  DigestPanel,
  digestFindings,
  digestMarkdown,
  mergeGroups,
  runtimeSplits,
} from '@/screens/insights/DigestPanel';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 11, 12);
const DAY = 86_400_000;

const task = (name: string, patch: Partial<Task>): Task => ({
  id: `lead-a:${name}`,
  owner_session_id: 'lead-a',
  title: `task ${name}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'done',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: NOW - DAY,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...patch,
});

const merge = (session_id: string) => ({
  session_id,
  title: session_id,
  merged_at: NOW - DAY,
  from_sha: null,
  sha: `sha-${session_id}`,
  additions: 1,
  deletions: 0,
  story_id: null,
});

const MODEL = {
  since: NOW - 7 * DAY,
  now: NOW,
  counts: { merged: 4, median_ms: 47 * 60_000 },
  milestones: [
    { id: 'm-refund', title: 'refund rollout', session_ids: [], merged: 1, status: 'active' },
    { id: 'm-export', title: 'order export', session_ids: [], merged: 1, status: 'completed' },
  ],
  task_progress: {
    totals: {
      done: 10,
      running: 2,
      waiting: 1,
      idle: 0,
      ready: 0,
      failed: 1,
      discarded: 3,
      not_started: 2,
    },
    daily: [],
    cycle: { median_ms: 47 * 60_000, p90_ms: null, sample_count: 3, buckets: [] },
  },
  tasks: [
    task('a', {
      milestone_id: 'm-refund',
      claim: { session_id: 's-a', runtime: 'claude', model: null },
      retrospective: {
        id: 'r-a',
        outcome: 'merged',
        recorded_at: NOW - DAY,
        gate_passed_on_attempt: 1,
        handbacks: 0,
      },
    }),
    task('b', {
      milestone_id: 'm-refund',
      claim: { session_id: 's-b', runtime: 'claude', model: null },
      retrospective: {
        id: 'r-b',
        outcome: 'merged',
        recorded_at: NOW - DAY,
        gate_passed_on_attempt: 2,
        handbacks: 1,
      },
    }),
    task('c', {
      milestone_id: 'm-export',
      claim: { session_id: 's-c', runtime: 'codex', model: null },
      retrospective: {
        id: 'r-c',
        outcome: 'merged',
        recorded_at: NOW - DAY,
        gate_passed_on_attempt: 1,
        handbacks: 0,
      },
    }),
    task('d', {
      status: 'discarded',
      claim: { session_id: 's-d', runtime: 'codex', model: null },
      retrospective: { id: 'r-d', outcome: 'removed', handbacks: 0 },
    }),
    task('open', { status: 'running', ended_at: null }),
  ],
  merges: [merge('s-a'), merge('s-b'), merge('s-a'), merge('s-c'), merge('s-loose')],
} as unknown as BoardModel;

const FINDINGS: ImprovementFinding[] = [
  { signal: 'repeat_gate_failure', retrospective_ids: ['r-b', 'r-old'] },
  { signal: 'handback_loop', retrospective_ids: ['r-old'] },
  {
    signal: 'queue_wait',
    retrospective_ids: ['r-a'],
    suggestion: { type: 'policy_change', param: 'max_parallel', to: 3 },
    withheld: 'already_set',
  },
  {
    signal: 'over_budget',
    cell: { domain: 'backend-logic', tier: 't2' },
    retrospective_ids: ['r-a', 'r-c'],
  },
];

const dg = (key: string) => zh(`insights.digest.${key}`);
const kpis = (html: string) =>
  [
    ...html.matchAll(
      /<span class="cap">([^<]+)<\/span><div class="wkd-kv"><span class="kpi">([^<]+)<\/span>(?:<span class="wkd-d">([^<]+)<\/span>)?/g,
    ),
  ].map((m) => m.slice(1).filter(Boolean));

const render = (model: BoardModel | null = MODEL) =>
  renderToStaticMarkup(
    createElement(DigestPanel, {
      model,
      projectId: 'project-a',
      bar: null,
      week: 0,
      onWeek() {},
    }),
  );

beforeEach(() => {
  mock.signals = { read: FINDINGS, loading: false, error: null };
});

describe('weekly digest panel', () => {
  it('draws only the skeleton until the board and the signals have both been read', () => {
    for (const html of [
      render(null),
      ((mock.signals = { read: null, loading: true, error: null }), render()),
    ]) {
      expect(html).toContain('skel');
      expect(html).not.toContain('class="kpi"');
      expect(html).not.toContain('refund rollout');
    }
  });

  it('shows the merges, the median start to merge and the discarded tasks of all tasks', () => {
    expect(kpis(render())).toEqual([
      [dg('merged'), '4'],
      [zh('insights.quality.cycle'), '47 分钟'],
      [dg('waiting'), '—'],
      [dg('discarded'), '3', '共 19 个'],
    ]);
  });

  it('groups what merged by milestone, the tasks outside any milestone last', () => {
    const html = render();
    const rows = [
      ...html.matchAll(/<span class="wkd-mt">([^<]+)<\/span><span class="wkd-mn">([^<]+)<\/span>/g),
    ].map((m) => [m[1], m[2]]);
    expect(rows).toEqual([
      ['refund rollout', '2 个任务'],
      ['order export', '1 个任务，已完成'],
      [dg('noMilestone'), '1 个任务'],
    ]);
  });

  it("splits each runtime's finished tasks into first passes and rework, with the numbers beside the bar", () => {
    const html = render();
    expect(html).toContain('aria-label="Claude：1 个首次过门禁，1 个返工"');
    expect(html).toContain('1 首次过，1 返工');
    expect(html).toContain('aria-label="Codex：1 个首次过门禁，0 个返工"');
    expect(html).toContain('1 首次过，0 返工');
    expect(html).toContain('样本只有 3 个任务，差别可能只是任务不同。');
  });

  it('lists the signals of this range that suggest something, each linking to a retrospective', () => {
    const html = render();
    const rules = html.split('<li class="wkd-rule">').slice(1);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toContain('同一个门禁检查在 2 次复盘里都失败了。');
    expect(rules[1]).toContain('最近 2 个后端逻辑 T2任务大多超了预算。');
    for (const rule of rules) expect(rule).toContain(dg('openRetro'));
  });

  it('opens the newest retrospective a signal rests on', () => {
    mock.retros = [];
    const tree = DigestPanel({
      model: MODEL,
      projectId: 'project-a',
      bar: null,
      week: 0,
      onWeek() {},
    });
    const opens = (rule: string) =>
      find(
        find(tree, (n) => n.props.className === 'wkd-rule' && text(n).includes(rule)),
        (n) => n.type === 'button',
      );
    opens('同一个门禁检查').props.onClick();
    opens('超了预算').props.onClick();
    expect(mock.retros).toEqual([['r-b'], ['r-a']]);
  });

  it('says so when no signal rests on this range', () => {
    mock.signals = { read: [FINDINGS[1]!], loading: false, error: null };
    const html = render();
    expect(html).toContain(dg('noRules'));
    expect(html).not.toContain('wkd-rule"');
  });

  it('shows a failed signal read with a retry and still draws the board numbers', () => {
    mock.signals = { read: null, loading: false, error: '读取失败（boom）' };
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain('读取失败（boom）');
    expect(html).toContain(zh('components.retry'));
    expect(html).toContain('refund rollout');
  });

  it('exports the same numbers as markdown', () => {
    const text = digestMarkdown(MODEL, FINDINGS, 0);
    expect(text).toContain('# 周复盘');
    expect(text).toContain('- 合并：4');
    expect(text).toContain('- 丢弃的任务：3（共 19 个）');
    expect(text).toContain('- refund rollout：2 个任务');
    expect(text).toContain('- Claude：1 首次过，1 返工');
    expect(text).toContain('- 同一个门禁检查在 2 次复盘里都失败了。');
    expect(text).toContain('## 各运行时表现');
    expect(text).not.toContain('交回');
  });
});

describe('weekly digest weeks', () => {
  // The week of 11-05 through 11-11, local time.
  const WEEK = { ...MODEL, since: new Date(2026, 10, 5).getTime() } as BoardModel;
  const bar = { nodeType: 1 } as unknown as HTMLElement;
  const dates = '11月5日 – 11日';
  // The top bar's controls, from the portal the panel puts into it.
  const barOf = (week: number, onWeek: (week: number) => void = () => {}, model = WEEK) => {
    const section = DigestPanel({ model, projectId: 'project-a', bar, week, onWeek }) as any;
    const portal = [section.props.children]
      .flat()
      .find((child: any) => child?.containerInfo === bar);
    return portal.children;
  };
  const buttons = (controls: any) =>
    [controls.props.children].flat().filter((c: any) => c?.type === 'button');
  const panel = (week: number, model = WEEK) =>
    renderToStaticMarkup(
      createElement(DigestPanel, { model, projectId: 'project-a', bar: null, week, onWeek() {} }),
    );
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('puts the previous week, the dates, the next week and the export in the top bar', () => {
    const html = renderToStaticMarkup(barOf(0));
    const order = [
      ...html.matchAll(/aria-label="([^"]+)"|class="wkd-wk">([^<]+)<|<\/svg>(导出)/g),
    ].map((m) => m[1] ?? m[2] ?? m[3]);
    expect(order).toEqual([dg('previousWeek'), dates, dg('nextWeek'), dg('export')]);
    expect(html).toMatch(/<button type="button" class="ib" aria-label="下一周" disabled="">/);
    expect(renderToStaticMarkup(barOf(1))).not.toContain('disabled');
  });

  it('writes both months for a week that crosses a month', () => {
    const crossing = { ...MODEL, since: new Date(2026, 9, 29).getTime() } as BoardModel;
    expect(renderToStaticMarkup(barOf(1, () => {}, crossing))).toContain(
      'class="wkd-wk">10月29日 – 11月4日<',
    );
  });

  it('steps a week back from the previous week button and forward from the next', () => {
    const onWeek = vi.fn();
    const [previous] = buttons(barOf(0, onWeek));
    previous.props.onClick();
    expect(onWeek).toHaveBeenLastCalledWith(1);
    const [, next] = buttons(barOf(2, onWeek));
    next.props.onClick();
    expect(onWeek).toHaveBeenLastCalledWith(1);
  });

  it('shows last week beside the merges and the start to merge time', () => {
    const model = {
      ...WEEK,
      counts: {
        merged: 4,
        median_ms: 47 * 60_000,
        previous: { tokens: 0, cost_usd: null, merged: 17, median_ms: 72 * 60_000 },
      },
    } as BoardModel;
    expect(kpis(panel(0, model))).toEqual([
      [dg('merged'), '4', '上周 17'],
      [zh('insights.quality.cycle'), '47 分钟', '上周 1 小时 12 分'],
      [dg('waiting'), '—'],
      [dg('discarded'), '3', '共 19 个'],
    ]);
  });

  it('draws neither the rules nor the discarded tasks for an earlier week', () => {
    const html = panel(1);
    expect(html).not.toContain(dg('rules'));
    expect(html).not.toContain(dg('discarded'));
    expect(html).toContain(`<span class="cap">${dg('merged')}</span>`);
    expect(html).toContain(`<span class="cap">${zh('insights.quality.cycle')}</span>`);
    expect(html).toContain(dg('mergedWhat'));
    expect(html).toContain(`<h3>${dg('runtimes')}</h3>`);
    expect(panel(0)).toContain(dg('rules'));
  });

  it('counts only the retrospectives recorded in the week for each model', () => {
    const retro = (id: string, recorded_at: number) =>
      task(id, {
        claim: { session_id: `s-${id}`, runtime: 'gemini', model: null },
        retrospective: {
          id: `r-${id}`,
          outcome: 'merged',
          recorded_at,
          gate_passed_on_attempt: 2,
          handbacks: 0,
        },
      });
    const model = {
      ...WEEK,
      tasks: [
        retro('before', new Date(2026, 10, 4, 23).getTime()),
        retro('first', new Date(2026, 10, 5).getTime()),
        retro('last', new Date(2026, 10, 11, 23, 59).getTime()),
        retro('after', new Date(2026, 10, 12).getTime()),
      ],
    } as BoardModel;
    for (const week of [0, 1]) {
      const html = panel(week, model);
      expect(html).toContain('0 首次过，2 返工');
      expect(html).toContain('样本只有 2 个任务');
    }
  });

  it('exports the week shown: its dates in the file name and title, and only the blocks drawn', async () => {
    let saved: Blob | null = null;
    const link = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: () => link });
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => ((saved = blob), 'blob:digest'),
      revokeObjectURL() {},
    });
    buttons(barOf(1)).at(-1).props.onClick();
    expect(link.download).toBe('digest-2026-11-05-2026-11-11.md');
    const text = await saved!.text();
    expect(text.split('\n')[0]).toBe(`# 周复盘，${dates}`);
    expect(text).toContain('- 合并：4');
    expect(text).toContain('## 这周合并了什么');
    expect(text).not.toContain(dg('discarded'));
    expect(text).not.toContain(dg('rules'));
    expect(digestMarkdown(WEEK, FINDINGS, 0)).toContain('## 可以改的规则');
  });
});

describe('weekly digest populations', () => {
  const MIN = 60_000;
  const segment = (session_id: string) =>
    ({ id: `seg-${session_id}`, session_id }) as Task['segments'][number];

  it('counts a task once when two of its parallel sessions merged', () => {
    const model = {
      ...MODEL,
      tasks: [
        task('split', {
          milestone_id: 'm-refund',
          segments: [segment('s-left'), segment('s-right')],
          claim: { session_id: 's-right', runtime: 'claude', model: null },
        }),
      ],
      merges: [merge('s-left'), merge('s-right')],
    } as BoardModel;
    expect(mergeGroups(model)).toEqual([
      { key: 'm-refund', title: 'refund rollout', tasks: 1, completed: false },
    ]);
  });

  it('counts a task accepted without a gate run neither as a first pass nor as rework', () => {
    const model = {
      ...MODEL,
      tasks: [
        task('report', {
          claim: { session_id: 's-report', runtime: 'codex', model: null },
          retrospective: {
            id: 'r-report',
            outcome: 'accepted',
            recorded_at: NOW - DAY,
            handbacks: 0,
          },
        }),
      ],
    } as BoardModel;
    expect(runtimeSplits(model)).toEqual([]);
  });

  it('compares the start to merge with last week over the same merged sessions', () => {
    mock.signals = { read: [], loading: false, error: null };
    const model = {
      ...MODEL,
      counts: {
        merged: 4,
        median_ms: 30 * MIN,
        previous: { tokens: 0, cost_usd: null, merged: 17, median_ms: 72 * MIN },
      },
    } as BoardModel;
    expect(kpis(render(model))[1]).toEqual([
      zh('insights.quality.cycle'),
      '30 分钟',
      '上周 1 小时 12 分',
    ]);
  });

  it('leaves out a finding whose retrospective was recorded before the week', () => {
    const model = {
      ...MODEL,
      tasks: [
        task('stale', {
          status: 'running',
          ended_at: null,
          retrospective: {
            id: 'r-stale',
            outcome: 'failed',
            recorded_at: NOW - 60 * DAY,
            handbacks: 3,
          },
        }),
      ],
    } as BoardModel;
    const loop: ImprovementFinding = { signal: 'handback_loop', retrospective_ids: ['r-stale'] };
    expect(digestFindings(model, [loop], 0)).toEqual([]);
  });

  it('exports the waiting, last week, the session time and the waits by reason', () => {
    const model = {
      ...MODEL,
      counts: {
        merged: 4,
        median_ms: 47 * MIN,
        previous: { tokens: 0, cost_usd: null, merged: 17, median_ms: 72 * MIN },
        session_time: {
          sessions: 3,
          working_ms: 16 * MIN,
          waiting_ms: 19 * MIN,
          gate_ms: 8 * MIN,
          queue_ms: 4 * MIN,
        },
        wait_by_reason_ms: { approval: 190 * MIN, question: 40 * MIN },
      },
    } as BoardModel;
    const lines = digestMarkdown(model, [], 0).split('\n');
    for (const line of [
      '- 合并：4（上周 17）',
      '- 从开工到合并：47 分钟（上周 1 小时 12 分）',
      '- 其中在等你：19 分钟（占 40%）',
      '## 一个会话的时间花在哪',
      '3 个会话的中位数',
      '- agent 在写：16 分钟',
      '- 等你：19 分钟',
      '- 门禁：8 分钟',
      '- 排队：4 分钟',
      '## 等你的时间，按原因',
      '- 审批命令：3 小时 10 分',
      '- 回答问题：40 分钟',
    ])
      expect(lines).toContain(line);
    expect(lines.join('\n')).not.toContain(dg('reason.review'));
  });
});
