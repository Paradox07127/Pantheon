import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Improvement } from '@pantheon/domain';
import { find, HookHost, nodes, text } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
import { LearnedList, type LearnedListProps } from '@/screens/memory/LearnedList';
import { zh } from './i18n-setup.js';

const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 10, day, hour, minute).getTime();

const item = (over: Partial<Improvement> & { id: string }): Improvement => ({
  revision: 1,
  project_id: 'p1',
  source: 'daemon',
  retrospective_ids: ['r1', 'r2', 'r3'],
  status: 'candidate',
  change: { type: 'experience', procedure: `rule ${over.id}` },
  proposed_at: at(13, 14, 33),
  ...over,
});

const items: Improvement[] = [
  item({
    id: 'c1',
    change: {
      type: 'experience',
      domain: 'backend-logic',
      tier: 't2',
      runtime: 'codex',
      procedure: 'run `pnpm test webhook` first',
    },
  }),
  item({ id: 'a1', status: 'active', decided_at: at(6, 9, 0) }),
  item({
    id: 't1',
    status: 'trial',
    trial_started_at: at(11, 9, 0),
    change: { type: 'policy_change', param: 'max_parallel', from: 3, to: 4 },
  }),
  item({
    id: 'a2',
    status: 'active',
    decided_at: at(2, 9, 0),
    retrospective_ids: ['r1'],
    change: { type: 'policy_change', param: 'path', tier: 't1', from: 'dispatch', to: 'direct' },
  }),
  item({ id: 'x1', status: 'reverted', status_reason: 'not_better', decided_at: at(10, 9, 0) }),
  item({ id: 'c2' }),
  item({ id: 'x2', status: 'rejected', decided_at: at(9, 9, 0) }),
];

const props = (over: Partial<LearnedListProps> = {}): LearnedListProps => ({
  items,
  pinned: [],
  selected: null,
  onSelect: vi.fn(),
  ...over,
});

const mount = (p: LearnedListProps) => {
  const host = new HookHost(() => LearnedList(p) as ReactElement<any>);
  host.render();
  return host;
};
const listboxes = (tree: ReactElement<any>) =>
  nodes(tree).filter((n) => n.props.role === 'listbox');
