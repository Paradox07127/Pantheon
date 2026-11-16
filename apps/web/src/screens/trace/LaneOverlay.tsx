import { useMemo } from 'react';
import { PreviewCard } from '@base-ui/react/preview-card';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { tokenText, usdText, whenText } from '../board/panels-model';
import { eventText } from './ActivityList';
import {
  ROW_HEIGHT,
  type TraceEvent,
  type TraceLaneView,
  type TraceRow,
  type TraceTurn,
  type TraceWindow,
} from './model';
import './timeline-overlay.css';

/** Width of a gate failure mark, px. */
const MARK_PX = 8;
/** The window's end trails the clock by up to one read of the trace. */
const NOW_LAG_MS = 60_000;

const pct = (share: number) => `${share * 100}%`;
const pad = (n: number) => String(n).padStart(2, '0');

/** Local "HH:MM:SS" on the day of end; an earlier day as whenText writes it. */
export function clockText(at: number, end: number): string {
  const date = new Date(at);
  return date.toDateString() === new Date(end).toDateString()
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    : whenText(at, end);
}

/** The lane of a Pantheon session, by its session id or lane key. */
export const laneOf = (lanes: readonly TraceLaneView[], sessionId: string) =>
  lanes.find((l) => l.lane.key === sessionId || l.lane.session_id === sessionId);

/** The last of the turns started by at. */
export function turnAt(turns: readonly TraceTurn[], at: number): TraceTurn | null {
  let found: TraceTurn | null = null;
  for (const turn of turns)
    if (turn.start !== null && turn.start <= at && (!found || turn.start >= found.start!))
      found = turn;
  return found;
}

/** What happened, in whose session and when, with the tokens and cost of the turn it followed. */
export function EventCard({
  event,
  title,
  end,
  turn,
}: {
  event: TraceEvent;
  title: string;
  /** End of the window, which decides whether the moment names its day. */
  end: number;
  turn: TraceTurn | null;
}) {
  const tokens = turn?.tokens && turn.tokens.input + turn.tokens.output;
  return (
    <>
      <b className="tlo-ch">{eventText(event)}</b>
      <span className="tlo-cm">{title}</span>
      <span className="tlo-ct">{clockText(event.at, end)}</span>
      {(tokens != null || turn?.cost_usd != null) && (
        <dl className="tlo-ckv">
          {tokens != null && (
            <>
              <dt>{t({ id: 'trace.overlay.tokens', defaultMessage: 'Turn tokens' })}</dt>
              <dd>{tokenText(tokens)}</dd>
            </>
          )}
          {turn?.cost_usd != null && (
            <>
              <dt>{t({ id: 'trace.overlay.cost', defaultMessage: 'Turn cost' })}</dt>
              <dd>{usdText(turn.cost_usd)}</dd>
            </>
          )}
        </dl>
      )}
    </>
  );
}

export interface LaneOverlayProps {
  /** The mounted rows; the first sits at index first. */
  rows: readonly TraceRow[];
  first: number;
  /** All rows, mounted or not. */
  count: number;
  axis: { position: (at: number) => number };
  view: TraceWindow;
  /** The window's events the table shows; null until read. */
  events: readonly TraceEvent[] | null;
  now: number;
}

/**
 * Over the lanes' track column: a mark per gate failure on its session's row, each with a hover
 * card, and the line at now while the view runs up to it. Scrolls with the rows.
 */
export function LaneOverlay({ rows, first, count, axis, view, events, now }: LaneOverlayProps) {
  const failures = useMemo(() => {
    const bySession = new Map<string, TraceEvent[]>();
    for (const event of events ?? [])
      if (event.what === 'gate_failed' && event.at >= view.from && event.at <= view.to)
        bySession.set(event.sessionId, [...(bySession.get(event.sessionId) ?? []), event]);
    return bySession;
  }, [events, view.from, view.to]);
  const height = count * ROW_HEIGHT;
  const live = now >= view.from && now - view.to <= NOW_LAG_MS;
  return (
    <div className="tlo-layer" style={{ height, marginTop: -height }}>
      <span className="tlo-col">
        {rows.map((row, i) => {
          if (row.kind !== 'session') return null;
          const lane = row.lane.lane;
          const marks = [
            ...(failures.get(lane.key) ?? []),
            ...(lane.session_id && lane.session_id !== lane.key
              ? (failures.get(lane.session_id) ?? [])
              : []),
          ];
          return marks.map((event) => (
            <PreviewCard.Root key={event.id}>
              <PreviewCard.Trigger
                render={
                  <span
                    className="tlo-mark"
                    role="img"
                    aria-label={listText(
                      eventText(event),
                      lane.title,
                      clockText(event.at, view.to),
                    )}
                    style={{
                      left: pct(axis.position(event.at)),
                      top: (first + i) * ROW_HEIGHT + (ROW_HEIGHT - MARK_PX) / 2,
                    }}
                  />
                }
              />
              <PreviewCard.Portal>
                <PreviewCard.Positioner side="top" sideOffset={8} style={{ zIndex: 40 }}>
                  <PreviewCard.Popup className="pop tlo-card">
                    <EventCard
                      event={event}
                      title={lane.title}
                      end={view.to}
                      turn={turnAt(row.lane.turns, event.at)}
                    />
                  </PreviewCard.Popup>
                </PreviewCard.Positioner>
              </PreviewCard.Portal>
            </PreviewCard.Root>
          ));
        })}
        {live && (
          <i
            className="tlo-now"
            aria-hidden="true"
            style={{ left: pct(axis.position(Math.min(now, view.to))) }}
          />
        )}
      </span>
    </div>
  );
}

type Swatch = 'run' | 'wait' | 'review' | 'merge' | 'gate' | 'idle' | 'queue';
// Labels are getters, so each is read in the language loaded by then.
const LEGEND: { swatch: Swatch; readonly label: string }[] = [
  {
    swatch: 'run',
    get label() {
      return t({ id: 'trace.laneState.run', defaultMessage: 'Working' });
    },
  },
  {
    swatch: 'wait',
    get label() {
      return t({ id: 'trace.laneState.wait', defaultMessage: 'Waiting on you' });
    },
  },
  {
    swatch: 'review',
    get label() {
      return t({ id: 'trace.laneState.review', defaultMessage: 'Ready for review' });
    },
  },
  {
    swatch: 'merge',
    get label() {
      return t({ id: 'trace.laneState.merge', defaultMessage: 'Merging' });
    },
  },
  {
    swatch: 'gate',
    get label() {
      return t({ id: 'trace.event.gateFailed', defaultMessage: 'Checks failed' });
    },
  },
  {
    swatch: 'idle',
    get label() {
      return t({ id: 'trace.laneState.idle', defaultMessage: 'Idle' });
    },
  },
  {
    swatch: 'queue',
    get label() {
      return t({ id: 'trace.laneState.queue', defaultMessage: 'Queued' });
    },
  },
];

/** What each colour on the lanes stands for, under the track column. */
export function LaneLegend() {
  return (
    <div className="legend tlo-legend">
      {LEGEND.map((item) => (
        <span key={item.swatch} className="tlo-li">
          <i className="tlo-sw" data-swatch={item.swatch} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}
