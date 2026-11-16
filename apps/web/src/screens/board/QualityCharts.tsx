import { useCallback, useRef, useState } from 'react';
import type { ReviewMetrics } from '@pantheon/domain';
import type { BoardModel, GateFirstPass, ProjectGatesHistory } from '@pantheon/protocol';
import { Tip } from '../../components/Tip';
import { shortId } from '../../data/format';
import { useQuery } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { useShell } from '../../store';
import { DataTable, Empty, Panel, runtimeColor, useFloatTip, ViewToggle } from './Charts';
import { Metric } from './KpiTiles';
import { durationText, runtimeName, whenText, type BoardMerge } from './panels-model';
import {
  gateState,
  gateTracker,
  MATRIX_COLUMNS,
  mergeTrack,
  reviewMatrix,
  type TrackCell,
  type TrackRun,
} from './quality-model';
import { QueryBody, useKindTick } from './Tables';
import { previousText, rangeDays } from './usage-model';
import './quality.css';

const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;

/* Review matrix */

export function ReviewMatrix({ rows }: { rows: readonly ReviewMetrics[] }) {
  return (
    <div
      className="ql-mx"
      role="table"
      aria-label={t({ id: 'board.reviewMatrix.title', defaultMessage: 'Review matrix' })}
    >
      <div className="ql-mxr ql-mxh" role="row">
        <span role="columnheader">
          {t({ id: 'board.reviewMatrix.reviewer', defaultMessage: 'Reviewer' })}
        </span>
        {MATRIX_COLUMNS.map((c) => (
          <span role="columnheader" key={c.key}>
            <i className="ql-sw" style={{ backgroundColor: c.color }} />
            {c.label}
          </span>
        ))}
      </div>
      {reviewMatrix(rows).map((r) => {
        const name = runtimeName(r.runtime);
        return (
          <div className="ql-mxr" role="row" key={r.runtime}>
            <span className="ql-rt" role="rowheader">
              <i className="bp-rtd" style={{ backgroundColor: runtimeColor(r.runtime) }} />
              {name}
            </span>
            {r.cells.map((c) => (
              <span className="ql-mxc" role="cell" key={c.key}>
                <span
                  className="ql-mxt"
                  role="img"
                  aria-label={`${name} ${c.label} ${c.count} / ${r.findings}`}
                >
                  <i className="ql-mxb" style={{ width: pct(c.share), backgroundColor: c.color }} />
                </span>
                <span className="ql-n">{c.count}</span>
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const projectParams = (project_id: string) => ({ project_id });
// Deleting a session also removes its reviews.
const reviewKind = (kind: string) => kind.startsWith('review.') || kind === 'session.deleted';
const acceptArray = <T,>(value: unknown): T[] | null =>
  Array.isArray(value) ? (value as T[]) : null;

export function ReviewMatrixPanel({ projectId }: { projectId: string }) {
  const [table, setTable] = useState(false);
  const tick = useKindTick(reviewKind);
  const query = useQuery(
    'project.review.metrics',
    projectId,
    projectParams,
    acceptArray<ReviewMetrics>,
    tick,
  );
  return (
    <Panel
      title={t({ id: 'board.reviewMatrix.title', defaultMessage: 'Review matrix' })}
      className="bp-tbl"
      tools={<ViewToggle table={table} onToggle={() => setTable(!table)} />}
    >
      <QueryBody query={query}>
        {(rows) =>
          rows.length === 0 ? (
            <Empty text={t({ id: 'board.reviewMatrix.empty', defaultMessage: 'No reviews yet' })} />
          ) : table ? (
            <DataTable
              head={[
                t({ id: 'board.reviewMatrix.reviewer', defaultMessage: 'Reviewer' }),
                t({ id: 'board.reviewMatrix.reviews', defaultMessage: 'Reviews' }),
                t({ id: 'board.reviewMatrix.findings', defaultMessage: 'Findings' }),
                t({ id: 'board.reviewMatrix.adoptedCount', defaultMessage: 'Adopted' }),
                t({ id: 'board.reviewMatrix.dismissedCount', defaultMessage: 'Dismissed' }),
                t({ id: 'board.reviewMatrix.unresolved', defaultMessage: 'Unresolved' }),
                t({ id: 'board.reviewMatrix.invalid', defaultMessage: 'Invalid' }),
              ]}
              rows={rows.map((r) => [
                runtimeName(r.runtime),
                String(r.reviews),
                String(r.findings),
                String(r.adopted),
                String(r.dismissed),
                String(r.unresolved),
                String(r.invalid),
              ])}
            />
          ) : (
            <ReviewMatrix rows={rows} />
          )
        }
      </QueryBody>
    </Panel>
  );
}

/* Merge track */

export function MergeTrack({
  merges,
  since,
  now,
  onOpenSession,
}: {
  merges: readonly BoardMerge[];
  since: number;
  now: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const tip = useFloatTip();
  const { marks, ticks } = mergeTrack(merges, since, now);
  return (
    <div className="ql-tk">
      <div
        className="ql-tka"
        role="group"
        aria-label={t(
          {
            id: 'board.mergeTrack.label',
            defaultMessage:
              '{count, plural, one {Merge timeline, # merge} other {Merge timeline, # merges}}',
          },
          { count: marks.length },
        )}
      >
        <i className="ql-tkl" />
        {marks.map((m) => {
          // The board names a deleted session with an empty title.
          const name =
            m.title ||
            t(
              { id: 'board.session.fallbackTitle', defaultMessage: 'Session {id}' },
              { id: shortId(m.session_id) },
            );
          const content = {
            head: m.sha,
            rows: [
              {
                label: t({ id: 'board.mergeTrack.session', defaultMessage: 'Session' }),
                value: name,
              },
              {
                label: t({ id: 'board.mergeTrack.merged', defaultMessage: 'Merged' }),
                value: whenText(m.merged_at, now),
              },
              {
                label: t({ id: 'board.mergeTrack.lines', defaultMessage: 'Lines changed' }),
                value: `+${m.additions} −${m.deletions}`,
              },
            ],
          };
          return (
            <button
              type="button"
              className="ql-mk"
              key={m.key}
              style={{ left: pct(m.x) }}
              aria-label={`${name} ${m.sha} +${m.additions} −${m.deletions}`}
              aria-describedby={tip.describedBy(m.key)}
              aria-disabled={!m.title || undefined}
              onClick={m.title ? () => onOpenSession(m.session_id) : undefined}
              onPointerMove={(e) => tip.show(e, content, m.key)}
              onPointerLeave={tip.hide}
              onFocus={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                tip.show({ clientX: r.left, clientY: r.top }, content, m.key);
              }}
              onBlur={tip.hide}
            >
              <i className="ql-add" style={{ height: pct(m.add * 0.42) }} />
              <i className="ql-dot" />
              <i className="ql-del" style={{ height: pct(m.del * 0.42) }} />
            </button>
          );
        })}
      </div>
      <div className="ql-tkx" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t.key} style={{ left: pct(t.x) }}>
            {t.label}
          </span>
        ))}
      </div>
      {tip.node}
    </div>
  );
}

/* Gate history */

type GateRuns = ProjectGatesHistory['runs'];

const CELL_FILL: Record<TrackCell['state'], string> = {
  passed: 'ok',
  failed: 'bad',
  timed_out: 'wait',
  skipped: 'none',
  absent: 'none',
};

const cellResult = (cell: TrackCell) =>
  cell.state === 'absent'
    ? t({ id: 'board.gateHistory.notRun', defaultMessage: 'Not run' })
    : cell.state === 'skipped'
      ? t({ id: 'board.gateStates.skipped', defaultMessage: 'Skipped' })
      : cell.state === 'timed_out'
        ? t({ id: 'board.gateStates.timedOut', defaultMessage: 'Timed out' })
        : t(
            { id: 'board.gateHistory.exitCode', defaultMessage: 'Exit code {code}' },
            { code: String(cell.exit_code ?? '—') },
          );

const rateText = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

/** Gate runs as a tracker: a row per command, a cell per run, and each command's pass rate. */
export function GateTracker({
  runs,
  selected,
  onRun,
}: {
  runs: Parameters<typeof gateTracker>[0];
  /** run_id of the column drawn with a border. */
  selected?: string;
  /** Without it a click opens the run's session on its checks tab. */
  onRun?: (run: TrackRun) => void;
}) {
  const openSession = useShell((s) => s.openSession);
  const { columns, rows } = gateTracker(runs);
  const now = Date.now();
  // Runs that overflow the tracker scroll; it opens on the newest, at the right end.
  const toNewest = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) el.scrollLeft = el.scrollWidth;
    },
    [columns.length],
  );
  return (
    <div
      className="ql-gt"
      role="group"
      aria-label={t(
        {
          id: 'board.gateHistory.label',
          defaultMessage: 'Gate history, last {count, plural, one {# run} other {# runs}}',
        },
        { count: columns.length },
      )}
    >
      <div className="ql-gtn">
        {rows.map((row) => (
          <span key={row.key} className="mono" title={row.name}>
            {row.name}
          </span>
        ))}
      </div>
      <div className="ql-gts" ref={toNewest}>
        <div className="ql-gtg">
          {rows.map((row, r) => (
            <div className="ql-gtr" key={row.key}>
              {row.cells.map((cell, i) => {
                const column = columns[i]!;
                const tip = listText(
                  whenText(Date.parse(column.finished_at), now),
                  cellResult(cell),
                );
                return (
                  <Tip key={cell.run_id} content={tip}>
                    <button
                      type="button"
                      className={`ql-tc ql-tc-${CELL_FILL[cell.state]}`}
                      aria-label={listText(row.name, column.commit, tip)}
                      aria-current={column.run_id === selected || undefined}
                      // One tab stop per run: every cell of a column opens the same run.
                      tabIndex={r === 0 ? 0 : -1}
                      onClick={() =>
                        onRun
                          ? onRun(column)
                          : openSession(column.session_id!, 'checks', column.run_id)
                      }
                    />
                  </Tip>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="ql-gtp">
        {rows.map((row) => (
          <span key={row.key}>{rateText(row.rate)}</span>
        ))}
      </div>
    </div>
  );
}

const acceptRuns = (value: unknown): GateRuns | null => {
  const runs = (value as { runs?: unknown } | null)?.runs;
  return Array.isArray(runs) ? (runs as GateRuns) : null;
};
const gateKind = (kind: string) =>
  kind === 'session.gate_checked' || kind === 'project.gate_set' || kind === 'session.deleted';

/** The project's gate runs started from `since` on, newest first, with the name of the range they were read for. */
function useGateRuns(projectId: string, since: number, range = '') {
  const tick = useKindTick(gateKind);
  const query = useQuery(
    'project.gates.history',
    `${projectId}:${since}`,
    () => ({ project_id: projectId, since: String(since), limit: '500' }),
    acceptRuns,
    tick,
  );
  // Within one project a new range shows the last range's runs until its own read lands.
  const last = useRef<{ projectId: string; query: typeof query; range: string } | null>(null);
  if (query.data) last.current = { projectId, query, range };
  const held = last.current;
  if (query.data || query.error || !held || held.projectId !== projectId)
    return { ...query, range };
  return {
    ...held.query,
    loading: false,
    refreshing: true,
    reload: query.reload,
    range: held.range,
  };
}

export function GateHistoryPanel({ projectId, since }: { projectId: string; since: number }) {
  const query = useGateRuns(projectId, since);
  return (
    <Panel title={t({ id: 'board.gateHistory.title', defaultMessage: 'Gate history' })}>
      <QueryBody query={query}>
        {(runs) =>
          runs.length === 0 ? (
            <Empty
              text={t({ id: 'board.gateHistory.empty', defaultMessage: 'No gate runs yet' })}
            />
          ) : (
            <GateTracker runs={runs} />
          )
        }
      </QueryBody>
    </Panel>
  );
}

/* Quality overview */

const firstPassText = (pass: GateFirstPass | undefined) =>
  pass && `${Math.round((pass.passed / pass.tasks) * 100)}%`;

export function QualityKpis({ model }: { model: BoardModel }) {
  // The same window as the backend's first-pass count.
  const retros = model.tasks.flatMap(({ retrospective: r }) =>
    r && (r.recorded_at ?? 0) >= model.since && (r.recorded_at ?? 0) <= model.now ? [r] : [],
  );
  const n = retros.length;
  const handbacks = retros.reduce((sum, r) => sum + r.handbacks, 0);
  const { median_ms, sample_count } = model.task_progress.cycle;
  const firstPass = model.counts.gate_first_pass;
  const before = previousText(
    rangeDays(model).length,
    firstPassText(model.counts.previous?.gate_first_pass),
  );
  return (
    <section
      className="bd-kpis"
      aria-label={t({ id: 'insights.quality.label', defaultMessage: 'Quality overview' })}
    >
      <Metric
        label={t({ id: 'insights.quality.firstPass', defaultMessage: 'Gates passed first time' })}
        text={firstPassText(firstPass) ?? '—'}
        note={
          firstPass &&
          t(
            {
              id: 'insights.quality.tasks',
              defaultMessage: '{count, plural, one {of # task} other {of # tasks}}',
            },
            { count: firstPass.tasks },
          )
        }
      >
        {before && <span className="bd-kpi-n">{before}</span>}
      </Metric>
      <Metric
        label={t({ id: 'insights.quality.rework', defaultMessage: 'Rework before merge' })}
        text={n ? (handbacks / n).toFixed(1) : '—'}
        note={
          n
            ? t(
                {
                  id: 'insights.quality.reworkUnit',
                  defaultMessage:
                    '{count, plural, one {rounds per task, of # task} other {rounds per task, of # tasks}}',
                },
                { count: n },
              )
            : undefined
        }
      />
      <Metric
        label={t({ id: 'insights.quality.cycle', defaultMessage: 'Start to merge' })}
        text={sample_count > 0 && median_ms !== null ? durationText(median_ms) : '—'}
        note={
          sample_count > 0 && median_ms !== null
            ? t(
                {
                  id: 'insights.quality.median',
                  defaultMessage:
                    '{count, plural, one {median of # task} other {median of # tasks}}',
                },
                { count: sample_count },
              )
            : undefined
        }
      />
    </section>
  );
}

/* Most failed gate steps */

const FAILED_STEPS = 5;

const median = (values: readonly number[]) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const stepTime = (ms: number) =>
  ms < 60_000
    ? t(
        { id: 'insights.gateFailures.seconds', defaultMessage: '{seconds}s' },
        { seconds: Math.round(ms / 1000) },
      )
    : durationText(ms);

/** The steps that failed most across the fetched gate runs; nothing when none failed. */
export function GateFailures({
  runs,
  range,
  flaky = [],
}: {
  runs: GateRuns;
  /** The name of the range the runs started in. */
  range: string;
  /** Steps that both passed and failed on one commit. */
  flaky?: readonly string[];
}) {
  const steps = new Map<string, { failed: number; times: number[] }>();
  for (const run of runs)
    for (const result of run.results) {
      const step = steps.get(result.name) ?? { failed: 0, times: [] };
      steps.set(result.name, step);
      if (gateState(result) === 'failed') step.failed++;
      if (result.duration_ms !== undefined) step.times.push(result.duration_ms);
    }
  const rows = [...steps]
    .filter(([, s]) => s.failed > 0)
    .sort(([a, x], [b, y]) => y.failed - x.failed || a.localeCompare(b))
    .slice(0, FAILED_STEPS);
  if (rows.length === 0) return null;
  const most = rows[0]![1].failed;
  return (
    <Panel
      title={t({ id: 'insights.gateFailures.title', defaultMessage: 'Most failed gate steps' })}
      num={
        <span className="bp-hn">
          {t(
            {
              id: 'insights.gateFailures.rangeRuns',
              defaultMessage: '{range}, {count, plural, one {# gate run} other {# gate runs}}',
            },
            { range, count: runs.length },
          )}
        </span>
      }
    >
      <div className="ql-fl">
        {rows.map(([name, step]) => (
          <div className="ql-fr" key={name}>
            {flaky.includes(name) ? (
              <span className="ql-fk">
                <span className="ql-fn" title={name}>
                  {name}
                </span>
                <span className="chip">
                  {t({ id: 'insights.gateFailures.flaky', defaultMessage: 'Flaky' })}
                </span>
              </span>
            ) : (
              <span className="ql-fn" title={name}>
                {name}
              </span>
            )}
            <span
              className="ql-ft"
              role="img"
              aria-label={t(
                {
                  id: 'insights.gateFailures.row',
                  defaultMessage: '{step} failed {count, plural, one {# time} other {# times}}',
                },
                { step: name, count: step.failed },
              )}
            >
              <i style={{ width: pct(step.failed / most) }} />
            </span>
            <span className="ql-fc">
              {t(
                {
                  id: 'insights.gateFailures.count',
                  defaultMessage: '{count, plural, one {# time} other {# times}}',
                },
                { count: step.failed },
              )}
            </span>
            {step.times.length > 0 && <span className="ql-fd">{stepTime(median(step.times))}</span>}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function GateFailuresPanel({
  projectId,
  since,
  range,
  flaky,
}: {
  projectId: string;
  since: number;
  range: string;
  /** Steps the board counts as flaky in the range. */
  flaky?: readonly string[];
}) {
  const runs = useGateRuns(projectId, since, range);
  return runs.data && <GateFailures runs={runs.data} range={runs.range} flaky={flaky} />;
}
