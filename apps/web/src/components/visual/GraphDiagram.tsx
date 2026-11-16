import { useState } from 'react';
import type { VisualContent } from '@pantheon/domain';
import type { Edge, Node, ReactFlow as Flow } from '@xyflow/react';
import { Drawing, useDraw } from './shared';
import './graph-diagram.css';

export type GraphSpec = Extract<VisualContent, { kind: 'graph' }>['spec'];

const NODE_HEIGHT = 24;
// A tall graph grows its card to this, the height of the zoomed visual view, then pans.
const MAX_HEIGHT = 640;
// Room around the laid-out graph, as fitView's default 10% padding needs.
const PAD = 32;
// Estimated label widths at 12px: wide (CJK) characters take 12px, the others 7px.
const nodeWidth = (label: string): number =>
  Math.min(
    240,
    [...label].reduce((width, c) => width + (c.charCodeAt(0) > 0x2e7f ? 12 : 7), 24),
  );

interface Laid {
  ReactFlow: typeof Flow;
  nodes: Node[];
  /** The laid-out graph's height in px. */
  extent: number;
  edges: Edge[];
}

export function GraphDiagram({
  spec,
  height,
  selected,
  onSelect,
  directed = false,
  grows = false,
}: {
  spec: GraphSpec;
  height: number;
  selected?: string;
  directed?: boolean;
  /** Grows past the height to fit a taller graph, up to the zoomed view's height. */
  grows?: boolean;
  onSelect?: (id: string) => void;
}) {
  const [laid, setLaid] = useState<Laid | null>(null);
  const ready = useDraw(
    async (live) => {
      const [flow, dagre] = await Promise.all([
        import('@xyflow/react'),
        import('@dagrejs/dagre'),
        import('@xyflow/react/dist/base.css'),
      ]);
      if (!live()) return undefined;
      const direction = spec.direction ?? 'LR';
      const g = new dagre.Graph();
      g.setGraph({ rankdir: direction, nodesep: 16, ranksep: 48, marginx: 0, marginy: 0 });
      g.setDefaultEdgeLabel(() => ({}));
      for (const node of spec.nodes)
        g.setNode(node.id, { width: nodeWidth(node.label), height: NODE_HEIGHT });
      for (const edge of spec.edges)
        g.setEdge(
          edge.from,
          edge.to,
          edge.label === undefined
            ? {}
            : { width: nodeWidth(edge.label), height: NODE_HEIGHT, labelpos: 'c' },
        );
      dagre.layout(g);
      const across = direction === 'LR';
      const bottoms = spec.nodes.map((node) => g.node(node.id).y! + NODE_HEIGHT / 2);
      const tops = spec.nodes.map((node) => g.node(node.id).y! - NODE_HEIGHT / 2);
      setLaid({
        extent: bottoms.length ? Math.max(...bottoms) - Math.min(...tops) : 0,
        ReactFlow: flow.ReactFlow,
        nodes: spec.nodes.map((node) => {
          const at = g.node(node.id);
          return {
            id: node.id,
            data: { label: node.label },
            position: { x: at.x! - at.width! / 2, y: at.y! - NODE_HEIGHT / 2 },
            width: at.width!,
            height: NODE_HEIGHT,
            className: 'vis-node',
            sourcePosition: across ? flow.Position.Right : flow.Position.Bottom,
            targetPosition: across ? flow.Position.Left : flow.Position.Top,
          };
        }),
        edges: spec.edges.map((edge, index) => ({
          id: String(index),
          source: edge.from,
          target: edge.to,
          ...(directed && { markerEnd: { type: flow.MarkerType.ArrowClosed } }),
          ...(edge.label !== undefined && { label: edge.label }),
        })),
      });
      return undefined;
    },
    [spec, directed],
  );
  return (
    <div
      className="vis-fill vis-graph"
      style={{
        height:
          grows && laid
            ? Math.min(Math.max(height, laid.extent + PAD * 2), Math.max(height, MAX_HEIGHT))
            : height,
      }}
      onKeyDown={(event) => {
        if (!onSelect || (event.key !== 'Enter' && event.key !== ' ')) return;
        const id = (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node')?.dataset
          .id;
        if (id && spec.nodes.some((node) => node.id === id)) {
          event.preventDefault();
          onSelect(id);
        }
      }}
    >
      {laid && (
        <laid.ReactFlow
          nodes={laid.nodes.map((node) => ({ ...node, selected: node.id === selected }))}
          edges={laid.edges}
          fitView
          // Fitting never shrinks below full size, so labels stay readable; larger graphs pan.
          fitViewOptions={{ minZoom: 1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={!!onSelect}
          nodesFocusable={!!onSelect}
          onNodeClick={(_, node) => onSelect?.(node.id)}
          edgesFocusable={false}
          deleteKeyCode={null}
          // A plain wheel keeps scrolling the page; pinch or the modifier key with the wheel zooms.
          zoomOnScroll={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        />
      )}
      {!ready && <Drawing />}
    </div>
  );
}
