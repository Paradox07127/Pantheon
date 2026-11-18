import { t } from '../../i18n';
import { RADIUS, band } from './ErDiagram';
import {
  CLASS,
  cardinalityAt,
  pillWidth,
  relationMark,
  roundedPath,
  type ClassCard,
  type ClassLayout,
  type ClassLine,
} from './mermaid-layout';
import type { UmlMember } from './mermaid-model';
import './native-diagram.css';

const LINE = 16;
const TAG = 18;

function Members({ card, members, top }: { card: ClassCard; members: UmlMember[]; top: number }) {
  const { x, width, nameAt } = card;
  return (
    <>
      <path className="vis-er-sep" d={`M${x} ${top}H${x + width}`} />
      {members.map((member, i) => {
        const middle = top + CLASS.pad + i * CLASS.row + CLASS.row / 2;
        return (
          <g key={i}>
            {member.visibility && (
              <text className="vis-cl-v" x={x + CLASS.side} y={middle}>
                {member.visibility}
              </text>
            )}
            <text
              className="vis-cl-mn"
              data-classifier={member.classifier}
              x={x + nameAt}
              y={middle}
            >
              {member.name}
            </text>
            {member.type && (
              <text className="vis-er-ty" x={x + width - CLASS.side} y={middle}>
                {member.type}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

function Card({ card }: { card: ClassCard }) {
  const { x, y, width, height, uml, tag } = card;
  const methodsAt =
    y +
    CLASS.head +
    (uml.attributes.length ? CLASS.pad * 2 + uml.attributes.length * CLASS.row : 0);
  const sections = uml.attributes.length + uml.methods.length > 0;
  const tagWidth = pillWidth(tag);
  return (
    <g>
      <rect className="vis-er-bg" x={x} y={y} width={width} height={height} rx={RADIUS} />
      {sections ? (
        <path className="vis-er-hd" d={band(x, y, width, CLASS.head, 'top')} />
      ) : (
        <rect className="vis-er-hd" x={x} y={y} width={width} height={height} rx={RADIUS} />
      )}
      <text className="vis-er-n" x={x + CLASS.side} y={y + CLASS.head / 2}>
        {uml.label}
        {uml.generic && (
          <tspan className="vis-er-al" dx={4}>
            {`<${uml.generic}>`}
          </tspan>
        )}
      </text>
      {tag && (
        <g className="vis-cl-tag">
          <rect
            x={x + width - CLASS.side - tagWidth}
            y={y + (CLASS.head - TAG) / 2}
            width={tagWidth}
            height={TAG}
            rx={5}
          />
          <text x={x + width - CLASS.side - tagWidth / 2} y={y + CLASS.head / 2}>
            {tag}
          </text>
        </g>
      )}
      {uml.attributes.length > 0 && (
        <Members card={card} members={uml.attributes} top={y + CLASS.head} />
      )}
      {uml.methods.length > 0 && <Members card={card} members={uml.methods} top={methodsAt} />}
      <rect className="vis-er-ln" x={x} y={y} width={width} height={height} rx={RADIUS} />
    </g>
  );
}

function Relation({ line }: { line: ClassLine }) {
  const { points, relation, label_box: box } = line;
  if (points.length < 2) return null;
  const n = points.length;
  const ends = [
    {
      mark: relation.fromEnd,
      cardinality: relation.fromCardinality,
      at: points[0]!,
      next: points[1]!,
    },
    {
      mark: relation.toEnd,
      cardinality: relation.toCardinality,
      at: points[n - 1]!,
      next: points[n - 2]!,
    },
  ];
  return (
    <g className="vis-cl-r" data-relation={relation.kind} data-dashed={relation.dashed}>
      <path className="vis-cl-p" d={roundedPath(points)} />
      {ends.map(
        (end, i) =>
          end.mark && (
            <path
              key={i}
              className="vis-cl-m"
              data-end={end.mark}
              d={relationMark(end.at, end.next, end.mark)}
            />
          ),
      )}
      {ends.map((end, i) => {
        if (!end.cardinality) return null;
        const at = cardinalityAt(end.at, end.next);
        return (
          <text key={i} className="vis-cl-c" x={at.x} y={at.y}>
            {end.cardinality}
          </text>
        );
      })}
      {box && relation.label && (
        <g className="vis-nd-lb">
          <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={5} />
          <text x={box.x + box.width / 2} y={box.y + box.height / 2}>
            {relation.label}
          </text>
        </g>
      )}
    </g>
  );
}

/** A class diagram drawn from mermaid's parse: class cards joined by lines with UML ends. */
export function ClassDiagram({
  id,
  layout,
  scale,
}: {
  id: string;
  layout: ClassLayout;
  scale: number;
}) {
  return (
    <svg
      className="vis-nd-svg"
      role="img"
      aria-label={t(
        {
          id: 'visual.mermaid.class',
          defaultMessage:
            '{classes, plural, one {# class} other {# classes}}, {relations, plural, one {# relation} other {# relations}}',
        },
        { classes: layout.classes.length, relations: layout.lines.length },
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
      {layout.namespaces.map((namespace, i) => (
        <g key={i} className="vis-nd-g">
          <rect
            x={namespace.x}
            y={namespace.y}
            width={namespace.width}
            height={namespace.height}
            rx={10}
          />
          <text className="vis-nd-gl" x={namespace.x + 12} y={namespace.y + 16}>
            {namespace.label}
          </text>
        </g>
      ))}
      {layout.attachments.map((points, i) => (
        <path key={i} className="vis-cl-nl" d={roundedPath(points)} />
      ))}
      {layout.lines.map((line, i) => (
        <Relation key={i} line={line} />
      ))}
      {layout.notes.map((note, i) => (
        <g key={i} className="vis-sq-note">
          <rect x={note.x} y={note.y} width={note.width} height={note.height} rx={5} />
          {note.lines.map((text, j) => (
            <text
              key={j}
              x={note.x + note.width / 2}
              y={note.y + note.height / 2 + (j - (note.lines.length - 1) / 2) * LINE}
            >
              {text}
            </text>
          ))}
        </g>
      ))}
      {layout.classes.map((card) => (
        <Card key={card.uml.id} card={card} />
      ))}
    </svg>
  );
}
