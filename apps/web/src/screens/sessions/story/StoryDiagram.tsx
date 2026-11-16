import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type {
  DecisionDiagram,
  FlowDiagram,
  StoryCard,
  TypeDiagram,
  UiSketch,
} from '@pantheon/domain';
import {
  decisionStatus,
  elementStatus,
  layoutFlow,
  typeRows,
  type ElementStatus,
  type StoryView,
} from './story-diagram';
import { t } from '../../../i18n';

type Diagram = NonNullable<StoryCard['diagram']>;

interface Marks {
  inferred: Set<string>;
  hunks: Record<string, string>;
  onHunk?: ((hunkId: string) => void) | undefined;
}

const MARKER_TONES = ['added', 'removed', 'same'] as const;

const beforeText = () => t({ id: 'sessions.panel.diagram.before', defaultMessage: 'Before' });
const afterText = () => t({ id: 'sessions.panel.diagram.after', defaultMessage: 'After' });

const shown = (label: string, inferred: boolean) => (inferred ? `${label}?` : label);

// Props that make an element jump to its hunk; empty when the element has none.
function hunkTarget(marks: Marks, key: string, label: string) {
  const hunk = Object.hasOwn(marks.hunks, key) ? marks.hunks[key] : undefined;
  if (hunk === undefined || !marks.onHunk) return {};
  const open = () => marks.onHunk!(hunk);
  return {
    role: 'button',
    tabIndex: 0,
    'aria-label': t(
      { id: 'sessions.panel.diagram.hunk', defaultMessage: 'Change {hunk} of {label}' },
      { label, hunk },
    ),
    'data-hunk': '',
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      open();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      open();
    },
  };
}

type Box = { x: number; y: number; width: number; height: number };

function edgePath(a: Box, b: Box): { d: string; lx: number; ly: number } {
  if (a === b) {
    const x1 = a.x + a.width / 3;
    const x2 = a.x + (2 * a.width) / 3;
    const y = a.y + a.height;
    const low = y + 28;
    return {
      d: `M${x1},${y} C${x1},${low} ${x2},${low} ${x2},${y}`,
      lx: a.x + a.width / 2,
      ly: low - 6,
    };
  }
  if (b.x > a.x) {
    const x1 = a.x + a.width;
    const y1 = a.y + a.height / 2;
    const x2 = b.x;
    const y2 = b.y + b.height / 2;
    const mx = (x1 + x2) / 2;
    return { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, lx: mx, ly: (y1 + y2) / 2 };
  }
  const x1 = a.x + a.width / 2;
  const x2 = b.x + b.width / 2;
  if (b.x === a.x) {
    const down = b.y > a.y;
    const y1 = down ? a.y + a.height : a.y;
    const y2 = down ? b.y : b.y + b.height;
    return { d: `M${x1},${y1} L${x2},${y2}`, lx: x1, ly: (y1 + y2) / 2 };
  }
  // A back edge loops under both nodes.
  const y1 = a.y + a.height;
  const y2 = b.y + b.height;
  const low = Math.max(y1, y2) + 28;
  return {
    d: `M${x1},${y1} C${x1},${low} ${x2},${low} ${x2},${y2}`,
    lx: (x1 + x2) / 2,
    ly: low - 6,
  };
}

