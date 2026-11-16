import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Improvement } from '@pantheon/domain';
import type { BoardModel } from '@pantheon/protocol';
import type { ImprovementFinding } from '@/data/workflow-policy';
import { find, text } from './web-hook-host.js';

const mock = vi.hoisted(() => ({
  signals: {
    read: null as ImprovementFinding[] | null,
    loading: false,
    error: null as string | null,
  },
}));
vi.mock('@/data/workflow-policy', async (actual) => ({
  ...(await actual<object>()),
  useImprovementSignals: () => ({ ...mock.signals, unavailable: false, stale: false, reload() {} }),
}));
import { sourceText } from '@/data/workflow-policy';
import { DigestPanel, digestFindings, digestMarkdown } from '@/screens/insights/DigestPanel';
import { useSettingsView } from '@/screens/settings/view';
import { zh } from './i18n-setup.js';

const NOW = Date.UTC(2026, 10, 11, 12);
const DAY = 86_400_000;
const MIN = 60_000;

const BASE = {
  since: NOW - 7 * DAY,
  now: NOW,
  counts: { merged: 2, median_ms: 47 * MIN },
  milestones: [],
  task_progress: {
    totals: {
      done: 2,
      running: 0,
      waiting: 0,
      idle: 0,
      ready: 0,
      failed: 0,
      discarded: 0,
      not_started: 0,
    },
    daily: [],
    cycle: { median_ms: 47 * MIN, p90_ms: null, sample_count: 2, buckets: [] },
  },
  tasks: [
    {
      id: 'lead-a:a',
      owner_session_id: 'lead-a',
      title: 'task a',
      status: 'done',
      segments: [],
      claim: { session_id: 's-a', runtime: 'claude', model: null },
      retrospective: { id: 'r-a', outcome: 'merged', recorded_at: NOW - DAY, handbacks: 0 },
    },
  ],
  merges: [],
} as unknown as BoardModel;

const TIME = {
  sessions: 3,
  working_ms: 16 * MIN,
  waiting_ms: 19 * MIN,
  gate_ms: 8 * MIN,
  queue_ms: 4 * MIN,
};
const WAITS = { approval: 190 * MIN, review: 118 * MIN, question: 40 * MIN };

const model = (counts: Partial<BoardModel['counts']>) =>
  ({ ...BASE, counts: { ...BASE.counts, ...counts } }) as BoardModel;

const props = (m: BoardModel, week = 0) => ({
  model: m,
  projectId: 'project-a',
  bar: null,
  week,
  onWeek() {},
});
const render = (m: BoardModel, week = 0) =>
  renderToStaticMarkup(createElement(DigestPanel, props(m, week)));

const APPROVED: ImprovementFinding = {
  signal: 'always_approved_command',
  retrospective_ids: [],
  evidence: {
    kind: 'always_approved_command',
    command: 'pnpm db:migrate --env staging',
    approvals: 11,
  },
};
const LATE: ImprovementFinding = {
  signal: 'late_gate_failure',
  retrospective_ids: [],
  evidence: { kind: 'late_gate_failure', name: 'typecheck', runs: 4, median_prior_ms: 5 * MIN },
};
const RETRO: ImprovementFinding = { signal: 'repeat_gate_failure', retrospective_ids: ['r-a'] };
const FINDINGS = [RETRO, APPROVED, LATE];

beforeEach(() => {
  mock.signals = { read: FINDINGS, loading: false, error: null };
});

const kpis = (html: string) =>
  [
    ...html.matchAll(
      /<span class="cap">([^<]+)<\/span><div class="wkd-kv"><span class="kpi">([^<]+)<\/span>(?:<span class="wkd-d">([^<]+)<\/span>)?/g,
    ),
  ].map((m) => m.slice(1).filter(Boolean));

describe('weekly digest waiting for you', () => {
  it('puts the median wait and its share after the start to merge', () => {
    const html = render(model({ session_time: TIME }));
    expect(kpis(html).slice(0, 3)).toEqual([
      [zh('insights.digest.merged'), '2'],
      [zh('insights.quality.cycle'), '47 分钟'],
      [zh('insights.digest.waiting'), '19 分钟', '占 40%'],
    ]);
    // The number counts a status, so it keeps the text colour of the other figures.
    expect(html).toContain('<span class="kpi">19 分钟</span>');
  });

  it('writes a dash without a note when no session merged, and no share when the parts are zero', () => {
    expect(kpis(render(model({})))[2]).toEqual([zh('insights.digest.waiting'), '—']);
    const zero = { sessions: 1, working_ms: 0, waiting_ms: 0, gate_ms: 0, queue_ms: 0 };
    expect(kpis(render(model({ session_time: zero })))[2]).toEqual([
      zh('insights.digest.waiting'),
      '&lt;1 秒',
    ]);
  });

  it('draws the cell for an earlier week too', () => {
    expect(kpis(render(model({ session_time: TIME }), 1)).map((k) => k[0])).toEqual([
      zh('insights.digest.merged'),
      zh('insights.quality.cycle'),
      zh('insights.digest.waiting'),
    ]);
  });
});

