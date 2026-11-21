import { Fragment, useState, type CSSProperties } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { ArrowUpRight, ChevronRight, CircleAlert, Clock, ShieldCheck } from 'lucide-react';
import type {
  TraceTimeAllocation,
  TraceTimeEvidence,
  TraceTimeKind,
  TraceTimeSlice,
} from '@pantheon/domain';
import { ReadStatus } from '../../components/ReadStatus';
import { Skeleton } from '../../components/Skeleton';
import { Tip } from '../../components/Tip';
import type { QueryState } from '../../data/workbench-sessions';
import { currentLocale, t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { durationText } from '../../lib/time-text';
import { Failure } from '../../components/PanelBoundary';
import { EmptyState } from '../../components/EmptyState';
import './trace-time.css';

type Group = 'model' | 'approval' | 'tool' | 'subagent' | 'queue' | 'other';
const members: Record<Group, TraceTimeKind[]> = {
  model: ['llm'],
  approval: ['approval'],
  tool: ['tool'],
  subagent: ['subagent'],
  queue: ['queue'],
  other: ['parallel', 'compact', 'delivery', 'unknown'],
};
const barOrder: Group[] = ['model', 'tool', 'approval', 'subagent', 'queue', 'other'];
const keyOrder: Group[] = ['model', 'approval', 'tool', 'subagent', 'queue', 'other'];
const groupName: Record<Group, () => string> = {
  model: () => t({ id: 'trace.timeChart.model', defaultMessage: 'Model' }),
  approval: () =>
    t({ id: 'trace.timeChart.approval', defaultMessage: 'Waiting for your approval' }),
  tool: () => t({ id: 'trace.timeChart.tool', defaultMessage: 'Tools' }),
  subagent: () => t({ id: 'trace.timeChart.subagent', defaultMessage: 'Subagents' }),
  queue: () => t({ id: 'trace.timeChart.queue', defaultMessage: 'Queue' }),
  other: () => t({ id: 'trace.timeChart.other', defaultMessage: 'Other' }),
};
const otherName: Partial<Record<TraceTimeKind, () => string>> = {
  parallel: () => t({ id: 'trace.timeChart.parallel', defaultMessage: 'Parallel' }),
  compact: () => t({ id: 'trace.timeChart.compact', defaultMessage: 'Compaction' }),
  delivery: () => t({ id: 'trace.timeChart.delivery', defaultMessage: 'Delivery' }),
  unknown: () => t({ id: 'trace.timeChart.unknown', defaultMessage: 'Unknown' }),
};
const groupOf = (kind: TraceTimeKind) =>
  (Object.keys(members) as Group[]).find((group) => members[group].includes(kind))!;
const kindName = (kind: TraceTimeKind) => (otherName[kind] ?? groupName[groupOf(kind)])();
const sourceName: Record<TraceTimeEvidence['source'], () => string> = {
  native: () => t({ id: 'trace.runtime.native', defaultMessage: 'Native trace' }),
  daemon: () => t({ id: 'trace.runtime.daemon', defaultMessage: 'Daemon events' }),
  runtime_reported: () => t({ id: 'trace.runtime.reported', defaultMessage: 'Reported duration' }),
};
type Mode = 'wall' | 'work';

/** With onEvidence each kind opens its overlaps and evidence, and coverage gaps are listed. */
export function TraceTimeChart({
  query,
  titleOf,
  onEvidence,
}: {
  query: QueryState<TraceTimeAllocation>;
  titleOf: (lane: string) => string;
  onEvidence?: (item: TraceTimeEvidence) => void;
}) {
  const [mode, setMode] = useState<Mode>('wall');
  const [selected, setSelected] = useState<TraceTimeKind | null>(null);
  const [more, setMore] = useState(false);
  const data = query.data;
  const heading = t({ id: 'trace.time.heading', defaultMessage: 'Time breakdown' });
  const total = data ? (mode === 'wall' ? data.wall_ms : data.work_ms) : 0;
  const rows = data?.[mode] ?? [];
  const groups = new Map(
    keyOrder.flatMap((group) => {
      const slices = members[group].flatMap((kind) => rows.filter((row) => row.kind === kind));
      const ms = slices.reduce((sum, row) => sum + row.ms, 0);
      return ms > 0 ? [[group, { ms, slices }] as const] : [];
    }),
  );
  const wall = t({ id: 'trace.timeChart.wall', defaultMessage: 'Wall clock' });
  const work = t({ id: 'trace.timeChart.work', defaultMessage: 'Cumulative' });
  const percent = (ms: number) =>
    t(
      { id: 'trace.timeChart.percent', defaultMessage: '{share, number, ::percent}' },
      { share: ms / total },
    );

  const detailOf = (row: TraceTimeSlice) =>
    onEvidence && selected === row.kind ? (
      <div className="trc-time-detail">
        {row.concurrent?.map(({ kinds, ms }) => (
          <div key={kinds.join(',')} className="trc-time-overlap">
            <span>{listText(...kinds.map(kindName))}</span>
            <span>{durationText(ms)}</span>
          </div>
        ))}
        {row.evidence.map((item) => (
          <Tip key={JSON.stringify([item.lane_key, item.id])} content={item.id}>
            <button type="button" className="trc-time-evidence" onClick={() => onEvidence(item)}>
              <span>{listText(item.operation, titleOf(item.lane_key))}</span>
              <small>
                {sourceName[item.source]()}{' '}
                <time dateTime={new Date(item.at).toISOString()}>
                  {new Date(item.at).toLocaleString(currentLocale(), {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
              </small>
              <ArrowUpRight aria-hidden="true" />
            </button>
          </Tip>
        ))}
      </div>
    ) : null;
  const key = (className: string, swatch: Group | null, row: TraceTimeSlice, ms: number) => {
    const fields = [
      swatch ? (
        <i key="x" className="trc-time-swatch" data-group={swatch} aria-hidden="true" />
      ) : (
        <span key="x" />
      ),
      <span key="name">{swatch ? groupName[swatch]() : kindName(row.kind)}</span>,
      <span key="n" className="trc-time-n">
        {durationText(ms)}
      </span>,
      <span key="p" className="trc-time-p">
        {percent(ms)}
      </span>,
    ];
    return onEvidence && (row.evidence.length > 0 || !!row.concurrent?.length) ? (
      <button
        type="button"
        className={className}
        aria-expanded={selected === row.kind}
        onClick={() => setSelected(selected === row.kind ? null : row.kind)}
      >
        {fields}
      </button>
    ) : (
      <div className={className}>{fields}</div>
    );
  };

  const gates = !!data && data.gates > 0;
  const untimed = !!data && data.untimed_operations > 0;
  const unplaced = !!data && data.unplaced_operations > 0;
  return (
    <section
      className="panel trc-time"
      aria-label={heading}
      aria-busy={(!data && !query.error) || undefined}
      data-notes={gates || untimed || unplaced || undefined}
    >
      <div className="cell trc-time-main">
        <div className="trc-time-head">
          <b>{t({ id: 'trace.timeChart.title', defaultMessage: 'Where the time went' })}</b>
          <RadioGroup<Mode>
            className="tb-seg"
            aria-label={t({ id: 'trace.time.mode', defaultMessage: 'Time measure' })}
            value={mode}
            disabled={!data}
            onValueChange={(value) => {
              setMode(value);
              setSelected(null);
            }}
          >
            <Radio.Root value="wall">{wall}</Radio.Root>
            <Radio.Root value="work">{work}</Radio.Root>
          </RadioGroup>
          {data && (
            <span className="trc-time-turns">
              {t(
                {
                  id: 'trace.time.turns',
                  defaultMessage: '{count, plural, one {# turn} other {# turns}}',
                },
                { count: data.turns },
              )}
            </span>
          )}
        </div>
        {data ? (
          <>
            <ReadStatus label={heading} {...query} inner />
            {total > 0 ? (
              <>
                <div className="trc-time-line">
                  <div
                    className="trc-time-bar"
                    role="img"
                    aria-label={t(
                      { id: 'trace.timeChart.bar', defaultMessage: '{measure} {total}: {parts}' },
                      {
                        measure: mode === 'wall' ? wall : work,
                        total: durationText(total),
                        parts: listText(
                          ...barOrder.map((group) => {
                            const part = groups.get(group);
                            return part && `${groupName[group]()} ${durationText(part.ms)}`;
                          }),
                        ),
                      },
                    )}
                  >
                    {barOrder.map((group) => {
                      const part = groups.get(group);
                      return (
                        part && (
                          <i
                            key={group}
                            data-group={group}
                            style={{ '--n': part.ms } as CSSProperties}
                          />
                        )
                      );
                    })}
                  </div>
                  <span className="trc-time-total" aria-live="polite">
                    {durationText(total)}
                  </span>
                </div>
                <div className="trc-time-keys">
                  {keyOrder.map((group) => {
                    const part = groups.get(group);
                    if (!part) return null;
                    if (group !== 'other')
                      return (
                        <Fragment key={group}>
                          {key('trc-time-key', group, part.slices[0]!, part.ms)}
                          {detailOf(part.slices[0]!)}
                        </Fragment>
                      );
                    return (
                      <div key={group} className="trc-time-group">
                        <button
                          type="button"
                          className="trc-time-key"
                          aria-expanded={more}
                          aria-label={t(
                            {
                              id: 'trace.timeChart.otherLabel',
                              defaultMessage: 'Other {duration}: {kinds}',
                            },
                            {
                              duration: durationText(part.ms),
                              kinds: listText(...part.slices.map((row) => kindName(row.kind))),
                            },
                          )}
                          onClick={() => setMore(!more)}
                        >
                          <i className="trc-time-swatch" data-group="other" aria-hidden="true" />
                          <span className="trc-time-more">
                            {groupName.other()}
                            <ChevronRight aria-hidden="true" />
                          </span>
                          <span className="trc-time-n">{durationText(part.ms)}</span>
                          <span className="trc-time-p">{percent(part.ms)}</span>
                        </button>
                        {more &&
                          part.slices.map((row) => (
                            <Fragment key={row.kind}>
                              {key('trc-time-sub', null, row, row.ms)}
                              {detailOf(row)}
                            </Fragment>
                          ))}
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <EmptyState
                inline
                title={
                  mode === 'wall'
                    ? t({
                        id: 'trace.time.emptyWall',
                        defaultMessage: 'No timed requests in this range.',
                      })
                    : t({
                        id: 'trace.time.emptyWork',
                        defaultMessage: 'No timed operations in this range.',
                      })
                }
              />
            )}
            {onEvidence && (data.partial || data.native === 'unavailable' || data.live) && (
              <footer className="trc-time-foot">
                {data.partial && (
                  <span>
                    {t({ id: 'trace.time.partial', defaultMessage: 'Partial trace coverage' })}
                  </span>
                )}
                {data.native === 'unavailable' && (
                  <span>
                    {t({ id: 'trace.time.noNative', defaultMessage: 'Native trace unavailable' })}
                  </span>
                )}
                {data.live && (
                  <span>
                    {t({ id: 'trace.time.live', defaultMessage: 'Includes running requests' })}
                  </span>
                )}
              </footer>
            )}
          </>
        ) : query.error ? (
          <Failure error={query.error} onRetry={query.reload} />
        ) : (
          <>
            <div className="trc-time-line">
              <Skeleton style={{ flex: '1 1 0', height: 10 }} />
              <Skeleton style={{ width: 40, height: 20 }} />
            </div>
            <div className="trc-time-keys">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} style={{ width: '60%', margin: '6px 0' }} />
              ))}
            </div>
          </>
        )}
      </div>
      {data && (gates || untimed || unplaced) && (
        <div className="cell trc-time-notes">
          {gates && (
            <>
              <div className="trc-time-note">
                <ShieldCheck aria-hidden="true" />
                <span>
                  {t({ id: 'trace.timeChart.gates', defaultMessage: 'Gates counted separately' })}
                </span>
                <span className="trc-time-n">{durationText(data.gate_ms)}</span>
              </div>
              <div className="trc-time-note">
                <span />
                <span className="trc-time-runs">
                  {t(
                    {
                      id: 'trace.timeChart.gateRuns',
                      defaultMessage:
                        '{count, plural, one {# run, not counted in the bar} other {# runs, not counted in the bar}}',
                    },
                    { count: data.gates },
                  )}
                </span>
              </div>
            </>
          )}
          {gates && (untimed || unplaced) && <hr />}
          {untimed && (
            <div className="trc-time-note" data-tone="wait">
              <CircleAlert aria-hidden="true" />
              <span>
                {t(
                  {
                    id: 'trace.timeChart.untimed',
                    defaultMessage:
                      '{untimed, plural, one {# of {total, number} calls has no timing} other {# of {total, number} calls have no timing}}',
                  },
                  { untimed: data.untimed_operations, total: data.operations },
                )}
              </span>
            </div>
          )}
          {unplaced && (
            <div className="trc-time-note">
              <Clock aria-hidden="true" />
              <span>
                {t(
                  {
                    id: 'trace.timeChart.unplaced',
                    defaultMessage:
                      "{count, plural, one {# call doesn't fit the wall clock} other {# calls don't fit the wall clock}}",
                  },
                  { count: data.unplaced_operations },
                )}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
