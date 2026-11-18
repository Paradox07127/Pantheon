import type { AgentEvent, SessionTask } from '@pantheon/domain';
import type { SessionTasks } from '@pantheon/protocol';
import type { ControlContext } from './context.js';

const TASK_KINDS = [
  'agent.task.started',
  'agent.task.progress',
  'agent.task.ended',
  'agent.background.changed',
  'agent.session.started',
  'agent.session.exited',
];

type Payload<K extends AgentEvent['kind']> = Extract<AgentEvent, { kind: K }>;

/**
 * The session's tasks folded from the runtime's task edges, reconciled with its background lists:
 * a listed task not seen before gets a row, a running background task missing from a list ended
 * in the background, and a task still running when the process started anew or exited stopped.
 */
export function sessionTasks(ctx: ControlContext, sessionId: string): SessionTasks {
  const { cursor } = ctx.store
    .statement('SELECT coalesce(max(sequence),0) AS cursor FROM events WHERE aggregate_id=?')
    .get(sessionId) as { cursor: number };
  const rows = ctx.store
    .statement(
      `SELECT kind, created_at, payload FROM events WHERE aggregate_id=? AND sequence<=? AND kind IN (${TASK_KINDS.map(() => '?').join(',')}) ORDER BY sequence`,
    )
    .all(sessionId, cursor, ...TASK_KINDS) as {
    kind: string;
    created_at: number;
    payload: string;
  }[];
  const tasks = new Map<string, SessionTask>();
  const change = (task: SessionTask, patch: Partial<SessionTask>) =>
    tasks.set(task.id, { ...task, ...patch });
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as unknown;
    if (row.kind === 'agent.task.started') {
      const { task } = payload as Payload<'task.started'>;
      tasks.set(task.id, { ...task, session_id: sessionId, state: 'running' });
    } else if (row.kind === 'agent.task.progress') {
      const { task_id, usage, last_tool, summary } = payload as Payload<'task.progress'>;
      const task = tasks.get(task_id);
      if (task)
        change(task, {
          ...(usage ? { usage } : {}),
          ...(last_tool !== undefined ? { last_tool } : {}),
          ...(summary !== undefined ? { summary } : {}),
        });
    } else if (row.kind === 'agent.task.ended') {
      const { task_id, state, summary, usage, output_file } = payload as Payload<'task.ended'>;
      const task = tasks.get(task_id);
      if (task)
        change(task, {
          state,
          ended_at: row.created_at,
          ...(summary !== undefined ? { summary } : {}),
          ...(usage ? { usage } : {}),
          ...(output_file !== undefined ? { output_file } : {}),
        });
    } else if (row.kind === 'agent.background.changed') {
      const listed = new Map(
        (payload as Payload<'background.changed'>).tasks.map((task) => [task.id, task]),
      );
      for (const task of tasks.values())
        if (task.background && task.state === 'running' && !listed.has(task.id))
          change(task, {
            state: 'completed',
            end_reason: 'ended_in_background',
            ended_at: row.created_at,
          });
      for (const { id, kind, description, started_at } of listed.values()) {
        const task = tasks.get(id);
        if (!task)
          tasks.set(id, {
            id,
            session_id: sessionId,
            kind,
            description,
            started_at,
            background: true,
            state: 'running',
          });
        // A foreground task the runtime moved to the background is listed with the same id.
        else if (!task.background && task.state === 'running') change(task, { background: true });
      }
    } else
      for (const task of tasks.values())
        if (task.state === 'running')
          change(task, {
            state: 'stopped',
            end_reason: 'process_restarted',
            ended_at: row.created_at,
          });
  }
  return { cursor, tasks: [...tasks.values()] };
}