describe("weekly digest a session's time", () => {
  it('splits the bar by the four medians and reads them out', () => {
    const html = render(model({ session_time: TIME }));
    expect(html).toContain(
      '<h3>一个会话的时间花在哪</h3><span class="wkd-hn">3 个会话的中位数</span>',
    );
    const bar = html.match(
      /<span class="wkd-seg wkd-seg-lg" role="img" aria-label="([^"]+)">(.*?)<\/span>/,
    )!;
    expect(bar[1]).toBe('agent 在写 16 分钟，等你 19 分钟，门禁 8 分钟，排队 4 分钟');
    expect(
      [...bar[2]!.matchAll(/data-c="(\w+)" style="--n:(\d+)"/g)].map((m) => [m[1], m[2]]),
    ).toEqual([
      ['run', String(16 * MIN)],
      ['wait', String(19 * MIN)],
      ['rev', String(8 * MIN)],
      ['idle', String(4 * MIN)],
    ]);
  });

  it('leaves out a part that took no time from the bar but not from the legend', () => {
    const html = render(model({ session_time: { ...TIME, gate_ms: 0 } }));
    const bar = html.match(/<span class="wkd-seg wkd-seg-lg"[^>]*>(.*?)<\/span>/)![1]!;
    expect([...bar.matchAll(/data-c="(\w+)"/g)].map((m) => m[1])).toEqual(['run', 'wait', 'idle']);
    const legend = [
      ...html.matchAll(
        /<span><i class="wkd-dot" data-c="(\w+)" aria-hidden="true"><\/i><span>([^<]+)<\/span><span class="wkd-lv">([^<]+)<\/span><\/span>/g,
      ),
    ].map((m) => m.slice(1));
    expect(legend).toEqual([
      ['run', zh('insights.digest.part.working'), '16 分钟'],
      ['wait', zh('insights.digest.part.waiting'), '19 分钟'],
      ['rev', zh('insights.digest.part.gates'), '&lt;1 秒'],
      ['idle', zh('insights.digest.part.queued'), '4 分钟'],
    ]);
  });

  it('paints each part of the bar in the colour of its legend dot, none in the empty track', () => {
    const css = readFileSync(
      fileURLToPath(new URL('../../apps/web/src/screens/insights/digest.css', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
      selectors: m[1]!.split(',').map((s) => s.trim()),
      background: /background:\s*([^;]+);/.exec(m[2]!)?.[1],
    }));
    const paint = (selector: string, base: string) =>
      [selector, base]
        .map((s) => rules.find((r) => r.background && r.selectors.includes(s))?.background)
        .find(Boolean);
    const html = render(model({ session_time: TIME }));
    const parts = [...html.matchAll(/<i class="wkd-dot" data-c="(\w+)"/g)].map((m) => m[1]!);
    expect(parts).toHaveLength(4);
    const painted = parts.map((c) => [
      c,
      paint(`.wkd-seg > i[data-c='${c}']`, '.wkd-seg > i'),
      paint(`.wkd-dot[data-c='${c}']`, '.wkd-dot'),
    ]);
    expect(painted.filter(([, seg, dot]) => seg !== dot || seg === 'var(--track)')).toEqual([]);
  });

  it('draws no title, bar or legend without merged sessions', () => {
    const html = render(model({ wait_by_reason_ms: WAITS }));
    expect(html).not.toContain(zh('insights.digest.sessionTime'));
    expect(html).not.toContain('wkd-seg-lg');
    expect(html).not.toContain('wkd-dot');
  });
});

