import { useMemo, useState } from 'react';
import { PreviewCard } from '@base-ui/react/preview-card';
import type { ProjectTrace } from '@pantheon/protocol';
import type { DaemonEvent } from '../../data/sync';
import { t } from '../../i18n';
import { Failure, Skeleton } from '../board/BoardScreen';
import { Empty, useSize } from '../board/Charts';
import { durationText } from '../board/panels-model';
import { EventGlyph, eventWords } from './ActivityList';
import { clockText, EventCard, laneOf, turnAt } from './LaneOverlay';
import type { TraceEvent } from './model';
import './timeline-overlay.css';

/** Height of one event row, px. */
const EVENT_ROW_PX = 30;
/** Rows mounted beyond each edge of the viewport. */
const OVERSCAN = 8;

/** Each gate run's summed command time by event id, for runs whose commands report one. */
function gateTimes(history: readonly DaemonEvent[] | null): ReadonlyMap<string, number> {
  const times = new Map<string, number>();
  for (const event of history ?? []) {
    if (event.kind !== 'session.gate_checked') continue;
    const results = (event.payload as { results?: unknown } | null)?.results;
    const ms = (Array.isArray(results) ? results : [])
      .map((r) => (r as { duration_ms?: unknown } | null)?.duration_ms)
      .filter((d): d is number => typeof d === 'number');
    if (ms.length)
      times.set(
        event.event_id,
        ms.reduce((a, b) => a + b, 0),
      );
  }
  return times;
}

export interface EventTableProps {
  /** Newest first; null until the history is read. */
  rows: readonly TraceEvent[] | null;
  error: string | null;
  onRetry: () => void;
  titleOf: (sessionId: string) => string;
  /** End of the trace's window. */
  to: number;
  /** Id of the row last shown on the lanes. */
  shown: string | null;
  /** Id of the newest row up to the replay's playhead; null at now, when every row shows. */
  current?: string | null;
  onShow: (event: TraceEvent) => void;
  /** The events the rows were read from; a gate run's duration comes from its commands. */
  history: readonly DaemonEvent[] | null;
  /** The trace's lanes; a row's hover card takes its session's turn from them. */
  lanes: ProjectTrace['lanes'];
  now: number;
}

/**
 * The window's approvals, gate runs, merges and session starts and ends, each with its moment and
 * how long it took; only the rows near the viewport are mounted.
 */
export function EventTable({
  rows,
  error,
  onRetry,
  titleOf,
  to,
  shown,
  current = null,
  onShow,
  history,
  lanes,
  now,
}: EventTableProps) {
  const gates = useMemo(() => gateTimes(history), [history]);
  const [measure, size] = useSize();
  const [top, setTop] = useState(0);
  const count = rows?.length ?? 0;
  const first = Math.min(
    Math.max(0, Math.floor(top / EVENT_ROW_PX) - OVERSCAN),
    Math.max(0, count - 1),
  );
  const last = Math.min(count - 1, Math.ceil((top + size.h) / EVENT_ROW_PX) - 1 + OVERSCAN);
  const endDay = new Date(to).toDateString();
  const dated = rows?.some((row) => new Date(row.at).toDateString() !== endDay);
  const duration = (row: TraceEvent) =>
    row.waitedMs === null
      ? t(
          { id: 'trace.overlay.waiting', defaultMessage: 'Waiting {duration}' },
          { duration: durationText(now - row.at) },
        )
      : row.waitedMs !== undefined
        ? durationText(row.waitedMs)
        : gates.has(row.id)
          ? durationText(gates.get(row.id)!)
          : '';
  return (
    <section
      className="tlo-et"
      data-dated={dated || undefined}
      data-replay={current !== null || undefined}
      aria-label={t({ id: 'trace.events.label', defaultMessage: 'Events' })}
    >
      <div className="tlo-er tlo-eh" aria-hidden="true">
        <span>{t({ id: 'trace.events.time', defaultMessage: 'Time' })}</span>
        <span />
        <span>{t({ id: 'trace.events.session', defaultMessage: 'Session' })}</span>
        <span>{t({ id: 'trace.events.event', defaultMessage: 'Event' })}</span>
        <span className="tlo-et-d">
          {t({ id: 'trace.overlay.duration', defaultMessage: 'Duration' })}
        </span>
      </div>
      {error ? (
        <Failure error={error} onRetry={onRetry} />
      ) : rows === null ? (
        <Skeleton />
      ) : rows.length === 0 ? (
        <Empty text={t({ id: 'trace.events.empty', defaultMessage: 'No events in this window' })} />
      ) : (
        <div className="tlo-es" ref={measure} onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
          <ul className="tlo-el" style={{ height: count * EVENT_ROW_PX }}>
            {rows.slice(first, last + 1).map((row, i) => {
              const lane = laneOf(lanes, row.sessionId);
              return (
                <li
                  key={row.id}
                  aria-posinset={first + i + 1}
                  aria-setsize={count}
                  style={{ top: (first + i) * EVENT_ROW_PX, height: EVENT_ROW_PX }}
                >
                  <PreviewCard.Root>
                    <PreviewCard.Trigger
                      render={
                        <button
                          type="button"
                          className="tlo-er"
                          data-sel={row.id === shown || row.id === current || undefined}
                          aria-current={row.id === current ? 'true' : undefined}
                          onClick={() => onShow(row)}
                        />
                      }
                    >
                      <span className="tlo-et-t">{clockText(row.at, to)}</span>
                      <EventGlyph event={row} />
                      <span className="tlo-et-s">{titleOf(row.sessionId)}</span>
                      {eventWords(row, 'tlo-et-w')}
                      <span className="tlo-et-d">{duration(row)}</span>
                    </PreviewCard.Trigger>
                    <PreviewCard.Portal>
                      <PreviewCard.Positioner
                        side="top"
                        align="start"
                        sideOffset={4}
                        style={{ zIndex: 40 }}
                      >
                        <PreviewCard.Popup className="pop tlo-card">
                          <EventCard
                            event={row}
                            title={titleOf(row.sessionId)}
                            end={to}
                            turn={lane ? turnAt(lane.turns, row.at) : null}
                          />
                        </PreviewCard.Popup>
                      </PreviewCard.Positioner>
                    </PreviewCard.Portal>
                  </PreviewCard.Root>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
