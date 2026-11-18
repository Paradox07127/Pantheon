import type { Mermaid } from 'mermaid';
import { GRAPH_COLORS, GRAPH_STATUSES } from '@pantheon/protocol';
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

export interface UmlMember {
  visibility: '' | '+' | '-' | '#' | '~';
  /** A method's name has its parameters in parentheses. */
  name: string;
  /** An attribute's type, a method's return type; empty when the source gives none. */
  type: string;
  classifier?: 'static' | 'abstract';
}
export interface UmlClass {
  id: string;
  label: string;
  generic?: string;
  /** Such as `interface`, without the guillemets. */
  annotations: string[];
  attributes: UmlMember[];
  methods: UmlMember[];
  namespace?: string;
}
/** The mark where a relation meets a class. */
export type RelationEnd = 'inheritance' | 'composition' | 'aggregation' | 'arrow';
export type RelationKind =
  | 'inheritance'
  | 'realization'
  | 'composition'
  | 'aggregation'
  | 'association'
  | 'dependency'
  | 'link';
export interface UmlRelation {
  /** A triangle or diamond is at `from`: the parent or the whole. */
  from: string;
  to: string;
  kind: RelationKind;
  fromEnd?: RelationEnd;
  toEnd?: RelationEnd;
  dashed: boolean;
  label: string;
  fromCardinality?: string;
  toCardinality?: string;
}
export interface UmlNote {
  lines: string[];
  /** The class it is attached to; a note without one stands alone. */
  for?: string;
  namespace?: string;
}
export interface UmlNamespace {
  id: string;
  label: string;
  parent?: string;
}
export interface ClassModel {
  classes: UmlClass[];
  relations: UmlRelation[];
  notes: UmlNote[];
  namespaces: UmlNamespace[];
  /** Only when the source sets one. */
  direction?: 'LR' | 'RL' | 'TB' | 'BT';
}

export type MermaidModel =
  | { type: 'er'; model: ErModel }
  | { type: 'sequence'; model: SequenceModel }
  | { type: 'class'; model: ClassModel }
  | { type: 'flowchart' | 'state'; model: GraphSpec };

