import type { ProjectGateRun, SessionGateRun } from '@pantheon/protocol';
import { t } from '../i18n';

/* Gate history */

export const GATE_RUNS = 30;

/** A project run names its session or its landing's branch; a session's own runs do not. */
type GateRun = SessionGateRun &
  Pick<ProjectGateRun, 'session_id' | 'session_title' | 'landing_id' | 'branch'>;
type GateState = 'passed' | 'failed' | 'timed_out' | 'skipped';

export const GATE_STATES: Record<GateState, { label: string }> = {
  passed: {
    get label() {
      return t({ id: 'board.gateStates.passed', defaultMessage: 'Passed' });
    },
  },
  failed: {
    get label() {
      return t({ id: 'board.gateStates.failed', defaultMessage: 'Failed' });
    },
  },
  timed_out: {
    get label() {
      return t({ id: 'board.gateStates.timedOut', defaultMessage: 'Timed out' });
    },
  },
  skipped: {
    get label() {
      return t({ id: 'board.gateStates.skipped', defaultMessage: 'Skipped' });
    },
  },
};

export const gateState = (r: GateRun['results'][number]): GateState =>
  r.skipped ? 'skipped' : r.timed_out ? 'timed_out' : r.exit_code === 0 ? 'passed' : 'failed';

/** A run as a tracker column. */
export interface TrackRun {
  run_id: string;
  session_id?: string;
  session_title?: string;
  landing_id?: string;
  branch?: string;
  commit: string;
  finished_at: string;
}

/** One command in one run; absent when the run had no such command. */
export interface TrackCell {
  run_id: string;
  state: GateState | 'absent';
  exit_code: number | null;
}

export interface TrackRow {
  /** The name and its occurrence in a run, so commands that share a name keep their own rows. */
  key: string;
  name: string;
  cells: TrackCell[];
  /** Passed runs out of those the command ran in, over all the given runs; null when it never ran. */
  rate: number | null;
}

/**
 * The latest runs as columns, oldest first so the newest sits at the right, and one row per
 * command in the newest run's order, then the commands only older shown runs had.
 */
export function gateTracker(runs: readonly GateRun[]): { columns: TrackRun[]; rows: TrackRow[] } {
  const latest = runs.slice(0, GATE_RUNS);
  const keyed = (run: GateRun) => {
    const seen = new Map<string, number>();
    return run.results.map((result) => {
      const n = seen.get(result.name) ?? 0;
      seen.set(result.name, n + 1);
      return { key: `${result.name}\0${n}`, name: result.name, result };
    });
  };
  const names = [
    ...new Map(latest.flatMap((run) => keyed(run).map((r) => [r.key, r.name] as const))),
  ];
  const shown = latest.slice().reverse();
  const columns = shown.map((run) => ({
    run_id: run.run_id,
    session_id: run.session_id,
    session_title: run.session_title,
    landing_id: run.landing_id,
    branch: run.branch,
    commit: run.commit.slice(0, 7),
    finished_at: run.finished_at,
  }));
  const rows = names.map(([key, name]) => {
    const cells = shown.map((run): TrackCell => {
      const result = keyed(run).find((r) => r.key === key)?.result;
      return {
        run_id: run.run_id,
        state: result ? gateState(result) : 'absent',
        exit_code: result?.exit_code ?? null,
      };
    });
    const ran = runs
      .flatMap((run) => keyed(run).find((r) => r.key === key)?.result ?? [])
      .map(gateState)
      .filter((state) => state !== 'skipped');
    return {
      key,
      name,
      cells,
      rate: ran.length ? ran.filter((state) => state === 'passed').length / ran.length : null,
    };
  });
  return { columns, rows };
}
