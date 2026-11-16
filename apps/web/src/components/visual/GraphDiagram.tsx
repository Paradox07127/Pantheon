import { useState } from 'react';
import type { VisualContent } from '@pantheon/domain';
import type { Edge, Node, ReactFlow as Flow } from '@xyflow/react';
import { Drawing, useDraw } from './shared';
import './graph-diagram.css';

export type GraphSpec = Extract<VisualContent, { kind: 'graph' }>['spec'];

const NODE_HEIGHT = 24;
// Estimated label widths at 12px: wide (CJK) characters take 12px, the others 7px.
const nodeWidth = (label: string): number =>
  Math.min(
    240,
    [...label].reduce((width, c) => width + (c.charCodeAt(0) > 0x2e7f ? 12 : 7), 24),
  );

interface Laid {
  ReactFlow: typeof Flow;
  nodes: Node[];
  edges: Edge[];
}

export function GraphDiagram({
  spec,
  height,
  selected,
  onSelect,
  directed = false,
}: {
  spec: GraphSpec;
  height: number;
  selected?: string;
  directed?: boolean;
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
      for (const edge of spec.edges) g.setEdge(edge.from, edge.to);
      dagre.layout(g);
      const across = direction === 'LR';
      setLaid({
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
      style={{ height }}
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
