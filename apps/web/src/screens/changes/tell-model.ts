import type { Session } from '@pantheon/domain';
import type { ChangeRow } from '@pantheon/protocol';
import { composeState } from '../../data/transcript';
import { t } from '../../i18n';
import { messageCommand } from '../sessions/thread-model';

export interface TellState {
  type: 'session.send' | 'session.steer';
  enabled: boolean;
  reason: string | null;
}

/** The command a message to the session goes out as, and whether it can go now. */
export function tellState(session: Session | undefined): TellState {
  if (!session)
    return {
      type: 'session.send',
      enabled: false,
      reason: t({ id: 'changes.tell.gone', defaultMessage: 'The session is gone' }),
    };
  const type = messageCommand(session.state);
  const state = composeState(session)[type === 'session.steer' ? 'steer' : 'send'];
  return { type, enabled: state.enabled, reason: state.reason };
}

/** The first line of a message about the change: its title, and its branch when it has one. */
export function tellDraft(row: Pick<ChangeRow, 'title' | 'branch'>): string {
  if (row.branch)
    return t(
      { id: 'changes.tell.draftBranch', defaultMessage: 'About change “{title}” ({branch}):\n' },
      { title: row.title, branch: row.branch },
    );
  return t(
    { id: 'changes.tell.draft', defaultMessage: 'About change “{title}”:\n' },
    { title: row.title },
  );
}
