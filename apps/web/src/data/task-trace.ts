import type { TaskTraceEntry } from '@pantheon/protocol';
import { useBoard } from './board';
import { changesBoard } from './board-view';
import type { DaemonEvent } from './sync';
import { useQuery, useRefetchTick, type QueryState } from './workbench-sessions';

export type { TaskTraceEntry };

const acceptTrace = (value: unknown): TaskTraceEntry[] | null =>
  Array.isArray(value) &&
  value.every(
    (entry: Partial<TaskTraceEntry> | null) =>
      typeof entry?.at === 'number' && typeof entry.kind === 'string',
  )
    ? (value as TaskTraceEntry[])
    : null;

const payloadSession = (event: DaemonEvent): unknown =>
  event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>).session_id
    : undefined;

/** Splits a board plan task id `<lead session id>:<task id>`. */
export function planTaskIds(boardTaskId: string): { lead: string; task: string } {
  const at = boardTaskId.indexOf(':');
  return { lead: boardTaskId.slice(0, at), task: boardTaskId.slice(at + 1) };
}

/**
 * GET /v1/task.trace for a plan task, read again after board events on the lead's plan or on the
 * task's sessions. A failed read has no data, so it never shows as an empty trace.
 */
export function useTaskTrace(
  project_id: string | null,
  boardTaskId: string,
  sessionIds: readonly string[],
): QueryState<TaskTraceEntry[]> {
  const { lead, task } = planTaskIds(boardTaskId);
  const sequence = useBoard((s) => {
    if (!project_id) return 0;
    for (let i = s.events.length - 1; i >= 0; i--) {
      const event = s.events[i]!;
      if (
        event.project_id === project_id &&
        changesBoard(event.kind) &&
        (event.aggregate_id === lead ||
          sessionIds.includes(event.aggregate_id) ||
          sessionIds.includes(payloadSession(event) as string))
      )
        return event.sequence;
    }
    return 0;
  });
  const tick = useRefetchTick(sequence, false);
  return useQuery(
    'task.trace',
    project_id && JSON.stringify([project_id, lead, task]),
    () => ({ project_id: project_id!, lead_session_id: lead, task_id: task }),
    acceptTrace,
    tick,
  );
}
