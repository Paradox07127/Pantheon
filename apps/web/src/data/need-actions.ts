import type { BoardModel, BoardTaskRung, CommandType } from '@pantheon/protocol';
import { t } from '../i18n';
import type { SnapshotSession } from '../lib/snapshot-types';
import { messageCommand } from '../screens/sessions/model';
import { needReasonText, reasonText } from './needs-you';
import { composeState } from './transcript';

export type BoardNeed = NonNullable<BoardModel['needs']>[number];
/** A needs-you item from the board, or from the needs-you list, which counts no unblocked tasks. */
export type NeedItem = Omit<BoardNeed, 'unblocks'> & { unblocks?: number };

/* Telling the lead */

export interface TellLeadState {
  type: 'session.send' | 'session.steer';
  enabled: boolean;
  reason: string | null;
}

/** The command a message to the lead goes out as, and whether it can go now. */
export function tellLead(lead: SnapshotSession | undefined): TellLeadState {
  if (!lead)
    return {
      type: 'session.send',
      enabled: false,
      reason: t({ id: 'board.tellLead.leadGone', defaultMessage: 'The lead session is gone' }),
    };
  const type = messageCommand(lead.state);
  const state = composeState(lead)[type === 'session.steer' ? 'steer' : 'send'];
  return { type, enabled: state.enabled, reason: state.reason };
}

/* Needs-you strip */

export type NeedActionKey =
  | 'approve'
  | 'approve_session'
  | 'reject'
  | 'answer'
  | 'reply'
  | 'accept'
  | 'merge'
  | 'merge_out_of_scope'
  | 'gates'
  | 'handoff'
  | 'continue'
  | 'sync'
  | 'budget'
  | 'memory'
  | 'stop_background'
  | 'board'
  | 'resume'
  | 'open';

export interface NeedAction {
  key: NeedActionKey;
  label: string;
  /** Why the button is off; null while it can be pressed. */
  reason: string | null;
}

function offReason(item: NeedItem, command: string): string | null {
  const action = item.actions.find((a) => a.command === command);
  if (!action || action.allowed) return null;
  return action.disabled_reason
    ? reasonText(action.disabled_reason)
    : t({ id: 'board.needs.noReason', defaultMessage: 'The backend gave no reason' });
}

const asksQuestion = (item: NeedItem) => item.binding?.action === 'AskUserQuestion';

/** The files a merge blocked for leaving its task's scope would land; null for any other block. */
export function outOfScopeFiles(session: SnapshotSession | undefined): string[] | null {
  return session?.merge?.state === 'blocked' && session.merge.reason === 'out_of_scope'
    ? (session.merge.conflicts ?? [])
    : null;
}

/**
 * The inline buttons of one needs-you item, in the order they show; lead is the lead of the
 * session's task, rung its task's. A task Pantheon or its lead still holds gets nothing that starts
 * its work again.
 */
export function needActions(
  item: NeedItem,
  session?: SnapshotSession,
  lead?: SnapshotSession,
  rung?: BoardTaskRung['rung'],
): NeedAction[] {
  const actions = itemActions(item, session, lead);
  return rung && rung !== 'user'
    ? actions.filter((a) => a.key !== 'merge' && a.key !== 'gates' && a.key !== 'continue')
    : actions;
}

/** The needs-you strip's buttons: a plan proposal is decided in its row, which is on the board. */
export const stripActions = (...args: Parameters<typeof needActions>): NeedAction[] =>
  args[0].kind === 'board.plan.proposal'
    ? needActions(...args).filter((a) => a.key !== 'board')
    : needActions(...args);

