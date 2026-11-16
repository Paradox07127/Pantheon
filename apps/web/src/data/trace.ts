import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectHeatmap,
  ProjectTimeline,
  ProjectTrace,
  SessionTrace,
} from '@pantheon/protocol';
import type { TraceTimeAllocation } from '@pantheon/domain';
import { t } from '../i18n';
import { listedTitle } from '../lib/daemon-text';
import { useBoard } from './board';
import { failureText } from './needs-you';
import { changesBoard } from './board-view';
import { readQuery, useQuery, useRefetchTick } from './workbench-sessions';

type TraceSpan = SessionTrace['spans'][number];

/** Spans per session, with the sessions whose last read failed. */
export type RunSpans = ReadonlyMap<string, TraceSpan[]> & {
  readonly failed: ReadonlySet<string>;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly readAt: ReadonlyMap<string, number>;
  readonly reload: () => void;
  readonly errors: ReadonlyMap<string, string>;
};

const runSpans = (
  entries: Iterable<readonly [string, TraceSpan[]]>,
  failed: Iterable<string>,
  metadata: Pick<RunSpans, 'loading' | 'stale' | 'readAt' | 'reload' | 'errors'> = {
    loading: false,
    stale: false,
    readAt: new Map(),
    errors: new Map(),
    reload: () => {},
  },
): RunSpans => Object.assign(new Map(entries), { failed: new Set(failed), ...metadata });

const NO_SPANS: RunSpans = runSpans([], []);

/** Epoch ms bounds of a trace read; to null reads up to now. */
export interface TraceFetch {
  from: number;
  to: number | null;
  bucketMs: number;
}

const titled = <Lane extends Parameters<typeof listedTitle>[0]>(lane: Lane): Lane => ({
  ...lane,
  title: listedTitle(lane),
});

const acceptTrace = (value: unknown): ProjectTrace | null =>
  Array.isArray((value as Partial<ProjectTrace> | null)?.lanes) &&
  Array.isArray((value as Partial<ProjectTrace> | null)?.buckets)
    ? {
        ...(value as ProjectTrace),
        lanes: (value as ProjectTrace).lanes.map((row) => ({ ...row, lane: titled(row.lane) })),
      }
    : null;

const acceptHeatmap = (value: unknown): ProjectHeatmap | null =>
  Array.isArray((value as Partial<ProjectHeatmap> | null)?.days) &&
  Array.isArray((value as Partial<ProjectHeatmap> | null)?.lanes) &&
  Array.isArray((value as Partial<ProjectHeatmap> | null)?.commits) &&
  Array.isArray((value as Partial<ProjectHeatmap> | null)?.merges)
    ? { ...(value as ProjectHeatmap), lanes: (value as ProjectHeatmap).lanes.map(titled) }
    : null;

const acceptSessionTrace = (value: unknown): SessionTrace | null =>
  Array.isArray((value as Partial<SessionTrace> | null)?.spans) ? (value as SessionTrace) : null;

const acceptTimeline = (value: unknown): ProjectTimeline | null =>
  Array.isArray((value as Partial<ProjectTimeline> | null)?.sessions)
    ? (value as ProjectTimeline)
    : null;

/** A session's state over epoch ms; to null runs on to now. */
export interface StateInterval {
  state: ProjectTimeline['sessions'][number]['intervals'][number]['state'];
  from: number;
  to: number | null;
}

/** Each session's state intervals by session id. */
export const stateIntervals = (timeline: ProjectTimeline): ReadonlyMap<string, StateInterval[]> =>
  new Map(
    timeline.sessions.map((s) => [
      s.session_id,
      s.intervals.map((i) => ({
        state: i.state,
        from: Date.parse(i.from),
        to: i.to === null ? null : Date.parse(i.to),
      })),
    ]),
  );

/** Time the sessions spent waiting on the user within [from, to]. */
export function waitingMs(
  intervals: ReadonlyMap<string, readonly StateInterval[]>,
  from: number,
  to: number,
): number {
  let ms = 0;
  for (const list of intervals.values())
    for (const i of list)
      if (i.state === 'waiting')
        ms += Math.max(0, Math.min(i.to ?? to, to) - Math.max(i.from, from));
  return ms;
}

/** Each lane's wall-clock time in a project read of trace.time, by lane key. */
export const laneWallMs = (time: TraceTimeAllocation | null): ReadonlyMap<string, number> =>
  new Map(Object.entries(time?.by_lane ?? {}).map(([key, lane]) => [key, lane.wall_ms]));

