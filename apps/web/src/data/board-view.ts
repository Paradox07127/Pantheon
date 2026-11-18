import { useEffect, useRef, useState } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { useBoard } from './board';
import { touchesNeedsYou, useMidnights } from './needs-you';
import type { DaemonEvent } from './sync';
import { useQuery, useRefetchTick } from './workbench-sessions';

const acceptView = (value: unknown): BoardModel | null =>
  Array.isArray((value as Partial<BoardModel> | null)?.tasks) ? (value as BoardModel) : null;

// Session states, merges, usage, goals, milestones, review findings, plans, claims and worker reports.
const BOARD_PREFIXES = [
  'goal.',
  'session.',
  'turn.',
  'workspace.',
  'approval.',
  'change_story.',
  'milestone.',
  'review.',
];
const BOARD_KINDS: ReadonlySet<string> = new Set([
  'agent.session.started',
  'agent.tool.started',
  'agent.tool.completed',
  'agent.usage.updated',
  'agent.quota.updated',
  'board.plan_updated',
  'board.plan_transferred',
  'task.accepted',
  'task.reported',
  'task.start_requested',
  'task.stop_requested',
  'task.dispatch_failed',
  'task.dispatched',
  'task.claimed',
  'task.released',
  'task.messaged',
  'board.lead_wake_failed',
  'lead.note_added',
]);

/** Whether an event of this kind can change what the board view shows. */
export const changesBoard = (kind: string): boolean =>
  BOARD_KINDS.has(kind) ||
  BOARD_PREFIXES.some((prefix) => kind.startsWith(prefix)) ||
  // The board view carries the needs-you list.
  touchesNeedsYou(kind);

export function newest(events: readonly DaemonEvent[], projectId: string): DaemonEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--)
    if (events[i]!.project_id === projectId && changesBoard(events[i]!.kind)) return events[i];
  return undefined;
}

/**
 * The project's board over the last `days` days, or the `days` days through the local day `until`;
 * read again after events that change it.
 */
export function useBoardView(
  projectId: string | null,
  days: 1 | 3 | 7 | 14 | 30 | 'all',
  until?: string,
): ReturnType<typeof useQuery<BoardModel>> {
  const sequence = useBoard((s) => (projectId ? (newest(s.events, projectId)?.sequence ?? 0) : 0));
  const resync = useBoard((s) => s.resync);
  const tick = useRefetchTick(sequence, false);
  const [clockTick, setClockTick] = useState(0);
  // The last `days` days move at local midnight, even on an idle board.
  const midnights = useMidnights();
  const live = useBoard((s) => s.status.state === 'live');
  const key = projectId && `${projectId}:${days}${until ? `:${until}` : ''}`;
  const query = useQuery(
    'board.view',
    key,
    () => ({ project_id: projectId!, days: String(days), ...(until && { until }) }),
    acceptView,
    tick + resync + clockTick + (until ? 0 : midnights),
    {},
    true,
  );
  // Quiet health and other time-based activity can change without a new daemon event.
  // An active board gets a bounded read; idle boards and disconnected clients do not poll.
  const activity = useRef({ key, active: false });
  if (activity.current.key !== key) activity.current = { key, active: false };
  if (query.data)
    activity.current.active =
      query.data.tasks.some((task) => task.turn_running) ||
      (query.data.leads?.some((lead) => lead.state === 'running') ?? false);
  // A failed read must keep the retry alive until a fresh board says the work ended.
  const active = live && activity.current.active;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setClockTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [active, query.data]);
  // Within one project a new range shows the last range's board until its own read lands.
  const last = useRef<{ projectId: string | null; query: typeof query } | null>(null);
  if (query.data) last.current = { projectId, query };
  const held = last.current;
  if (query.data || query.error || !held || held.projectId !== projectId) return query;
  return { ...held.query, loading: false, refreshing: true, reload: query.reload };
}
