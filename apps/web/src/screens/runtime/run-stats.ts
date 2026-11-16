import type { ProjectTrace, ProjectTraceStats, SessionTrace } from '@pantheon/protocol';
import { runStats, type RunForest, type RunNode } from './run-tree';

type TraceSpan = SessionTrace['spans'][number];

/** The figures strip above the runs table. */
export interface RunFigures {
  /** Model calls, tool calls and subagents. */
  calls: number;
  /** null when the source does not report them. */
  failed: number | null;
  /** Of the finished calls, ms; null without any, or when the source does not report them. */
  median: number | null;
  p95: number | null;
  tokens: number;
  /** Ended turns that reported no tokens; tokens leaves them out. */
  unreported: number;
  /** Cache reads over input plus cache reads; null when none were reported or nothing was read. */
  cacheHit: number | null;
  /** Calls started in each bucket, oldest first. */
  spark: number[];
}

/** The now view's spark: calls per minute over the last ten minutes. */
export const SPARK_BUCKETS = 10;
export const SPARK_BUCKET_MS = 60_000;

const CALL_KINDS = new Set<TraceSpan['kind']>(['llm', 'tool', 'subagent']);

/** The value at or below which a share q of the sorted values falls. */
const rank = (sorted: readonly number[], q: number) =>
  sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;

const share = (input: number, cacheRead: number | undefined) =>
  cacheRead === undefined || input + cacheRead === 0 ? null : cacheRead / (input + cacheRead);

function* sessionsOf(nodes: readonly RunNode[]): Generator<RunNode> {
  for (const node of nodes) {
    if (node.kind === 'subagent') continue;
    yield node;
    yield* sessionsOf(node.children);
  }
}

/** The figures of the forest's sessions from their spans. */
export function liveFigures(
  forest: RunForest,
  spans: ReadonlyMap<string, readonly TraceSpan[]>,
  now: number,
): RunFigures {
  const roots = [...forest.trees, ...forest.adhoc];
  const spark = Array.from({ length: SPARK_BUCKETS }, () => 0);
  const durations: number[] = [];
  let calls = 0;
  let failed = 0;
  let input = 0;
  let cacheRead: number | undefined;
  for (const node of sessionsOf(roots)) {
    const own = spans.get(node.id) ?? [];
    // A turn's own usage, else its model calls', as the project trace totals count it.
    const reported = new Set(
      own.flatMap((span) => (span.kind === 'turn' && span.tokens ? [span.id] : [])),
    );
    for (const span of own) {
      if (
        span.tokens &&
        (span.kind === 'turn' || (span.kind === 'llm' && !reported.has(span.turn)))
      ) {
        input += span.tokens.input;
        if (span.tokens.cache_read !== undefined)
          cacheRead = (cacheRead ?? 0) + span.tokens.cache_read;
      }
      if (!CALL_KINDS.has(span.kind)) continue;
      calls += 1;
      if (span.status === 'error') failed += 1;
      if (span.status !== 'running' && span.start !== null && span.end !== null)
        durations.push(span.duration_ms ?? span.end - span.start);
      if (span.start === null || span.start > now) continue;
      const at = SPARK_BUCKETS - 1 - Math.floor((now - span.start) / SPARK_BUCKET_MS);
      if (at >= 0) spark[at]! += 1;
    }
  }
  durations.sort((a, b) => a - b);
  const { tokens, unreported } = runStats(roots, now);
  return {
    calls,
    failed,
    median: durations.length ? rank(durations, 0.5) : null,
    p95: durations.length ? rank(durations, 0.95) : null,
    tokens,
    unreported,
    cacheHit: share(input, cacheRead),
    spark,
  };
}

/**
 * The figures of a project trace; its durations are of tool calls only, and its failures the failed
 * tool calls of the trace stats over the same range, unknown without them.
 */
export function rangeFigures(
  trace: Pick<ProjectTrace, 'stats' | 'buckets'>,
  counted?: Pick<ProjectTraceStats, 'failed_tool_calls'> | null,
): RunFigures {
  const { stats } = trace;
  return {
    calls: stats.llm + stats.tool,
    failed: counted?.failed_tool_calls ?? null,
    median: stats.tool_duration_p50_ms ?? null,
    p95: stats.tool_duration_p95_ms ?? null,
    tokens: stats.tokens.input + stats.tokens.output,
    unreported: 0,
    cacheHit: share(stats.tokens.input, stats.tokens.cache_read),
    spark: trace.buckets.map((bucket) => bucket.llm + bucket.tool),
  };
}

/**
 * The range figures of one session's lane: its failures are its failed spans less its failed turns,
 * and it has no spark, as the trace buckets only the whole project.
 */
export function laneFigures(lane: ProjectTrace['lanes'][number]): RunFigures {
  const failedTurns = lane.turns.filter((turn) => turn.status === 'error').length;
  return rangeFigures(
    { stats: lane.stats, buckets: [] },
    { failed_tool_calls: lane.stats.error - failedTurns },
  );
}
