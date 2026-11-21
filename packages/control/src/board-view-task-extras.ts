import type { BoardPlan, Session, SessionTurn } from '@pantheon/domain';
import type { BoardTaskExtras } from '@pantheon/protocol';
import type { ControlContext } from './context.js';

/** Fields of a plan task's board row beyond those the board view builds itself. */
export function taskExtras(
  ctx: ControlContext,
  _plan: BoardPlan,
  _task: BoardPlan['tasks'][number],
  session: Session | undefined,
): BoardTaskExtras {
  return statusLineOf(ctx, session);
}

/** The session's status line while the turn that set it is the newest turn that started. */
export function statusLineOf(
  ctx: ControlContext,
  session: Session | undefined,
): Pick<BoardTaskExtras, 'status_line'> {
  if (!session?.status_line) return {};
  const line = session.status_line,
    id = session.id;
  const newest = ctx.store
    .list<SessionTurn>('session_turns')
    .findLast((turn) => turn.session_id === id && turn.state !== 'queued');
  return newest?.id === line.turn_id ? { status_line: { text: line.text, at: line.at } } : {};
}
