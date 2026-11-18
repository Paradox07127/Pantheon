import type { ElkNode } from 'elkjs/lib/elk-api';
import {
  labelLines,
  type Cardinality,
  type ErEntity,
  type ErModel,
  type ErRelationship,
  type MessageKind,
  type Participant,
  type SegmentKind,
  type SequenceItem,
  type SequenceModel,
} from './mermaid-model';

export interface Point {
  x: number;
  y: number;
}
export interface Box extends Point {
  width: number;
  height: number;
}

/** Room around the drawing inside its box. */
export const PAD = 16;
/** A label line's height at 12px. */
const LINE = 16;

/** Estimated advance of a run of text: wide (CJK) characters take a full em. */
export const textWidth = (text: string, size: number, narrow: number): number =>
  [...text].reduce((width, c) => width + (c.charCodeAt(0) > 0x2e7f ? size : narrow), 0);
/** 12px text, regular; 12px mono; 13px regular; 13px semibold. */
const xs = (text: string) => textWidth(text, 12, 6.8);
const mono = (text: string) => textWidth(text, 12, 7.2);
const sm = (text: string) => textWidth(text, 13, 7.2);
const title = (text: string) => textWidth(text, 13, 7.6);

/** The width of a label pill or chip around 12px text. */
export const pillWidth = (text: string) => Math.ceil(xs(text) + 14);

// ER tables: a header band, then a row per attribute.
export const TABLE = { head: 32, row: 24, min: 208, side: 12, badge: 18 } as const;

export interface ErTable extends Box {
  entity: ErEntity;
  /** Where attribute names start; key badges sit before it. */
  nameAt: number;
}
export interface ErLine {
  relationship: ErRelationship;
  /** The orthogonal route from the `from` table's border to the `to` table's. */
  points: Point[];
  label_box?: Box;
}
export interface ErLayout {
  width: number;
  height: number;
  tables: ErTable[];
  lines: ErLine[];
}

const keyText = (keys: readonly string[]) => keys.join(',');
const badgeWidth = (keys: readonly string[]) => Math.max(28, Math.ceil(mono(keyText(keys)) + 14));

function tableSize(entity: ErEntity) {
  const keyed = entity.attributes.filter((a) => a.keys.length > 0);
  const nameAt = keyed.length
    ? 8 + Math.max(...keyed.map((a) => badgeWidth(a.keys))) + 8
    : TABLE.side;
  const head =
    TABLE.side + title(entity.id) + (entity.alias ? 6 + xs(entity.alias) : 0) + TABLE.side;
  const rows = entity.attributes.map((a) => nameAt + sm(a.name) + 16 + mono(a.type) + TABLE.side);
  return {
    nameAt,
    width: Math.ceil(Math.max(TABLE.min, head, ...rows)),
    height: TABLE.head + TABLE.row * entity.attributes.length,
  };
}

const ER_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeEdge': '12',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
  'elk.spacing.edgeNode': '16',
  // A route leaves a table straight for at least this long, which holds its cardinality marks.
  'elk.layered.spacing.edgeNodeBetweenLayers': '32',
  'elk.edgeLabels.inline': 'false',
  'elk.edgeLabels.placement': 'CENTER',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  'org.eclipse.elk.json.shapeCoords': 'ROOT',
  'org.eclipse.elk.json.edgeCoords': 'ROOT',
};

/** The largest zoom, at most 1, that shows the whole drawing inside the room. */
export const fitZoom = (size: { width: number; height: number }, room: Point): number =>
  Math.min(1, room.x / size.width, room.y / size.height);

/**
 * Lays the tables out with ELK's layered algorithm across and down, and keeps the one that fits
 * `room` at the larger zoom. Coordinates include `PAD` on every side.
 */
