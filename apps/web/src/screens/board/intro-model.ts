import type { ProjectIntro } from '@pantheon/domain';

export interface TreeCell {
  /** The value's index in the input. */
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The mermaid blocks of an introduction body, still fenced, for `Markdown` to draw. */
export const mermaidBlocks = (body: string): string =>
  [...body.matchAll(/^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[ \t]*\n[\s\S]*?\n {0,3}\1[ \t]*$/gm)]
    .map((block) => block[0].trim())
    .join('\n\n');

type Item = { index: number; area: number };

const sum = (row: readonly Item[]) => row.reduce((total, item) => total + item.area, 0);

// The worst aspect ratio of a row laid along a side of this length.
function worst(row: readonly Item[], side: number): number {
  const s = sum(row);
  const max = Math.max(...row.map((item) => item.area));
  const min = Math.min(...row.map((item) => item.area));
  return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
}

/** A squarified treemap of the positive values over the box; each cell's area is its share of it. */
export function squarify(values: readonly number[], width: number, height: number): TreeCell[] {
  const total = values.reduce((all, value) => all + Math.max(0, value), 0);
  if (!total || width <= 0 || height <= 0) return [];
  const items = values
    .map((value, index) => ({ index, area: (value / total) * width * height }))
    .filter((item) => item.area > 0)
    .sort((a, b) => b.area - a.area);
  const cells: TreeCell[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  const lay = (row: readonly Item[]) => {
    const s = sum(row);
    if (w >= h) {
      const across = s / h;
      let at = y;
      for (const item of row) {
        cells.push({ index: item.index, x, y: at, w: across, h: item.area / across });
        at += item.area / across;
      }
      x += across;
      w -= across;
    } else {
      const down = s / w;
      let at = x;
      for (const item of row) {
        cells.push({ index: item.index, x: at, y, w: item.area / down, h: down });
        at += item.area / down;
      }
      y += down;
      h -= down;
    }
  };
  let row: Item[] = [];
  for (const item of items) {
    const side = Math.min(w, h);
    if (row.length && worst([...row, item], side) > worst(row, side)) {
      lay(row);
      row = [];
    }
    row.push(item);
  }
  lay(row);
  return cells;
}

/** The lowest commit count of each shade step: none, 1–3, 4–9, 10–19, 20 or more. */
export const COMMIT_STEPS = [0, 1, 4, 10, 20] as const;

export const commitStep = (commits: number): number =>
  COMMIT_STEPS.filter((min) => commits >= min).length - 1;

/** The share of the text colour mixed into the track at each step, in percent. */
export const SHADES = [0, 18, 36, 56, 76] as const;
/** From this shade on a cell's text takes the surface colour. */
export const DARK_SHADE = 56;

export const commitShade = (commits: number): number => SHADES[commitStep(commits)]!;

/** The legend text of a shade step. */
export function stepRange(step: number): string {
  const min = COMMIT_STEPS[step]!;
  const next = COMMIT_STEPS[step + 1];
  if (next === undefined) return `${min}+`;
  return next - 1 === min ? String(min) : `${min}–${next - 1}`;
}

export interface LanguagePart {
  /** null stands for every language folded into the last part. */
  name: string | null;
  lines: number;
  share: number;
}

/** At most five parts by lines; with more languages the fifth holds all but the largest four. */
export function languageParts(languages: ProjectIntro['languages']): LanguagePart[] {
  const total = languages.reduce((all, language) => all + language.lines, 0);
  if (!total) return [];
  const named = languages
    .filter((language) => language.name !== 'other' && language.lines > 0)
    .sort((a, b) => b.lines - a.lines);
  const other = languages.some((language) => language.name === 'other' && language.lines > 0);
  const kept = named.length + (other ? 1 : 0) > 5 ? named.slice(0, 4) : named;
  const rest = total - kept.reduce((all, language) => all + language.lines, 0);
  return [
    ...kept.map(({ name, lines }) => ({ name, lines, share: lines / total })),
    ...(rest > 0 ? [{ name: null, lines: rest, share: rest / total }] : []),
  ];
}

/** A source reference as shown: a file path with its line, or the start of a commit SHA. */
export function sourceText(source: string): string {
  if (source.startsWith('file:')) return source.slice('file:'.length);
  if (source.startsWith('commit:')) return source.slice('commit:'.length, 'commit:'.length + 7);
  return source;
}

/** The argv as a POSIX shell line: an argument with anything the shell would read is single-quoted. */
export const shellLine = (argv: readonly string[]): string =>
  argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(' ');

type ArchSpec = NonNullable<ProjectIntro['architecture']>;

export interface ArchEdge {
  from: string;
  to: string;
  /** The graph also has the edge back; it is drawn with a head at each end. */
  both: boolean;
}

/** Each edge once; an edge back along an earlier one becomes that edge's second head. */
export function mergeEdges(edges: readonly { from: string; to: string }[]): ArchEdge[] {
  const merged: ArchEdge[] = [];
  for (const { from, to } of edges) {
    if (merged.some((edge) => edge.from === from && edge.to === to)) continue;
    const back = merged.find((edge) => edge.from === to && edge.to === from);
    if (back) back.both = true;
    else merged.push({ from, to, both: false });
  }
  return merged;
}

/** Architecture node size, the gaps between columns and rows, and the space above and below. */
export const ARCH_NODE = { w: 140, h: 44 } as const;
const ARCH_GAP = { x: 40, y: 22 } as const;
const ARCH_PAD = 12;

export interface ArchLayout {
  width: number;
  height: number;
  nodes: (ArchSpec['nodes'][number] & { x: number; y: number })[];
  /** `d` is the SVG path from the edge's source node to its target node. */
  edges: (ArchEdge & { d: string })[];
}

/**
 * Nodes in columns by their longest path from a node nothing points at, in input order within a
 * column; a node on a cycle stays in the column its other sources put it in.
 */
export function archLayout(
  spec: ArchSpec,
  /** Node size, for nodes that hold more than an architecture node. */
  size: { w: number; h: number } = ARCH_NODE,
  /** Gaps between columns and rows, for a diagram smaller than an architecture diagram. */
  gap: { x: number; y: number } = ARCH_GAP,
): ArchLayout {
  const ids = new Set(spec.nodes.map((node) => node.id));
  const edges = mergeEdges(spec.edges).filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const rank = new Map(spec.nodes.map((node) => [node.id, 0]));
  const into = new Map(spec.nodes.map((node) => [node.id, 0]));
  for (const edge of edges) into.set(edge.to, into.get(edge.to)! + 1);
  const ready = spec.nodes.filter((node) => into.get(node.id) === 0).map((node) => node.id);
  while (ready.length) {
    const id = ready.shift()!;
    for (const edge of edges.filter((edge) => edge.from === id)) {
      rank.set(edge.to, Math.max(rank.get(edge.to)!, rank.get(id)! + 1));
      into.set(edge.to, into.get(edge.to)! - 1);
      if (into.get(edge.to) === 0) ready.push(edge.to);
    }
  }
  const rows = new Map<number, number>();
  const nodes = spec.nodes.map((node) => {
    const column = rank.get(node.id)!;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return {
      ...node,
      x: column * (size.w + gap.x),
      y: ARCH_PAD + row * (size.h + gap.y),
    };
  });
  const at = new Map(nodes.map((node) => [node.id, node]));
  // Rows and columns are separated by node-free channels; an edge that skips one runs along them.
  let reach = 0;
  const path = (from: { x: number; y: number }, to: { x: number; y: number }): string => {
    const { w, h } = size;
    if (from.x === to.x) {
      if (Math.abs(to.y - from.y) > h + gap.y) {
        // Out of the right side into the gap after the column, at most three quarters across it.
        const x = from.x + w;
        reach = Math.max(reach, x + (gap.x * 3) / 4);
        const [y1, y2] = [from.y + h / 2, to.y + h / 2];
        return `M${x} ${y1}C${x + gap.x} ${y1} ${x + gap.x} ${y2} ${x} ${y2}`;
      }
      const down = to.y > from.y;
      return `M${from.x + w / 2} ${down ? from.y + h : from.y}V${down ? to.y : to.y + h}`;
    }
    const right = to.x > from.x;
    const x1 = right ? from.x + w : from.x;
    const x2 = right ? to.x : to.x + w;
    const y1 = from.y + h / 2;
    const y2 = to.y + h / 2;
    if (Math.abs(to.x - from.x) > w + gap.x) {
      // Into the column gap beside the source, along the row channel above it, out of the gap beside the target.
      const side = right ? gap.x / 2 : -gap.x / 2;
      const [g1, g2] = [x1 + side, x2 - side];
      const [m1, m2] = [(x1 + g1) / 2, (g2 + x2) / 2];
      const channel = from.y - ARCH_PAD / 2;
      return `M${x1} ${y1}C${m1} ${y1} ${m1} ${channel} ${g1} ${channel}H${g2}C${m2} ${channel} ${m2} ${y2} ${x2} ${y2}`;
    }
    if (y1 === y2) return `M${x1} ${y1}H${x2}`;
    const mid = (x1 + x2) / 2;
    return `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
  };
  const drawn = edges.map((edge) => ({ ...edge, d: path(at.get(edge.from)!, at.get(edge.to)!) }));
  const columns = Math.max(0, ...rows.keys()) + 1;
  const most = Math.max(0, ...rows.values());
  return {
    width: Math.max(columns * size.w + (columns - 1) * gap.x, reach),
    height: 2 * ARCH_PAD + most * size.h + Math.max(0, most - 1) * gap.y,
    nodes,
    edges: drawn,
  };
}

/** The label a treemap cell this wide shows: the path, else its last segment, else nothing. */
export function cellLabel(path: string, width: number): string | null {
  // 7.2px is the advance of a 12px monospace glyph (0.6em); 16px is the label's two side gaps.
  const fits = (text: string) => text.length * 7.2 + 16 <= width;
  const tail = path.slice(path.lastIndexOf('/') + 1);
  return fits(path) ? path : fits(tail) ? tail : null;
}
