import { useMemo } from 'react';
import type { ProjectTrace, ProjectTraceStats, SessionTrace } from '@pantheon/protocol';
import { sessionNode, type RunForest, type RunStatus } from '../screens/runtime/run-tree';
import { useProjectTrace, useRunSpans, useTraceTick } from './trace';
import { useQuery } from './workbench-sessions';

type TraceSpan = SessionTrace['spans'][number];

/** The history view's spark: calls per ten minutes, widened by the daemon for long ranges. */
export const HISTORY_BUCKET_MS = 600_000;

const TURN_STATUS: Record<TraceSpan['status'], RunStatus> = {
  running: 'running',
  error: 'error',
  ok: 'ok',
  unknown: 'idle',
};

/**
 * One session per lane with a turn in the range, newest first, with its newest turn's state, the
 * lane's tokens and the calls of read spans; with sessionId only that session's lane.
 */
export function historyForest(
  lanes: ProjectTrace['lanes'],
  spans: ReadonlyMap<string, readonly TraceSpan[]>,
  sessionId: string | null,
): RunForest {
  const nodes = lanes
    .filter(
      ({ lane }) => sessionId === null || lane.key === sessionId || lane.session_id === sessionId,
    )
    .map(({ lane, stats, turns }) => {
      const newest = turns.at(-1) ?? null;
      // session.trace reads the whole lane; only the turns in the range belong to this row.
      const ranged = new Set(turns.map((turn) => turn.id));
      const node = sessionNode(
        {
          id: lane.key,
          kind: 'session',
          runtime: lane.runtime,
          title: lane.title,
          model: null,
          status: TURN_STATUS[newest?.status ?? 'unknown'],
          phase: null,
          start: newest?.start ?? null,
          end: newest?.end ?? null,
          taskId: null,
        },
        (spans.get(lane.key) ?? []).filter((span) => ranged.has(span.turn)),
        [],
      );
      node.tokens = stats.tokens.input + stats.tokens.output;
      return node;
    })
    .sort((a, b) => (b.start ?? -Infinity) - (a.start ?? -Infinity));
  return { trees: [], adhoc: nodes };
}

const acceptStats = (value: unknown): ProjectTraceStats | null =>
  typeof (value as Partial<ProjectTraceStats> | null)?.failed_tool_calls === 'number'
    ? (value as ProjectTraceStats)
    : null;

/**
 * The history view's reads: the project trace and its stats over range, nothing while range is
 * null, and the spans of the lanes in open. A range without its end reaches to the time of the read.
 */
export function useRunHistory(
  projectId: string | null,
  range: { from: number; to: number | null } | null,
  open: readonly string[],
  sessionId: string | null,
) {
  const trace = useProjectTrace(range ? projectId : null, {
    from: range?.from ?? 0,
    to: range?.to ?? null,
    bucketMs: HISTORY_BUCKET_MS,
  });
  const tick = useTraceTick(projectId);
  const stats = useQuery(
    'project.trace.stats',
    projectId && range && `${projectId}:${range.from}:${range.to ?? ''}`,
    () => ({
      project_id: projectId!,
      since: String(range!.from),
      until: String(range!.to ?? Date.now()),
    }),
    acceptStats,
    tick,
    {},
    true,
  );
  const spans = useRunSpans(projectId, open);
  const lanes = trace.data?.lanes;
  const forest = useMemo(
    () => historyForest(lanes ?? [], spans, sessionId),
    [lanes, spans, sessionId],
  );
  return { trace, stats, spans, forest };
}