export async function layoutEr(model: ErModel, room: Point): Promise<ErLayout> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK();
  const index = new Map(model.entities.map((entity, i) => [entity.id, i]));
  const sizes = model.entities.map(tableSize);
  const once = async (direction: 'RIGHT' | 'DOWN'): Promise<ErLayout> => {
    const root: ElkNode = {
      id: 'root',
      layoutOptions: { ...ER_OPTIONS, 'elk.direction': direction },
      children: sizes.map((size, i) => ({ id: `t${i}`, width: size.width, height: size.height })),
      edges: model.relationships.map((r, i) => ({
        id: `r${i}`,
        sources: [`t${index.get(r.from)}`],
        targets: [`t${index.get(r.to)}`],
        ...(r.label && {
          labels: [{ id: `l${i}`, text: r.label, width: pillWidth(r.label), height: 18 }],
        }),
      })),
    };
    const laid = await elk.layout(root);
    const shapes = new Map((laid.children ?? []).map((shape) => [shape.id, shape]));
    const routes = new Map((laid.edges ?? []).map((edge) => [edge.id, edge]));
    const at = (p: Point) => ({ x: p.x + PAD, y: p.y + PAD });
    return {
      width: (laid.width ?? 0) + PAD * 2,
      height: (laid.height ?? 0) + PAD * 2,
      tables: model.entities.map((entity, i) => {
        const shape = shapes.get(`t${i}`)!;
        return {
          entity,
          nameAt: sizes[i]!.nameAt,
          ...at({ x: shape.x ?? 0, y: shape.y ?? 0 }),
          width: sizes[i]!.width,
          height: sizes[i]!.height,
        };
      }),
      lines: model.relationships.map((relationship, i) => {
        const route = routes.get(`r${i}`);
        const section = route?.sections?.[0];
        const label = route?.labels?.[0];
        return {
          relationship,
          points: section
            ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(at)
            : [],
          ...(label && {
            label_box: {
              ...at({ x: label.x ?? 0, y: label.y ?? 0 }),
              width: label.width ?? 0,
              height: label.height ?? 0,
            },
          }),
        };
      }),
    };
  };
  const [across, down] = await Promise.all([once('RIGHT'), once('DOWN')]);
  return fitZoom(down, room) > fitZoom(across, room) + 1e-3 ? down : across;
}

/**
 * Crow's-foot marks for the end of a line at `end`, coming from `from`: a bar for one, a circle
 * for zero, three prongs for many, the nearest mark at the table.
 */
export function cardinalityMarks(
  end: Point,
  from: Point,
  cardinality: Cardinality,
): { path: string; circle?: Point } {
  const length = Math.hypot(from.x - end.x, from.y - end.y) || 1;
  const [ux, uy] = [(from.x - end.x) / length, (from.y - end.y) / length];
  const along = (d: number, side: number) => ({
    x: end.x + ux * d - uy * side,
    y: end.y + uy * d + ux * side,
  });
  const segment = (a: Point, b: Point) => `M${a.x} ${a.y}L${b.x} ${b.y}`;
  const bar = (d: number) => segment(along(d, -6), along(d, 6));
  const prongs = [-7, 0, 7].map((side) => segment(along(0, side), along(12, 0))).join('');
  switch (cardinality) {
    case 'one':
      return { path: bar(8) + bar(14) };
    case 'zero-or-one':
      return { path: bar(8), circle: along(18, 0) };
    case 'one-or-more':
      return { path: prongs + bar(16) };
    case 'zero-or-more':
      return { path: prongs, circle: along(20, 0) };
  }
}

// Sequences.

export const CARD = { min: 96, one: 32, two: 44, gap: 48, icon: 28, plain: 12 } as const;
const ROW = 40;
const SEGMENT_HEAD = 28;
const NOTE_PAD = 8;
const BAR = 8;
const SELF = 32;
/** A diagram drawn taller than this repeats its participants under the lifelines. */
const REPEAT_BELOW = 600;

