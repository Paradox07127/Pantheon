import type { ReviewMetrics } from '@pantheon/domain';
import type { ProjectGateRun } from '@pantheon/protocol';
import { compareRuntimes } from '../../components/RuntimeGlyph';
import { GATE_RUNS, gateState } from '../../lib/gate-model';

/* Gate quality */

const failing = (r: ProjectGateRun['results'][number]) => {
  const state = gateState(r);
  return state === 'failed' || state === 'timed_out';
};

export interface FlakyStep {
  key: string;
  name: string;
  /** Commits on which the step both passed and failed. */
  commits: number;
}

/**
 * Gate quality over project runs, newest first.
 *
 * First pass: each session or landing counts once, by its run the daemon marks `first`, its first
 * over all recorded history; it passed when no step of that run failed or timed out. An owner whose
 * first run is not among the runs given does not count. A landing keeps only one run, marked first.
 *
 * Flaky: a step, by name and command, that both passed and failed (or timed out) on the same
 * commit within the newest `GATE_RUNS` runs, in any order and in any session or landing; a skipped
 * step and a run without a commit count for neither.
 */
export function gateQuality(runs: readonly ProjectGateRun[]): {
  firstPass: { passed: number; total: number };
  flaky: FlakyStep[];
} {
  const owners = runs.filter((run) => run.first);
  const seen = new Map<string, { name: string; by: Map<string, Set<'passed' | 'failed'>> }>();
  for (const run of runs.slice(0, GATE_RUNS)) {
    if (!run.commit) continue;
    for (const r of run.results) {
      if (gateState(r) === 'skipped') continue;
      const key = `${r.name}\0${r.command.join(' ')}`;
      const step = seen.get(key) ?? { name: r.name, by: new Map() };
      seen.set(key, step);
      const outcomes = step.by.get(run.commit) ?? new Set();
      step.by.set(run.commit, outcomes.add(failing(r) ? 'failed' : 'passed'));
    }
  }
  const flaky = [...seen]
    .map(([key, step]) => ({
      key,
      name: step.name,
      commits: [...step.by.values()].filter((outcomes) => outcomes.size === 2).length,
    }))
    .filter((step) => step.commits > 0)
    .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
  return {
    firstPass: {
      passed: owners.filter((run) => !run.results.some(failing)).length,
      total: owners.length,
    },
    flaky,
  };
}

/* Review matrix */

type MatrixKey = 'unresolved' | 'adopted' | 'dismissed' | 'invalid';

const MATRIX_COUNT: Record<MatrixKey, (r: ReviewMetrics) => number> = {
  unresolved: (r) => r.unresolved,
  adopted: (r) => r.fixed,
  dismissed: (r) => r.intentional + r.not_worth_it + r.wrong,
  invalid: (r) => r.invalid,
};

export const MATRIX_COLUMNS: readonly { key: MatrixKey; color: string }[] = [
  { key: 'unresolved', color: 'var(--wait)' },
  { key: 'adopted', color: 'var(--ok)' },
  { key: 'dismissed', color: 'var(--idle)' },
  { key: 'invalid', color: 'var(--bad)' },
];

export interface MatrixRow {
  runtime: string;
  findings: number;
  /** Adopted findings as a share of all this runtime recorded; null without findings. */
  adoption: number | null;
  cells: { key: MatrixKey; color: string; count: number; share: number }[];
}

/**
 * One row per reviewer runtime; each outcome as a share of that runtime's findings, rejected ones
 * included. Adopted is fixed; dismissed is intentional, not worth it and wrong.
 */
export function reviewMatrix(rows: readonly ReviewMetrics[]): MatrixRow[] {
  return rows
    .slice()
    .sort((a, b) => compareRuntimes(a.runtime, b.runtime))
    .map((r) => ({
      runtime: r.runtime,
      findings: r.findings,
      adoption: r.findings ? r.fixed / r.findings : null,
      cells: MATRIX_COLUMNS.map((c) => {
        const count = MATRIX_COUNT[c.key](r);
        return { ...c, count, share: r.findings ? count / r.findings : 0 };
      }),
    }));
}
