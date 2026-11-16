import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { FlowDiagram, StoryCard, TypeDiagram, UiSketch } from '@pantheon/domain';
import { HookHost, find, nodes } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'diagram' }),
);
import { StoryDiagram } from '@/screens/sessions/story/StoryDiagram';
import type { StoryView } from '@/screens/sessions/story/story-diagram';
import { zh } from './i18n-setup.js';

type Diagram = NonNullable<StoryCard['diagram']>;
const PARTS = ['Flow', 'Decision', 'TypeBox', 'Sketch'];

/** The diagram's body in the given view, rendered down to plain elements. */
function draw(diagram: Diagram, view: StoryView, onHunk = vi.fn()): ReactNode {
  const h = new HookHost(() => StoryDiagram({ diagram, onHunk }));
  h.render();
  find(
    h.value,
    (n) => n.props['aria-label'] === zh('sessions.panel.diagram.views'),
  ).props.onValueChange(view);
  h.render();
  const part = find(
    h.value,
    (n) => typeof n.type === 'function' && PARTS.includes((n.type as { name: string }).name),
  );
  return new HookHost(() => (part.type as (props: unknown) => ReactNode)(part.props)).render();
}

const byClass = (tree: ReactNode, name: string) =>
  nodes(tree).filter((n) => String(n.props.className ?? '').split(' ')[0] === name);

const flow = (edges: FlowDiagram['edges'], nodesOf?: FlowDiagram['nodes']): FlowDiagram => ({
  type: 'flow',
  title: 'who picks the next writer',
  lanes: ['controller', 'lead'],
  nodes: nodesOf ?? [
    { id: 'signal', label: 'progress signal', lane: 'controller', side: 'both' },
    { id: 'session', label: 'start lead session', lane: 'lead', side: 'before' },
    { id: 'rule', label: 'dispatch by rule', lane: 'controller', side: 'after' },
  ],
  edges,
});

describe('story flow diagram', () => {
  it('draws no edge into a node the view hides', () => {
    const spec = flow([
      { from: 'signal', to: 'session', side: 'both' },
      { from: 'signal', to: 'rule', side: 'after' },
    ]);
    const after = byClass(draw({ spec, inferred: [], hunks: {} }, 'after'), 'sd-e');
    expect(after.map((e) => e.props['aria-label'])).toEqual([
      'progress signal 到 dispatch by rule',
    ]);
    const before = byClass(draw({ spec, inferred: [], hunks: {} }, 'before'), 'sd-e');
    expect(before.map((e) => e.props['aria-label'])).toEqual([
      'progress signal 到 start lead session',
    ]);
  });

  it('draws a node that loops back to itself with its label', () => {
    const spec = flow([
      { from: 'signal', to: 'rule', side: 'after' },
      { from: 'rule', to: 'rule', label: 'retry', side: 'after' },
    ]);
    const edges = byClass(draw({ spec, inferred: [], hunks: {} }, 'overlay'), 'sd-e');
    expect(edges).toHaveLength(2);
    const loop = edges[1]!;
    expect(loop.props['aria-label']).toBe('dispatch by rule 到 dispatch by rule：retry');
    const path = nodes(loop.props.children).find((n) => n.type === 'path')!;
    expect(path.props.d).toMatch(/^M[\d.]+,[\d.]+ C/);
    expect(nodes(loop.props.children).some((n) => n.type === 'text')).toBe(true);
  });

  it('names both ends of every edge for assistive technology', () => {
    const spec = flow([{ from: 'signal', to: 'rule', label: 'routine progress', side: 'after' }]);
    const [edge] = byClass(draw({ spec, inferred: [], hunks: {} }, 'overlay'), 'sd-e');
    expect(edge!.props.role).toBe('img');
    expect(edge!.props['aria-label']).toBe('progress signal 到 dispatch by rule：routine progress');
  });

  it('opens only hunks the diagram maps, not inherited object keys', () => {
    const spec = flow(
      [],
      [
        { id: 'constructor', label: 'build controller', lane: 'controller', side: 'both' },
        { id: 'toString', label: 'print plan', lane: 'lead', side: 'both' },
      ],
    );
    const shown = byClass(draw({ spec, inferred: [], hunks: {} }, 'overlay'), 'sd-n');
    expect(shown).toHaveLength(2);
    for (const node of shown) {
      expect(node.props.role).toBeUndefined();
      expect(node.props.onClick).toBeUndefined();
    }
  });
});

describe('story type diagram', () => {
  const spec: TypeDiagram = {
    type: 'type',
    name: 'BacklogEntry',
    file: 'packages/domain/src/planning.ts',
    fields: [
      { name: 'lane', type: 'string', side: 'before', quote: 'lane: string' },
      { name: 'lane', type: 'LaneName', side: 'after', quote: 'lane: LaneName' },
    ],
  };
  const diagram: Diagram = { spec, inferred: ['0'], hunks: { '0': 'hunk-old', '1': 'hunk-new' } };

  it('binds a field row to the side the view shows', () => {
    const onHunk = vi.fn();
    const [after] = byClass(draw(diagram, 'after', onHunk), 'sd-f');
    expect(after!.props.className).not.toContain('inf');
    after!.props.onClick({ stopPropagation() {} });
    expect(onHunk).toHaveBeenLastCalledWith('hunk-new');
    const [before] = byClass(draw(diagram, 'before', onHunk), 'sd-f');
    expect(before!.props.className).toContain('inf');
    before!.props.onClick({ stopPropagation() {} });
    expect(onHunk).toHaveBeenLastCalledWith('hunk-old');
  });
});

describe('story ui sketch', () => {
  const spec: UiSketch = {
    type: 'ui',
    title: 'session panel',
    regions: [
      { id: 'panel', label: 'panel', side: 'both' },
      { id: 'header', label: 'header', parent: 'panel', side: 'both' },
      { id: 'merge', label: 'merge button', parent: 'header', side: 'after' },
    ],
  };

  it('never puts a hunk button inside another', () => {
    const onHunk = vi.fn();
    const tree = draw(
      { spec, inferred: [], hunks: { panel: 'hunk-a', header: 'hunk-b', merge: 'hunk-c' } },
      'overlay',
      onHunk,
    );
    const buttons = nodes(tree).filter((n) => n.props.role === 'button');
    expect(buttons).toHaveLength(3);
    for (const button of buttons)
      expect(nodes(button.props.children).some((n) => n.props.role === 'button')).toBe(false);
    const header = byClass(tree, 'sd-r').find(
      (n) => (nodes(n.props.children)[0] as ReactElement<any>).props.children === 'header',
    )!;
    header.props.onClick({ stopPropagation() {} });
    expect(onHunk).toHaveBeenLastCalledWith('hunk-b');
  });
});