export interface SeqParticipant {
  participant: Participant;
  /** The lifeline's x. */
  x: number;
  width: number;
}
export interface SeqMessage {
  kind: MessageKind;
  lines: string[];
  number?: number;
  /** Where the line starts and where its head points; equal for a message to itself. */
  x1: number;
  x2: number;
  y: number;
  self: boolean;
}
export interface SeqSegment extends Box {
  kind: SegmentKind;
  label: string;
  /** The `else`, `and` or `option` branches, each with the y of its divider. */
  branches: { label: string; y: number }[];
}
export interface SeqNote extends Box {
  lines: string[];
}
export interface SeqLayout {
  /** The viewBox: the drawing's extent with `PAD` around it. */
  x: number;
  y: number;
  width: number;
  height: number;
  participants: SeqParticipant[];
  cardHeight: number;
  /** The tops of the participant rows: the top one, and a bottom one in a tall diagram. */
  rows: number[];
  lifeline: { y1: number; y2: number };
  boxes: (Box & { label: string })[];
  segments: SeqSegment[];
  activations: Box[];
  messages: SeqMessage[];
  notes: SeqNote[];
}

const cardWidth = (p: Participant) =>
  Math.ceil(
    Math.max(
      CARD.min,
      (p.type ? CARD.icon : CARD.plain) +
        Math.max(title(p.title), p.description ? mono(p.description) : 0) +
        CARD.plain,
    ),
  );
const linesWidth = (lines: string[]) => Math.max(0, ...lines.map(xs));
const noteWidth = (lines: string[]) => Math.ceil(linesWidth(lines) + NOTE_PAD * 3);
/** The keyword that starts a segment's later branches. */
const BRANCH_WORD: Partial<Record<SegmentKind, string>> = { par: 'and', critical: 'option' };
/** A segment's keyword, or the one of its `index`th branch. */
export const segmentWord = (kind: SegmentKind, index: number) =>
  index === 0 ? kind : (BRANCH_WORD[kind] ?? 'else');
/** The width of a segment's label chip: its keyword, then its text. */
export const chipWidth = (word: string, label: string) =>
  Math.ceil(title(word) + (label ? 6 + xs(label) : 0) + 16);

const CORNER = 6;