function itemActions(
  item: NeedItem,
  session?: SnapshotSession,
  lead?: SnapshotSession,
): NeedAction[] {
  const open: NeedAction = {
    key: 'open',
    label: t({ id: 'board.needs.actions.open', defaultMessage: 'Open session' }),
    reason: null,
  };
  if (item.kind === 'milestone.ready_for_acceptance')
    return [
      {
        key: 'accept',
        label: t({ id: 'board.needs.actions.accept', defaultMessage: 'Accept' }),
        reason: offReason(item, 'milestone.accept'),
      },
    ];
  if (item.kind === 'project.over_budget')
    return [
      {
        key: 'budget',
        label: t({ id: 'board.needs.actions.budget', defaultMessage: 'Adjust budget' }),
        reason: offReason(item, 'workflow.policy.set'),
      },
    ];
  if (item.kind === 'memory.decision_budget')
    return [
      {
        key: 'memory',
        label: t({ id: 'board.needs.actions.memory', defaultMessage: 'Open memory' }),
        reason: null,
      },
    ];
  // Accepting here takes the lead's own ops; changing them first is done on the board.
  if (item.kind === 'board.plan.proposal') {
    const reason = offReason(item, 'board.plan.proposal.resolve');
    return [
      {
        key: 'approve',
        label: t({ id: 'board.plan.proposal.accept', defaultMessage: 'Accept' }),
        reason,
      },
      {
        key: 'reject',
        label: t({ id: 'board.plan.proposal.reject', defaultMessage: 'Reject' }),
        reason,
      },
      {
        key: 'board',
        label: t({ id: 'board.needs.actions.board', defaultMessage: 'View on board' }),
        reason: null,
      },
    ];
  }
  if (item.kind === 'board.plan.reassessment')
    return [
      {
        key: 'resume',
        label: t({ id: 'board.needs.actions.resumePlan', defaultMessage: 'Resume' }),
        reason: offReason(item, 'board.plan.resume'),
      },
    ];
  if (item.kind === 'lead.question')
    return [
      {
        key: 'reply',
        label: t({ id: 'board.needs.actions.reply', defaultMessage: 'Reply' }),
        reason: offReason(item, 'lead.question.answer'),
      },
      // A relayed question opens the thread of the session that asked it.
      item.question?.source
        ? {
            ...open,
            label: t({ id: 'board.needs.actions.viewThread', defaultMessage: 'View thread' }),
          }
        : open,
    ];
  if (item.kind === 'external.approval')
    return [
      {
        key: 'approve',
        label: t({ id: 'board.needs.actions.approveStep', defaultMessage: 'Approve' }),
        reason: offReason(item, 'external.approve'),
      },
      open,
    ];
  if (item.kind === 'board.lane.approval')
    return [
      {
        key: 'approve',
        label: t({ id: 'board.needs.actions.approvePlan', defaultMessage: 'Approve plan' }),
        reason: offReason(item, 'board.lane.approve'),
      },
    ];
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
  if (item.kind === 'session.merge_blocked' && outOfScopeFiles(session))
    return [
      {
        key: 'merge_out_of_scope',
        label: t({ id: 'board.needs.actions.mergeOutOfScope', defaultMessage: 'Merge anyway' }),
        reason: offReason(item, 'session.merge'),
      },
      open,
    ];
  if (item.kind === 'session.merge_blocked' || item.kind === 'session.gate_failed') {
    const told = tellLead(lead);
    return [
      {
        key: 'merge',
        label: t({ id: 'board.needs.actions.merge', defaultMessage: 'Retry merge' }),
        reason: offReason(item, 'session.merge'),
      },
      ...(item.kind === 'session.gate_failed'
        ? [
            {
              key: 'gates' as const,
              label: t({ id: 'board.needs.actions.gates', defaultMessage: 'Rerun gates' }),
              reason: offReason(item, 'session.gates.run'),
            },
          ]
        : []),
      ...(session?.task
        ? [
            {
              key: 'handoff' as const,
              label: t({ id: 'board.needs.actions.handoff', defaultMessage: 'Hand to lead' }),
              reason: told.enabled ? null : told.reason,
            },
          ]
        : []),
      open,
    ];
  }
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
    ...(has('board.sync')
      ? [
          {
            key: 'sync' as const,
            label: t({ id: 'board.needs.actions.sync', defaultMessage: 'Update board' }),
            reason: offReason(item, 'board.sync'),
          },
        ]
      : []),
    open,
  ];
}

/** The message a continue button sends. */
export const CONTINUE_INPUT = 'Continue where you left off.';

/** What a hand-off tells the lead of a session whose merge is blocked or whose gate failed. */
export function handoffInput(item: NeedItem, session: SnapshotSession): string {
  const files = session.merge?.conflicts ?? [];
  const title = session.title?.trim() || session.id;
  const id = session.task?.id ?? session.id;
  // Sent to the lead, so it stays in English whatever the interface language is.
  const problem =
    item.kind === 'session.gate_failed'
      ? 'Its merge gates failed'
      : `Its merge is blocked (${session.merge?.reason ?? item.reason})`;
  const touched = files.length ? `, touching ${files.join(', ')}` : '';
  return `About task "${title}" (${id.slice(id.indexOf(':') + 1)}):\n${problem}${touched}. Please fix it and merge again.`;
}

/**
 * The command an action sends, at its expected revision; null for actions that only open a session
 * and for an acceptance, which its dialog sends. `session` and `lead` are the item's session and
 * the lead of its task.
 */
