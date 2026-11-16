import type { EffortLevel, Retrospective, TaskKind } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { agentAttempt } from './improvement-signals.js';

export interface RoutingCandidateStats {
  runtime: string;
  model: string;
  effort?: EffortLevel;
  /** Tasks in the cell that ran the gate, or failed without the user stopping them. */
  n: number;
  /** Of those, the tasks whose first gate run passed. */
  s: number;
  /** Median input plus output tokens of the task sessions; absent when no task recorded usage. */
  median_tokens?: number;
}
export interface RoutingCellStats extends TaskKind {
  candidates: RoutingCandidateStats[];
}

export const candidateKey = (candidate: { runtime: string; model: string; effort?: string }) =>
  JSON.stringify([candidate.runtime, candidate.model, candidate.effort ?? null]);

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b),
    middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The project's finished, gated tasks per (domain, tier) and (runtime, model, effort), from retrospectives. */
export function routingStats(ctx: ControlContext, projectId: string): RoutingCellStats[] {
  const cells = new Map<
    string,
    TaskKind & { candidates: Map<string, RoutingCandidateStats & { tokens: number[] }> }
  >();
  for (const row of ctx.store.list<Retrospective>('retrospectives')) {
    const kind = row.measured_kind ?? row.planned_kind;
    if (
      row.project_id !== projectId ||
      row.outcome === 'removed' ||
      !row.runtime ||
      !row.model ||
      // A failed attempt without a gate run counts as a run whose first gate did not pass.
      (row.gate_passed_on_attempt === undefined &&
        !row.gate_failures?.length &&
        !(row.outcome === 'failed' && agentAttempt(row))) ||
      !kind
    )
      continue;
    const cellKey = `${kind.domain}:${kind.tier}`;
    const cell = cells.get(cellKey) ?? { ...kind, candidates: new Map() };
    cells.set(cellKey, cell);
    const key = candidateKey({ runtime: row.runtime, model: row.model, effort: row.effort });
    const candidate = cell.candidates.get(key) ?? {
      runtime: row.runtime,
      model: row.model,
      ...(row.effort ? { effort: row.effort } : {}),
      n: 0,
      s: 0,
      tokens: [],
    };
    cell.candidates.set(key, candidate);
    candidate.n++;
    if (row.gate_passed_on_attempt === 1) candidate.s++;
    if (row.task_usage)
      candidate.tokens.push(row.task_usage.input_tokens + row.task_usage.output_tokens);
  }
  return [...cells.values()].map(({ domain, tier, candidates }) => ({
    domain,
    tier,
    candidates: [...candidates.values()].map(({ tokens, ...candidate }) => {
      const tokenMedian = median(tokens);
      return tokenMedian === undefined ? candidate : { ...candidate, median_tokens: tokenMedian };
    }),
  }));
}
