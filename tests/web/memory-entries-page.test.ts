import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import type { MemoryDirectory, MemoryItem, MemorySummary } from '@pantheon/domain';
import {
  find,
  HookHost,
  named,
  nodes,
  text,
  unmountAll,
  mount as mountHost,
} from './web-hook-host.js';
import { toastManager } from '@/components/Toast';
import { useBoard } from '@/data/board';
import { useMemoryView } from '@/data/memory-view';
import { failureText } from '@/data/needs-you';
import { EntriesBar, EntriesTopControls, type EntriesFilters } from '@/screens/memory/EntriesBar';
import { EntriesPage } from '@/screens/memory/EntriesPage';
import { OverviewMemory } from '@/screens/memory/OverviewMemory';
import { useShell } from '@/store';
import { zh } from './i18n-setup.js';

const summary = (id: string, extra: Partial<MemorySummary> = {}): MemorySummary => ({
  id,
  revision: 1,
  key: `key-${id}`,
  title: `Title ${id}`,
  summary: `Summary ${id}`,
  tags: [],
  kind: 'decision',
  state: 'active',
  authority: 'user',
  created_at: 1,
  indexed: true,
  bytes: 10,
  ...extra,
});

const directory = (extra: Partial<MemoryDirectory> = {}): MemoryDirectory => ({
  epoch: 3,
  records: [summary('r1'), summary('r2')],
  signature: 's'.repeat(64),
  total: 2,
  index_pending: 0,
  facets: {
    tags: [{ tag: 'webhook', count: 2 }],
  },
  budget: { used_bytes: 0, limit_bytes: 12000 },
  counts: { active: 2, draft: 1, archived: 0 },
  jobs: [],
  sessions: [
    {
      id: 'sess',
      title: 'Idempotency',
      delivered: true,
      prepared: true,
      memory_tool: true,
      stale: false,
    },
  ],
  document_ready: true,
  ...extra,
});

const item = (id: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  revision: 1,
  project_id: 'p',
  key: `key-${id}`,
  title: `Title ${id}`,
  kind: 'decision',
  state: 'active',
  authority: 'user',
  author: 'user',
  body_hash: 'h',
  dependencies: [],
  based_on: 's'.repeat(64),
  created_at: 1,
  committed_at: 1,
  text: 'body',
  ...extra,
});

type Answer =
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
let pages: (params: Record<string, string>) => Answer;
let items: Record<string, MemoryItem>;
let commands: Record<string, Answer>;
let query: ReturnType<typeof vi.fn>;
let command: ReturnType<typeof vi.fn>;
const listeners = new Map<string, Set<(e: any) => void>>();
// The query cache outlives a test, so each test reads its own project.
let projectId = '';
let projects = 0;

