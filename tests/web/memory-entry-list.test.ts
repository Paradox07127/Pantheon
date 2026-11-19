import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemorySummary } from '@pantheon/domain';
import { EntryList, type EntryListProps } from '@/screens/memory/EntryList';
import { find, nodes, text } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';

const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const at = (day: number, hour: number, minute: number) =>
  new Date(2026, 10, day, hour, minute).getTime();

const record = (over: Partial<MemorySummary> & { id: string }): MemorySummary => ({
  revision: 1,
  key: over.id,
  title: `title ${over.id}`,
  summary: `summary ${over.id}`,
  tags: [],
  kind: 'decision',
  state: 'active',
  authority: 'user',
  created_at: at(13, 10, 26),
  indexed: true,
  bytes: 10,
  ...over,
});

const taskA = { lead_session_id: 'lead-1', id: 'refund-idempotency' };
const taskB = { lead_session_id: 'lead-1', id: 'webhook-signature' };

const props = (over: Partial<EntryListProps> = {}): EntryListProps => ({
  state: 'active',
  records: [],
  tasks: [{ ...taskA, title: 'Refund idempotency' }, taskB],
  query: '',
  total: 0,
  pageSize: 20,
  indexPending: 0,
  selectedId: null,
  onSelect: vi.fn(),
  hasMore: false,
  loadingMore: false,
  onLoadMore: vi.fn(),
  stale: false,
  onFirstPage: vi.fn(),
  onRestore: vi.fn(),
  busy: false,
  authorTitle: () => undefined,
  ...over,
});

