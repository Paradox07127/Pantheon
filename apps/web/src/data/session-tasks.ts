import type { SessionTasks } from '@pantheon/protocol';
import { useBoard } from './board';
import { STREAM_KINDS, type DaemonEvent } from './sync';
import { useQuery, useRefetchTick, type QueryState } from './workbench-sessions';

// The events the daemon folds into a session's tasks.
const TASK_KINDS: ReadonlySet<string> = new Set([
  'agent.task.started',
  'agent.task.progress',
  'agent.task.ended',
  'agent.background.changed',
  'agent.session.started',
  'agent.session.exited',
]);

function newest(events: readonly DaemonEvent[], sessionId: string): DaemonEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.aggregate_id === sessionId && TASK_KINDS.has(event.kind)) return event;
  }
  return undefined;
}

const sessionParams = (session_id: string) => ({ session_id });
const acceptTasks = (value: unknown): SessionTasks | null => {
  const tasks = value as Partial<SessionTasks> | null;
  return typeof tasks?.cursor === 'number' && Array.isArray(tasks.tasks)
    ? (tasks as SessionTasks)
    : null;
};

/** The session's agent and background tasks as the daemon folds them; read again after its task events. */
export function useSessionTasks(sessionId: string | null): QueryState<SessionTasks> {
  const last = (events: readonly DaemonEvent[]) =>
    sessionId === null ? undefined : newest(events, sessionId);
  const sequence = useBoard((s) => last(s.events)?.sequence ?? 0);
  const stream = useBoard((s) => STREAM_KINDS.has(last(s.events)?.kind ?? ''));
  const tick = useRefetchTick(sequence, stream);
  return useQuery('session.tasks', sessionId, sessionParams, acceptTasks, tick);
}
