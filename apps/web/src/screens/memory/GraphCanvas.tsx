import { useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Diamond, File, FileText, Globe, Hash, MessageSquare, StickyNote } from 'lucide-react';
import { t } from '../../i18n';
import { nextNode, type ArrowKey } from './graph-focus';
import type { GraphEdge, GraphLayout, LaidNode } from './graph-layout';
import './memory-graph.css';
import './memory-graph-interact.css';

export interface GraphCanvasProps {
  layout: GraphLayout;
  selected: string | null;
  /** The nodes in the focused neighbourhood; null when nothing is focused. */
  near: ReadonlySet<string> | null;
  /** Search words; the matching parts of titles are marked. */
  query: string;
  zoom: number;
  onSelect: (id: string) => void;
  /** What the drawing shows, read out in place of it. */
  summary?: string;
  /** An arrow key reached this node; the focus moves there too. */
  onMove?: (id: string) => void;
  /** The card shown beside the hovered or keyboard-focused node; `id` names it for aria-describedby. */
  card?: (node: LaidNode, id: string) => ReactNode;
  /** Escape, or a click on the canvas outside the nodes, lets the selection go. */
  onClear?: () => void;
}

const KEYS = new Set<string>(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
// The card's place from the node's top right corner.
const CARD_GAP = 8;
const CARD_RISE = 16;
let cardSeq = 0;

const KINDS = {
  decision: {
    icon: Diamond,
    get label() {
      return t({ id: 'memory.graph.kind.decision', defaultMessage: 'Decision' });
    },
  },
  report: {
    icon: FileText,
    get label() {
      return t({ id: 'memory.graph.kind.report', defaultMessage: 'Report' });
    },
  },
  note: {
    icon: StickyNote,
    get label() {
      return t({ id: 'memory.graph.kind.note', defaultMessage: 'Note' });
    },
  },
  file: {
    icon: File,
    get label() {
      return t({ id: 'memory.graph.kind.file', defaultMessage: 'File source' });
    },
  },
  url: {
    icon: Globe,
    get label() {
      return t({ id: 'memory.graph.kind.url', defaultMessage: 'Web source' });
    },
  },
  session: {
    icon: MessageSquare,
    get label() {
      return t({ id: 'memory.graph.kind.session', defaultMessage: 'Session source' });
    },
  },
  tag: {
    icon: Hash,
    get label() {
      return t({ id: 'memory.graph.kind.tag', defaultMessage: 'Tag' });
    },
  },
};

const STATES = {
  get active() {
    return t({ id: 'memory.graph.state.active', defaultMessage: 'Current' });
  },
  get draft() {
    return t({ id: 'memory.graph.state.draft', defaultMessage: 'Pending review' });
  },
  get archived() {
    return t({ id: 'memory.graph.state.archived', defaultMessage: 'Archived' });
  },
};

const LINE: Record<GraphEdge['kind'], string> = {
  depends_on: 'mg-dep',
  supersedes: 'mg-sup',
  restored_from: 'mg-res',
  source: 'mg-src',
  tagged: 'mg-src',
};

const ARROWS = [
  ['mg-arrow', 'mg-ah'],
  ['mg-arrow-hot', 'mg-ah mg-hot'],
  ['mg-arrow-out', 'mg-ah mg-out'],
] as const;

/** The label with every match of the query wrapped in mark. */
function marked(label: string, query: string): ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return label;
  const low = label.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, at)) {
    if (i > at) parts.push(label.slice(at, i));
    parts.push(<mark key={i}>{label.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (!parts.length) return label;
  if (at < label.length) parts.push(label.slice(at));
  return parts;
}

const kindOf = (n: LaidNode) => (n.kind === 'source' ? (n.source_kind ?? 'file') : n.kind);

/** The memory graph as laid out: links underneath and one button per node. */
export function GraphCanvas(p: GraphCanvasProps) {
  const { layout, near } = p;
  const [hover, setHover] = useState<string | null>(null);
  // The node the keyboard last reached, and the one showing a focus ring now.
  const [reached, setReached] = useState<string | null>(null);
  const [ringed, setRinged] = useState<string | null>(null);
  // Not useId: the canvas tests drive it without a React renderer.
  const [cardId] = useState(() => `mg-card-${++cardSeq}`);
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const has = (id: string | null) => layout.nodes.some((n) => n.id === id);
  const stop = has(p.selected) ? p.selected : has(reached) ? reached : layout.nodes[0]?.id;
  const shown = layout.nodes.find((n) => n.id === (hover ?? ringed));
  const move = (e: KeyboardEvent<HTMLButtonElement>, from: string) => {
    if (!KEYS.has(e.key)) return;
    e.preventDefault();
    const to = nextNode(layout, from, e.key as ArrowKey);
    if (!to) return;
    p.onMove?.(to);
    buttons.current.get(to)?.focus();
  };
  const focus = (e: FocusEvent<HTMLButtonElement>, id: string) => {
    setReached(id);
    setRinged(e.currentTarget.matches(':focus-visible') ? id : null);
  };
  const node = (n: LaidNode) => {
    const kind = kindOf(n);
    const pill = n.kind === 'source' || n.kind === 'tag';
    const Icon = KINDS[kind].icon;
    const label = pill
      ? t(
          { id: 'memory.graph.attachment', defaultMessage: '{kind}: {title}' },
          { kind: KINDS[kind].label, title: n.label },
        )
      : t(
          { id: 'memory.graph.node', defaultMessage: '{kind}: {title}, {state}' },
          { kind: KINDS[kind].label, title: n.label, state: STATES[n.state ?? 'active'] },
        );
    const className = [
      pill ? 'mg-ms' : 'mg-mn',
      n.kind === 'tag' && 'mg-tag',
      n.state === 'draft' && 'mg-dr',
      n.state === 'archived' && 'mg-ar',
      near && !near.has(n.id) && 'mg-out',
    ]
      .filter(Boolean)
      .join(' ');
    return (
      <button
        key={n.id}
        type="button"
        className={className}
        style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
        tabIndex={n.id === stop ? 0 : -1}
        aria-pressed={n.id === p.selected}
        aria-label={label}
        aria-describedby={p.card && n.id === shown?.id ? cardId : undefined}
        ref={(el) => {
          buttons.current.set(n.id, el);
        }}
        onClick={() => p.onSelect(n.id)}
        onKeyDown={(e) => move(e, n.id)}
        onFocus={(e) => focus(e, n.id)}
        onBlur={() => setRinged(null)}
        onPointerEnter={() => setHover(n.id)}
        onPointerLeave={() => setHover(null)}
      >
        {n.kind === 'tag' ? (
          <span className="mg-tg">
            <Icon aria-hidden="true" />
          </span>
        ) : (
          <Icon aria-hidden="true" />
        )}
        <span className={kind === 'file' ? 'mg-l mg-mono' : 'mg-l'}>
          {marked(n.label, p.query)}
        </span>
        {n.state === 'draft' && <span className="mg-wait" aria-hidden="true" />}
      </button>
    );
  };
  return (
    <section
      className="mg-view"
      aria-label={t({ id: 'memory.graph.label', defaultMessage: 'Knowledge graph' })}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && p.selected !== null) p.onClear?.();
      }}
      onClick={(e) => {
        if (!(e.target as Element).closest('button, .mgi-at')) p.onClear?.();
      }}
    >
      <div
        className="mg-plane"
        style={{ width: layout.width * p.zoom, height: layout.height * p.zoom }}
      >
        <div
          className="mg-stage"
          style={{ width: layout.width, height: layout.height, transform: `scale(${p.zoom})` }}
        >
          <svg
            className="mg-edges"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            {...(p.summary ? { role: 'img', 'aria-label': p.summary } : { 'aria-hidden': 'true' })}
          >
            <defs>
              {ARROWS.map(([id, className]) => (
                <marker
                  key={id}
                  id={id}
                  viewBox="0 0 8 8"
                  refX="7.5"
                  refY="4"
                  markerWidth="8"
                  markerHeight="8"
                  markerUnits="userSpaceOnUse"
                  orient="auto"
                >
                  <path className={className} d="M0 .5 L7.5 4 L0 7.5z" />
                </marker>
              ))}
            </defs>
            {layout.edges.map((e) => {
              const shade = near ? (near.has(e.from) && near.has(e.to) ? 'hot' : 'out') : null;
              const plain = e.kind === 'source' || e.kind === 'tagged';
              return (
                <path
                  key={e.id}
                  className={['mg-ed', LINE[e.kind], shade && `mg-${shade}`]
                    .filter(Boolean)
                    .join(' ')}
                  d={e.d}
                  markerEnd={
                    plain ? undefined : `url(#${shade ? `mg-arrow-${shade}` : 'mg-arrow'})`
                  }
                />
              );
            })}
          </svg>
          {layout.nodes.map(node)}
          {shown && p.card && (
            <div
              key={shown.id}
              className="mgi-at"
              style={{ left: shown.x + shown.w + CARD_GAP, top: shown.y - CARD_RISE }}
            >
              {p.card(shown, cardId)}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