/** A tick that moves when the native transcript index moves and after the project's board events. */
export function useTraceTick(projectId: string | null): number {
  const revision = useBoard((s) => s.trace_revision);
  const sequence = useBoard((s) => {
    if (!projectId) return 0;
    for (let i = s.events.length - 1; i >= 0; i--)
      if (
        s.events[i]!.project_id === projectId &&
        (changesBoard(s.events[i]!.kind) ||
          [
            'agent.context.compacted',
            'agent.background.changed',
            'workflow.step_changed',
            'task.dispatch_wait_changed',
            'turn.prepare_started',
          ].includes(s.events[i]!.kind))
      )
        return s.events[i]!.sequence;
    return 0;
  });
  const resync = useBoard((s) => s.resync);
  const tick = useRefetchTick(sequence, false);
  return tick + revision + resync;
}

/** Charts read bounded aggregates only while visible. */
export function useTraceTime(
  projectId: string | null,
  laneKey?: string,
  window?: Pick<TraceFetch, 'from' | 'to'>,
  now?: number,
) {
  const tick = useTraceTick(projectId);
  const from = window?.from,
    to = window?.to;
  return useQuery<TraceTimeAllocation>(
    'trace.time',
    projectId && JSON.stringify([projectId, laneKey, from, to]),
    () => ({
      project_id: projectId!,
      ...(laneKey && { lane_key: laneKey }),
      ...(from !== undefined && { from: new Date(from).toISOString() }),
      ...(to != null && { to: new Date(to).toISOString() }),
    }),
    (value) => {
      const result = value as TraceTimeAllocation | null;
      return Array.isArray(result?.wall) && Array.isArray(result.work) ? result : null;
    },
    tick + (to == null && now !== undefined ? Math.floor(now / 60_000) : 0),
    {},
    true,
  );
}

/**
 * The project's trace over the window; read again when the native transcript index moves and
 * after board events, which carry the Pantheon sessions' turns.
 */
export function useProjectTrace(
  projectId: string | null,
  window: TraceFetch,
): ReturnType<typeof useQuery<ProjectTrace>> {
  const tick = useTraceTick(projectId);
  return useQuery(
    'project.trace',
    projectId && `${projectId}:${window.from}:${window.to ?? ''}:${window.bucketMs}`,
    () => ({
      project_id: projectId!,
      from: new Date(window.from).toISOString(),
      ...(window.to !== null && { to: new Date(window.to).toISOString() }),
      bucket_ms: String(window.bucketMs),
    }),
    acceptTrace,
    tick,
    {},
    true,
  );
}

/** The project's session state intervals from `from` on, refreshed like the trace. */
export function useProjectTimeline(
  projectId: string | null,
  from: number,
): ReturnType<typeof useQuery<ProjectTimeline>> {
  const tick = useTraceTick(projectId);
  return useQuery(
    'project.timeline',
    projectId && `${projectId}:${from}`,
    () => ({ project_id: projectId!, since: new Date(from).toISOString() }),
    acceptTimeline,
    tick,
    {},
    true,
  );
}

/** Calls and commits per session and local day over the last days, refreshed like the trace. */
export function useProjectHeatmap(
  projectId: string | null,
  days: '7' | '30' | '90' | 'all',
): ReturnType<typeof useQuery<ProjectHeatmap>> {
  const tick = useTraceTick(projectId);
  return useQuery(
    'project.heatmap',
    projectId && `${projectId}:${days}`,
    () => ({ project_id: projectId!, days }),
    acceptHeatmap,
    tick,
    {},
    true,
  );
}

/** Every span of one lane; none read while laneKey is null. Read again like the project trace. */
export function useSessionTrace(
  projectId: string | null,
  laneKey: string | null,
): ReturnType<typeof useQuery<SessionTrace>> {
  const tick = useTraceTick(projectId);
  return useQuery(
    'session.trace',
    projectId && laneKey && `${projectId}:${laneKey}`,
    () => ({ project_id: projectId!, lane_key: laneKey! }),
    acceptSessionTrace,
    tick,
    {},
    true,
  );
}

/**
 * Every span of each session, read in parallel like the project trace, on reconnect and when the
 * ids change. A session keeps its last spans while a read runs and after a read fails.
 */
