import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemoryGraph, MemorySummary } from '@pantheon/domain';
import { HookHost, named, nodes, text, unmountAll, mount as mountHost } from './web-hook-host.js';
import { MenuCheckboxItem } from '@/components/Menu';
import { useBoard } from '@/data/board';
import { useMemoryView } from '@/data/memory-view';
import { t } from '@/i18n';
import { EntryList } from '@/screens/memory/EntryList';
import { GraphTopControls, MemoryGraphView } from '@/screens/memory/MemoryGraphView';
import { useShell } from '@/store';

const task = { id: 't1', lead_session_id: 'lead', generation: 1, title: 'Refund idempotency' };
const graph = (extra: Partial<MemoryGraph> = {}): MemoryGraph => ({
  nodes: [
    { id: 'm1', label: 'Refund dedupe', kind: 'decision', state: 'active', memory_id: 'm1', task },
    {
      id: 'm2',
      label: 'Refund replay test',
      kind: 'report',
      state: 'active',
      memory_id: 'm2',
      task,
    },
    { id: 'm3', label: 'Channel retry', kind: 'note', state: 'draft', memory_id: 'm3' },
    { id: 'm4', label: 'Lone report', kind: 'report', state: 'archived', memory_id: 'm4' },
    { id: 'source:a', label: 'refund.ts', kind: 'source', source_kind: 'file', uri: 'refund.ts' },
  ],
  edges: [
    { id: 'e1', from: 'm2', to: 'm1', kind: 'depends_on' },
    { id: 'e2', from: 'm1', to: 'source:a', kind: 'source' },
  ],
  signature: 's'.repeat(64),
  total: 5,
  truncated: false,
  depth: 1,
  ...extra,
});

