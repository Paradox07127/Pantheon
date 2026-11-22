import type { CommandType } from '@pantheon/protocol';
import { t } from '../i18n';
import type { SnapshotSession } from '../lib/snapshot-types';
import { reasonText, type NeedsYouItem } from './needs-you';

/* Needs-you strip */

export type NeedActionKey =
  | 'approve'
  | 'approve_session'
  | 'reject'
  | 'answer'
  | 'reply'
  | 'merge'
  | 'merge_anyway'
  | 'gates'
  | 'continue'
  | 'stop_background'
  | 'usage'
  | 'open';

export interface NeedAction {
  key: NeedActionKey;
  label: string;
  /** Why the button is off; null while it can be pressed. */
  reason: string | null;
}

function offReason(item: NeedsYouItem, command: string): string | null {
  const action = item.actions.find((a) => a.command === command);
  if (!action || action.allowed) return null;
  return action.disabled_reason
    ? reasonText(action.disabled_reason)
    : t({ id: 'board.needs.noReason', defaultMessage: 'The backend gave no reason' });
}

const asksQuestion = (item: NeedsYouItem) => item.binding?.action === 'AskUserQuestion';

/** The inline buttons of one needs-you item, in the order they show. */
export function needActions(item: NeedsYouItem, session?: SnapshotSession): NeedAction[] {
  const open: NeedAction = {
    key: 'open',
    label: t({ id: 'board.needs.actions.open', defaultMessage: 'Open session' }),
    reason: null,
  };
  if (item.kind === 'permission') {
    // A voided request or an undelivered answer takes no answer here.
    if (!item.actions.length) return [open];
    if (asksQuestion(item)) {
      if (!item.questions?.length)
        return [
          {
            key: 'answer',
            label: t({ id: 'board.needs.actions.answer', defaultMessage: 'Answer' }),
            reason: null,
          },
        ];
      const reason = offReason(item, 'approval.respond');
      return [
        {
          key: 'reply',
          label: t({ id: 'board.needs.actions.reply', defaultMessage: 'Reply' }),
          reason,
        },
        {
          key: 'reject',
          label: t({ id: 'board.needs.actions.reject', defaultMessage: 'Deny' }),
          reason,
        },
        open,
      ];
    }
    // Nothing is allowed here without the input it is asked for.
    if (!item.binding?.input_summary) return [open];
    const reason = offReason(item, 'approval.respond');
    return [
      {
        key: 'approve',
        label: t({ id: 'board.needs.actions.approve', defaultMessage: 'Allow once' }),
        reason,
      },
      // The backend refuses an allow for the session without a rule to keep.
      ...(item.binding.rule
        ? [
            {
              key: 'approve_session' as const,
              label: t({
                id: 'board.needs.actions.approveSession',
                defaultMessage: 'Allow for this session',
              }),
              reason,
            },
          ]
        : []),
      {
        key: 'reject',
        label: t({ id: 'board.needs.actions.reject', defaultMessage: 'Deny' }),
        reason,
      },
    ];
  }
  if (item.kind === 'session.merge_blocked' || item.kind === 'session.gate_failed')
    return [
      {
        key: 'merge',
        label: t({ id: 'board.needs.actions.merge', defaultMessage: 'Retry merge' }),
        reason: offReason(item, 'session.merge'),
      },
      ...(session?.merge?.reason === 'gate_files_changed'
        ? [
            {
              key: 'merge_anyway' as const,
              label: t({ id: 'board.needs.actions.mergeAnyway', defaultMessage: 'Land anyway' }),
              reason: offReason(item, 'session.merge'),
            },
          ]
        : []),
      ...(item.kind === 'session.gate_failed'
        ? [
            {
              key: 'gates' as const,
              label: t({ id: 'board.needs.actions.gates', defaultMessage: 'Rerun gates' }),
              reason: offReason(item, 'session.gates.run'),
            },
          ]
        : []),
      open,
    ];
  if (item.kind === 'project.over_budget')
    return [
      {
        key: 'usage',
        label: t({
          id: 'board.needs.actions.projectSettings',
          defaultMessage: 'Open project settings',
        }),
        reason: null,
      },
    ];
  const has = (command: string) => item.actions.some((a) => a.command === command);
  return [
    ...(item.background && has('session.background.stop')
      ? [
          {
            key: 'stop_background' as const,
            label: t({
              id: 'board.needs.actions.stopBackground',
              defaultMessage: 'Stop background task',
            }),
            reason: offReason(item, 'session.background.stop'),
          },
        ]
      : []),
    ...(has('session.send')
      ? [
          {
            key: 'continue' as const,
            label: t({ id: 'board.needs.actions.continue', defaultMessage: 'Continue' }),
            reason: offReason(item, 'session.send'),
          },
        ]
      : []),
    open,
  ];
}

/** The message a continue button sends. */
export const CONTINUE_INPUT = 'Continue where you left off.';

/** The command an action sends, at its expected revision; null for actions that only open a session. */
export function needCommand(
  item: NeedsYouItem,
  key: NeedActionKey,
  extra: { answers?: Record<string, string> } = {},
): { type: CommandType; input: Record<string, unknown>; revision: number | null } | null {
  const sessionId = needSession(item);
  if (key === 'merge' || key === 'merge_anyway')
    return {
      type: 'session.merge',
      input: {
        session_id: sessionId,
        ...(key === 'merge_anyway' ? { allow_gate_change: true } : {}),
      },
      revision: item.source.revision,
    };
  if (key === 'gates')
    return {
      type: 'session.gates.run',
      input: { session_id: sessionId },
      revision: item.source.revision,
    };
  if (key === 'continue')
    return {
      type: 'session.send',
      input: { session_id: sessionId, input: CONTINUE_INPUT },
      revision: item.source.revision,
    };
  if (key === 'stop_background' && item.background)
    return {
      type: 'session.background.stop',
      input: { session_id: sessionId, background_id: item.background.id },
      revision: null,
    };
  if (key === 'approve' || key === 'approve_session' || key === 'reject')
    return {
      type: 'approval.respond',
      input: { approval_id: item.source.id, decision: key },
      revision: item.source.revision,
    };
  if (key === 'reply')
    return {
      type: 'approval.respond',
      input: { approval_id: item.source.id, decision: 'approve', answers: extra.answers ?? {} },
      revision: item.source.revision,
    };
  return null;
}

/** The session the item is about. */
export const needSession = (item: Pick<NeedsYouItem, 'source' | 'session_id'>): string | null =>
  item.source.table === 'sessions' ? item.source.id : (item.session_id ?? null);