const html = (p: EntryListProps) => renderToStaticMarkup(createElement(EntryList, p));
const tree = (p: EntryListProps) => EntryList(p) as ReactElement<any>;
const options = (p: EntryListProps) => nodes(tree(p)).filter((n) => n.props.role === 'option');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('memory entry list', () => {
  it('puts project-level entries first, then one group per task named by its title', () => {
    const p = props({
      records: [
        record({ id: 'a', task: taskA }),
        record({ id: 'b' }),
        record({ id: 'c', task: taskB }),
        record({ id: 'd', task: taskA }),
      ],
      total: 4,
    });
    const groups = nodes(tree(p)).filter((n) => n.props.role === 'group');
    expect(groups.map((g) => g.props['aria-label'])).toEqual([
      zh('memory.list.projectLevel'),
      'Refund idempotency',
      'webhook-signature',
    ]);
    expect(
      groups.map((g) =>
        nodes(g.props.children)
          .filter((n) => n.props.role === 'option')
          .map((n) => n.key),
      ),
    ).toEqual([['b'], ['a', 'd'], ['c']]);
    const out = html(p);
    expect(out).toContain(`role="listbox" aria-label="${zh('memory.list.label.active')}"`);
    expect(out).toMatch(/class="ml-gh"[^>]*>项目级<span class="ml-ct">1<\/span>/);
    expect(out).toMatch(/class="ml-gh"[^>]*>Refund idempotency<span class="ml-ct">2<\/span>/);
  });

  it('draws a current row with kind, title, summary, tags, who set it and when', () => {
    const p = props({
      records: [
        record({ id: 'a', tags: ['webhook', 'safety'], created_at: at(13, 9, 5) }),
        record({ id: 'b', kind: 'report', authority: 'agent_reported', created_at: at(12, 9, 0) }),
        record({ id: 'c', kind: 'note', created_at: at(10, 9, 0) }),
      ],
      selectedId: 'b',
    });
    const out = html(p);
    expect(out).toMatch(
      /class="ml-row"[^>]*><span [^>]*class="ml-ic"[^>]*aria-label="决定"[^>]*>.*<\/span><span class="ml-t">title a<\/span><span class="ml-s">summary a<\/span><span class="ml-tg"><span class="chip">webhook<\/span><span class="chip">safety<\/span><\/span><span class="ml-by">你定的<\/span><span class="ml-tm">09:05<\/span>/,
    );
    expect(out).toContain(`aria-label="${zh('memory.list.kind.report')}"`);
    expect(out).toContain(`<span class="ml-by">${zh('memory.list.byAgent')}</span>`);
    expect(out).toContain(
      `<span class="ml-tm">${zhf('lib.time.yesterdayAt', { time: '09:00' })}</span>`,
    );
    expect(out).toContain(`aria-label="${zh('memory.list.kind.note')}"`);
    expect(out).toContain('<span class="ml-tm">11月10日 09:00</span>');
    expect(options(p).map((n) => n.props['aria-selected'])).toEqual([false, true, false]);
  });

  it('shows the first two tags of a row and counts the rest', () => {
    const p = props({
      records: [record({ id: 'a', tags: ['webhook', 'safety', 'refunds', 'stripe'] })],
    });
    const shown = text(options(p)[0]!);
    expect(shown).toContain('summary awebhooksafety+2');
    expect(shown).not.toContain('refunds');
    expect(shown).not.toContain('stripe');
  });

  it('selects the entry a row stands for when it is clicked', () => {
    const p = props({ records: [record({ id: 'a' }), record({ id: 'b' })] });
    options(p)[1]!.props.onClick();
    expect(p.onSelect).toHaveBeenCalledWith('b');
  });

  it('selects the focused row with Enter or Space, but not from a button inside it', () => {
    const p = props({ records: [record({ id: 'a' }), record({ id: 'b' })] });
    const row = options(p)[1]!;
    for (const key of ['Enter', ' ']) {
      const preventDefault = vi.fn();
      row.props.onKeyDown({ key, target: 'row', currentTarget: 'row', preventDefault });
      expect(preventDefault).toHaveBeenCalled();
    }
    expect(p.onSelect).toHaveBeenCalledTimes(2);
    expect(p.onSelect).toHaveBeenCalledWith('b');
    row.props.onKeyDown({ key: 'Enter', target: 'button', currentTarget: 'row' });
    row.props.onKeyDown({ key: 'x', target: 'row', currentTarget: 'row' });
    expect(p.onSelect).toHaveBeenCalledTimes(2);
  });

  it('moves focus and the selection to the row above or below with the arrow keys', () => {
    const p = props({ records: [record({ id: 'a' }), record({ id: 'b' })] });
    const el = () => ({ focus: vi.fn(), click: vi.fn() });
    const rows = [el(), el()];
    const list = find(tree(p), (n) => n.props.role === 'listbox');
    const press = (key: string, target: unknown) => {
      const preventDefault = vi.fn();
      list.props.onKeyDown({
        key,
        target,
        currentTarget: { querySelectorAll: () => rows },
        preventDefault,
      });
      return preventDefault;
    };
    expect(press('ArrowDown', rows[0])).toHaveBeenCalled();
    expect(rows[1]!.focus).toHaveBeenCalled();
    expect(rows[1]!.click).toHaveBeenCalled();
    expect(press('ArrowUp', rows[1])).toHaveBeenCalled();
    expect(rows[0]!.click).toHaveBeenCalled();
    expect(press('ArrowDown', rows[1])).not.toHaveBeenCalled();
    expect(press('ArrowDown', {})).not.toHaveBeenCalled();
  });

  it('keeps a tab stop on the first row while the selection is not in the list', () => {
    const records = [record({ id: 'a' }), record({ id: 'b' })];
    const stops = (selectedId: string | null) =>
      options(props({ records, selectedId })).map((n) => n.props.tabIndex);
    expect(stops('elsewhere')).toEqual([0, -1]);
    expect(stops(null)).toEqual([0, -1]);
    expect(stops('b')).toEqual([-1, 0]);
  });

  it('scrolls a newly selected row into view, and moves focus to it when focus was on another row', () => {
    const p = props({ records: [record({ id: 'a' }), record({ id: 'b' })], selectedId: 'b' });
    const [a, b] = options(p);
    expect(a!.props.ref).toBeUndefined();
    const reveal = b!.props.ref as (el: unknown) => void;
    expect(options(p)[1]!.props.ref).toBe(reveal);
    reveal(null);
    const row = (focusedInList: boolean) => ({
      scrollIntoView: vi.fn(),
      focus: vi.fn(),
      ownerDocument: { activeElement: 'other row' },
      closest: () => ({ contains: () => focusedInList }),
    });
    const inside = row(true);
    reveal(inside);
    expect(inside.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(inside.focus).toHaveBeenCalledWith({ preventScroll: true });
    const outside = row(false);
    reveal(outside);
    expect(outside.scrollIntoView).toHaveBeenCalled();
    expect(outside.focus).not.toHaveBeenCalled();
  });

  it('keeps the paging and notice controls outside the listbox', () => {
    const records = Array.from({ length: 20 }, (_, i) => record({ id: `r${i}` }));
    for (const over of [{}, { stale: true }]) {
      const list = find(
        tree(props({ records, total: 27, hasMore: true, ...over })),
        (n) => n.props.role === 'listbox',
      );
      expect(
        nodes(list).filter((n) => n.type === 'button'),
        JSON.stringify(over),
      ).toEqual([]);
    }
  });

  it('marks only entries whose body is not indexed yet', () => {
    const p = props({ records: [record({ id: 'a', indexed: false }), record({ id: 'b' })] });
    const marks = html(p).match(/aria-label="还没进索引，搜索只按标题、摘要和标签命中"/g);
    expect(marks).toHaveLength(1);
    expect(text(options(p)[0]!.props.children)).toContain('title a');
  });

  it("marks how each of the plan's entries ended and says the plan set it", () => {
    const origin = (outcome: 'confirmed' | 'refuted' | 'closed') => ({
      kind: 'plan' as const,
      lead_session_id: 'lead-1',
      subject: 'assumption' as const,
      subject_id: outcome,
      outcome,
      plan_version: 2,
    });
    const p = props({
      records: [
        record({ id: 'a', origin: origin('confirmed') }),
        record({ id: 'b', origin: origin('refuted') }),
        record({ id: 'c', origin: origin('closed') }),
        record({ id: 'd' }),
      ],
    });
    const out = html(p);
    for (const outcome of ['confirmed', 'refuted', 'closed'])
      expect(
        out.match(new RegExp(`aria-label="${zh(`memory.detail.outcome.${outcome}`)}"`, 'g')),
      ).toHaveLength(1);
    const rows = options(p).map((row) => text(row.props.children));
    expect(rows.slice(0, 3).every((row) => row.includes(zh('memory.list.byPlan')))).toBe(true);
    expect(rows[3]).toContain(zh('memory.list.byUser'));
  });

  it('puts a waiting mark before the time of an entry that awaits review', () => {
    const out = html(
      props({
        state: 'draft',
        records: [record({ id: 'a', state: 'draft', created_at: at(13, 10, 33) })],
      }),
    );
    expect(out).toContain(`role="listbox" aria-label="${zh('memory.list.label.draft')}"`);
    expect(out).toContain(
      `<span class="ml-tm"><span class="ml-wait" role="img" aria-label="${zh('memory.list.pending')}"></span>10:33</span>`,
    );
  });

  it('draws an archived row with its reason and a restore button that does not select the row', () => {
    const p = props({
      state: 'archived',
      records: [
        record({ id: 'a', state: 'archived', reason: 'superseded' }),
        record({ id: 'b', state: 'archived', reason: 'expired' }),
        record({ id: 'c', state: 'archived', reason: 'retracted' }),
        record({ id: 'd', state: 'archived', reason: 'stale' }),
      ],
    });
    const out = html(p);
    expect(out.match(/class="ml-arow"/g)).toHaveLength(4);
    for (const reason of [
      zh('memory.list.reason.superseded'),
      zh('memory.list.reason.expired'),
      zh('memory.list.reason.retracted'),
      zh('memory.list.reason.stale'),
    ])
      expect(out).toContain(`<span class="ml-why">${reason}</span>`);
    const restore = find(
      options(p)[2]!.props.children,
      (n) => n.type === 'button' && text(n.props.children) === zh('memory.list.restore'),
    );
    const stopPropagation = vi.fn();
    restore.props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalled();
    expect(p.onRestore).toHaveBeenCalledWith('c');
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('keeps the restore button and the replacement link of an archived row out of the tab order and hidden from screen readers', () => {
    const p = props({
      state: 'archived',
      records: [
        record({ id: 'a', state: 'archived', reason: 'superseded', superseded_by: 'a2' }),
        record({ id: 'b', state: 'archived', reason: 'stale', basis_id: 'base-1' }),
      ],
    });
    const buttons = options(p).flatMap((o) =>
      nodes(o.props.children).filter((n) => n.type === 'button'),
    );
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      expect(b.props.tabIndex).toBe(-1);
      expect(b.props['aria-hidden']).toBe(true);
    }
  });

  it('shows an empty state instead of an empty list when a search finds nothing', () => {
    const out = html(props({ query: 'nowhere', records: [] }));
    expect(out).toContain(zh('memory.list.noMatch'));
    expect(out).not.toContain('role="listbox"');
  });

  it('turns the restore buttons off while a command runs', () => {
    const restores = (busy: boolean) =>
      nodes(
        tree(
          props({
            state: 'archived',
            busy,
            records: [record({ id: 'a', state: 'archived', reason: 'retracted' })],
          }),
        ),
      )
        .filter((n) => n.type === 'button' && text(n.props.children) === zh('memory.list.restore'))
        .map((n) => n.props.disabled);
    expect(restores(true)).toEqual([true]);
    expect(restores(false)).toEqual([false]);
  });

  it('names the session that proposed a pending entry, and who set it when that session is unknown', () => {
    const p = props({
      state: 'draft',
      records: [
        record({ id: 'a', state: 'draft', author_session_id: 'sess-1' }),
        record({ id: 'b', state: 'draft', author_session_id: 'gone' }),
      ],
      authorTitle: (id) => (id === 'sess-1' ? 'Refund idempotency' : undefined),
    });
    const out = html(p);
    expect(out).toContain('<span class="ml-by">Refund idempotency</span>');
    expect(out).toContain(`<span class="ml-by">${zh('memory.list.byUser')}</span>`);
  });

  it('draws the version, replacement, expiry, basis and archive time of an archived row only when it has them', () => {
    const p = props({
      state: 'archived',
      records: [
        record({
          id: 'a',
          state: 'archived',
          reason: 'superseded',
          version: 2,
          superseded_by: 'a3',
          archived_at: at(13, 10, 26),
        }),
        record({
          id: 'b',
          state: 'archived',
          reason: 'expired',
          expires_at: at(12, 9, 0),
          archived_at: at(11, 8, 0),
        }),
        record({ id: 'c', state: 'archived', reason: 'stale', basis_id: 'base-1' }),
        record({ id: 'd', state: 'archived', reason: 'superseded' }),
      ],
    });
    const out = html(p);
    const rows = options(p).map((n) => renderToStaticMarkup(n));
    expect(rows[0]).toContain('<span class="ml-v">第 2 版</span>');
    expect(rows[0]).toContain('<span class="ml-tm">10:26</span>');
    expect(rows[1]).toContain('<span class="ml-why">昨天 09:00 到期</span>');
    expect(rows[1]).toContain('<span class="ml-tm">11月11日 08:00</span>');
    expect(rows[3]).not.toContain('ml-v');
    expect(rows[3]).toContain(`<span class="ml-why">${zh('memory.list.reason.superseded')}</span>`);
    expect(rows[3]).toContain('<span class="ml-tm"></span>');
    expect(out.match(/class="ml-lnk"/g)).toHaveLength(2);
    for (const [row, id] of [
      [0, 'a3'],
      [2, 'base-1'],
    ] as const) {
      const link = find(options(p)[row]!.props.children, (n) => n.props.className === 'ml-lnk');
      const stopPropagation = vi.fn();
      link.props.onClick({ stopPropagation });
      expect(stopPropagation).toHaveBeenCalled();
      expect(p.onSelect).toHaveBeenLastCalledWith(id);
    }
    expect(text(find(options(p)[2]!.props.children, (n) => n.props.className === 'ml-lnk'))).toBe(
      zh('memory.list.reason.stale'),
    );
  });

  it('names the version that replaced an archived row and the title of the basis it rested on', () => {
    const p = props({
      state: 'archived',
      records: [
        record({
          id: 'a',
          state: 'archived',
          reason: 'superseded',
          version: 2,
          superseded_by: 'a3',
          superseded_by_version: 3,
        }),
        record({
          id: 'b',
          state: 'archived',
          reason: 'stale',
          basis_id: 'base-1',
          basis_title: 'Refund window is 30 days',
        }),
      ],
    });
    const rows = options(p).map((n) => renderToStaticMarkup(n));
    expect(rows[0]).toMatch(
      /<span class="ml-r">.*<button type="button" class="ml-lnk" tabindex="-1" aria-hidden="true">被新版本替代<\/button><span class="ml-v">第 3 版<\/span><\/span>/,
    );
    expect(rows[1]).toContain(
      '<button type="button" class="ml-lnk" tabindex="-1" aria-hidden="true">Refund window is 30 days</button>',
    );
  });

  it('lists search results ungrouped, with the words lit in the title and where they matched', () => {
    const p = props({
      query: '幂等',
      indexPending: 1,
      records: [
        record({
          id: 'a',
          title: '幂等键存 Redis',
          tags: ['幂等'],
          task: taskA,
          reasons: ['tag_exact:幂等', 'metadata', 'fts', 'literal'],
        }),
        record({ id: 'b', title: '状态转移表', reasons: ['fts'] }),
      ],
    });
    const out = html(p);
    expect(out).not.toContain('role="group"');
    expect(out.match(/class="ml-qrow"/g)).toHaveLength(2);
    expect(out).toContain('<span class="ml-t"><mark class="hit">幂等</mark>键存 Redis</span>');
    expect(out).toContain('<span class="ml-why">标签 幂等，标题，正文</span>');
    expect(out).toContain(`<span class="ml-why">${zh('memory.list.match.body')}</span>`);
    expect(out).toMatch(/class="ml-nb"[^>]*>.*还有 1 条正文没进索引，没搜到不代表没有/);
  });

  it('reads the next page when the list is scrolled near its end', () => {
    const p = props({ records: [record({ id: 'a' })], total: 27, hasMore: true });
    const list = tree(p);
    expect(list.props.className).toBe('ml-list');
    list.props.onScroll({ currentTarget: { scrollTop: 0, clientHeight: 300, scrollHeight: 1200 } });
    expect(p.onLoadMore).not.toHaveBeenCalled();
    list.props.onScroll({
      currentTarget: { scrollTop: 860, clientHeight: 300, scrollHeight: 1200 },
    });
    expect(p.onLoadMore).toHaveBeenCalledTimes(1);
    for (const over of [{ loadingMore: true }, { hasMore: false }, { stale: true }]) {
      const q = props({ records: [record({ id: 'a' })], total: 27, hasMore: true, ...over });
      tree(q).props.onScroll({
        currentTarget: { scrollTop: 900, clientHeight: 300, scrollHeight: 1200 },
      });
      expect(q.onLoadMore, JSON.stringify(over)).not.toHaveBeenCalled();
    }
  });

  it('offers the rest of the entries after the loaded ones', () => {
    const records = Array.from({ length: 20 }, (_, i) => record({ id: `r${i}` }));
    const p = props({ records, total: 27, hasMore: true });
    expect(html(p)).toMatch(
      /<span class="ml-ct">20 \/ 27<\/span><button[^>]*>接着读 7 条<\/button>/,
    );
    find(
      tree(p),
      (n) => n.type === 'button' && text(n.props.children) === '接着读 7 条',
    ).props.onClick();
    expect(p.onLoadMore).toHaveBeenCalledTimes(1);
    expect(html(props({ records, total: 70, hasMore: true }))).toContain('接着读 20 条');
    expect(html(props({ records, total: 20 }))).not.toContain('接着读');
  });

  it('says the page no longer matches and goes back to the first page', () => {
    const p = props({ records: [record({ id: 'a' })], total: 27, hasMore: true, stale: true });
    const out = html(p);
    expect(out).toMatch(/class="ml-nb" role="alert">.*内容变了，这一页对不上了/);
    expect(out).not.toContain('接着读');
    find(
      tree(p),
      (n) => n.type === 'button' && text(n.props.children) === zh('memory.list.firstPage'),
    ).props.onClick();
    expect(p.onFirstPage).toHaveBeenCalled();
  });
});
