import type { LeadNote, Principal, Project, Session, SessionTurn } from '@pantheon/domain';
import type { TaskTraceEntry, TaskTraceKind } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';

const TEXT_LIMIT = 2000;

const BLOCKED: ReadonlySet<string> = new Set([
  'session.merge_blocked',
  'session.merge_skipped',
  'session.merge_cancelled',
]);

/** The task's start request, dispatch, messages, reports, hand-backs, acceptance, gates, merges and user edits, in event order. */
export function taskTrace(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  leadId: string,
  taskId: string,
): TaskTraceEntry[] {
  projectAccess(ctx, principal, projectId, 'task.trace');
  ctx.store.must<Project>('projects', projectId);
  const sessions = new Set(
    ctx.store
      .list<Session>('sessions')
      .filter((session) => session.task?.lead_session_id === leadId && session.task.id === taskId)
      .map((session) => session.id),
  );
  const entries: TaskTraceEntry[] = [];
  const add = (at: number, kind: TaskTraceKind, sessionId?: string, text?: string) =>
    entries.push({
      at,
      kind,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(text !== undefined
        ? { text: text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text }
        : {}),
    });
  const kinds = [
      'task.start_requested',
      'task.dispatched',
      'task.reported',
      'task.accepted',
      'lead.note_added',
      'task.messaged',
      'turn.queued',
      'session.merge_started',
      'session.gate_checked',
      'session.merged',
      'session.discarded',
      ...BLOCKED,
    ],
    owners = [leadId, ...sessions],
    marks = (values: unknown[]) => values.map(() => '?').join(',');
  // Only events on the plan or the task's sessions, or turns queued on those sessions, can be entries.
  const rows = ctx.store.db
    .prepare(
      `SELECT kind, aggregate_id, created_at, payload FROM events INDEXED BY events_project_kind WHERE project_id=? AND kind IN (${marks(kinds)}) AND (aggregate_id IN (${marks(owners)}) OR (kind='turn.queued' AND payload ->> '$.session_id' IN (${marks([...sessions])}))) ORDER BY sequence`,
    )
    .all(projectId, ...kinds, ...owners, ...sessions) as {
    kind: string;
    aggregate_id: string;
    created_at: number;
    payload: string;
  }[];
  for (const event of rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload) as unknown,
  }))) {
    const p = event.payload as Record<string, unknown>,
      at = event.created_at,
      onPlan = event.aggregate_id === leadId,
      onSession = sessions.has(event.aggregate_id);
    if (event.kind === 'task.start_requested') {
      if (onPlan && (p.task_ids as string[]).includes(taskId)) add(at, 'start_requested');
    } else if (event.kind === 'task.dispatched') {
      if (onPlan && p.task_id === taskId) add(at, 'dispatched', p.session_id as string);
    } else if (event.kind === 'task.reported' || event.kind === 'lead.note_added') {
      const note = p as unknown as LeadNote;
      // One edit of several tasks is one note, filed under its first task.
      const edited = note.edit?.ops.some(
        (op) => ('task' in op ? op.task.id : 'task_id' in op && op.task_id) === taskId,
      );
      if (!onPlan || (note.task_id !== taskId && !edited)) continue;
      // Each report is also kept as a note; only a user's plan edit is taken from the notes.
      if (event.kind === 'task.reported') add(at, 'report', note.session_id, note.text);
      else if (note.kind === 'user_edit') add(at, 'user_edit', undefined, note.text);
    } else if (event.kind === 'task.accepted') {
      if (onPlan && p.task_id === taskId) add(at, 'accepted', undefined, p.evidence as string);
    } else if (event.kind === 'task.messaged') {
      if (onSession)
        add(
          at,
          'lead_message',
          event.aggregate_id,
          ctx.store.get<SessionTurn>('session_turns', p.turn_id as string)?.input,
        );
    } else if (event.kind === 'turn.queued') {
      const turn = p as unknown as SessionTurn;
      // The tracker queues a turn on a task session only to hand a merge problem back.
      if (sessions.has(turn.session_id) && turn.origin === 'tracker')
        add(at, 'handback', turn.session_id, turn.input);
    } else if (!onSession) continue;
    else if (event.kind === 'session.gate_checked') {
      const failed = (
        p.results as {
          name: string;
          exit_code?: number | null;
          timed_out?: boolean;
          state?: string;
        }[]
      ).find(
        (result) => result.state !== 'skipped' && (result.exit_code !== 0 || result.timed_out),
      );
      add(at, failed ? 'gate_failed' : 'gate_passed', event.aggregate_id, failed?.name);
    } else if (BLOCKED.has(event.kind))
      add(at, 'merge_blocked', event.aggregate_id, p.reason as string | undefined);
    else if (event.kind === 'session.merge_started') add(at, 'merge_started', event.aggregate_id);
    else if (event.kind === 'session.merged') add(at, 'merged', event.aggregate_id);
    else add(at, 'discarded', event.aggregate_id);
  }
  return entries;
}
