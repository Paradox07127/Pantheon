import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { GraphHoverCard } from '@/screens/memory/GraphHoverCard';
import { GraphZoom } from '@/screens/memory/GraphZoom';
import { nodes, text } from './web-hook-host.js';
import { zh } from './i18n-setup.js';

const plain = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('memory graph hover card', () => {
  it('shows the title, the summary on one line and the state as a tooltip', () => {
    const html = renderToStaticMarkup(
      createElement(GraphHoverCard, {
        id: 'graph-card',
        node: {
          id: 'cross-day',
          label: 'Cross-day failure',
          kind: 'report',
          state: 'draft',
          summary: 'Days are cut in UTC.',
        },
      }),
    );
    expect(html).toContain('role="tooltip"');
    expect(html).toContain('id="graph-card"');
    expect(html).toContain('data-st="wait"');
    expect(plain(html)).toBe(
      `Cross-day failure Days are cut in UTC. ${zh('memory.graphInteract.state.draft')}`,
    );
  });

  it('leaves out the summary and the state a node does not have', () => {
    const html = renderToStaticMarkup(
      createElement(GraphHoverCard, {
        node: { id: 'file', label: 'idempotency.ts', kind: 'source', source_kind: 'file' },
      }),
    );
    expect(plain(html)).toBe('idempotency.ts');
    expect(html).not.toContain('data-st');
  });

  it('marks current and archived memories by their own glyphs', () => {
    const state = (s: 'active' | 'archived') =>
      renderToStaticMarkup(
        createElement(GraphHoverCard, { node: { id: 'm', label: 'M', kind: 'note', state: s } }),
      );
    expect(state('active')).toContain('data-st="ok"');
    expect(plain(state('active'))).toBe(`M ${zh('memory.graphInteract.state.active')}`);
    expect(state('archived')).toContain('data-st="idle"');
    expect(plain(state('archived'))).toBe(`M ${zh('memory.graphInteract.state.archived')}`);
  });
});

describe('memory graph zoom', () => {
  const zoom = (value: number) => {
    const p = { zoom: value, onZoom: vi.fn(), onFit: vi.fn() };
    const tree = GraphZoom(p) as ReactElement<any>;
    const buttons = nodes(tree).filter((n) => n.type === 'button');
    return { p, tree, buttons };
  };

  it('shows the zoom in percent between the out and in buttons, then fit to window', () => {
    const { tree, buttons } = zoom(1);
    expect(tree.props['aria-label']).toBe(zh('memory.graphInteract.zoom'));
    expect(buttons.map((b) => b.props['aria-label'] ?? text(b.props.children))).toEqual([
      zh('memory.graphInteract.zoomOut'),
      zh('memory.graphInteract.zoomIn'),
      zh('memory.graphInteract.fit'),
    ]);
    expect(text(tree.props.children)).toContain('100%');
    expect(text(zoom(0.87).tree.props.children)).toContain('87%');
  });

  it('steps the zoom by a tenth and fits on request', () => {
    const { p, buttons } = zoom(0.87);
    buttons[0]!.props.onClick();
    expect(p.onZoom).toHaveBeenLastCalledWith(0.8);
    buttons[1]!.props.onClick();
    expect(p.onZoom).toHaveBeenLastCalledWith(0.9);
    buttons[2]!.props.onClick();
    expect(p.onFit).toHaveBeenCalledOnce();
  });

  it('turns off the button that would pass a limit', () => {
    expect(zoom(0.5).buttons.map((b) => b.props.disabled)).toEqual([true, false, undefined]);
    expect(zoom(2).buttons.map((b) => b.props.disabled)).toEqual([false, true, undefined]);
  });
});