export function useRunSpans(projectId: string | null, sessionIds: readonly string[]): RunSpans {
  const tick = useTraceTick(projectId);
  const live = useBoard((s) => s.status.state === 'live');
  // Counts the times the stream went live, so a disconnect alone reads nothing.
  const reconnects = useRef({ live, count: 0 });
  if (reconnects.current.live !== live)
    reconnects.current = { live, count: reconnects.current.count + (live ? 1 : 0) };
  const reconnected = reconnects.current.count;
  const ids = sessionIds.join('\n');
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const [state, setState] = useState<{ projectId: string | null; spans: RunSpans }>({
    projectId: null,
    spans: NO_SPANS,
  });
  const wanted = useRef({ projectId, ids });
  wanted.current = { projectId, ids };
  // A replaced or unmounted effect invalidates every outstanding response it started.
  const runs = useRef({ started: 0 });

  useEffect(() => {
    if (!projectId) return;
    const run = ++runs.current.started;
    const lanes = ids ? ids.split('\n') : [];
    setState((was) => ({
      projectId,
      spans: runSpans(
        was.projectId === projectId ? [...was.spans].filter(([id]) => lanes.includes(id)) : [],
        was.projectId === projectId ? [...was.spans.failed].filter((id) => lanes.includes(id)) : [],
        {
          loading: lanes.length > 0,
          stale: was.projectId === projectId && was.spans.stale,
          readAt: was.projectId === projectId ? was.spans.readAt : new Map(),
          errors: was.projectId === projectId ? was.spans.errors : new Map(),
          reload,
        },
      ),
    }));
    void Promise.all(
      lanes.map(async (id) => {
        const result = await readQuery('session.trace', { project_id: projectId, lane_key: id });
        const trace = result.ok ? acceptSessionTrace(result.value) : null;
        return [
          id,
          trace,
          trace
            ? null
            : result.ok
              ? t(
                  {
                    id: 'data.read.incomplete',
                    defaultMessage: 'Incomplete read result ({method})',
                  },
                  { method: 'session.trace' },
                )
              : failureText(result.error),
        ] as const;
      }),
    ).then((read) => {
      // Only the newest requested observation may replace this scope's evidence.
      const now = wanted.current;
      if (now.projectId !== projectId || now.ids !== ids || run !== runs.current.started) return;
      setState((was) => {
        const kept = was.projectId === projectId ? was.spans : NO_SPANS;
        return {
          projectId,
          spans: runSpans(
            read.flatMap(([id, trace]) => {
              const spans = trace?.spans ?? kept.get(id);
              return spans ? [[id, spans] as const] : [];
            }),
            read.flatMap(([id, trace]) => (trace ? [] : [id])),
            {
              loading: false,
              stale: read.some(([id, trace]) => trace === null && kept.has(id)),
              reload,
              errors: new Map(
                read.flatMap(([id, , error]) => (error ? [[id, error] as const] : [])),
              ),
              readAt: new Map(
                read.flatMap(([id, trace]) => {
                  const at = trace ? Date.now() : kept.readAt.get(id);
                  return at === undefined ? [] : [[id, at] as const];
                }),
              ),
            },
          ),
        };
      });
    });
    return () => {
      if (runs.current.started === run) runs.current.started++;
    };
  }, [projectId, ids, tick, reconnected, attempt]);

  const shown = state.projectId === projectId ? state.spans : NO_SPANS;
  return useMemo(() => {
    const wanted = new Set(ids ? ids.split('\n') : []);
    return runSpans(
      [...shown].filter(([id]) => wanted.has(id)),
      [...shown.failed].filter((id) => wanted.has(id)),
      {
        loading: shown.loading,
        stale: shown.stale || (!live && shown.size > 0),
        readAt: shown.readAt,
        errors: shown.errors,
        reload,
      },
    );
  }, [shown, ids, live, reload]);
}

/** One turn's spans, the turn span among them; none read while either id is null. */
export function useTurnSteps(
  projectId: string | null,
  laneKey: string | null,
  turnId: string | null,
): ReturnType<typeof useQuery<SessionTrace>> {
  const tick = useTraceTick(projectId);
  return useQuery(
    'session.trace',
    projectId && laneKey && turnId && `${projectId}:${laneKey}:${turnId}`,
    () => ({ project_id: projectId!, lane_key: laneKey!, turn: turnId! }),
    acceptSessionTrace,
    tick,
    {},
    true,
  );
}
