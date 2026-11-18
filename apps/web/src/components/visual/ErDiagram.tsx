import { useState } from 'react';
import { t } from '../../i18n';
import {
  TABLE,
  cardinalityMarks,
  roundedPath,
  type ErLayout,
  type ErLine,
  type ErTable,
} from './mermaid-layout';
import './native-diagram.css';

/** The table card's corner, `--r-md`. */
export const RADIUS = 10;
const BADGE = { inset: 8, height: TABLE.badge } as const;

/** Hover focus: the hovered table's relationships stand out, tables off them dim. */
type Focus = 'on' | 'dim' | undefined;

/** A band `height` high at `y` with its top or bottom corners rounded to the card's. */
export function band(x: number, y: number, width: number, height: number, round: 'top' | 'bottom') {
  const r = RADIUS;
  return round === 'top'
    ? `M${x} ${y + height}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + width - r}Q${x + width} ${y} ${x + width} ${y + r}V${y + height}Z`
    : `M${x} ${y}H${x + width}V${y + height - r}Q${x + width} ${y + height} ${x + width - r} ${y + height}H${x + r}Q${x} ${y + height} ${x} ${y + height - r}Z`;
}

function Table({
  table,
  focus,
  onHover,
}: {
  table: ErTable;
  focus: Focus;
  onHover: (id: string | null) => void;
}) {
  const { x, y, width, height, entity, nameAt } = table;
  const last = entity.attributes.length - 1;
  return (
    <g
      className="vis-er-t"
      data-focus={focus}
      onMouseEnter={() => onHover(entity.id)}
      onMouseLeave={() => onHover(null)}
    >
      <rect className="vis-er-bg" x={x} y={y} width={width} height={height} rx={RADIUS} />
      {last < 0 ? (
        <rect className="vis-er-hd" x={x} y={y} width={width} height={height} rx={RADIUS} />
      ) : (
        <path className="vis-er-hd" d={band(x, y, width, TABLE.head, 'top')} />
      )}
      <text className="vis-er-n" x={x + TABLE.side} y={y + TABLE.head / 2}>
        {entity.id}
        {entity.alias && (
          <tspan className="vis-er-al" dx={6}>
            {entity.alias}
          </tspan>
        )}
      </text>
      {entity.attributes.map((attribute, i) => {
        const top = y + TABLE.head + i * TABLE.row;
        const middle = top + TABLE.row / 2;
        const keys = attribute.keys.join(',');
        const badge = Math.max(28, nameAt - BADGE.inset * 2);
        return (
          <g key={i}>
            {attribute.comment && <title>{attribute.comment}</title>}
            {i % 2 === 1 &&
              (i === last ? (
                <path className="vis-er-z" d={band(x, top, width, TABLE.row, 'bottom')} />
              ) : (
                <rect className="vis-er-z" x={x} y={top} width={width} height={TABLE.row} />
              ))}
            {keys && (
              <>
                <rect
                  className="vis-er-k"
                  x={x + BADGE.inset}
                  y={middle - BADGE.height / 2}
                  width={badge}
                  height={BADGE.height}
                  rx={5}
                />
                <text className="vis-er-kt" x={x + BADGE.inset + badge / 2} y={middle}>
                  {keys}
                </text>
              </>
            )}
            <text className="vis-er-c" x={x + nameAt} y={middle}>
              {attribute.name}
            </text>
            <text className="vis-er-ty" x={x + width - TABLE.side} y={middle}>
              {attribute.type}
            </text>
          </g>
        );
      })}
      <rect className="vis-er-ln" x={x} y={y} width={width} height={height} rx={RADIUS} />
      {last >= 0 && <path className="vis-er-sep" d={`M${x} ${y + TABLE.head}H${x + width}`} />}
    </g>
  );
}

function Relationship({ line, focus }: { line: ErLine; focus: Focus }) {
  const { points, relationship, label_box: box } = line;
  if (points.length < 2) return null;
  const n = points.length;
  const ends = [
    cardinalityMarks(points[0]!, points[1]!, relationship.fromCardinality),
    cardinalityMarks(points[n - 1]!, points[n - 2]!, relationship.toCardinality),
  ];
  const cardinalities = [relationship.fromCardinality, relationship.toCardinality];
  return (
    <g className="vis-er-r" data-focus={focus} data-identifying={relationship.identifying}>
      <path className="vis-er-p" d={roundedPath(points)} />
      {ends.map((mark, i) => (
        <g key={i} data-cardinality={cardinalities[i]}>
          <path className="vis-er-m" d={mark.path} />
          {mark.circle && (
            <circle className="vis-er-o" cx={mark.circle.x} cy={mark.circle.y} r={4} />
          )}
        </g>
      ))}
      {box && relationship.label && (
        <g className="vis-nd-lb">
          <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={5} />
          <text x={box.x + box.width / 2} y={box.y + box.height / 2}>
            {relationship.label}
          </text>
        </g>
      )}
    </g>
  );
}

/** An ER diagram drawn from mermaid's parse: table cards joined by crow's-foot lines. */
export function ErDiagram({ id, layout, scale }: { id: string; layout: ErLayout; scale: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const touches = (line: ErLine) =>
    line.relationship.from === hover || line.relationship.to === hover;
  const near = hover
    ? new Set(
        layout.lines
          .filter(touches)
          .flatMap((line) => [line.relationship.from, line.relationship.to]),
      ).add(hover)
    : null;
  return (
    <svg
      className="vis-nd-svg"
      role="img"
      aria-label={t(
        {
          id: 'visual.mermaid.er',
          defaultMessage:
            '{tables, plural, one {# table} other {# tables}}, {relationships, plural, one {# relationship} other {# relationships}}',
        },
        { tables: layout.tables.length, relationships: layout.lines.length },
      )}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width * scale}
      height={layout.height * scale}
    >
      <defs>
        <pattern id={`${id}-dots`} width={16} height={16} patternUnits="userSpaceOnUse">
          <rect className="vis-nd-dot" width={1} height={1} />
        </pattern>
      </defs>
      <rect width={layout.width} height={layout.height} fill={`url(#${id}-dots)`} />
      {layout.lines.map((line, i) => (
        <Relationship
          key={i}
          line={line}
          focus={hover ? (touches(line) ? 'on' : 'dim') : undefined}
        />
      ))}
      {layout.tables.map((table) => (
        <Table
          key={table.entity.id}
          table={table}
          focus={near && !near.has(table.entity.id) ? 'dim' : undefined}
          onHover={setHover}
        />
      ))}
    </svg>
  );
}
