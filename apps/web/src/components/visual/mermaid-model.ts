import type { Mermaid } from 'mermaid';
import { t } from '../../i18n';
import type { EdgeStyle, GraphSpec, NodeKind, NodeShape } from './graph-layout';

export type Cardinality = 'one' | 'zero-or-one' | 'one-or-more' | 'zero-or-more';
export type KeyKind = 'PK' | 'FK' | 'UK';

export interface ErAttribute {
  type: string;
  name: string;
  keys: KeyKind[];
  comment: string;
}
export interface ErEntity {
  /** The name the source gives it; relationships refer to it by this. */
  id: string;
  /** The alias in brackets, without the name when it starts with it. */
  alias?: string;
  attributes: ErAttribute[];
}
export interface ErRelationship {
  from: string;
  to: string;
  /** How many of `from` take part, drawn at its end. */
  fromCardinality: Cardinality;
  toCardinality: Cardinality;
  /** A solid line; a non-identifying one is dashed. */
  identifying: boolean;
  label: string;
}
export interface ErModel {
  entities: ErEntity[];
  relationships: ErRelationship[];
}

export type ParticipantType =
  'actor' | 'boundary' | 'collections' | 'control' | 'database' | 'entity' | 'queue';
export type MessageKind = 'sync' | 'async' | 'reply' | 'dotted';
export type SegmentKind = 'loop' | 'alt' | 'opt' | 'par' | 'rect' | 'critical' | 'break';

export interface Participant {
  id: string;
  title: string;
  /** The lines after the first of its label. */
  description?: string;
  /** Absent for a plain participant. */
  type?: ParticipantType;
}
export interface SequenceBox {
  label: string;
  participants: string[];
}
export type SequenceItem =
  | { item: 'message'; from: string; to: string; text: string; kind: MessageKind; number?: number }
  | {
      item: 'note';
      placement: 'left' | 'right' | 'over';
      /** One participant, or the first and last it spans. */
      participants: string[];
      text: string;
    }
  | { item: 'activate' | 'deactivate'; participant: string }
  | {
      item: 'segment';
      kind: SegmentKind;
      /** The first branch is the segment's own; `else`, `and` and `option` start the others. */
      branches: { label: string; items: SequenceItem[] }[];
    };
export interface SequenceModel {
  participants: Participant[];
  boxes: SequenceBox[];
  items: SequenceItem[];
  autonumber: boolean;
}

export type MermaidModel =
  | { type: 'er'; model: ErModel }
  | { type: 'sequence'; model: SequenceModel }
  | { type: 'flowchart' | 'state'; model: GraphSpec };

const HEADERS: Record<string, MermaidModel['type']> = {
  erDiagram: 'er',
  sequenceDiagram: 'sequence',
  flowchart: 'flowchart',
  graph: 'flowchart',
  stateDiagram: 'state',
};

/** What a flowchart or state diagram may use that Pantheon's graph cannot show; mermaid draws it. */
const UNSHOWN: readonly RegExp[] = [
  // State forks and joins, and concurrent regions.
  /<<(?:fork|join)>>|\[\[(?:fork|join)\]\]/,
  /^\s*--\s*$/m,
  // Icons and images on flowchart nodes.
  /\bfa[bklrs]?:fa-[\w-]/,
  /@\{[^}]*\b(?:icon|img)\s*:/,
];

/** The diagram's type when its first statement is a header Pantheon draws itself. */
export function nativeType(source: string): MermaidModel['type'] | undefined {
  const lines = source.split('\n');
  let at = 0;
  if (lines[0]?.trim() === '---') {
    at = lines.findIndex((line, i) => i > 0 && line.trim() === '---') + 1;
    if (at === 0) return undefined;
  }
  while (at < lines.length && (!lines[at]!.trim() || lines[at]!.trim().startsWith('%%'))) at++;
  const header = /^\s*(erDiagram|sequenceDiagram|flowchart|graph|stateDiagram)\b/.exec(
    lines[at] ?? '',
  )?.[1];
  const type = header === undefined ? undefined : HEADERS[header];
  const graph = type === 'flowchart' || type === 'state';
  return graph && UNSHOWN.some((feature) => feature.test(source)) ? undefined : type;
}

/** A label's lines: mermaid breaks lines with `<br>`; other markup is dropped. */
export const labelLines = (text: string): string[] =>
  text
    .split(/<br\s*\/?>|\n/i)
    .map((line) => line.replace(/<[^>]*>/g, '').trim())
    .filter((line) => line !== '');