export function needCommand(
  item: NeedItem,
  key: NeedActionKey,
  extra: {
    answers?: Record<string, string>;
    session?: SnapshotSession;
    lead?: SnapshotSession;
  } = {},
): { type: CommandType; input: Record<string, unknown>; revision: number | null } | null {
  const sessionId = needSession(item);
  if (key === 'merge' || key === 'merge_out_of_scope')
    return {
      type: 'session.merge',
      input: {
        session_id: sessionId,
        ...(key === 'merge_out_of_scope' ? { allow_out_of_scope: true } : {}),
      },
      revision: item.source.revision,
    };
  if (key === 'gates')
    return {
      type: 'session.gates.run',
      input: { session_id: sessionId },
      revision: item.source.revision,
    };
  if (key === 'handoff')
    return extra.lead && extra.session
      ? {
          type: tellLead(extra.lead).type,
          input: { session_id: extra.lead.id, input: handoffInput(item, extra.session) },
          revision: extra.lead.revision,
        }
      : null;
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
  if (key === 'sync')
    return { type: 'board.sync', input: { project_id: item.project_id }, revision: null };
  if (item.kind === 'board.plan.proposal' && (key === 'approve' || key === 'reject'))
    return {
      type: 'board.plan.proposal.resolve',
      input: {
        project_id: item.project_id,
        lead_session_id: item.session_id,
        proposal_id: item.request_id,
        decision: key === 'approve' ? 'accept' : 'reject',
      },
      revision: null,
    };
  if (key === 'resume')
    return {
      type: 'board.plan.resume',
      input: { project_id: item.project_id, lead_session_id: item.session_id },
      revision: null,
    };
  if (item.kind === 'external.approval' && key === 'approve')
    return {
      type: 'external.approve',
      input: { project_id: item.project_id, subject_key: item.request_id },
      revision: null,
    };
  if (item.kind === 'board.lane.approval' && key === 'approve')
    return {
      type: 'board.lane.approve',
      input: {
        project_id: item.project_id,
        lead_session_id: item.session_id,
        lane_id: item.request_id,
      },
      revision: null,
    };
  if (key === 'approve' || key === 'approve_session' || key === 'reject')
    return {
      type: 'approval.respond',
      input: { approval_id: item.source.id, decision: key },
      revision: item.source.revision,
    };
  // The daemon checks no revision on an answer; a second answer is refused as already answered.
  if (key === 'reply' && item.kind === 'lead.question' && item.question) {
    const answers = extra.answers ?? {};
    // A relayed question hands every answer on to the request it relays.
    return {
      type: 'lead.question.answer',
      input: {
        project_id: item.project_id,
        lead_session_id: item.session_id,
        question_id: item.question.id,
        answer: item.question.source
          ? Object.values(answers).join('\n')
          : (answers[item.question.question] ?? ''),
        ...(item.question.source ? { answers } : {}),
      },
      revision: null,
    };
  }
  if (key === 'reply')
    return {
      type: 'approval.respond',
      input: { approval_id: item.source.id, decision: 'approve', answers: extra.answers ?? {} },
      revision: item.source.revision,
    };
  return null;
}

/** A key unique to the item; a plan's items share their source. */
export const needKey = (
  item: Pick<NeedItem, 'source' | 'task_id' | 'kind' | 'request_id'>,
): string =>
  // One plan holds every proposal, held external request and held lane of its lead, so their ids tell them apart.
  `${item.source.table}:${item.source.id}:${item.kind === 'board.plan.proposal' || item.kind === 'external.approval' || item.kind === 'board.lane.approval' ? item.request_id : (item.task_id ?? '')}`;

/**
 * The session the item is about; none for a milestone or a proposal, whose session_id is the lead
 * that wrote it. A lead's question relaying a session's request is about that session.
 */
export const needSession = (
  item: Pick<NeedItem, 'source' | 'session_id' | 'question'>,
): string | null =>
  item.source.table === 'sessions'
    ? item.source.id
    : item.source.table === 'milestones'
      ? null
      : (item.question?.source?.session_id ?? item.session_id ?? null);

const reasonDetail = (reason: string, detail: string) =>
  t({ id: 'board.needs.reasonDetail', defaultMessage: '{reason}: {detail}' }, { reason, detail });

/** What the user is asked to do. */
export function needWhat(item: NeedItem, session?: SnapshotSession): string {
  const blocked = item.kind === 'session.merge_blocked' ? session?.merge?.reason : undefined;
  if (blocked) return reasonDetail(reasonText(item.reason), reasonText(blocked));
  if (item.background) return reasonDetail(reasonText(item.reason), item.background.description);
  if (item.memory_notes)
    return t(
      {
        id: 'board.needs.memoryBudget',
        defaultMessage:
          'The memory budget for decisions is full; {count, plural, one {# plan decision was} other {# plan decisions were}} kept as notes',
      },
      { count: item.memory_notes.count },
    );
  if (item.kind !== 'permission' || item.reason !== 'permission_requested')
    return needReasonText(item);
  if (asksQuestion(item))
    return t({ id: 'board.needs.answerQuestion', defaultMessage: 'Answer the question' });
  return t(
    { id: 'board.needs.approveAction', defaultMessage: 'Approve {action}' },
    {
      action:
        item.binding?.action || t({ id: 'board.needs.toolFallback', defaultMessage: 'a tool' }),
    },
  );
}