const rows = (tree: ReactElement<any>) => nodes(tree).filter((n) => n.props.role === 'option');
const fold = (tree: ReactElement<any>) => find(tree, (n) => 'aria-expanded' in n.props);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('learned list', () => {
  it('heads the columns and groups the rows awaiting you, on trial and in force', () => {
    const tree = mount(props()).value;
    const out = renderToStaticMarkup(tree);
    expect(out).toContain(`aria-label="${zh('memory.learned.label')}"`);
    expect(out).toMatch(
      /class="lr-head"><span><\/span><span>规则<\/span><span>适用范围<\/span><span>状态<\/span><span class="lr-n">依据<\/span><\/div>/,
    );
    expect(listboxes(tree).map((n) => n.props['aria-label'])).toEqual([
      zh('memory.learned.group.candidate'),
      zh('memory.learned.group.trial'),
      zh('memory.learned.group.active'),
    ]);
    expect(listboxes(tree).map((n) => rows(n).map((r) => r.key))).toEqual([
      ['c1', 'c2'],
      ['t1'],
      ['a1', 'a2'],
    ]);
    for (const [name, count] of [
      [zh('memory.learned.group.candidate'), 2],
      [zh('memory.learned.group.trial'), 1],
      [zh('memory.learned.group.active'), 2],
    ])
      expect(out).toContain(
        `<div class="lr-gh"><span class="lr-gn">${name}</span><span class="lr-ct">${count}</span></div>`,
      );
  });

  it('leaves out a group with no rows', () => {
    const tree = mount(props({ items: items.filter((i) => i.status !== 'trial') })).value;
    expect(listboxes(tree).map((n) => n.props['aria-label'])).toEqual([
      zh('memory.learned.group.candidate'),
      zh('memory.learned.group.active'),
    ]);
    expect(renderToStaticMarkup(tree)).not.toContain(zh('memory.learned.group.trial'));
  });

  it('draws a row with its state glyph, rule, scope, status and how many retrospectives back it', () => {
    const tree = mount(props()).value;
    const out = renderToStaticMarkup(rows(tree)[0]!);
    expect(out).toMatch(
      /^<button type="button" role="option" aria-selected="false" class="lr-row"/,
    );
    expect(out).toMatch(/<span class="lr-st" aria-hidden="true"><svg [^>]*data-shape="clipboard"/);
    expect(out).toContain(
      '<span class="lr-rule">run <span class="lr-inl">pnpm test webhook</span> first</span>',
    );
    expect(out).toMatch(
      /<span class="lr-sc"><span>后端逻辑<\/span><span class="lr-mono">T2<\/span><span class="lr-rt"><svg [^>]*>.*?<\/svg>Codex<\/span><\/span>/,
    );
    expect(out).toContain('<span class="lr-tm">27 分钟</span><span class="lr-n">3 次复盘</span>');
    const shapes = rows(tree).map(
      (r) => renderToStaticMarkup(r).match(/data-shape="([^"]+)"/)?.[1],
    );
    expect(shapes).toEqual([
      'clipboard',
      'clipboard',
      'hollow-diamond',
      'circle-check',
      'circle-check',
    ]);
    const trial = renderToStaticMarkup(rows(tree)[2]!);
    expect(trial).toContain('<span class="lr-rule">并发上限从 3 改成 4</span>');
    expect(trial).toContain(
      `<span class="lr-sc"><span>${zh('data.workflowPolicy.wholeProject')}</span></span>`,
    );
    expect(trial).toContain('<span class="lr-tm">第 3 天</span>');
    expect(renderToStaticMarkup(rows(tree)[3]!)).toContain(
      '<span class="lr-tm">11 月 6 日起</span>',
    );
  });

  it('marks the selected row and selects the row that is clicked', () => {
    const p = props({ selected: 't1' });
    const tree = mount(p).value;
    expect(rows(tree).map((r) => r.props['aria-selected'])).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    rows(tree)[3]!.props.onClick();
    expect(p.onSelect).toHaveBeenCalledWith('a1');
  });

  it('marks a pinned parameter on the policy change in force that set it', () => {
    const tree = mount(props({ pinned: ['path'] })).value;
    const marked = rows(tree).filter((r) =>
      renderToStaticMarkup(r).includes(zh('memory.learned.pinned')),
    );
    expect(marked.map((r) => r.key)).toEqual(['a2']);
    expect(renderToStaticMarkup(marked[0]!)).toMatch(
      /<span class="lr-rw"><span class="lr-rule">任务路径 T1从 派任务会话 改成 主会话直接做<\/span><span class="chip lr-pin"><svg [^>]*>.*?<\/svg>已钉住<\/span><\/span>/,
    );
    const reverted = item({
      id: 'x3',
      status: 'reverted',
      change: { type: 'policy_change', param: 'path', from: 'dispatch', to: 'direct' },
    });
    const folded = mount(props({ items: [reverted], pinned: ['path'] }));
    fold(folded.value).props.onClick();
    folded.render();
    expect(renderToStaticMarkup(folded.value)).not.toContain(zh('memory.learned.pinned'));
  });

  it('folds the reverted and rejected rows under a button that opens them', () => {
    const host = mount(props());
    const closed = renderToStaticMarkup(host.value);
    expect(closed).toMatch(
      /<button type="button" class="lr-gh lr-fold" aria-expanded="false"><svg [^>]*>.*?<\/svg><span class="lr-gn">已撤回和已拒绝<\/span><span class="lr-ct">2<\/span><\/button>/,
    );
    expect(listboxes(host.value)).toHaveLength(3);
    fold(host.value).props.onClick();
    host.render();
    expect(fold(host.value).props['aria-expanded']).toBe(true);
    const old = listboxes(host.value)[3]!;
    expect(old.props['aria-label']).toBe(zh('memory.learned.group.closed'));
    expect(old.props.className).toBe('lr-old');
    expect(rows(old).map((r) => r.key)).toEqual(['x1', 'x2']);
    expect(rows(old).map((r) => text(r.props.children))).toEqual([
      expect.stringContaining('撤回：没变好'),
      expect.stringContaining(zh('memory.learned.rejected')),
    ]);
    expect(
      rows(old).map((r) => renderToStaticMarkup(r).match(/data-shape="([^"]+)"/)?.[1]),
    ).toEqual(['hollow-circle', 'hollow-circle']);
    fold(host.value).props.onClick();
    host.render();
    expect(listboxes(host.value)).toHaveLength(3);
  });

  it('shows no fold when nothing was reverted or rejected', () => {
    const tree = mount(props({ items: items.filter((i) => i.id[0] !== 'x') })).value;
    expect(nodes(tree).some((n) => 'aria-expanded' in n.props)).toBe(false);
  });

  it('staggers the rows in, holding the delay after the sixth', () => {
    const tree = mount(props()).value;
    expect(rows(tree).map((r) => r.props.style['--lr-k'])).toEqual([0, 1, 2, 3, 4]);
    const many = Array.from({ length: 9 }, (_, i) => item({ id: `c${i}` }));
    expect(rows(mount(props({ items: many })).value).map((r) => r.props.style['--lr-k'])).toEqual([
      0, 1, 2, 3, 4, 5, 6, 6, 6,
    ]);
  });
});