const CARDINALITY: Record<string, Cardinality> = {
  ONLY_ONE: 'one',
  MD_PARENT: 'one',
  ZERO_OR_ONE: 'zero-or-one',
  ONE_OR_MORE: 'one-or-more',
  ZERO_OR_MORE: 'zero-or-more',
};

interface ErDb {
  getEntities(): Map<
    string,
    {
      id: string;
      alias: string;
      attributes: { type: string; name: string; keys?: KeyKind[]; comment?: string }[];
    }
  >;
  getRelationships(): {
    entityA: string;
    entityB: string;
    roleA: string;
    relSpec: { cardA: string; cardB: string; relType: string };
  }[];
}

function erModel(db: ErDb): ErModel {
  const entities = [...db.getEntities()];
  const named = new Map(entities.map(([name, entity]) => [entity.id, name]));
  return {
    entities: entities.map(([name, entity]) => {
      const alias = entity.alias
        .replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[·:|/-]\\s*`), '')
        .trim();
      return {
        id: name,
        ...(alias && alias !== name && { alias }),
        attributes: entity.attributes.map((a) => ({
          type: a.type,
          name: a.name,
          keys: a.keys ?? [],
          comment: a.comment ?? '',
        })),
      };
    }),
    // A relationship to a subgraph has no table to end on.
    relationships: db.getRelationships().flatMap((r) => {
      const [from, to] = [named.get(r.entityA), named.get(r.entityB)];
      if (from === undefined || to === undefined) return [];
      return [
        {
          from,
          to,
          // The parser keeps the left end's cardinality as `cardB`.
          fromCardinality: CARDINALITY[r.relSpec.cardB] ?? 'one',
          toCardinality: CARDINALITY[r.relSpec.cardA] ?? 'one',
          identifying: r.relSpec.relType === 'IDENTIFYING',
          label: labelLines(r.roleA).join(' '),
        },
      ];
    }),
  };
}

interface SequenceDb {
  LINETYPE: Record<string, number>;
  PLACEMENT: { LEFTOF: number; RIGHTOF: number; OVER: number };
  getActors(): Map<string, { name: string; description: string; type: string }>;
  getBoxes(): { name?: string; actorKeys: string[] }[];
  getMessages(): {
    from?: string;
    to?: string;
    message: string | { start?: number; step?: number; visible: boolean };
    type?: number;
    placement?: number;
  }[];
}

const TYPES: readonly string[] = [
  'actor',
  'boundary',
  'collections',
  'control',
  'database',
  'entity',
  'queue',
] satisfies ParticipantType[];

function sequenceModel(db: SequenceDb): SequenceModel {
  const L = db.LINETYPE;
  const kindOf = (type: number): MessageKind => {
    if (type === L.DOTTED) return 'reply';
    if (type === L.SOLID_POINT || type === L.DOTTED_POINT) return 'async';
    const name = Object.keys(L).find((key) => L[key] === type) ?? '';
    return name.includes('DOTTED') ? 'dotted' : 'sync';
  };
  const starts: Record<number, SegmentKind> = {
    [L.LOOP_START!]: 'loop',
    [L.ALT_START!]: 'alt',
    [L.OPT_START!]: 'opt',
    [L.PAR_START!]: 'par',
    [L.PAR_OVER_START!]: 'par',
    [L.RECT_START!]: 'rect',
    [L.CRITICAL_START!]: 'critical',
    [L.BREAK_START!]: 'break',
  };
  const branches = new Set([L.ALT_ELSE, L.PAR_AND, L.CRITICAL_OPTION]);
  const ends = new Set([
    L.LOOP_END,
    L.ALT_END,
    L.OPT_END,
    L.PAR_END,
    L.RECT_END,
    L.CRITICAL_END,
    L.BREAK_END,
  ]);
  const root: SequenceItem[] = [];
  const open: Extract<SequenceItem, { item: 'segment' }>[] = [];
  const into = () => open.at(-1)?.branches.at(-1)?.items ?? root;
  let numbering = null as { next: number; step: number } | null;
  let autonumber = false;
  for (const m of db.getMessages()) {
    const type = m.type ?? L.SOLID!;
    const text = typeof m.message === 'string' ? m.message : '';
    if (type === L.AUTONUMBER && typeof m.message === 'object') {
      numbering = m.message.visible
        ? { next: m.message.start ?? numbering?.next ?? 1, step: m.message.step ?? 1 }
        : null;
      autonumber ||= m.message.visible;
    } else if (type === L.NOTE) {
      const placement =
        m.placement === db.PLACEMENT.LEFTOF
          ? 'left'
          : m.placement === db.PLACEMENT.RIGHTOF
            ? 'right'
            : 'over';
      into().push({
        item: 'note',
        placement,
        participants: m.from === m.to ? [m.from!] : [m.from!, m.to!],
        text,
      });
    } else if (type === L.ACTIVE_START || type === L.ACTIVE_END) {
      into().push({
        item: type === L.ACTIVE_START ? 'activate' : 'deactivate',
        participant: m.from!,
      });
    } else if (starts[type]) {
      const segment: Extract<SequenceItem, { item: 'segment' }> = {
        item: 'segment',
        kind: starts[type],
        // A rect's text is its colour.
        branches: [{ label: type === L.RECT_START ? '' : text, items: [] }],
      };
      into().push(segment);
      open.push(segment);
    } else if (branches.has(type)) {
      open.at(-1)?.branches.push({ label: text, items: [] });
    } else if (ends.has(type)) {
      open.pop();
    } else if (m.from !== undefined && m.to !== undefined) {
      const message: SequenceItem = {
        item: 'message',
        from: m.from,
        to: m.to,
        text,
        kind: kindOf(type),
      };
      if (numbering) {
        message.number = numbering.next;
        numbering.next += numbering.step;
      }
      into().push(message);
    }
  }
  return {
    participants: [...db.getActors()].map(([id, actor]) => {
      const [title = id, ...rest] = labelLines(actor.description || actor.name);
      return {
        id,
        title,
        ...(rest.length > 0 && { description: rest.join(' ') }),
        ...(TYPES.includes(actor.type) && { type: actor.type as ParticipantType }),
      };
    }),
    boxes: db
      .getBoxes()
      .map((box) => ({ label: box.name ?? '', participants: [...box.actorKeys] })),
    items: root,
    autonumber,
  };
}

const KINDS: readonly string[] = [
  'client',
  'service',
  'store',
  'queue',
  'external',
  'policy',
] satisfies NodeKind[];
const kindOf = (classes: string[]) =>
  classes.find((c) => KINDS.includes(c)) as NodeKind | undefined;

// Mermaid's names for the diamond and for the cylinder shapes.
const DIAMONDS = new Set(['diamond', 'diam', 'decision', 'question']);
const CYLINDERS = new Set([
  'cylinder',
  'cyl',
  'db',
  'database',
  'h-cyl',
  'das',
  'horizontal-cylinder',
  'lin-cyl',
  'disk',
  'lined-cylinder',
]);

const directionOf = (dir: string | undefined): GraphSpec['direction'] =>
  dir === 'LR' || dir === 'RL'
    ? 'LR'
    : dir === 'TB' || dir === 'TD' || dir === 'BT'
      ? 'TB'
      : undefined;

/** A node with its first label line as its title and the others as its detail. */
function graphNode(
  id: string,
  lines: string[],
  more: { kind?: NodeKind | undefined; shape?: NodeShape | undefined; group?: string | undefined },
): GraphSpec['nodes'][number] {
  const [label = id, ...rest] = lines;
  return {
    id,
    label,
    ...(rest.length > 0 && { sublabel: rest.join(' ') }),
    ...(more.kind && { kind: more.kind }),
    ...(more.shape && { shape: more.shape }),
    ...(more.group !== undefined && { group: more.group }),
  };
}

/** The graph, with only the edges that end on a node or on a group with a node in it. */
function graphOf(
  nodes: GraphSpec['nodes'],
  edges: GraphSpec['edges'],
  groups: NonNullable<GraphSpec['groups']>,
  direction: GraphSpec['direction'],
): GraphSpec {
  const parents = new Map(groups.map((group) => [group.id, group.parent]));
  const ends = new Set(nodes.map((node) => node.id));
  for (const node of nodes)
    for (let at = node.group; at !== undefined && !ends.has(at); at = parents.get(at)) ends.add(at);
  return {
    nodes,
    edges: edges.filter((edge) => ends.has(edge.from) && ends.has(edge.to)),
    ...(groups.length > 0 && { groups }),
    ...(direction && { direction }),
  };
}

interface FlowDb {
  getDirection(): string | undefined;
  getVertices(): Map<string, { id: string; text?: string; type?: string; classes: string[] }>;
  getEdges(): { start: string; end: string; type?: string; stroke?: string; text: string }[];
  getSubGraphs(): { id: string; title: string; nodes: string[] }[];
}

const STROKES: Record<string, EdgeStyle> = { thick: 'main', dotted: 'async' };

/** Styles, link styles, clicks and class definitions other than the kinds are left out. */
function flowModel(db: FlowDb): GraphSpec {
  const subgraphs = db.getSubGraphs();
  const groupOf = new Map<string, string>();
  for (const subgraph of subgraphs)
    for (const member of subgraph.nodes) if (!groupOf.has(member)) groupOf.set(member, subgraph.id);
  const named = new Set(subgraphs.map((subgraph) => subgraph.id));
  const nodes = [...db.getVertices().values()]
    // An edge to a subgraph makes a vertex of its name too.
    .filter((vertex) => !named.has(vertex.id))
    .map((vertex) =>
      graphNode(vertex.id, labelLines(vertex.text ?? vertex.id), {
        kind: kindOf(vertex.classes) ?? (CYLINDERS.has(vertex.type ?? '') ? 'store' : undefined),
        shape: DIAMONDS.has(vertex.type ?? '') ? 'decision' : undefined,
        group: groupOf.get(vertex.id),
      }),
    );
  const edges = db.getEdges().flatMap((link): GraphSpec['edges'] => {
    if (link.stroke === 'invisible') return [];
    const label = labelLines(link.text).join(' ');
    const style = STROKES[link.stroke ?? ''];
    const edge = {
      from: link.start,
      to: link.end,
      ...(label && { label }),
      ...(style && { style }),
    };
    // A link with a head at each end is the edge both ways, which the graph draws as one.
    return link.type?.startsWith('double_')
      ? [edge, { ...edge, from: link.end, to: link.start }]
      : [edge];
  });
  const groups = subgraphs.map((subgraph) => {
    const parent = groupOf.get(subgraph.id);
    return {
      id: subgraph.id,
      label: labelLines(subgraph.title).join(' ') || subgraph.id,
      ...(parent !== undefined && { parent }),
    };
  });
  return graphOf(nodes, edges, groups, directionOf(db.getDirection()));
}

interface StateDb {
  getDirection(): string;
  getData(): {
    nodes: {
      id: string;
      shape: string;
      label?: string | string[];
      description?: string | string[];
      cssClasses: string;
      parentId?: string;
      isGroup?: boolean;
    }[];
    edges: { start: string; end: string; label?: string }[];
  };
}

const STATE_SHAPES: Record<string, NodeShape> = {
  stateStart: 'start',
  stateEnd: 'end',
  choice: 'decision',
};

/** Notes are left out; a composite state is a group. */
function stateModel(db: StateDb): GraphSpec {
  const data = db.getData();
  const shown = data.nodes.filter((node) => node.shape !== 'note' && node.shape !== 'noteGroup');
  const text = (value: string | string[] | undefined) => [value ?? []].flat();
  const nodes = shown
    .filter((node) => !node.isGroup)
    .map((node) => {
      const shape = STATE_SHAPES[node.shape];
      const lines =
        shape === 'start'
          ? [t({ id: 'visual.graph.start', defaultMessage: 'Start' })]
          : shape === 'end'
            ? [t({ id: 'visual.graph.end', defaultMessage: 'End' })]
            : [...text(node.label), ...text(node.description)].flatMap(labelLines);
      return graphNode(node.id, lines, {
        kind: kindOf(node.cssClasses.split(/\s+/)),
        shape,
        group: node.parentId,
      });
    });
  const groups = shown
    .filter((node) => node.isGroup)
    .map((node) => ({
      id: node.id,
      label: text(node.label).flatMap(labelLines).join(' ') || node.id,
      ...(node.parentId !== undefined && { parent: node.parentId }),
    }));
  const edges = data.edges.map((edge) => {
    const label = labelLines(edge.label ?? '').join(' ');
    return { from: edge.start, to: edge.end, ...(label && { label }) };
  });
  return graphOf(nodes, edges, groups, directionOf(db.getDirection()));
}

/**
 * Parses a diagram with mermaid's own parser into a plain model. A source mermaid cannot parse
 * throws mermaid's error.
 */
export async function parseMermaid(
  mermaid: Mermaid,
  source: string,
  type: MermaidModel['type'],
): Promise<MermaidModel> {
  const { db } = await mermaid.mermaidAPI.getDiagramFromText(source);
  switch (type) {
    case 'er':
      return { type, model: erModel(db as unknown as ErDb) };
    case 'sequence':
      return { type, model: sequenceModel(db as unknown as SequenceDb) };
    case 'flowchart':
      return { type, model: flowModel(db as unknown as FlowDb) };
    case 'state':
      return { type, model: stateModel(db as unknown as StateDb) };
  }
}