/** An orthogonal route with each bend rounded. */
export function roundedPath(points: Point[]): string {
  if (points.length < 2) return '';
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [before, corner, after] = [points[i - 1]!, points[i]!, points[i + 1]!];
    const into = Math.hypot(corner.x - before.x, corner.y - before.y);
    const out = Math.hypot(after.x - corner.x, after.y - corner.y);
    const r = Math.min(CORNER, into / 2, out / 2);
    if (!r) {
      d += `L${corner.x} ${corner.y}`;
      continue;
    }
    const a = {
      x: corner.x - ((corner.x - before.x) / into) * r,
      y: corner.y - ((corner.y - before.y) / into) * r,
    };
    const b = {
      x: corner.x + ((after.x - corner.x) / out) * r,
      y: corner.y + ((after.y - corner.y) / out) * r,
    };
    d += `L${a.x} ${a.y}Q${corner.x} ${corner.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1]!;
  return `${d}L${last.x} ${last.y}`;
}

/** Lays a sequence out: columns wide enough for their labels, rows as tall as their content. */
export function layoutSequence(model: SequenceModel): SeqLayout {
  const order = new Map(model.participants.map((p, i) => [p.id, i]));
  const widths = model.participants.map(cardWidth);
  const n = widths.length;
  // gaps[i] is the distance from lifeline i to lifeline i + 1; the margins hold the outer cards.
  const gaps = widths.slice(1).map((w, i) => widths[i]! / 2 + CARD.gap + w / 2);
  const margin = { left: (widths[0] ?? 0) / 2, right: (widths[n - 1] ?? 0) / 2 };
  const needs: { lo: number; hi: number; room: number }[] = [];
  const need = (lo: number, hi: number, room: number) => needs.push({ lo, hi, room });
  const collect = (items: SequenceItem[]) => {
    for (const item of items) {
      if (item.item === 'message') {
        const [a, b] = [order.get(item.from)!, order.get(item.to)!];
        const label = linesWidth(labelLines(item.text));
        if (a === b) need(a, a + 1, Math.max(label + 8, SELF + 8) + 24);
        else need(Math.min(a, b), Math.max(a, b), label + 32);
      } else if (item.item === 'note') {
        const width = noteWidth(labelLines(item.text));
        const [a, b = a] = item.participants.map((id) => order.get(id)!) as [number, number?];
        if (item.placement === 'right') need(a, a + 1, width + 24);
        else if (item.placement === 'left') need(a - 1, a, width + 24);
        else if (a !== b) need(Math.min(a, b), Math.max(a, b), width - 48);
        else {
          need(a - 1, a, width / 2 + 8);
          need(a, a + 1, width / 2 + 8);
        }
      } else if (item.item === 'segment') for (const branch of item.branches) collect(branch.items);
    }
  };
  collect(model.items);
  // Narrow spans first, so a wide one only adds what its inner columns still lack.
  for (const { lo, hi, room } of needs.sort((a, b) => a.hi - a.lo - (b.hi - b.lo))) {
    if (lo < 0) margin.left = Math.max(margin.left, room);
    else if (hi >= n) margin.right = Math.max(margin.right, room);
    else {
      const span = gaps.slice(lo, hi).reduce((sum, gap) => sum + gap, 0);
      if (span < room) gaps[hi - 1]! += room - span;
    }
  }
  const lifelines: number[] = [margin.left];
  for (const gap of gaps) lifelines.push(lifelines.at(-1)! + gap);
  const x = (id: string) => lifelines[order.get(id)!]!;

  const boxed = model.boxes.some((box) => box.participants.length > 0);
  const cardTop = model.boxes.some((box) => box.label) ? SEGMENT_HEAD : boxed ? 12 : 0;
  const cardHeight = model.participants.some((p) => p.description) ? CARD.two : CARD.one;
  let y = cardTop + cardHeight + 16;

  const messages: SeqMessage[] = [];
  const notes: SeqNote[] = [];
  const segments: SeqSegment[] = [];
  const activations: Box[] = [];
  const open = new Map<string, number[]>();
  let last: { y: number; to: string } | undefined;
  const depth = (id: string) => open.get(id)?.length ?? 0;
  // A line ends at the outer edge of the activation bars on its side; nested bars step right.
  const edge = (id: string, toward: number) => {
    const d = depth(id);
    if (d === 0) return x(id);
    return toward < 0 ? x(id) - BAR / 2 : x(id) + BAR / 2 + (d - 1) * (BAR / 2);
  };
  type Extent = [number, number];
  const widen = (a: Extent, b: Extent): Extent => [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
  const walk = (items: SequenceItem[]): Extent => {
    let extent: Extent = [Infinity, -Infinity];
    for (const item of items) {
      if (item.item === 'message') {
        const lines = labelLines(item.text);
        const lineY = y + NOTE_PAD + Math.max(1, lines.length) * LINE;
        const self = item.from === item.to;
        const [from, to] = [x(item.from), x(item.to)];
        const x1 = edge(item.from, self ? 1 : to - from);
        const x2 = self ? x1 : edge(item.to, from - to);
        messages.push({
          kind: item.kind,
          lines,
          ...(item.number !== undefined && { number: item.number }),
          x1,
          x2,
          y: lineY,
          self,
        });
        extent = widen(
          extent,
          self
            ? [from - 24, Math.max(x1 + SELF, from + 8 + linesWidth(lines)) + 24]
            : [Math.min(from, to) - 24, Math.max(from, to) + 24],
        );
        last = { y: lineY, to: item.to };
        y = lineY + (self ? LINE : 0) + LINE;
      } else if (item.item === 'note') {
        const lines = labelLines(item.text);
        const ends = item.participants.map(x);
        const height = Math.max(CARD.one, lines.length * LINE + NOTE_PAD * 2);
        let width = noteWidth(lines);
        let left: number;
        if (item.placement === 'right') left = ends[0]! + 12;
        else if (item.placement === 'left') left = ends[0]! - 12 - width;
        else {
          const [lo, hi] = [Math.min(...ends), Math.max(...ends)];
          width = Math.max(width, hi - lo + 48);
          left = (lo + hi) / 2 - width / 2;
        }
        notes.push({ x: left, y: y + 4, width, height, lines });
        extent = widen(extent, [left - 12, left + width + 12]);
        y += height + 4 + 12;
      } else if (item.item === 'activate') {
        const starts = open.get(item.participant) ?? [];
        starts.push(last?.to === item.participant ? last.y - BAR : y + LINE);
        open.set(item.participant, starts);
      } else if (item.item === 'deactivate') {
        const starts = open.get(item.participant);
        const start = starts?.pop();
        if (start === undefined) continue;
        const end = Math.max((last?.y ?? start) + BAR, start + LINE);
        activations.push({
          x: x(item.participant) - BAR / 2 + (starts?.length ?? 0) * (BAR / 2),
          y: start,
          width: BAR,
          height: end - start,
        });
      } else if (item.item === 'segment') {
        const top = y;
        y += SEGMENT_HEAD;
        const dividers: number[] = [];
        let inner: Extent = [Infinity, -Infinity];
        item.branches.forEach((branch, i) => {
          if (i > 0) {
            dividers.push(y + 4);
            y += 4 + SEGMENT_HEAD;
          }
          inner = widen(inner, walk(branch.items));
        });
        y += NOTE_PAD;
        const [label] = item.branches;
        const chips = item.branches.map((branch, i) =>
          chipWidth(segmentWord(item.kind, i), branch.label),
        );
        if (inner[0] > inner[1]) inner = [lifelines[0]! - 24, lifelines[0]! + 24];
        const left = inner[0] - 12;
        const width = Math.max(inner[1] + 12 - left, Math.max(...chips) + 16);
        segments.push({
          kind: item.kind,
          label: label!.label,
          x: left,
          y: top,
          width,
          height: y - top,
          branches: item.branches.slice(1).map((branch, i) => ({
            label: branch.label,
            y: dividers[i]!,
          })),
        });
        extent = widen(extent, [left, left + width]);
        y += 12;
      }
    }
    return extent;
  };
  walk(model.items);
  const end = y + NOTE_PAD;
  for (const [id, starts] of open)
    starts.forEach((start, level) =>
      activations.push({
        x: x(id) - BAR / 2 + level * (BAR / 2),
        y: start,
        width: BAR,
        height: Math.max(end - start, LINE),
      }),
    );
  const rows = [cardTop];
  if (end + PAD * 2 > REPEAT_BELOW) rows.push(end);
  const bottom = rows.length > 1 ? end + cardHeight : end;
  const participants = model.participants.map((participant, i) => ({
    participant,
    x: lifelines[i]!,
    width: widths[i]!,
  }));
  const boxes = model.boxes.flatMap((box) => {
    const inside = participants.filter((p) => box.participants.includes(p.participant.id));
    if (!inside.length) return [];
    const left = Math.min(...inside.map((p) => p.x - p.width / 2)) - 12;
    const right = Math.max(...inside.map((p) => p.x + p.width / 2)) + 12;
    return [{ label: box.label, x: left, y: 0, width: right - left, height: bottom + 12 }];
  });
  const shapes: Box[] = [
    ...participants.map((p) => ({ x: p.x - p.width / 2, y: 0, width: p.width, height: 0 })),
    ...boxes,
    ...segments,
    ...notes,
    ...messages.map((m) => ({
      x: Math.min(m.x1, m.x2) - 12,
      y: 0,
      width: Math.abs(m.x2 - m.x1) + (m.self ? Math.max(SELF, 8 + linesWidth(m.lines)) : 0) + 24,
      height: 0,
    })),
  ];
  const left = Math.min(...shapes.map((s) => s.x));
  const right = Math.max(...shapes.map((s) => s.x + s.width));
  return {
    x: left - PAD,
    y: -PAD,
    width: right - left + PAD * 2,
    height: Math.max(bottom, ...boxes.map((b) => b.height)) + PAD * 2,
    participants,
    cardHeight,
    rows,
    lifeline: { y1: cardTop + cardHeight, y2: end },
    boxes,
    segments,
    activations,
    messages,
    notes,
  };
}