const HEADERS: Record<string, MermaidModel['type']> = {
  erDiagram: 'er',
  sequenceDiagram: 'sequence',
  classDiagram: 'class',
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
/** What a class diagram may use that Pantheon's class cards cannot show: lollipop interfaces. */
const CLASS_UNSHOWN: readonly RegExp[] = [/\(\)[ \t]*(?:--|\.\.)|(?:--|\.\.)[ \t]*\(\)/];

/** The diagram's type when its first statement is a header Pantheon draws itself. */
export function nativeType(source: string): MermaidModel['type'] | undefined {
  const lines = source.split('\n');
  let at = 0;
  if (lines[0]?.trim() === '---') {
    at = lines.findIndex((line, i) => i > 0 && line.trim() === '---') + 1;
    if (at === 0) return undefined;
  }
  while (at < lines.length && (!lines[at]!.trim() || lines[at]!.trim().startsWith('%%'))) at++;
  const header = /^\s*(erDiagram|sequenceDiagram|classDiagram|flowchart|graph|stateDiagram)\b/.exec(
    lines[at] ?? '',
  )?.[1];
  const type = header === undefined ? undefined : HEADERS[header];
  const unshown =
    type === 'class' ? CLASS_UNSHOWN : type === 'flowchart' || type === 'state' ? UNSHOWN : [];
  return unshown.some((feature) => feature.test(source)) ? undefined : type;
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

interface ClassDbMember {
  memberType: 'method' | 'attribute';
  visibility: UmlMember['visibility'];
  /** An attribute's whole text, a method's name. */
  id: string;
  classifier: string;
  parameters?: string;
  returnType?: string;
}
type ClassDbEnd = number | 'none';
interface ClassDb {
  relationType: { AGGREGATION: number; EXTENSION: number; COMPOSITION: number; DEPENDENCY: number };
  lineType: { DOTTED_LINE: number };
  getDirection(): string;
  getClasses(): Map<
    string,
    {
      id: string;
      label: string;
      type: string;
      annotations: string[];
      members: ClassDbMember[];
      methods: ClassDbMember[];
      parent?: string;
    }
  >;
  getRelations(): {
    id1: string;
    id2: string;
    relationTitle1: string;
    relationTitle2: string;
    title?: string;
    relation: { type1: ClassDbEnd; type2: ClassDbEnd; lineType: number };
  }[];
  getNotes(): Map<string, { class?: string; text: string; parent?: string }>;
  getNamespaces(): Map<string, { id: string; label: string; parent?: string }>;
}

const CLASSIFIERS: Record<string, UmlMember['classifier']> = { $: 'static', '*': 'abstract' };
/** Mermaid writes a generic between tildes. */
const generics = (text: string) => text.replace(/~([^~]*)~/g, '<$1>');

/** An attribute is `type name` or `name: type`. */
function umlMember(member: ClassDbMember): UmlMember {
  let [name, type] = [`${member.id}(${member.parameters ?? ''})`, member.returnType ?? ''];
  if (member.memberType === 'attribute') {
    const text = member.id.trim();
    const colon = text.indexOf(':');
    const space = text.lastIndexOf(' ');
    [name, type] =
      colon >= 0
        ? [text.slice(0, colon).trim(), text.slice(colon + 1).trim()]
        : space >= 0
          ? [text.slice(space + 1), text.slice(0, space).trim()]
          : [text, ''];
  }
  const classifier = CLASSIFIERS[member.classifier];
  return {
    visibility: member.visibility,
    name: generics(name),
    type: generics(type),
    ...(classifier && { classifier }),
  };
}

/** Styles, class definitions, clicks and links are left out. */
function classModel(db: ClassDb, source: string): ClassModel {
  const R = db.relationType;
  const ends: Record<number, RelationEnd> = {
    [R.EXTENSION]: 'inheritance',
    [R.COMPOSITION]: 'composition',
    [R.AGGREGATION]: 'aggregation',
    [R.DEPENDENCY]: 'arrow',
  };
  const endOf = (type: ClassDbEnd) => (type === 'none' ? undefined : ends[type]);
  const cardinality = (title: string) => (title && title !== 'none' ? title : undefined);
  const classes = [...db.getClasses().values()];
  const parents = new Map(classes.map((c) => [c.id, c.parent]));
  return {
    classes: classes.map((c) => ({
      id: c.id,
      label: labelLines(c.label).join(' ') || c.id,
      ...(c.type && { generic: generics(c.type) }),
      annotations: [...c.annotations],
      attributes: c.members.map(umlMember),
      methods: c.methods.map(umlMember),
      ...(c.parent !== undefined && { namespace: c.parent }),
    })),
    relations: db.getRelations().map((r) => {
      let ends = [
        { id: r.id1, end: endOf(r.relation.type1), cardinality: cardinality(r.relationTitle1) },
        { id: r.id2, end: endOf(r.relation.type2), cardinality: cardinality(r.relationTitle2) },
      ];
      // A relation runs from its triangle or diamond, so a parent or whole lays out first.
      if (!ends[0]!.end && ends[1]!.end && ends[1]!.end !== 'arrow') ends = ends.reverse();
      const [from, to] = ends as [(typeof ends)[number], (typeof ends)[number]];
      const dashed = r.relation.lineType === db.lineType.DOTTED_LINE;
      const marks = [from.end, to.end];
      const kind: RelationKind = marks.includes('inheritance')
        ? dashed
          ? 'realization'
          : 'inheritance'
        : marks.includes('composition')
          ? 'composition'
          : marks.includes('aggregation')
            ? 'aggregation'
            : marks.includes('arrow')
              ? dashed
                ? 'dependency'
                : 'association'
              : 'link';
      return {
        from: from.id,
        to: to.id,
        kind,
        ...(from.end && { fromEnd: from.end }),
        ...(to.end && { toEnd: to.end }),
        dashed,
        label: labelLines(r.title ?? '').join(' '),
        ...(from.cardinality && { fromCardinality: from.cardinality }),
        ...(to.cardinality && { toCardinality: to.cardinality }),
      };
    }),
    notes: [...db.getNotes().values()].map((note) => {
      const namespace = note.parent ?? (note.class && parents.get(note.class));
      return {
        // Mermaid breaks a note's lines at a written `\n`.
        lines: labelLines(note.text.replace(/\\n/g, '\n')),
        ...(note.class && { for: note.class }),
        ...(namespace && { namespace }),
      };
    }),
    namespaces: [...db.getNamespaces().values()].map((namespace) => ({
      id: namespace.id,
      label: labelLines(namespace.label).join(' ') || namespace.id,
      ...(namespace.parent !== undefined && { parent: namespace.parent }),
    })),
    // Mermaid gives a direction whether or not the source sets one.
    ...(/^\s*direction\s/m.test(source) && {
      direction: db.getDirection() as NonNullable<ClassModel['direction']>,
    }),
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
/** The first class that names one of `names`, which Pantheon defines as it does the kinds. */
const namedBy =
  <T extends string>(names: readonly T[]) =>
  (classes: string[]) =>
    classes.find((c): c is T => (names as readonly string[]).includes(c));
const statusOf = namedBy(GRAPH_STATUSES);
const colorOf = namedBy(GRAPH_COLORS);

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
  more: {
    kind?: NodeKind | undefined;
    shape?: NodeShape | undefined;
    group?: string | undefined;
    classes: string[];
  },
): GraphSpec['nodes'][number] {
  const status = statusOf(more.classes);
  const color = colorOf(more.classes);
  const [label = id, ...rest] = lines;
  return {
    id,
    label,
    ...(rest.length > 0 && { sublabel: rest.join(' ') }),
    ...(more.kind && { kind: more.kind }),
    ...(more.shape && { shape: more.shape }),
    ...(status && { status }),
    ...(color && { color }),
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
        classes: vertex.classes,
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
  getRootDocV2(): { doc?: { stmt: string }[] };
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
      const classes = node.cssClasses.split(/\s+/);
      return graphNode(node.id, lines, {
        kind: kindOf(classes),
        shape,
        group: node.parentId,
        classes,
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
  // Mermaid gives a direction whether or not the source sets one at the top.
  const set = db.getRootDocV2().doc?.some((statement) => statement.stmt === 'dir');
  return graphOf(nodes, edges, groups, set ? directionOf(db.getDirection()) : undefined);
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
    case 'class':
      return { type, model: classModel(db as unknown as ClassDb, source) };
    case 'flowchart':
      return { type, model: flowModel(db as unknown as FlowDb) };
    case 'state':
      return { type, model: stateModel(db as unknown as StateDb) };
  }
}