type Answer =
  { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
let answer: () => Answer;
let query: ReturnType<typeof vi.fn>;
const listeners = new Map<string, Set<(e: any) => void>>();
// The query cache outlives a test, so each test reads its own project.
let projectId = '';
let projects = 0;

beforeEach(() => {
  projectId = `graph-${++projects}`;
  answer = () => ({ ok: true, value: graph() });
  query = vi.fn(async (method: string) =>
    method === 'memory.graph' ? answer() : { ok: true, value: null },
  );
  listeners.clear();
  vi.stubGlobal('window', {
    pantheon: { query, command: vi.fn(async () => ({ ok: true, value: {} })) },
    addEventListener: (type: string, fn: (e: any) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: any) => void) => listeners.get(type)?.delete(fn),
  });
  useBoard.setState({
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] } as any,
    events: [],
    status: { state: 'live' } as any,
    resync: 0,
    refresh() {},
  });
  useShell.setState({ screen: 'memory', memoryTab: 'graph' });
  useMemoryView.setState({
    selectedId: null,
    graphNode: null,
    query: '',
    hiddenKinds: [],
    showTags: false,
    depth: 1,
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

async function mount(body: () => unknown) {
  const h = mountHost<any>(body);
  await h.flush();
  return h;
}
const view = () => mount(() => MemoryGraphView({ projectId }));
const controls = () => mount(() => GraphTopControls({ projectId }));
async function rerender(h: HookHost<any>) {
  h.render();
  await h.flush();
  h.render();
  await h.flush();
}
const reads = () =>
  query.mock.calls.filter(([method]) => method === 'memory.graph').map(([, params]) => params);
const has = (h: HookHost<any>, name: string) =>
  nodes(h.value).some((n) => typeof n.type === 'function' && n.type.name === name);
const canvas = (h: HookHost<any>) => named(h.value, 'GraphCanvas');
const drawn = (h: HookHost<any>) =>
  canvas(h).props.layout.nodes.map((n: { id: string }) => n.id) as string[];
const search = (h: HookHost<any>) =>
  nodes(h.value).find((n) => n.type === 'input' && n.props.type === 'search')!;
const hits = (h: HookHost<any>) => nodes(h.value).find((n) => n.props.className === 'mgv-hits');
const toggle = (h: HookHost<any>) =>
  nodes(h.value).find((n) => n.type === 'input' && n.props.role === 'switch')!;
const depth = (h: HookHost<any>) =>
  nodes(h.value).find(
    (n) => n.props['aria-label'] === t({ id: 'memory.graphView.depth', defaultMessage: 'Depth' }),
  )!;
const kindMenu = (h: HookHost<any>) => named(h.value, 'Menu');
const press = (key: string, target: unknown = { tagName: 'DIV' }) => {
  for (const fn of listeners.get('keydown') ?? [])
    fn({ key, target, preventDefault() {}, defaultPrevented: false, isComposing: false });
};

describe('memory graph tab', () => {
  it('reads the whole project on entry, every state, up to 80 nodes, tags as the switch says', async () => {
    const h = await view();
    expect(reads()).toEqual([
      { project_id: projectId, state: 'all', max_nodes: '80', include_tags: 'false' },
    ]);
    expect(drawn(h)).toEqual(expect.arrayContaining(['m1', 'm2', 'm3', 'm4', 'source:a']));
    const legend = named(h.value, 'GraphLegend').props;
    expect(legend).toMatchObject({ shown: 5, total: 5, truncated: false, focused: null });
    const top = await controls();
    toggle(top).props.onChange({ target: { checked: true } });
    await rerender(h);
    expect(reads().at(-1)).toEqual({
      project_id: projectId,
      state: 'all',
      max_nodes: '80',
      include_tags: 'true',
    });
  });

  it('drops the last project graph while the next project graph is read', async () => {
    let shown = projectId;
    const h = await mount(() => MemoryGraphView({ projectId: shown }));
    expect(has(h, 'GraphCanvas')).toBe(true);
    answer = () => new Promise<never>(() => {}) as never;
    shown = `${projectId}-next`;
    await rerender(h);
    expect(reads().at(-1)).toMatchObject({ project_id: shown });
    expect(has(h, 'GraphCanvas')).toBe(false);
  });

  it('marks the search in the graph without dropping nodes, and counts the hits in the field', async () => {
    const h = await view();
    const top = await controls();
    const before = reads().length;
    search(top).props.onChange({ target: { value: 'refund' } });
    await rerender(h);
    await rerender(top);
    expect(canvas(h).props.query).toBe('refund');
    expect(drawn(h)).toHaveLength(5);
    expect(text(hits(top)!.props.children)).toBe('3');
    expect(hits(top)!.props['aria-label']).toContain('3');
    expect(reads()).toHaveLength(before);
  });

  it('reads the graph again for the ticked kinds only when a kind is unticked', async () => {
    const h = await view();
    const top = await controls();
    const items = nodes(kindMenu(top).props.children).filter((n) => n.type === MenuCheckboxItem);
    expect(items).toHaveLength(6);
    expect(items.every((n) => n.props.checked)).toBe(true);
    items[1]!.props.onChange(false);
    await rerender(h);
    expect(reads().at(-1)).toEqual({
      project_id: projectId,
      state: 'all',
      max_nodes: '80',
      include_tags: 'false',
      kind: ['decision', 'note', 'file', 'url', 'session'],
    });
    expect(drawn(h)).not.toContain('m2');
    expect(drawn(h)).not.toContain('m4');
    expect(drawn(h)).toContain('m1');
  });

  it('reads nothing and says nothing matches when every kind is unticked', async () => {
    const h = await view();
    const before = reads().length;
    useMemoryView.setState({
      hiddenKinds: ['decision', 'report', 'note', 'file', 'url', 'session'],
    });
    await rerender(h);
    expect(reads()).toHaveLength(before);
    expect(has(h, 'GraphCanvas')).toBe(false);
    expect(named(h.value, 'EmptyState').props.title).toBe(
      t({ id: 'memory.graphView.noMatch', defaultMessage: 'Nothing matches the filter' }),
    );
  });

  it('keeps the selected memory in the graph read ahead of the node cap', async () => {
    const h = await view();
    canvas(h).props.onSelect('m3');
    await rerender(h);
    expect(reads().at(-1)).toMatchObject({ project_id: projectId, keep: 'm3' });
  });

  it('says nothing matches when the kind filter leaves no node, and keeps the kind menu on', async () => {
    useMemoryView.setState({ hiddenKinds: ['decision', 'report', 'note'] });
    answer = () => ({ ok: true, value: graph({ nodes: [], edges: [], total: 0 }) });
    const h = await view();
    const top = await controls();
    expect(has(h, 'GraphEmpty')).toBe(false);
    expect(named(h.value, 'EmptyState').props.title).toBe(
      t({ id: 'memory.graphView.noMatch', defaultMessage: 'Nothing matches the filter' }),
    );
    expect(kindMenu(top).props.trigger.props.disabled).toBe(false);
    press('n');
    await rerender(h);
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(false);
  });

  it('turns the depth choice off until a node is selected, then focuses its neighbourhood', async () => {
    const h = await view();
    const top = await controls();
    expect(depth(top).props.disabled).toBe(true);
    expect(canvas(h).props.near).toBeNull();
    canvas(h).props.onSelect('m2');
    await rerender(h);
    await rerender(top);
    expect(depth(top).props.disabled).toBe(false);
    expect([...canvas(h).props.near].sort()).toEqual(['m1', 'm2']);
    depth(top).props.onValueChange('2');
    await rerender(h);
    expect([...canvas(h).props.near].sort()).toEqual(['m1', 'm2', 'source:a']);
    expect(named(h.value, 'GraphLegend').props.focused).toBe(3);
  });

  it('opens the details column for a clicked node, and Open entry goes to the entries tab with it', async () => {
    const h = await view();
    expect(has(h, 'GraphDetail')).toBe(false);
    canvas(h).props.onSelect('m1');
    await rerender(h);
    const detail = named(h.value, 'GraphDetail');
    expect(detail.props).toMatchObject({ projectId, memoryId: 'm1' });
    expect(h.value.props['data-detail']).toBe('');
    detail.props.onFocus('m2');
    await rerender(h);
    expect(named(h.value, 'GraphDetail').props.memoryId).toBe('m2');
    useMemoryView.setState({ selectedId: null });
    named(h.value, 'GraphDetail').props.onOpenEntry('m2');
    expect(useMemoryView.getState().selectedId).toBe('m2');
    expect(useShell.getState().memoryTab).toBe('entries');
    useShell.setState({ memoryTab: 'graph' });
    named(h.value, 'GraphDetail').props.onClose();
    await rerender(h);
    expect(useMemoryView.getState().selectedId).toBeNull();
    expect(has(h, 'GraphDetail')).toBe(false);
  });

  it('focuses a source node without making it the selected entry', async () => {
    const h = await view();
    canvas(h).props.onSelect('m1');
    await rerender(h);
    canvas(h).props.onSelect('source:a');
    await rerender(h);
    expect(useMemoryView.getState().selectedId).toBe('m1');
    expect(canvas(h).props.selected).toBe('source:a');
    expect(has(h, 'GraphDetail')).toBe(false);
    canvas(h).props.onSelect('m2');
    await rerender(h);
    expect(canvas(h).props.selected).toBe('m2');
    expect(named(h.value, 'GraphDetail').props.memoryId).toBe('m2');
  });

  it('focuses a source row of the details without making it the selected entry', async () => {
    const h = await view();
    canvas(h).props.onSelect('m1');
    await rerender(h);
    named(h.value, 'GraphDetail').props.onFocus('source:a');
    await rerender(h);
    expect(useMemoryView.getState().selectedId).toBe('m1');
    expect(canvas(h).props.selected).toBe('source:a');
  });

  it('shows a failed read again after the graph has loaded once', async () => {
    const h = await view();
    expect(has(h, 'GraphCanvas')).toBe(true);
    answer = () => ({ ok: false, error: { code: 'internal', message: 'graph broke' } });
    useBoard.setState({ resync: 1 });
    await rerender(h);
    const alert = nodes(h.value).find((n) => n.props.role === 'alert');
    expect(text(alert?.props.children)).toContain('graph broke');
  });

  it('shows the read failure in place of the drawing with a retry', async () => {
    answer = () => ({ ok: false, error: { code: 'internal', message: 'graph broke' } });
    const h = await view();
    const alert = nodes(h.value).find((n) => n.props.role === 'alert')!;
    expect(text(alert.props.children)).toContain('graph broke');
    const before = reads().length;
    answer = () => ({ ok: true, value: graph() });
    nodes(alert)
      .find((n) => n.type === 'button')!
      .props.onClick();
    await rerender(h);
    expect(reads().length).toBeGreaterThan(before);
    expect(has(h, 'GraphCanvas')).toBe(true);
  });

  it('offers a new entry on an empty project, with N, and turns the top controls off', async () => {
    answer = () => ({
      ok: true,
      value: graph({ nodes: [], edges: [], total: 0 }),
    });
    const h = await view();
    const top = await controls();
    expect(has(h, 'GraphCanvas')).toBe(false);
    expect(search(top).props.disabled).toBe(true);
    expect(kindMenu(top).props.trigger.props.disabled).toBe(true);
    expect(toggle(top).props.disabled).toBe(true);
    expect(depth(top).props.disabled).toBe(true);
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(false);
    named(h.value, 'GraphEmpty').props.onCreate();
    await rerender(h);
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(true);
    named(h.value, 'NewMemoryDialog').props.onOpenChange(false);
    await rerender(h);
    press('n', { tagName: 'INPUT' });
    await rerender(h);
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(false);
    press('n');
    await rerender(h);
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(true);
  });

  it('leaves N alone while the project has memory', async () => {
    const h = await view();
    press('n');
    await rerender(h);
    expect(named(h.value, 'NewMemoryDialog').props.open).toBe(false);
  });
});

describe('memory kind icons', () => {
  it('draws decisions, reports and notes in the entry list with the graph glyphs', () => {
    const record = (id: string, kind: MemorySummary['kind']): MemorySummary => ({
      id,
      revision: 1,
      key: id,
      title: id,
      summary: id,
      tags: [],
      kind,
      state: 'active',
      authority: 'user',
      created_at: 1,
      indexed: true,
      bytes: 1,
    });
    const html = renderToStaticMarkup(
      createElement(EntryList, {
        state: 'active',
        records: [record('a', 'decision'), record('b', 'report'), record('c', 'note')],
        tasks: [],
        query: '',
        total: 3,
        pageSize: 20,
        indexPending: 0,
        selectedId: null,
        onSelect() {},
        hasMore: false,
        loadingMore: false,
        onLoadMore() {},
        stale: false,
        onFirstPage() {},
        onRestore() {},
        busy: false,
        authorTitle: () => undefined,
      }) as ReactElement,
    );
    for (const glyph of ['lucide-diamond', 'lucide-file-text', 'lucide-sticky-note'])
      expect(html).toContain(glyph);
    for (const glyph of ['lucide-flag', 'lucide-list', 'lucide-square-pen'])
      expect(html).not.toContain(glyph);
  });
});

describe('memory graph styles', () => {
  it('keeps the selected background of a source pill under the pointer', () => {
    const css = readFileSync(
      path.resolve(import.meta.dirname, '../../apps/web/src/screens/memory/memory-graph.css'),
      'utf8',
    );
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
      selector: m[1]!.trim(),
      body: m[2]!,
    }));
    const hover = rules.filter(
      (r) => r.selector.includes('.mg-ms:hover') && /background/.test(r.body),
    );
    expect(hover.length).toBeGreaterThan(0);
    for (const r of hover) expect(r.selector).toContain(":not([aria-pressed='true'])");
  });
});
