import type { ComponentType } from 'react';
import {
  AppWindow,
  Box,
  Cog,
  Database,
  Layers,
  ListOrdered,
  User,
  type LucideProps,
} from 'lucide-react';
import { t } from '../../i18n';
import type { ParticipantType } from './mermaid-model';
import {
  CARD,
  chipWidth,
  segmentWord,
  type SeqLayout,
  type SeqMessage,
  type SeqParticipant,
  type SeqSegment,
} from './mermaid-layout';
import './native-diagram.css';

const HEAD = 6;
const LINE = 16;
const ICON = 14;

const TYPE_ICON: Record<ParticipantType, ComponentType<LucideProps>> = {
  actor: User,
  boundary: AppWindow,
  collections: Layers,
  control: Cog,
  database: Database,
  entity: Box,
  queue: ListOrdered,
};
/** The graph node kind whose colour a participant type takes. */
const TYPE_KIND: Record<ParticipantType, string> = {
  actor: 'external',
  boundary: 'client',
  collections: 'store',
  control: 'service',
  database: 'store',
  entity: 'service',
  queue: 'queue',
};

function Card({ at, top, height }: { at: SeqParticipant; top: number; height: number }) {
  const { participant, x, width } = at;
  const Icon = participant.type && TYPE_ICON[participant.type];
  const left = x - width / 2;
  const textAt = left + (Icon ? CARD.icon : CARD.plain);
  const described = participant.description !== undefined;
  return (
    <g className="vis-sq-n" data-kind={participant.type && TYPE_KIND[participant.type]}>
      <rect className="vis-sq-nb" x={left} y={top} width={width} height={height} rx={7} />
      {Icon && (
        <Icon
          className="vis-sq-ic"
          x={left + 7}
          y={top + (described ? 14 : height / 2) - ICON / 2}
          width={ICON}
          height={ICON}
          aria-hidden="true"
        />
      )}
      <text className="vis-sq-t" x={textAt} y={top + (described ? 14 : height / 2)}>
        {participant.title}
      </text>
      {described && (
        <text className="vis-sq-s" x={textAt} y={top + 31}>
          {participant.description}
        </text>
      )}
    </g>
  );
}

/** A head with its tip on `tip`, pointing along `direction` (1 right, -1 left). */
const headPath = (tip: { x: number; y: number }, direction: number) =>
  `M${tip.x} ${tip.y}L${tip.x - direction * HEAD} ${tip.y + 3.5}L${tip.x - direction * HEAD} ${tip.y - 3.5}Z`;

function Message({ message }: { message: SeqMessage }) {
  const { x1, x2, y, self, lines, kind } = message;
  const direction = self ? -1 : Math.sign(x2 - x1) || 1;
  const tip = self ? { x: x1, y: y + LINE } : { x: x2, y };
  const line = self
    ? `M${x1} ${y}H${x1 + 32}V${y + LINE}H${x1 + HEAD - 1}`
    : `M${x1} ${y}H${x2 - direction * (HEAD - 1)}`;
  const labelX = self ? x1 + 8 : (x1 + x2) / 2;
  return (
    <g className="vis-sq-e" data-kind={kind}>
      <path className="vis-sq-ln" d={line} />
      <path className="vis-sq-ah" d={headPath(tip, direction)} />
      {lines.map((text, i) => (
        <text
          key={i}
          className="vis-sq-msg"
          x={labelX}
          y={y - 14 - (lines.length - 1 - i) * LINE}
          textAnchor={self ? 'start' : 'middle'}
        >
          {text}
        </text>
      ))}
      {message.number !== undefined && (
        <g className="vis-sq-no">
          <circle cx={x1} cy={y} r={9} />
          <text x={x1} y={y}>
            {message.number}
          </text>
        </g>
      )}
    </g>
  );
}

function Chip({ x, y, word, label }: { x: number; y: number; word: string; label: string }) {
  return (
    <g className="vis-sq-chip">
      <rect x={x} y={y} width={chipWidth(word, label)} height={18} rx={5} />
      <text x={x + 8} y={y + 9}>
        <tspan className="vis-sq-kw">{word}</tspan>
        {label && <tspan dx={6}>{label}</tspan>}
      </text>
    </g>
  );
}

function Segment({ segment }: { segment: SeqSegment }) {
  const { x, y, width, height, kind } = segment;
  return (
    <g className="vis-nd-g" data-kind={kind}>
      <rect x={x} y={y} width={width} height={height} rx={10} />
      {segment.branches.map((branch, i) => (
        <path key={i} className="vis-sq-div" d={`M${x} ${branch.y}H${x + width}`} />
      ))}
    </g>
  );
}

function SegmentChips({ segment }: { segment: SeqSegment }) {
  const { x, y, kind } = segment;
  // A rect only shades its messages; its text is a colour.
  if (kind === 'rect') return null;
  return (
    <>
      <Chip x={x + 8} y={y + 5} word={segmentWord(kind, 0)} label={segment.label} />
      {segment.branches.map((branch, i) => (
        <Chip
          key={i}
          x={x + 8}
          y={branch.y + 5}
          word={segmentWord(kind, i + 1)}
          label={branch.label}
        />
      ))}
    </>
  );
}

/** A sequence diagram drawn from mermaid's parse: participant cards over lifelines, then rows. */
export function SequenceDiagram({
  id,
  layout,
  scale,
}: {
  id: string;
  layout: SeqLayout;
  scale: number;
}) {
  const { lifeline } = layout;
  return (
    <svg
      className="vis-nd-svg"
      role="img"
      aria-label={t(
        {
          id: 'visual.mermaid.sequence',
          defaultMessage:
            '{participants, plural, one {# participant} other {# participants}}, {messages, plural, one {# message} other {# messages}}, {segments, plural, one {# segment} other {# segments}}',
        },
        {
          participants: layout.participants.length,
          messages: layout.messages.length,
          segments: layout.segments.length,
        },
      )}
      viewBox={`${layout.x} ${layout.y} ${layout.width} ${layout.height}`}
      width={layout.width * scale}
      height={layout.height * scale}
    >
      <defs>
        <pattern id={`${id}-dots`} width={16} height={16} patternUnits="userSpaceOnUse">
          <rect className="vis-nd-dot" width={1} height={1} />
        </pattern>
      </defs>
      <rect
        x={layout.x}
        y={layout.y}
        width={layout.width}
        height={layout.height}
        fill={`url(#${id}-dots)`}
      />
      {layout.boxes.map((box, i) => (
        <g key={i} className="vis-nd-g">
          <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={10} />
          {box.label && (
            <text className="vis-nd-gl" x={box.x + 12} y={box.y + 14}>
              {box.label}
            </text>
          )}
        </g>
      ))}
      {layout.segments.map((segment, i) => (
        <Segment key={i} segment={segment} />
      ))}
      {layout.participants.map((p) => (
        <path
          key={p.participant.id}
          className="vis-sq-life"
          d={`M${p.x} ${lifeline.y1}V${lifeline.y2}`}
        />
      ))}
      {layout.activations.map((bar, i) => (
        <rect
          key={i}
          className="vis-sq-act"
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          rx={2}
        />
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
      {layout.messages.map((message, i) => (
        <Message key={i} message={message} />
      ))}
      {layout.segments.map((segment, i) => (
        <SegmentChips key={i} segment={segment} />
      ))}
      {layout.rows.map((top) =>
        layout.participants.map((p) => (
          <Card key={`${top}:${p.participant.id}`} at={p} top={top} height={layout.cardHeight} />
        )),
      )}
    </svg>
  );
}
