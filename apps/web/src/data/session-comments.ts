import type { SessionComment } from '@pantheon/domain';
import type { BridgeResult } from '@pantheon/protocol';
import { toast } from '../components/Toast';
import { useBoard } from './board';
import { runCommand } from './commands';
import type { FeedbackItem } from './feedback';
import { failureText } from './needs-you';
import { STREAM_KINDS, type DaemonEvent } from './sync';
import { touchesSession, useQuery, useRefetchTick, type QueryState } from './workbench-sessions';

function newest(
  events: readonly DaemonEvent[],
  keep: (event: DaemonEvent) => boolean,
): DaemonEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (keep(events[i]!)) return events[i];
  return undefined;
}

const sessionParams = (session_id: string) => ({ session_id });
const acceptComments = (value: unknown): SessionComment[] | null =>
  Array.isArray(value) ? (value as SessionComment[]) : null;

/**
 * The session's diff comments by path, line and age; read again after the session's events, which
 * every comment change records.
 */
export function useSessionComments(sessionId: string | null): QueryState<SessionComment[]> {
  const keep = (e: DaemonEvent) => sessionId !== null && touchesSession(e, sessionId);
  const sequence = useBoard((s) => newest(s.events, keep)?.sequence ?? 0);
  const stream = useBoard((s) => STREAM_KINDS.has(newest(s.events, keep)?.kind ?? ''));
  const tick = useRefetchTick(sequence, stream);
  return useQuery('session.comments', sessionId, sessionParams, acceptComments, tick);
}

export const addComment = (
  sessionId: string,
  comment: Pick<SessionComment, 'path' | 'line' | 'side' | 'text' | 'line_text' | 'turn_id'>,
): Promise<BridgeResult<unknown>> =>
  runCommand(
    'session.comment.add',
    {
      session_id: sessionId,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      text: comment.text,
      ...(comment.line_text === undefined ? {} : { line_text: comment.line_text }),
      ...(comment.turn_id === undefined ? {} : { turn_id: comment.turn_id }),
    },
    null,
  );

export const resolveComment = (
  comment: { id: string; revision: number },
  state: 'sent' | 'kept',
): Promise<BridgeResult<unknown>> =>
  runCommand('session.comment.resolve', { comment_id: comment.id, state }, comment.revision);

/** Adds a deleted comment back, sent or kept again as it was; the result is the comment added. */
export async function restoreComment(
  sessionId: string,
  comment: SessionComment,
): Promise<BridgeResult<SessionComment>> {
  const added = await addComment(sessionId, comment);
  if (!added.ok) return added;
  const back = added.value as SessionComment;
  if (comment.state === 'open') return { ok: true, value: back };
  const resolved = await resolveComment(back, comment.state);
  return resolved.ok ? { ok: true, value: resolved.value as SessionComment } : resolved;
}

export const deleteComment = (comment: {
  id: string;
  revision: number;
}): Promise<BridgeResult<unknown>> =>
  runCommand('session.comment.delete', { comment_id: comment.id }, comment.revision);

/**
 * Marks sent the stored comments among the items a sent message carried; a refusal shows as a
 * failure toast.
 */
export function markCommentsSent(items: readonly FeedbackItem[]): void {
  for (const item of items)
    if (item.comment)
      void resolveComment(item.comment, 'sent').then(
        (result) => result.ok || toast({ title: failureText(result.error), kind: 'failure' }),
      );
}
