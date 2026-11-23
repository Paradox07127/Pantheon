import { useCallback } from 'react';
import { Tip } from '../../components/Tip';
import { t } from '../../i18n';
import { gateTracker, type TrackCell, type TrackRun } from '../../lib/gate-model';
import { listText } from '../../lib/list-text';
import { dayText } from '../../lib/time-text';
import { useShell } from '../../store';
import './gate-tracker.css';

const CELL_FILL: Record<TrackCell['state'], string> = {
  passed: 'ok',
  failed: 'bad',
  timed_out: 'bad',
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
                  column.branch ?? column.session_title,
                  dayText(Date.parse(column.finished_at), now, { time: true }),
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
