import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { GraphCanvas, type GraphCanvasProps } from '@/screens/memory/GraphCanvas';
import { layoutGraph } from '@/screens/memory/graph-layout';
import { HookHost, nodes, text } from './web-hook-host.js';

vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));

const layout = layoutGraph(
  {
    nodes: [
      { id: 'incident', label: 'Duplicate refund incident', kind: 'report', state: 'active' },
      { id: 'by-order', label: 'Dedupe by order', kind: 'decision', state: 'archived' },
      { id: 'by-key', label: 'Dedupe by key', kind: 'decision', state: 'active' },
      { id: 'cross-day', label: 'Cross-day failure', kind: 'report', state: 'draft' },
      { id: 'prefix', label: 'Key prefix for switches', kind: 'note', state: 'active' },
      { id: 'file', label: 'idempotency.ts', kind: 'source', source_kind: 'file' },
      { id: 'web', label: 'Signature docs', kind: 'source', source_kind: 'url' },
      { id: 'tag:refunds', label: 'refunds', kind: 'tag' },
    ],
    edges: [
      { id: 'e1', from: 'by-key', to: 'incident', kind: 'depends_on' },
      { id: 'e2', from: 'by-key', to: 'by-order', kind: 'supersedes' },
      { id: 'e3', from: 'cross-day', to: 'by-key', kind: 'depends_on' },
      { id: 'e4', from: 'by-key', to: 'file', kind: 'source' },
      { id: 'e5', from: 'prefix', to: 'web', kind: 'source' },
      { id: 'e6', from: 'cross-day', to: 'by-order', kind: 'restored_from' },
      { id: 'e7', from: 'by-key', to: 'tag:refunds', kind: 'tagged' },
    ],
  },
  { kinds: null, tags: true },
);

const props = (over: Partial<GraphCanvasProps> = {}): GraphCanvasProps => ({
  layout,
  selected: null,
  near: null,
  query: '',
  zoom: 1,
  onSelect: vi.fn(),
  ...over,
});

const tree = (p: GraphCanvasProps) =>
  new HookHost(() => GraphCanvas(p)).render() as ReactElement<any>;
const buttons = (p: GraphCanvasProps) => nodes(tree(p)).filter((n) => n.type === 'button');
const button = (p: GraphCanvasProps, label: string) =>
  buttons(p).find((n) => text(n.props.children).includes(label))!;
const paths = (p: GraphCanvasProps) =>
  nodes(tree(p)).filter((n) => n.type === 'path' && String(n.props.className).includes('mg-ed'));