describe('weekly digest waiting by reason', () => {
  const rows = (html: string) =>
    [
      ...html.matchAll(
        /<li><span>([^<]+)<\/span><span class="meter" aria-hidden="true" style="--v:([^"]+)"><i><\/i><\/span><span class="wkd-wv">([^<]+)<\/span><\/li>/g,
      ),
    ].map((m) => m.slice(1));

  it('bars each reason against the longest, in a fixed order', () => {
    const html = render(model({ session_time: TIME, wait_by_reason_ms: WAITS }));
    expect(html).toContain('<hr class="wkd-sep"/>');
    expect(html).toContain(zh('insights.digest.waitByReason'));
    expect(rows(html)).toEqual([
      [zh('insights.digest.reason.approval'), '100%', '3 小时 10 分'],
      [zh('insights.digest.reason.review'), '62%', '1 小时 58 分'],
      [zh('insights.digest.reason.question'), '21%', '40 分钟'],
    ]);
  });

  it('draws only the reasons with time', () => {
    const html = render(model({ wait_by_reason_ms: { question: 40 * MIN, approval: 10 * MIN } }));
    expect(rows(html)).toEqual([
      [zh('insights.digest.reason.approval'), '25%', '10 分钟'],
      [zh('insights.digest.reason.question'), '100%', '40 分钟'],
    ]);
    expect(html).not.toContain('wkd-sep');
  });

  it('draws nothing of it without user waits', () => {
    const html = render(model({ session_time: TIME }));
    expect(html).not.toContain(zh('insights.digest.waitByReason'));
    expect(html).not.toContain('wkd-sep');
    expect(rows(html)).toEqual([]);
  });
});

describe('weekly digest layout of the time and the rules', () => {
  it('puts the time beside the rules this week', () => {
    const html = render(model({ session_time: TIME }));
    expect(html).toMatch(
      /<div class="panel wkd-two"><div class="cell"><div class="wkd-h"><h3>一个会话的时间花在哪<\/h3>.*<div class="cell"><div class="wkd-h"><h3>可以改的规则<\/h3>/,
    );
  });

  it('gives the rules a row of their own without the time', () => {
    const html = render(model({}));
    expect(html).toContain(
      '<div class="panel"><div class="cell"><div class="wkd-h"><h3>可以改的规则</h3>',
    );
  });

  it('gives the time a row of its own for an earlier week', () => {
    const html = render(model({ wait_by_reason_ms: WAITS }), 1);
    expect(html).not.toContain(zh('insights.digest.rules'));
    expect(html).toContain(
      '<div class="panel"><div class="cell"><span class="cap">等你的时间，按原因</span>',
    );
  });
});

describe('weekly digest rules from the last 7 days', () => {
  const rules = (html: string) => html.split('<li class="wkd-rule">').slice(1);

  it('lists the approved command and the late gate step first this week', () => {
    const html = render(model({}));
    const [approved, late, retro] = rules(html);
    expect(rules(html)).toHaveLength(3);
    expect(approved).toContain(
      '<code class="wkd-cmd" title="pnpm db:migrate --env staging">pnpm db:migrate --env staging</code> 这周你批准了 11 次，没拒绝过。',
    );
    expect(approved).not.toContain('<button');
    expect(late).toContain('typecheck 失败 4 次，每次都在前面的步骤跑完 5 分钟之后才发现。');
    expect(late).toContain(zh('insights.digest.openGateSettings'));
    expect(late).not.toContain(zh('insights.digest.openRetro'));
    expect(retro).toContain('同一个门禁检查在 1 次复盘里都失败了。');
    expect(retro).toContain(zh('insights.digest.openRetro'));
  });

  it('keeps them out of an earlier week', () => {
    expect(digestFindings(model({}), FINDINGS, 1)).toEqual([RETRO]);
    expect(digestFindings(model({}), FINDINGS, 0)).toEqual([APPROVED, LATE, RETRO]);
  });

  it('opens the project settings on the gates page from the late gate step', () => {
    useSettingsView.setState({ open: false, page: 'general' });
    const tree = DigestPanel(props(model({})));
    const button = find(
      tree,
      (n) =>
        n.type === 'button' && text(n.props.children) === zh('insights.digest.openGateSettings'),
    );
    button.props.onClick();
    expect(useSettingsView.getState()).toMatchObject({
      open: true,
      detail: 'project-a',
      page: 'gates',
    });
  });

  it('exports both as rule lines', () => {
    const lines = digestMarkdown(model({}), FINDINGS, 0).split('\n');
    expect(lines).toContain('- `pnpm db:migrate --env staging` 这周你批准了 11 次，没拒绝过。');
    expect(lines).toContain('- typecheck 失败 4 次，每次都在前面的步骤跑完 5 分钟之后才发现。');
    expect(digestMarkdown(model({}), FINDINGS, 1)).not.toContain('typecheck');
  });

  it('names both signals as the source of an improvement', () => {
    const improvement = (signal: Improvement['signal']) =>
      ({ source: 'daemon', signal, retrospective_ids: [] }) as unknown as Improvement;
    expect(sourceText(improvement('always_approved_command'))).toContain(
      zh('data.workflowPolicy.signal.alwaysApprovedCommand'),
    );
    expect(sourceText(improvement('late_gate_failure'))).toContain(
      zh('data.workflowPolicy.signal.lateGateFailure'),
    );
  });
});
