import { t } from '../../i18n';
import { nodeKind } from './GraphLegend';
import type { GraphEdge, GraphLayout } from './graph-layout';

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
/** The zoom buttons move between multiples of a tenth. */
const STEPS = 10;

const clamp = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

/** The nodes within `depth` links of the selected one, either way along a link, itself included. */
export function graphNear(
  edges: readonly Pick<GraphEdge, 'from' | 'to'>[],
  selected: string,
  depth: 1 | 2,
): ReadonlySet<string> {
  const near = new Set([selected]);
  let ring = [selected];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const e of edges)
      for (const [a, b] of [
        [e.from, e.to],
        [e.to, e.from],
      ] as const)
        if (ring.includes(a) && !near.has(b)) {
          near.add(b);
          next.push(b);
        }
    ring = next;
  }
  return near;
}

const count = (layout: GraphLayout, kind: GraphEdge['kind'], end?: 'from' | 'to', id?: string) =>
  layout.edges.filter((e) => e.kind === kind && (!end || e[end] === id)).length;

/** One sentence that tells a screen reader what the drawing shows. */
export function graphSummary(
  layout: GraphLayout,
  selected: string | null,
  near: ReadonlySet<string> | null,
  total: number,
): string {
  const shown = layout.nodes.length;
  const focus = near && layout.nodes.find((n) => n.id === selected);
  if (focus) {
    const inside = layout.nodes.filter((n) => near.has(n.id)).length;
    const sources = layout.edges.filter(
      (e) => e.kind === 'source' && (e.from === focus.id || e.to === focus.id),
    ).length;
    return t(
      {
        id: 'memory.graphInteract.summary.focus',
        defaultMessage:
          'Knowledge graph, {total, plural, one {# node} other {# nodes}}. Focused on {kind, select, decision {decision} report {report} note {note} file {file} url {web page} session {session} other {tag}} “{title}”, {near, plural, one {# node} other {# nodes}} around it: rests on {dependsOn}, replaces {replaces}, relied on by {reliedOn}, {sources, plural, one {# source} other {# sources}}; {faded, plural, one {# other node} other {# other nodes}} faded.',
      },
      {
        total,
        kind: nodeKind(focus),
        title: focus.label,
        near: inside,
        dependsOn: count(layout, 'depends_on', 'from', focus.id),
        replaces: count(layout, 'supersedes', 'from', focus.id),
        reliedOn: count(layout, 'depends_on', 'to', focus.id),
        sources,
        faded: shown - inside,
      },
    );
  }
  if (total > shown)
    return t(
      {
        id: 'memory.graphInteract.summary.truncated',
        defaultMessage:
          'Knowledge graph, {total, plural, one {# node} other {# nodes}}, only {shown} drawn.',
      },
      { total, shown },
    );
  const memories = layout.nodes.filter((n) => n.kind !== 'source' && n.kind !== 'tag').length;
  return t(
    {
      id: 'memory.graphInteract.summary.all',
      defaultMessage:
        'Knowledge graph, {memories, plural, one {# memory} other {# memories}} and {sources, plural, one {# source} other {# sources}}. Rests on {dependsOn}, replaces {replaces}, restored from {restores}, cites a source {cites}.',
    },
    {
      memories,
      sources: layout.nodes.filter((n) => n.kind === 'source').length,
      dependsOn: count(layout, 'depends_on'),
      replaces: count(layout, 'supersedes'),
      restores: count(layout, 'restored_from'),
      cites: count(layout, 'source'),
    },
  );
}

/**
 * The node nearest to `from` on screen in the arrow's direction; sideways distance counts double,
 * so the walk keeps to rows and columns.
 */
export function nextNode(layout: GraphLayout, from: string, key: ArrowKey): string | null {
  const centre = (n: GraphLayout['nodes'][number]) => [n.x + n.w / 2, n.y + n.h / 2] as const;
  const start = layout.nodes.find((n) => n.id === from);
  if (!start) return null;
  const [x0, y0] = centre(start);
  let best: { id: string; score: number } | null = null;
  for (const n of layout.nodes) {
    const [x, y] = centre(n);
    const [ahead, aside] =
      key === 'ArrowRight'
        ? [x - x0, y - y0]
        : key === 'ArrowLeft'
          ? [x0 - x, y - y0]
          : key === 'ArrowDown'
            ? [y - y0, x - x0]
            : [y0 - y, x - x0];
    if (ahead <= 0) continue;
    const score = ahead + 2 * Math.abs(aside);
    if (!best || score < best.score) best = { id: n.id, score };
  }
  return best?.id ?? null;
}

/** The zoom at which the whole drawing fits the viewport, at most its own size, even under ZOOM_MIN. */
export function fitZoom(layout: GraphLayout, viewport: { width: number; height: number }): number {
  return Math.min(
    1,
    Math.floor(Math.min(viewport.width / layout.width, viewport.height / layout.height) * 100) /
      100,
  );
}

/** The next tenth up or down from `zoom`, within the zoom limits. */
export function stepZoom(zoom: number, by: 1 | -1): number {
  const at = zoom * STEPS;
  return clamp((by > 0 ? Math.floor(at + 1e-6) + 1 : Math.ceil(at - 1e-6) - 1) / STEPS);
}