describe('memory graph canvas', () => {
  it('draws each node as a button where the layout put it, named by kind, title and state', () => {
    const p = props();
    expect(buttons(p).map((b) => b.props['aria-label'])).toEqual(
      layout.nodes.map((n) => expect.stringContaining(n.label)),
    );
    expect(button(p, 'Dedupe by order').props['aria-label']).toBe('决定：Dedupe by order，已归档');
    expect(button(p, 'Cross-day').props['aria-label']).toBe('报告：Cross-day failure，待确认');
    expect(button(p, 'Key prefix').props['aria-label']).toBe('笔记：Key prefix for switches，当前');
    expect(button(p, 'idempotency').props['aria-label']).toBe('文件来源：idempotency.ts');
    expect(button(p, 'Signature').props['aria-label']).toBe('网址来源：Signature docs');
    expect(button(p, 'refunds').props['aria-label']).toBe('标签：refunds');
    const at = layout.nodes.find((n) => n.id === 'by-key')!;
    expect(button(p, 'Dedupe by key').props.style).toEqual({
      left: at.x,
      top: at.y,
      width: at.w,
      height: at.h,
    });
  });

  it('marks pending and archived memories and gives pending ones a waiting mark', () => {
    const p = props();
    const pending = button(p, 'Cross-day');
    expect(pending.props.className).toBe('mg-mn mg-dr');
    expect(nodes(pending.props.children).some((n) => n.props.className === 'mg-wait')).toBe(true);
    expect(button(p, 'Dedupe by order').props.className).toBe('mg-mn mg-ar');
    expect(button(p, 'idempotency').props.className).toBe('mg-ms');
    expect(button(p, 'refunds').props.className).toBe('mg-ms mg-tag');
  });

  it('lets only the selected node, or the first without one, take the tab stop', () => {
    const none = buttons(props());
    expect(none.map((b) => b.props.tabIndex)).toEqual(none.map((_, i) => (i === 0 ? 0 : -1)));
    const p = props({ selected: 'by-key' });
    expect(buttons(p).filter((b) => b.props.tabIndex === 0)).toEqual([
      expect.objectContaining({ key: 'by-key' }),
    ]);
    expect(button(p, 'Dedupe by key').props['aria-pressed']).toBe(true);
    expect(button(p, 'Dedupe by order').props['aria-pressed']).toBe(false);
  });

  it('selects the node clicked', () => {
    const p = props();
    button(p, 'idempotency').props.onClick();
    expect(p.onSelect).toHaveBeenCalledWith('file');
  });

  it('fades the nodes and links outside the focused neighbourhood', () => {
    const near = new Set(['by-key', 'incident', 'file']);
    const p = props({ selected: 'by-key', near });
    expect(button(p, 'Dedupe by order').props.className).toBe('mg-mn mg-ar mg-out');
    expect(button(p, 'Dedupe by key').props.className).toBe('mg-mn');
    const edge = (from: string, to: string) =>
      paths(p).find((n) => n.key === layout.edges.find((e) => e.from === from && e.to === to)!.id)!;
    expect(edge('by-key', 'incident').props.className).toBe('mg-ed mg-dep mg-hot');
    expect(edge('by-key', 'incident').props.markerEnd).toBe('url(#mg-arrow-hot)');
    expect(edge('by-key', 'by-order').props.className).toBe('mg-ed mg-sup mg-out');
    expect(edge('by-key', 'by-order').props.markerEnd).toBe('url(#mg-arrow-out)');
    expect(edge('by-key', 'file').props.className).toBe('mg-ed mg-src mg-hot');
    expect(edge('by-key', 'file').props.markerEnd).toBeUndefined();
  });

  it('draws the four kinds of link by their own styles, along the paths of the layout', () => {
    const p = props();
    expect(paths(p).map((n) => [n.key, n.props.d])).toEqual(layout.edges.map((e) => [e.id, e.d]));
    expect(paths(p).map((n) => n.props.className)).toEqual([
      'mg-ed mg-dep',
      'mg-ed mg-sup',
      'mg-ed mg-dep',
      'mg-ed mg-src',
      'mg-ed mg-src',
      'mg-ed mg-res',
      'mg-ed mg-src',
    ]);
    expect(paths(p).map((n) => n.props.markerEnd)).toEqual([
      'url(#mg-arrow)',
      'url(#mg-arrow)',
      'url(#mg-arrow)',
      undefined,
      undefined,
      'url(#mg-arrow)',
      undefined,
    ]);
  });

  it('wraps the parts of titles that match the search in mark', () => {
    const p = props({ query: 'dedupe' });
    const marks = (label: string) =>
      nodes(button(p, label).props.children)
        .filter((n) => n.type === 'mark')
        .map((n) => text(n.props.children));
    expect(marks('Dedupe by key')).toEqual(['Dedupe']);
    expect(marks('Duplicate refund')).toEqual([]);
    expect(text(button(p, 'Dedupe by key').props.children)).toBe('Dedupe by key');
  });

  it('scales the drawing by the zoom and sizes the scrolled area to match', () => {
    const root = tree(props({ zoom: 1.5 }));
    expect(root.props.className).toBe('mg-view');
    const plane = nodes(root).find((n) => n.props.className === 'mg-plane')!;
    expect(plane.props.style).toEqual({ width: layout.width * 1.5, height: layout.height * 1.5 });
    const stage = nodes(root).find((n) => n.props.className === 'mg-stage')!;
    expect(stage.props.style).toEqual({
      width: layout.width,
      height: layout.height,
      transform: 'scale(1.5)',
    });
  });

  it('names the drawing with the summary for screen readers', () => {
    const svg = (p: GraphCanvasProps) => nodes(tree(p)).find((n) => n.type === 'svg')!;
    const named = svg(props({ summary: 'Knowledge graph, 8 nodes.' })).props;
    expect(named.role).toBe('img');
    expect(named['aria-label']).toBe('Knowledge graph, 8 nodes.');
    expect(named['aria-hidden']).toBeUndefined();
    expect(svg(props()).props['aria-hidden']).toBe('true');
  });

  describe('with the keyboard and pointer', () => {
    const mount = (over: Partial<GraphCanvasProps> = {}) => {
      const p = props({ onMove: vi.fn(), card: (n) => createElement('i', null, n.label), ...over });
      const host = new HookHost(() => GraphCanvas(p) as ReactElement<any>);
      host.render();
      const all = () => nodes(host.value).filter((n) => n.type === 'button');
      const at = (id: string) => all().find((n) => n.key === id)!;
      const els = new Map(layout.nodes.map((n) => [n.id, { focus: vi.fn() }]));
      for (const b of all()) b.props.ref(els.get(b.key!));
      const cards = () => nodes(host.value).filter((n) => n.props.className === 'mgi-at');
      const fire = (id: string, event: string, arg?: unknown) => {
        at(id).props[event](arg);
        host.render();
      };
      return { p, at, els, cards, fire };
    };
    const focusEvent = (visible: boolean) => ({
      currentTarget: { matches: (q: string) => q === ':focus-visible' && visible },
    });

    it('moves to the next node in the arrow direction, reporting it and moving the focus there', () => {
      const m = mount();
      const preventDefault = vi.fn();
      m.fire('incident', 'onKeyDown', { key: 'ArrowRight', preventDefault });
      expect(preventDefault).toHaveBeenCalled();
      expect(m.p.onMove).toHaveBeenCalledWith('by-key');
      expect(m.els.get('by-key')!.focus).toHaveBeenCalled();
      m.fire('incident', 'onKeyDown', { key: 'Enter', preventDefault: vi.fn() });
      expect(m.p.onMove).toHaveBeenCalledTimes(1);
    });

    it('keeps the tab stop on the node the keyboard last reached while none is selected', () => {
      const m = mount();
      m.fire('by-key', 'onFocus', focusEvent(true));
      m.fire('by-key', 'onBlur');
      expect(m.at('by-key').props.tabIndex).toBe(0);
      expect(m.at('incident').props.tabIndex).toBe(-1);
    });

    it('shows the card beside the hovered node until the pointer leaves', () => {
      const m = mount();
      expect(m.cards()).toEqual([]);
      m.fire('by-key', 'onPointerEnter');
      const at = layout.nodes.find((n) => n.id === 'by-key')!;
      expect(m.cards().map((c) => [c.props.style, text(c.props.children)])).toEqual([
        [{ left: at.x + at.w + 8, top: at.y - 16 }, 'Dedupe by key'],
      ]);
      m.fire('by-key', 'onPointerLeave');
      expect(m.cards()).toEqual([]);
    });

    it('shows the card beside the node with keyboard focus, not after a click', () => {
      const m = mount();
      m.fire('incident', 'onFocus', focusEvent(false));
      expect(m.cards()).toEqual([]);
      m.fire('incident', 'onFocus', focusEvent(true));
      expect(m.cards().map((c) => text(c.props.children))).toEqual(['Duplicate refund incident']);
      m.fire('incident', 'onBlur');
      expect(m.cards()).toEqual([]);
    });

    it('describes the node showing the card by the card', () => {
      const m = mount({ card: (n, id) => createElement('i', { id }, n.label) });
      expect(m.at('incident').props['aria-describedby']).toBeUndefined();
      m.fire('incident', 'onFocus', focusEvent(true));
      const id = nodes(m.cards()).find((n) => n.type === 'i')!.props.id;
      expect(id).toEqual(expect.any(String));
      expect(m.at('incident').props['aria-describedby']).toBe(id);
      expect(m.at('by-key').props['aria-describedby']).toBeUndefined();
    });
  });
});
