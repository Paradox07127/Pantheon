import type { TaskThreadEntry } from '@pantheon/domain';
import { useBoard } from './board';
import type { DaemonEvent } from './sync';
import { planTaskIds } from './task-trace';
import { useQuery, useRefetchTick, type QueryState } from './workbench-sessions';

export type { TaskThreadEntry };

/** The event kinds task.thread reads its entries from. */
const THREAD_KINDS: ReadonlySet<string> = new Set([
  'turn.queued',
  'task.reported',
  'review.finding_recorded',
  'lead.question_asked',
  'lead.question_answered',
  'lead.question_overruled',
  'lead.note_added',
  'session.gate_checked',
  'task.dispatched',
  'task.handed_back',
  'session.merged',
  'session.merge_blocked',
]);

const acceptThread = (value: unknown): TaskThreadEntry[] | null =>
  Array.isArray(value) &&
  value.every(
    (entry: Partial<TaskThreadEntry> | null) =>
      typeof entry?.event_id === 'string' &&
      typeof entry.at === 'number' &&
      typeof entry.kind === 'string',
  )
    ? (value as TaskThreadEntry[])
    : null;

const payloadSession = (event: DaemonEvent): unknown =>
  event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>).session_id
    : undefined;

/**
 * GET /v1/task.thread for a plan task, read again after an event of a thread kind on the lead or on
 * the task's sessions. A failed read has no data, so it never shows as an empty thread.
 */
export function useTaskThread(
  project_id: string | null,
  boardTaskId: string,
  sessionIds: readonly string[],
): QueryState<TaskThreadEntry[]> {
  const { lead, task } = planTaskIds(boardTaskId);
  const sequence = useBoard((s) => {
    if (!project_id) return 0;
    for (let i = s.events.length - 1; i >= 0; i--) {
      const event = s.events[i]!;
      if (
        event.project_id === project_id &&
        THREAD_KINDS.has(event.kind) &&
        // A finding's event names its review, not the reviewed session.
        (event.kind === 'review.finding_recorded' ||
          event.aggregate_id === lead ||
          sessionIds.includes(event.aggregate_id) ||
          sessionIds.includes(payloadSession(event) as string))
      )
        return event.sequence;
    }
    return 0;
  });
  const tick = useRefetchTick(sequence, false);
  return useQuery(
    'task.thread',
    project_id && JSON.stringify([project_id, lead, task]),
    () => ({ project_id: project_id!, lead_session_id: lead, task_id: task }),
    acceptThread,
    tick,
  );
}