beforeEach(() => {
  projectId = `entries-${++projects}`;
  pages = () => ({ ok: true, value: directory() });
  items = { r1: item('r1'), r2: item('r2') };
  commands = {};
  query = vi.fn(async (method: string, params: Record<string, string>) =>
    method === 'memory.read'
      ? pages(params)
      : method === 'memory.item'
        ? { ok: true, value: items[params.memory_id!] }
        : { ok: true, value: null },
  );
  command = vi.fn(async (c: { type: string }) =>
    c.type === 'memory.history'
      ? { ok: true, value: { items: Object.values(items) } }
      : c.type === 'memory.related'
        ? { ok: true, value: { items: [] } }
        : (commands[c.type] ?? { ok: true, value: {} }),
  );
  listeners.clear();
  vi.stubGlobal('window', {
    pantheon: { query, command },
    addEventListener: (type: string, fn: (e: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: any) => void) => listeners.get(type)?.delete(fn),
  });
  useBoard.setState({
    board: {
      cursor: 1,
      projects: [],
      sessions: [{ id: 'sess', runtime: 'codex', title: 'Idempotency' }],
      session_turns: [],
      workspaces: [],
    } as any,
    events: [],
    status: { state: 'live' } as any,
    resync: 0,
    refresh() {},
  });
  useShell.setState({ screen: 'memory', memoryTab: 'entries' });
  useMemoryView.setState({ selectedId: null, query: '' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

async function mount() {
  const h = mountHost(() => EntriesPage({ projectId }));
  await h.flush();
  return h;
}
async function rerender(h: HookHost<any>) {
  h.render();
  await h.flush();
  h.render();
  await h.flush();
}
const press = (key: string, target: unknown = { tagName: 'DIV' }) => {
  for (const fn of listeners.get('keydown') ?? [])
    fn({ key, target, preventDefault() {}, defaultPrevented: false, isComposing: false });
};
const reads = () =>
  query.mock.calls.filter(([method]) => method === 'memory.read').map(([, params]) => params);
const list = (h: HookHost<any>) => named(h.value, 'EntryList');
const has = (h: HookHost<any>, name: string) =>
  nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === name);

describe('memory entries page', () => {
  it('reads the directory again with the new conditions when a filter or the search changes', async () => {
    const h = await mount();
    expect(reads().at(-1)).toEqual({ project_id: projectId, state: 'active', limit: '20' });
    named(h.value, 'EntriesBar').props.onChange({
      state: 'draft',
      kind: 'decision',
      tag: ['webhook'],
    });
    await rerender(h);
    expect(reads().at(-1)).toEqual({
      project_id: projectId,
      state: 'draft',
      kind: 'decision',
      tag: ['webhook'],
      limit: '20',
    });
    useMemoryView.getState().setQuery('idem ');
    await rerender(h);
    expect(reads().at(-1)).toMatchObject({ state: 'draft', q: 'idem' });
  });

  it('reads the entries carrying every ticked tag, and all of them again after All tags', async () => {
    pages = () => ({
      ok: true,
      value: directory({
        facets: {
          tags: [
            { tag: 'webhook', count: 2 },
            { tag: 'storage', count: 1 },
          ],
        },
      }),
    });
    const h = await mount();
    const tagRow = (label: string) => {
      const bar = mountHost(() => EntriesBar(named(h.value, 'EntriesBar').props));
      const menu = find(
        bar.value,
        (n) => typeof n.type === 'function' && n.props.label === zh('memory.entries.tag'),
      );
      return nodes(menu.props.children).find(
        (n) =>
          typeof n.type === 'function' &&
          n.type.name === 'MenuCheckboxItem' &&
          text(n.props.children).startsWith(label),
      )!;
    };
    tagRow('webhook').props.onChange(true);
    await rerender(h);
    tagRow('storage').props.onChange(true);
    await rerender(h);
    expect(reads().at(-1)).toMatchObject({ state: 'active', tag: ['webhook', 'storage'] });
    tagRow(zh('memory.entries.allTags')).props.onChange(true);
    await rerender(h);
    expect(reads().at(-1)).toEqual({ project_id: projectId, state: 'active', limit: '20' });
  });

  it('names the session that proposed a pending entry from the board', async () => {
    const h = await mount();
    expect(list(h).props.authorTitle('sess')).toBe('Idempotency');
    expect(list(h).props.authorTitle('missing')).toBeUndefined();
  });

  it('appends the next page to the ones read so far', async () => {
    pages = (p) =>
      p.cursor === 'c1'
        ? { ok: true, value: directory({ records: [summary('r3')], total: 3 }) }
        : { ok: true, value: directory({ next_cursor: 'c1', total: 3 }) };
    const h = await mount();
    expect(list(h).props.hasMore).toBe(true);
    list(h).props.onLoadMore();
    await rerender(h);
    expect(reads().at(-1)).toMatchObject({ cursor: 'c1', state: 'active' });
    expect(list(h).props.records.map((r: MemorySummary) => r.id)).toEqual(['r1', 'r2', 'r3']);
    expect(list(h).props.hasMore).toBe(false);
  });

  it('drops the later pages once a fresh first page no longer leads to them', async () => {
    let first = directory({ next_cursor: 'c1', total: 3 });
    pages = (p) =>
      p.cursor === 'c1'
        ? { ok: true, value: directory({ records: [summary('r3')], total: 3 }) }
        : { ok: true, value: first };
    const h = await mount();
    list(h).props.onLoadMore();
    await rerender(h);
    const focus = async () => {
      for (const fn of listeners.get('focus') ?? []) fn({});
      await rerender(h);
    };
    await focus();
    expect(list(h).props.records.map((r: MemorySummary) => r.id)).toEqual(['r1', 'r2', 'r3']);
    first = directory({ records: [summary('r2')], total: 1 });
    await focus();
    expect(list(h).props.records.map((r: MemorySummary) => r.id)).toEqual(['r2']);
    expect(list(h).props.hasMore).toBe(false);
  });

  it('says the page no longer lines up when the cursor expired, and goes back to the first page', async () => {
    pages = (p) =>
      p.cursor
        ? {
            ok: false,
            error: {
              code: 'revision_conflict',
              message: 'Memory directory changed; restart from the first page',
            },
          }
        : { ok: true, value: directory({ next_cursor: 'c1', total: 3 }) };
    const h = await mount();
    list(h).props.onLoadMore();
    await rerender(h);
    expect(list(h).props.stale).toBe(true);
    const before = reads().length;
    list(h).props.onFirstPage();
    await rerender(h);
    expect(list(h).props.stale).toBe(false);
    expect(reads().length).toBeGreaterThan(before);
    expect(reads().at(-1)).not.toHaveProperty('cursor');
  });

  it('opens the details column for a selection with its versions and relations, and Esc closes it', async () => {
    const h = await mount();
    expect(has(h, 'EntryDetail')).toBe(false);
    list(h).props.onSelect('r1');
    await rerender(h);
    expect(named(h.value, 'EntryDetail').props.item.id).toBe('r1');
    expect(h.value.props['data-detail']).toBe('');
    const sent = command.mock.calls.map(([c]) => [c.type, c.input]);
    expect(sent).toContainEqual(['memory.history', { project_id: projectId, key: 'key-r1' }]);
    expect(sent).toContainEqual([
      'memory.related',
      { project_id: projectId, memory_id: 'r1', state: 'all', relation: 'dependency', limit: 30 },
    ]);
    expect(sent).toContainEqual([
      'memory.related',
      { project_id: projectId, memory_id: 'r1', state: 'all', relation: 'dependent', limit: 30 },
    ]);
    press('Escape');
    await rerender(h);
    expect(useMemoryView.getState().selectedId).toBeNull();
    expect(has(h, 'EntryDetail')).toBe(false);
    expect(h.value.props['data-detail']).toBeUndefined();
  });

  it('filters the list by a tag picked in the details and keeps the entry open', async () => {
    items.r1 = item('r1', { tags: ['webhook'] });
    const h = await mount();
    list(h).props.onSelect('r1');
    await rerender(h);
    named(h.value, 'EntryDetail').props.onTag('webhook');
    await rerender(h);
    expect(reads().at(-1)).toMatchObject({ state: 'active', tag: ['webhook'] });
    expect(named(h.value, 'EntriesBar').props.filters.tag).toEqual(['webhook']);
    expect(useMemoryView.getState().selectedId).toBe('r1');
  });

  it('moves the selection down with J and up with K', async () => {
    const h = await mount();
    press('j');
    await rerender(h);
    expect(useMemoryView.getState().selectedId).toBe('r1');
    press('j');
    await rerender(h);
    expect(useMemoryView.getState().selectedId).toBe('r2');
    press('k');
    await rerender(h);
    expect(useMemoryView.getState().selectedId).toBe('r1');
    press('j', { tagName: 'INPUT' });
    await rerender(h);
    expect(useMemoryView.getState().selectedId).toBe('r1');
  });

  it('leaves the selection and the page dialog alone while a dialog over the page has focus', async () => {
    const h = await mount();
    const inDialog = {
      tagName: 'BUTTON',
      closest: (selector: string) => (selector === '[role=dialog]' ? {} : null),
    };
    press('n', inDialog);
    press('j', inDialog);
    await rerender(h);
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(false);
    expect(useMemoryView.getState().selectedId).toBeNull();
  });

  it('opens the new memory dialog with N, but not while typing', async () => {
    const h = await mount();
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(false);
    press('n', { tagName: 'TEXTAREA' });
    await rerender(h);
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(false);
    press('n');
    await rerender(h);
    const dialog = named(h.value, 'NewMemoryDialog');
    expect(dialog.props.open).toBe(true);
    expect(dialog.props.original).toBeNull();
  });

  it('shows the refused state of the pending card when confirming fails because the sources changed', async () => {
    items.d1 = item('d1', {
      state: 'draft',
      committed_at: undefined,
      author_session_id: 'sess',
      based_on: 'a'.repeat(64),
    });
    commands['memory.commit'] = {
      ok: false,
      error: { code: 'revision_conflict', message: 'Sources changed; review a fresh proposal' },
    };
    useMemoryView.setState({ selectedId: 'd1' });
    const h = await mount();
    await rerender(h);
    expect(has(h, 'PendingCard')).toBe(false);
    named(h.value, 'EntryActions').props.onCommit();
    await rerender(h);
    expect(command.mock.calls.map(([c]) => c)).toContainEqual(
      expect.objectContaining({
        type: 'memory.commit',
        input: { memory_id: 'd1' },
        expected_revision: 1,
      }),
    );
    const card = named(h.value, 'PendingCard');
    expect(card.props.rejected).toBe(true);
    expect(card.props.author).toEqual({ title: 'Idempotency', runtime: 'codex' });
    expect(has(h, 'EntryActions')).toBe(false);
  });

  it('does not say the sources changed when another window already confirmed the draft', async () => {
    items.d1 = item('d1', {
      state: 'draft',
      committed_at: undefined,
      author_session_id: 'sess',
      based_on: 'a'.repeat(64),
    });
    commands['memory.commit'] = {
      ok: false,
      error: { code: 'revision_conflict', message: 'Supply the current revision' },
    };
    useMemoryView.setState({ selectedId: 'd1' });
    const h = await mount();
    await rerender(h);
    items.d1 = { ...items.d1, state: 'active', revision: 2, committed_at: 2 };
    // The entry's own read is still out, so the page still holds the draft.
    const answer = query.getMockImplementation() as (...args: unknown[]) => Promise<Answer>;
    query.mockImplementation((method: string, params: Record<string, string>) =>
      method === 'memory.item' ? new Promise(() => {}) : answer(method, params),
    );
    named(h.value, 'EntryActions').props.onCommit();
    await rerender(h);
    expect(has(h, 'PendingCard')).toBe(false);
  });

  it('tells the list a restore is running until its answer comes back', async () => {
    const h = await mount();
    expect(list(h).props.busy).toBe(false);
    list(h).props.onRestore('r1');
    h.render();
    expect(list(h).props.busy).toBe(true);
    await rerender(h);
    expect(list(h).props.busy).toBe(false);
    expect(command.mock.calls.filter(([c]) => c.type === 'memory.restore')).toHaveLength(1);
  });

  it('shows the over-budget pending card with the largest decisions when confirming does not fit', async () => {
    items.d1 = item('d1', { state: 'draft', committed_at: undefined, author_session_id: 'sess' });
    const details = {
      used_bytes: 11800,
      limit_bytes: 12000,
      largest_records: [{ id: 'r1', title: 'Title r1', bytes: 4000 }],
    };
    commands['memory.commit'] = {
      ok: false,
      error: { code: 'memory_budget_exceeded', message: 'Over budget', details } as never,
    };
    useMemoryView.setState({ selectedId: 'd1' });
    const h = await mount();
    await rerender(h);
    named(h.value, 'EntryActions').props.onCommit();
    await rerender(h);
    const card = named(h.value, 'PendingCard');
    expect(card.props.overBudget).toEqual(details);
    expect(card.props.rejected).toBeFalsy();
    card.props.onRecord('r1');
    expect(useMemoryView.getState().selectedId).toBe('r1');
  });

  it('opens an entry from the overview with it selected', async () => {
    useShell.setState({ memoryTab: 'overview' });
    const h = mountHost(() => OverviewMemory({ projectId, onHold() {} }));
    await h.flush();
    const view = named(h.value, 'OverviewMemoryView');
    view.props.actions.onEntry('m1');
    expect(useMemoryView.getState().selectedId).toBe('m1');
    expect(useShell.getState().memoryTab).toBe('entries');

    const onEntry = vi.fn();
    const recent = [
      { at: 2, kind: 'committed', memory_id: 'm2', key: 'k2', title: 'Newest', actor: 'user' },
      { at: 1, kind: 'archived', memory_id: 'm3', key: 'k3', title: 'Older', actor: 'user' },
    ];
    const run = (type: unknown, props: object) => (type as (p: object) => ReactNode)(props);
    const tree = run(view.type, {
      ...view.props,
      data: { ...view.props.data, recent },
      actions: { onEntry },
    });
    const part = named(tree, 'Recent');
    const shown = run(part.type, part.props);
    const buttons = nodes(shown).filter((n) => n.type === 'button');
    buttons.find((n) => text(n).includes('Newest'))!.props.onClick();
    buttons.find((n) => text(n) === zh('memory.agent.history'))!.props.onClick();
    expect(onEntry.mock.calls).toEqual([['m2'], ['m2']]);
  });
});

describe('retrying the progress document', () => {
  const error = { code: 'disk_full', message: 'No space left' };
  let add: MockInstance<typeof toastManager.add>;
  beforeEach(() => void (add = vi.spyOn(toastManager, 'add')));
  afterEach(() => {
    add.mockRestore();
    toastManager.close();
  });
  const shown = () => add.mock.calls.map(([notice]) => [notice.title, notice.type]);
  const maintains = () => command.mock.calls.filter(([c]) => c.type === 'memory.maintain');

  it('from the overview says why it failed, and sends one retry at a time', async () => {
    let answer!: (result: Answer) => void;
    commands['memory.maintain'] = new Promise<Answer>((resolve) => (answer = resolve)) as never;
    const h = mountHost(() => OverviewMemory({ projectId, onHold() {} }));
    await h.flush();
    const view = () => named(h.value, 'OverviewMemoryView').props;
    view().actions.onMaintain();
    h.render();
    expect(view().data.maintaining).toBe(true);
    view().actions.onMaintain();
    answer({ ok: false, error });
    await h.flush();
    expect(maintains()).toHaveLength(1);
    expect(view().data.maintaining).toBe(false);
    expect(shown()).toEqual([[failureText(error), 'failure']]);
  });

  it('from the entries footer says why it failed', async () => {
    commands['memory.maintain'] = { ok: false, error };
    const h = await mount();
    named(h.value, 'EntriesFooter').props.onRetryDocument();
    await rerender(h);
    expect(maintains()).toHaveLength(1);
    expect(shown()).toEqual([[failureText(error), 'failure']]);
  });
});

describe('memory entries filter row', () => {
  const bar = (filters: EntriesFilters) => {
    const onChange = vi.fn();
    const h = mountHost(() =>
      EntriesBar({
        filters,
        counts: { active: 2, draft: 0, archived: 0 },
        facets: {
          tags: [
            { tag: 'webhook', count: 4 },
            { tag: 'storage', count: 1 },
          ],
        },
        total: 2,
        onChange,
      }),
    );
    return { h, onChange };
  };
  const menu = (h: HookHost<any>, label: string) =>
    find(h.value, (n) => typeof n.type === 'function' && n.props.label === label);

  it('lists each tag with its count, and narrows the list by the words in its filter field', () => {
    const { h } = bar({ state: 'active', tag: [] });
    const rows = () =>
      nodes(menu(h, zh('memory.entries.tag')).props.children)
        .filter((n) => typeof n.type === 'function' && n.type.name === 'MenuCheckboxItem')
        .map((n) => text(n.props.children));
    expect(rows()).toEqual([zh('memory.entries.allTags'), 'webhook4', 'storage1']);
    const field = find(menu(h, zh('memory.entries.tag')).props.children, (n) => n.type === 'input');
    expect(field.props['aria-label']).toBe(zh('memory.entries.findTag'));
    field.props.onChange({ target: { value: 'STOR' } });
    h.render();
    expect(rows()).toEqual([zh('memory.entries.allTags'), 'storage1']);
  });

  it('names the tag button by the first ticked tag and how many more are ticked', () => {
    const trigger = (tag: string[]) =>
      menu(bar({ state: 'active', tag }).h, zh('memory.entries.tag')).props.trigger;
    expect(text(trigger([]))).toBe(zh('memory.entries.tag'));
    expect(text(trigger(['storage']))).toBe('storage');
    const three = trigger(['storage', 'webhook', 'infra']);
    expect(text(three)).toBe('storage+2');
    expect(
      nodes(three)
        .filter((n) => n.type === 'span')
        .map((n) => text(n)),
    ).toEqual(['storage', '+2']);
  });

  it('clears the search words with the button that shows while there are some', () => {
    const h = mountHost(() => EntriesTopControls({ projectId }));
    const clear = () =>
      nodes(h.render()).find(
        (n) => n.type === 'button' && n.props['aria-label'] === zh('memory.entries.clearSearch'),
      );
    expect(clear()).toBeUndefined();
    useMemoryView.getState().setQuery('idem');
    clear()!.props.onClick();
    expect(useMemoryView.getState().query).toBe('');
    expect(clear()).toBeUndefined();
  });
});

describe('memory entries styles', () => {
  it('wraps the filter row onto more lines instead of overflowing beside the details column', () => {
    const css = readFileSync(
      path.resolve(import.meta.dirname, '../../apps/web/src/screens/memory/entries-page.css'),
      'utf8',
    );
    const bar = /\.mep-bar \{([^}]*)\}/.exec(css)![1]!;
    expect(bar).toContain('flex-wrap: wrap;');
    expect(bar).not.toMatch(/(^|[^-])height:/);
  });
});
