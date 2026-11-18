import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../i18n';
import {
  layoutTimeline,
  type Box,
  type TextLine,
  type TimelineLayout,
  type TimelineSpec,
} from './timeline-layout';
import './timeline.css';

export type { TimelineSpec } from './timeline-layout';

// A tall timeline grows its card to this, then scrolls.
const MAX_HEIGHT = 1200;

const line = ({ x, y, text, anchor }: TextLine, className: string, key?: number) => (
  <text key={key} className={className} x={x} y={y} textAnchor={anchor}>
    {text}
  </text>
);

function axisTitle(axis: TimelineLayout['axis']): string {
  if (axis.unit === 'ms') return t({ id: 'visual.timeline.ms', defaultMessage: 'ms' });
  if (axis.unit === 's') return t({ id: 'visual.timeline.seconds', defaultMessage: 's' });
  return axis.zone === undefined
    ? t({ id: 'visual.timeline.time', defaultMessage: 'Time' })
    : t({ id: 'visual.timeline.timeIn', defaultMessage: 'Time ({zone})' }, { zone: axis.zone });
}

function summary(layout: TimelineLayout, items: number): string {
  const values = { lanes: layout.lanes.length, items, ...layout.range };
  return layout.lanes.length > 0
    ? t(
        {
          id: 'visual.timeline.summary',
          defaultMessage:
            '{lanes, plural, one {# lane} other {# lanes}}, {items, plural, one {# item} other {# items}}, {from} to {to}',
        },
        values,
      )
    : t(
        {
          id: 'visual.timeline.summarySpans',
          defaultMessage: '{items, plural, one {# item} other {# items}}, {from} to {to}',
        },
        values,
      );
}

/** Events in lanes over a waterfall of spans on one time axis, filling the card's width. */
export function TimelineChart({
  spec,
  height,
  grows = false,
}: {
  spec: TimelineSpec;
  height: number;
  /** Grows past the height to the drawing, up to `MAX_HEIGHT`, as a conversation visual does. */
  grows?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  useLayoutEffect(() => {
    const at = box.current;
    if (!at) return undefined;
    const measure = () => setRoom(at.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(at);
    return () => watch.disconnect();
  }, []);
  const layout = useMemo(() => (room > 0 ? layoutTimeline(spec, room) : null), [spec, room]);
  const focus = (id: string) => (hover === null ? undefined : id === hover ? 'on' : 'dim');
  const marks = layout
    ? [
        ...layout.events.map((event) => ({
          id: event.item.id,
          box: event.box,
          name: event.item.detail
            ? t(
                { id: 'visual.timeline.eventDetail', defaultMessage: '{label}, {time}: {detail}' },
                { label: event.item.label, time: event.at, detail: event.item.detail },
              )
            : t(
                { id: 'visual.timeline.event', defaultMessage: '{label}, {time}' },
                { label: event.item.label, time: event.at },
              ),
        })),
        ...layout.spans.map((span) => {
          const values = {
            label: span.item.label,
            from: span.from,
            to: span.to,
            duration: span.length,
          };
          return {
            id: span.item.id,
            box: span.box,
            name: span.item.detail
              ? t(
                  {
                    id: 'visual.timeline.spanDetail',
                    defaultMessage: '{label}, {from} to {to}, {duration}: {detail}',
                  },
                  { ...values, detail: span.item.detail },
                )
              : t(
                  {
                    id: 'visual.timeline.span',
                    defaultMessage: '{label}, {from} to {to}, {duration}',
                  },
                  values,
                ),
          };
        }),
      ]
    : [];
  const place = (at: Box) => ({ left: at.x, top: at.y, width: at.width, height: at.height });
  return (
    <div
      ref={box}
      className="vis-tl"
      style={grows ? { maxHeight: Math.max(height, MAX_HEIGHT) } : { height }}
    >
      {spec.subtitle && <p className="vis-tl-sub">{spec.subtitle}</p>}
      {layout && layout.legend.length > 0 && (
        <ul
          className="vis-tl-lg"
          aria-label={t({ id: 'visual.timeline.legend', defaultMessage: 'Legend' })}
        >
          {layout.legend.map((group) => (
            <li key={group.id} data-series={group.series}>
              <span className="vis-tl-dot" aria-hidden="true" />
              <span>{group.label}</span>
              <span className="vis-tl-n">{group.count}</span>
            </li>
          ))}
        </ul>
      )}
      {layout && (
        <div className="vis-tl-plot">
          <svg
            className="vis-tl-svg"
            role="img"
            aria-label={summary(layout, spec.items.length)}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width}
            height={layout.height}
          >
            {layout.ticks.map((tick) => (
              <path
                key={`grid-${tick.x}`}
                className="vis-tl-grid"
                d={`M${tick.x} ${layout.plot.top}V${layout.plot.bottom}`}
              />
            ))}
            {layout.ticks.map((tick) => (
              <text
                key={`tick-${tick.x}`}
                className="vis-tl-ax"
                x={tick.x}
                y={layout.plot.bottom + 16}
                textAnchor="middle"
              >
                {tick.label}
              </text>
            ))}
            <text
              className="vis-tl-at"
              x={(layout.plot.left + layout.plot.right) / 2}
              y={layout.axis.y}
              textAnchor="middle"
            >
              {axisTitle(layout.axis)}
            </text>
            {layout.lanes.map((lane, i) => (
              <g key={`lane-${lane.id}`}>
                {i > 0 && <path className="vis-tl-lane" d={`M16 ${lane.y}H${layout.width - 16}`} />}
                {line(lane.label, 'vis-tl-lb')}
              </g>
            ))}
            {layout.events.map((event) => (
              <g
                key={event.item.id}
                className="vis-tl-i"
                data-item={event.item.id}
                data-series={event.series}
                data-focus={focus(event.item.id)}
              >
                {line(event.title, 'vis-tl-et')}
                <circle className="vis-tl-pt" cx={event.x} cy={event.y} r={4} />
                {event.lines.map((detail, j) => line(detail, 'vis-tl-ed', j))}
              </g>
            ))}
            {layout.spans.map((span) => (
              <g
                key={span.item.id}
                className="vis-tl-i"
                data-item={span.item.id}
                data-series={span.series}
                data-focus={focus(span.item.id)}
              >
                {line(span.label, 'vis-tl-lb')}
                <rect
                  className="vis-tl-bar"
                  x={span.bar.x}
                  y={span.bar.y}
                  width={span.bar.width}
                  height={span.bar.height}
                  rx={3}
                />
                <text
                  className="vis-tl-du"
                  data-inside={span.duration.inside || undefined}
                  x={span.duration.x}
                  y={span.duration.y}
                  textAnchor={span.duration.anchor}
                >
                  {span.duration.text}
                </text>
              </g>
            ))}
          </svg>
          <ul
            className="vis-tl-hits"
            aria-label={t({ id: 'visual.timeline.list', defaultMessage: 'Items' })}
          >
            {marks.map((mark) => (
              <li
                key={mark.id}
                tabIndex={0}
                aria-label={mark.name}
                style={place(mark.box)}
                onMouseEnter={() => setHover(mark.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(mark.id)}
                onBlur={() => setHover(null)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