function Flow({ spec, view, marks }: { spec: FlowDiagram; view: StoryView; marks: Marks }) {
  const layout = useMemo(() => layoutFlow(spec), [spec]);
  const markerId = useId();
  const boxes = new Map(layout.nodes.map((n) => [n.id, n]));
  const status = new Map(spec.nodes.map((n) => [n.id, elementStatus(n.side, view)]));
  const names = new Map(spec.nodes.map((n) => [n.id, n.label]));
  return (
    <div className="sd-cv">
      <svg
        className="sd-flow"
        viewBox={`0 0 ${layout.width} ${layout.height + 8}`}
        style={{ maxWidth: layout.width }}
        role="group"
        aria-label={spec.title}
      >
        <defs>
          {MARKER_TONES.map((tone) => (
            <marker
              key={tone}
              id={`${markerId}-${tone}`}
              className={`sd-mk ${tone}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L10,5 L0,10 z" />
            </marker>
          ))}
        </defs>
        {layout.lanes.map((lane, i) => (
          <g key={lane.name} className={i % 2 ? 'sd-lane alt' : 'sd-lane'}>
            <rect x={0} y={lane.y} width={layout.width} height={lane.height} />
            <text x={10} y={lane.y + 16}>
              {lane.name}
            </text>
          </g>
        ))}
        {spec.edges.map((e, i) => {
          const tone = elementStatus(e.side, view);
          const a = boxes.get(e.from);
          const b = boxes.get(e.to);
          const ends = [e.from, e.to].map((id) => status.get(id));
          if (tone === 'hidden' || !a || !b || ends.includes('hidden')) return null;
          const path = edgePath(a, b);
          const name = t(
            { id: 'sessions.panel.diagram.edge', defaultMessage: '{from} to {to}' },
            { from: names.get(e.from), to: names.get(e.to) },
          );
          return (
            <g
              key={i}
              className={`sd-e ${tone}`}
              role="img"
              aria-label={
                e.label
                  ? t(
                      {
                        id: 'sessions.panel.diagram.edgeLabel',
                        defaultMessage: '{name}: {label}',
                      },
                      { name, label: e.label },
                    )
                  : name
              }
            >
              <path d={path.d} markerEnd={`url(#${markerId}-${tone})`} />
              {e.label && (
                <text x={path.lx} y={path.ly - 4} textAnchor="middle">
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {spec.nodes.map((n) => {
          const tone = status.get(n.id)!;
          const box = boxes.get(n.id)!;
          if (tone === 'hidden') return null;
          const inferred = marks.inferred.has(n.id);
          const label = shown(n.label, inferred);
          return (
            <g
              key={n.id}
              className={`sd-n ${tone}${inferred ? ' inf' : ''}`}
              {...hunkTarget(marks, n.id, label)}
            >
              <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={6} />
              <foreignObject x={box.x} y={box.y} width={box.width} height={box.height}>
                <div className="sd-nl">{label}</div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Decision({ spec, view, marks }: { spec: DecisionDiagram; view: StoryView; marks: Marks }) {
  return (
    <table className="sd-tbl" aria-label={spec.title}>
      <thead>
        <tr>
          <th scope="col">{t({ id: 'sessions.panel.diagram.case', defaultMessage: 'Case' })}</th>
          {view !== 'after' && <th scope="col">{beforeText()}</th>}
          {view !== 'before' && <th scope="col">{afterText()}</th>}
        </tr>
      </thead>
      <tbody>
        {spec.rows.map((row, i) => {
          const key = String(i);
          const inferred = marks.inferred.has(key);
          const label = shown(row.case, inferred);
          const tone = decisionStatus(row);
          return (
            <tr key={i} className={`${tone}${inferred ? ' inf' : ''}`}>
              <th scope="row">
                <span {...hunkTarget(marks, key, label)}>{label}</span>
              </th>
              {view !== 'after' && <td>{row.before}</td>}
              {view !== 'before' && <td className="sd-to">{row.after}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TypeBox({ spec, view, marks }: { spec: TypeDiagram; view: StoryView; marks: Marks }) {
  const rows = typeRows(spec);
  return (
    <div className="sd-type" role="group" aria-label={spec.name}>
      <div className="sd-th">{spec.name}</div>
      <div className="sd-fields">
        {rows.map((row) => {
          const type = view === 'before' ? row.before : view === 'after' ? row.after : null;
          if (view !== 'overlay' && type === undefined) return null;
          const keys = spec.fields.flatMap((f, i) =>
            f.name === row.name && elementStatus(f.side, view) !== 'hidden' ? [String(i)] : [],
          );
          const inferred = keys.some((k) => marks.inferred.has(k));
          const label = shown(row.name, inferred);
          const key = keys.find((k) => marks.hunks[k] !== undefined) ?? keys[0]!;
          const tone = view === 'overlay' ? row.status : 'same';
          const text =
            type ??
            (row.status === 'changed' ? `${row.before} → ${row.after}` : (row.after ?? row.before));
          return (
            <div
              key={row.name}
              className={`sd-f ${tone}${inferred ? ' inf' : ''}`}
              {...hunkTarget(marks, key, label)}
            >
              {label}: {text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Sketch({ spec, view, marks }: { spec: UiSketch; view: StoryView; marks: Marks }) {
  const children = new Map<string | undefined, UiSketch['regions']>();
  for (const r of spec.regions) children.set(r.parent, [...(children.get(r.parent) ?? []), r]);
  const region = (r: UiSketch['regions'][number]): ReactNode => {
    const tone: ElementStatus = elementStatus(r.side, view);
    if (tone === 'hidden') return null;
    const inferred = marks.inferred.has(r.id);
    const label = shown(r.label, inferred);
    const inner = children.get(r.id) ?? [];
    const target = hunkTarget(marks, r.id, label);
    // The label is the button, so a region's button never holds its children's.
    return (
      <div
        key={r.id}
        className={`sd-r ${tone}${inferred ? ' inf' : ''}${inner.length ? '' : ' leaf'}`}
        data-hunk={target['data-hunk']}
        onClick={target.onClick}
      >
        <span className="sd-rl" {...target}>
          {label}
        </span>
        {inner.length > 0 && <div className="sd-rc">{inner.map(region)}</div>}
      </div>
    );
  };
  return (
    <div className="sd-ui" role="group" aria-label={spec.title}>
      {(children.get(undefined) ?? []).map(region)}
    </div>
  );
}

export function StoryDiagram({
  diagram,
  onHunk,
}: {
  diagram: Diagram;
  onHunk?: (hunkId: string) => void;
}) {
  const [view, setView] = useState<StoryView>('overlay');
  const inferred = useMemo(() => new Set(diagram.inferred), [diagram.inferred]);
  const marks: Marks = { inferred, hunks: diagram.hunks, onHunk };
  const { spec } = diagram;
  return (
    <div className="sd">
      <RadioGroup<StoryView>
        className="seg sd-views"
        aria-label={t({ id: 'sessions.panel.diagram.views', defaultMessage: 'Diagram view' })}
        value={view}
        onValueChange={(value) => setView(value)}
      >
        <Radio.Root value="before">{beforeText()}</Radio.Root>
        <Radio.Root value="after">{afterText()}</Radio.Root>
        <Radio.Root value="overlay">
          {t({ id: 'sessions.panel.diagram.overlay', defaultMessage: 'Overlay' })}
        </Radio.Root>
      </RadioGroup>
      {spec.type === 'flow' ? (
        <Flow spec={spec} view={view} marks={marks} />
      ) : spec.type === 'decision' ? (
        <Decision spec={spec} view={view} marks={marks} />
      ) : spec.type === 'type' ? (
        <TypeBox spec={spec} view={view} marks={marks} />
      ) : (
        <Sketch spec={spec} view={view} marks={marks} />
      )}
    </div>
  );
}
