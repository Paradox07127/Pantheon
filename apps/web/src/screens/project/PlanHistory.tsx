import { useMemo, type CSSProperties } from 'react';
import type { ProjectPlanView } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { Failure } from '../../components/PanelBoundary';
import { Tip } from '../../components/Tip';
import { useNow } from '../../data/needs-you';
import { useLandingRecords, usePlanHistory } from '../../data/plan-history';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { dayText } from '../../lib/time-text';
import {
  milestoneLabels,
  planTimeline,
  type PlanTimeline,
  type TimelineRow,
} from './plan-timeline';

const at = (x: number): CSSProperties => ({ left: `${x * 100}%` });

/**
 * Where the labels of marks at xs, left to right, go: each starts at its mark and stops short of
 * the next one; the last, near the axis end, ends at its mark and shares the gap before it.
 */
function labelPlaces(xs: readonly number[]): { style: CSSProperties; end: boolean }[] {
  const flip = (xs.at(-1) ?? 0) > 0.8;
  const pct = (share: number) => `calc(${share * 100}% - 8px)`;
  return xs.map((x, k) => {
    if (flip && k === xs.length - 1) {
      const from = k ? (xs[k - 1]! + x) / 2 : 0;
      return { style: { right: `${(1 - x) * 100}%`, maxWidth: pct(x - from) }, end: true };
    }
    const after = xs[k + 1];
    const to = after === undefined ? 1 : flip && k === xs.length - 2 ? (x + after) / 2 : after;
    return { style: { left: `${x * 100}%`, maxWidth: pct(to - x) }, end: false };
  });
}

function spanText(span: TimelineRow['spans'][number], now: number) {
  const added = dayText(span.added, now, { time: true });
  if (!span.ended)
    return t({ id: 'project.history.span.open', defaultMessage: 'Added {added}' }, { added });
  const ended = dayText(span.ended.at, now, { time: true });
  return span.ended.kind === 'removed'
    ? t(
        { id: 'project.history.span.removed', defaultMessage: 'Added {added}, removed {ended}' },
        { added, ended },
      )
    : t(
        { id: 'project.history.span.dropped', defaultMessage: 'Added {added}, dropped {ended}' },
        { added, ended },
      );
}

function landingText(state: TimelineRow['landings'][number]['state'], time: string) {
  if (state === 'landed')
    return t({ id: 'project.history.landing.landed', defaultMessage: 'Landed {time}' }, { time });
  if (state === 'blocked')
    return t(
      { id: 'project.history.landing.blocked', defaultMessage: 'Landing blocked {time}' },
      { time },
    );
  return t(
    { id: 'project.history.landing.noChanges', defaultMessage: 'Landed with no changes {time}' },
    { time },
  );
}

/** What a replan did, a line each: when, the items it removed, each item it moved. */
function replanLines(replan: PlanTimeline['replans'][number], now: number): string[] {
  const none = t({ id: 'project.history.noMilestone', defaultMessage: 'no milestone' });
  return [
    t(
      { id: 'project.history.replan', defaultMessage: 'Replanned {time}' },
      { time: dayText(replan.at, now, { time: true }) },
    ),
    ...(replan.removed.length
      ? [
          t(
            { id: 'project.history.replan.removed', defaultMessage: 'Removed {items}' },
            { items: listText(...replan.removed) },
          ),
        ]
      : []),
    ...replan.moved.map((move) =>
      t(
        {
          id: 'project.history.replan.moved',
          defaultMessage: 'Moved {item} from {from} to {to}',
        },
        { item: move.title, from: move.from ?? none, to: move.to ?? none },
      ),
    ),
  ];
}

/**
 * The plan over time, a row per item from when a revision added it to when one removed or dropped
 * it, with its sessions' landings on it, milestone lines and replan marks above.
 */