describe('learned list columns', () => {
  const css = readFileSync(
    path.resolve(import.meta.dirname, '../../apps/web/src/screens/memory/memory-learned.css'),
    'utf8',
  );
  const columns = (selector: string) =>
    new RegExp(`\\${selector} \\{[^}]*grid-template-columns: ([^;]+);`).exec(css)![1]!;

  /** The track widths a grid with these columns and 8px gaps gives in `width` pixels. */
  function trackWidths(template: string, width: number): number[] {
    const tracks = [...template.matchAll(/minmax\(([^,]+), ([^)]+)\)|(\d+)px/g)].map((m) =>
      m[3]
        ? { min: Number(m[3]), max: Number(m[3]), fr: false }
        : {
            min: parseFloat(m[1]!),
            max: m[2]!.endsWith('fr') ? Infinity : parseFloat(m[2]!),
            fr: m[2]!.endsWith('fr'),
          },
    );
    const sizes = tracks.map((t) => t.min);
    let free = width - 8 * (tracks.length - 1) - sizes.reduce((a, b) => a + b, 0);
    for (let growing = tracks.filter((t) => !t.fr); free > 0.01;) {
      growing = growing.filter((t) => sizes[tracks.indexOf(t)]! < t.max);
      if (!growing.length) break;
      const share = free / growing.length;
      for (const t of growing) {
        const i = tracks.indexOf(t);
        const step = Math.min(share, t.max - sizes[i]!);
        sizes[i] = sizes[i]! + step;
        free -= step;
      }
    }
    tracks.forEach((t, i) => {
      if (t.fr && free > 0) sizes[i] = sizes[i]! + free;
    });
    return sizes;
  }

  it('keeps the rule readable beside the details at the narrowest window', () => {
    // 1100px window, 248px sidebar, 8px inset, 400px details, then the list and row paddings.
    const width = 1100 - 248 - 8 - 400 - 32 - 16;
    for (const selector of ['.lr-row', '.lr-head']) {
      expect(columns(selector)).toBe(columns('.lr-row'));
      expect(trackWidths(columns(selector), width)[1]).toBeGreaterThanOrEqual(160);
    }
  });

  it('gives the rule the room the other columns leave in a wide list', () => {
    const [, rule, scope, status, basis] = trackWidths(columns('.lr-row'), 900);
    expect([scope, status, basis]).toEqual([184, 104, 64]);
    expect(rule).toBe(900 - 32 - 14 - 184 - 104 - 64);
  });
});