export function PlanHistory({
  projectId,
  plan,
  selected,
  onSelect,
}: {
  projectId: string;
  plan: NonNullable<ProjectPlanView['plan']>;
  /** The item whose details are open. */
  selected: string | null;
  onSelect: (itemId: string) => void;
}) {
  const history = usePlanHistory(projectId);
  const landings = useLandingRecords(projectId);
  const now = useNow(60_000);
  const revisions = history.read?.revisions;
  const records = landings.read?.landings;
  const timeline = useMemo(
    () => (revisions && records ? planTimeline(revisions, records, now) : null),
    [revisions, records, now],
  );
  const error = history.error ?? landings.error;
  // Only an item still in the plan has details to open.
  const open = new Set(plan.items.filter((item) => !item.dropped).map((item) => item.id));
  const title = t({ id: 'project.history.title', defaultMessage: 'Plan history' });
  const labels = milestoneLabels(timeline?.milestones ?? []);
  const names = labelPlaces(labels.map((label) => label.x));
  const ticks = labelPlaces(timeline?.ticks.map((tick) => tick.x) ?? []);
  return (
    <section
      className="pj-list"
      aria-label={title}
      aria-busy={(history.loading || landings.loading) && !error ? true : undefined}
    >
      <div className="pj-lh">
        <h2 className="pj-h2">{title}</h2>
      </div>
      {error && (
        <Failure
          error={error}
          onRetry={() => {
            history.reload();
            landings.reload();
          }}
        />
      )}
      {revisions?.length === 0 ? (
        <p className="pj-hs-none">
          {t({ id: 'project.history.empty', defaultMessage: 'No plan revisions yet' })}
        </p>
      ) : (
        timeline && (
          <div className="pj-hs">
            <div className="pj-hs-band">
              <span className="pj-hs-trk">
                {labels.map((m, k) => (
                  <span
                    key={m.x}
                    className="pj-hs-lab"
                    data-end={names[k]!.end ? '' : undefined}
                    style={names[k]!.style}
                  >
                    <Clip text={listText(...m.titles)} />
                  </span>
                ))}
              </span>
            </div>
            <div className="pj-hs-band">
              <span className="pj-hs-trk">
                {timeline.replans.map((replan) => {
                  const lines = replanLines(replan, now);
                  return (
                    <Tip key={replan.revision} content={lines.join('\n')}>
                      <button
                        type="button"
                        className="pj-hs-rp"
                        style={at(replan.x)}
                        aria-label={listText(...lines)}
                      />
                    </Tip>
                  );
                })}
              </span>
            </div>
            <ul className="pj-hs-rows">
              {timeline.rows.map((row) => {
                const pick = open.has(row.id) ? () => onSelect(row.id) : undefined;
                return (
                  <li
                    key={row.id}
                    className="pj-hs-row"
                    data-ended={row.ended ? row.ended.kind : undefined}
                    aria-current={row.id === selected ? 'true' : undefined}
                    // The title button is the keyboard path; a click elsewhere on the row selects the same item.
                    onClick={pick}
                  >
                    <span className="pj-hs-lbl">
                      {pick ? (
                        <button
                          type="button"
                          className="pj-open"
                          onClick={(e) => {
                            e.stopPropagation();
                            pick();
                          }}
                        >
                          <Clip text={row.title} />
                        </button>
                      ) : (
                        <Clip text={row.title} />
                      )}
                    </span>
                    <span className="pj-hs-trk">
                      {row.spans.map((span) => (
                        <i
                          key={span.added}
                          className="pj-hs-bar"
                          role="img"
                          aria-label={spanText(span, now)}
                          style={{
                            left: `${span.x1 * 100}%`,
                            width: `${(span.x2 - span.x1) * 100}%`,
                          }}
                        />
                      ))}
                      {row.landings.map((landing, k) => (
                        <i
                          key={k}
                          className="pj-hs-dot"
                          data-state={landing.state}
                          role="img"
                          aria-label={landingText(
                            landing.state,
                            dayText(landing.at, now, { time: true }),
                          )}
                          style={at(landing.x)}
                        />
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="pj-hs-band">
              <span className="pj-hs-trk">
                {timeline.ticks.map((tick, k) => (
                  <span
                    key={k}
                    className="pj-hs-lab"
                    data-tick=""
                    data-end={ticks[k]!.end ? '' : undefined}
                    style={ticks[k]!.style}
                  >
                    <Clip text={dayText(tick.at, now, { time: true })} />
                  </span>
                ))}
              </span>
            </div>
            <div className="pj-hs-over" aria-hidden="true">
              {timeline.breaks.map((b) => (
                <i
                  key={b.x}
                  className="pj-hs-brk"
                  style={{ left: `${b.x * 100}%`, width: `${b.width * 100}%` }}
                />
              ))}
              {timeline.milestones.map((m) => (
                <i key={m.revision} className="pj-hs-ml" style={at(m.x)} />
              ))}
            </div>
          </div>
        )
      )}
    </section>
  );
}
