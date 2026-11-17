import type { AgentProfile, ProjectBaseline } from '@pantheon/domain';
import type { BoardModel, BoardSnapshot, CommandType } from '@pantheon/protocol';
import type { GlyphName } from '../../components/SessionStateIcon';
import { agentName, shownAgents, templateName } from '../../data/agents';
import { shortId } from '../../data/format';
import { reasonText } from '../../data/needs-you';
import { proposalTitle } from '../../data/plan-edit';
import { ASSISTANT, choiceKey, type RequestChoice } from '../../data/request-target';
import { t } from '../../i18n';
import { defaultPermissionMode, defaultRuntime, newSessionInput } from '../sessions/model';
import { tellLead, type SnapshotSession } from './panels-model';

export type BoardLead = NonNullable<BoardModel['leads']>[number];
export type BoardNeed = NonNullable<BoardModel['needs']>[number];
/** A needs-you item from the board, or from the needs-you list, which counts no unblocked tasks. */
export type NeedItem = Omit<BoardNeed, 'unblocks'> & { unblocks?: number };
/** The needs the board lists. */
export const boardNeeds = (model: Pick<BoardModel, 'needs'>): BoardNeed[] => model.needs ?? [];
export type SessionDefaults = BoardSnapshot['projects'][number]['session_defaults'];

/* Requirement box */

export interface RequirementTarget {
  choice: RequestChoice;
  name: string;
  /** The session it goes to; none for the Assistant, a new lead and a resident with no session that takes input. */
  session?: SnapshotSession;
}

const takesInput = (session: SnapshotSession | undefined): session is SnapshotSession =>
  !!session && !session.archived_at && tellLead(session).enabled;

/**
 * Where the requirement bar can send, in menu order: the Assistant, the other residents, the leads
 * of the current plans, the direct sessions that take input, then a new lead.
 */
export function requirementTargets(
  leads: readonly BoardLead[] | undefined,
  sessions: readonly SnapshotSession[],
  agents: readonly AgentProfile[] | null,
): RequirementTarget[] {
  const shown = shownAgents(agents ?? []);
  const assistant = shown.find((agent) => agent.template === 'assistant');
  const residents = shown
    .filter((agent) => agent !== assistant)
    .map((agent): RequirementTarget => {
      const session = sessions.find((s) => s.resident?.agent_id === agent.id && takesInput(s));
      return {
        choice: { kind: 'agent', agent_id: agent.id },
        name: agentName(agent),
        ...(session ? { session } : {}),
      };
    });
  const leadIds = new Set((leads ?? []).map((lead) => lead.session_id));
  const planLeads = (leads ?? []).flatMap((lead): RequirementTarget[] => {
    const session = sessions.find((s) => s.id === lead.session_id);
    return takesInput(session) && !session.resident
      ? [
          {
            choice: { kind: 'session', session_id: session.id },
            name: lead.title ?? session.title ?? session.id,
            session,
          },
        ]
      : [];
  });
  const direct = sessions
    .filter((s) => takesInput(s) && !s.resident && !s.task && !leadIds.has(s.id))
    .map((session): RequirementTarget => ({
      choice: { kind: 'session', session_id: session.id },
      name:
        session.title?.trim() ||
        t(
          { id: 'board.session.fallbackTitle', defaultMessage: 'Session {id}' },
          { id: shortId(session.id) },
        ),
      session,
    }));
  return [
    { choice: ASSISTANT, name: assistant ? agentName(assistant) : templateName('assistant') },
    ...residents,
    ...planLeads,
    ...direct,
    {
      choice: { kind: 'create' },
      name: t({ id: 'board.lead.publish.newLead', defaultMessage: 'New lead' }),
    },
  ];
}

/** The target of the stored choice among the targets; the Assistant when it is not among them. */
export function requirementTarget(
  choice: RequestChoice,
  targets: readonly RequirementTarget[],
): RequirementTarget {
  const key = choiceKey(choice);
  return targets.find((target) => choiceKey(target.choice) === key) ?? targets[0]!;
}

/** The session.create input of a requirement and its attachments under the project's session defaults, among the runtimes offered. */
export function requirementSessionInput(
  projectId: string,
  defaults: SessionDefaults,
  input: string,
  runtimes: readonly string[],
  attachments: readonly string[] = [],
) {
  const runtime = defaultRuntime(runtimes, defaults?.runtime);
  return newSessionInput({
    projectId,
    runtime,
    permissionMode: defaultPermissionMode(runtime, defaults?.permission_mode),
    input,
    attachments,
  });
}

/* Lead states */

// Labels are getters, so each is read in the language loaded by then. Each state is drawn with
// the session state glyph of the same meaning.
export const LEAD_STATE: Record<BoardLead['state'], { label: string; glyph: GlyphName }> = {
  running: {
    get label() {
      return t({ id: 'board.leadStates.running', defaultMessage: 'Running' });
    },
    glyph: 'running',
  },
  waiting: {
    get label() {
      return t({ id: 'board.leadStates.waiting', defaultMessage: 'Awaiting an answer' });
    },
    glyph: 'question',
  },
  idle: {
    get label() {
      return t({ id: 'board.leadStates.idle', defaultMessage: 'Idle' });
    },
    glyph: 'idle',
  },
  failed: {
    get label() {
      return t({ id: 'board.leadStates.failed', defaultMessage: 'Failed' });
    },
    glyph: 'failed',
  },
  closed: {
    get label() {
      return t({ id: 'board.leadStates.closed', defaultMessage: 'Closed' });
    },
    glyph: 'discarded',
  },
};

/** A lead's state, a waiting lead by whether it waits for an answer or an approval. */
export function leadState(lead: Pick<BoardLead, 'state' | 'waiting'>): {
  label: string;
  glyph: GlyphName;
} {
  if (lead.state === 'waiting' && lead.waiting?.kind === 'approval')
    return {
      label: t({ id: 'board.leadStates.waitingApproval', defaultMessage: 'Awaiting approval' }),
      glyph: 'approval',
    };
  return LEAD_STATE[lead.state];
}

/* Needs-you strip */

export type NeedActionKey =
  | 'approve'
  | 'approve_session'
  | 'reject'
  | 'answer'
  | 'reply'
  | 'accept'
  | 'confirm'
  | 'decline'
  | 'merge'
  | 'merge_out_of_scope'
  | 'gates'
  | 'handoff'
  | 'continue'
  | 'sync'
  | 'budget'
  | 'stop_background'
  | 'board'
  | 'keep'
  | 'revert'
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

/** Why Update board is off for the project's newest baseline: it runs or awaits confirmation. */
export const baselineSyncReason = (
  baseline: Pick<ProjectBaseline, 'state'> | null | undefined,
): string | null =>
  baseline?.state === 'running' || baseline?.state === 'submitted'
    ? t({ id: 'board.headline.syncBaseline', defaultMessage: 'A baseline is running' })
    : null;

const asksQuestion = (item: NeedItem) => item.binding?.action === 'AskUserQuestion';

/** The files a merge blocked for leaving its task's scope would land; null for any other block. */
export function outOfScopeFiles(session: SnapshotSession | undefined): string[] | null {
  return session?.merge?.state === 'blocked' && session.merge.reason === 'out_of_scope'
    ? (session.merge.conflicts ?? [])
    : null;
}

/** The inline buttons of one needs-you item, in the order they show; lead is the lead of the session's task. */
export function needActions(
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
  if (item.kind === 'improvement.candidate') {
    const reason = offReason(item, 'improvement.decide');
    return [
      {
        key: 'confirm',
        label: t({ id: 'board.needs.actions.confirm', defaultMessage: 'Confirm' }),
        reason,
      },
      {
        key: 'decline',
        label: t({ id: 'board.needs.actions.decline', defaultMessage: 'Reject' }),
        reason,
      },
    ];
  }
  if (item.kind === 'workflow.definition.trial')
    return (['keep', 'revert'] as const).map((key) => ({
      key,
      label:
        key === 'keep'
          ? t({ id: 'board.needs.actions.keepTrial', defaultMessage: 'Keep' })
          : t({ id: 'board.needs.actions.revertTrial', defaultMessage: 'Revert' }),
      reason: offReason(item, 'workflow.definition.trial.decide'),
    }));
  // The item holds no ops, so the proposal is decided on the board.
  if (item.kind === 'board.plan.proposal')
    return [
      {
        key: 'board',
        label: t({ id: 'board.needs.actions.board', defaultMessage: 'View on board' }),
        reason: null,
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
  if (item.kind === 'workflow.approval') {
    const reason = offReason(item, 'workflow.step.decide');
    return [
      {
        key: 'approve',
        label: t({ id: 'board.needs.actions.approveStep', defaultMessage: 'Approve' }),
        reason,
      },
      {
        key: 'reject',
        label: t({ id: 'board.needs.actions.rejectStep', defaultMessage: 'Reject' }),
        reason,
      },
      open,
    ];
  }
  if (item.kind === 'external.approval')
    return [
      {
        key: 'approve',
        label: t({ id: 'board.needs.actions.approveStep', defaultMessage: 'Approve' }),
        reason: offReason(item, 'external.approve'),
      },
      open,
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
  // The daemon checks no revision on a step decision; a second one is refused as no longer waiting.
  if (item.kind === 'workflow.approval' && (key === 'approve' || key === 'reject'))
    return {
      type: 'workflow.step.decide',
      input: { step_run_id: item.source.id, decision: key },
      revision: null,
    };
  if (item.kind === 'external.approval' && key === 'approve')
    return {
      type: 'external.approve',
      input: { project_id: item.project_id, subject_key: item.request_id },
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
  if (key === 'keep' || key === 'revert')
    return {
      type: 'workflow.definition.trial.decide',
      input: { project_id: item.project_id, id: item.source.id, decision: key },
      revision: null,
    };
  if (key === 'confirm' || key === 'decline')
    return {
      type: 'improvement.decide',
      input: {
        project_id: item.project_id,
        improvement_id: item.source.id,
        decision: key === 'confirm' ? 'confirm' : 'reject',
      },
      revision: null,
    };
  return null;
}

/** A key unique to the item; a plan's items share their source. */
export const needKey = (
  item: Pick<NeedItem, 'source' | 'task_id' | 'kind' | 'request_id'>,
): string =>
  // One plan holds every proposal and held external request of its lead, so their ids tell them apart.
  `${item.source.table}:${item.source.id}:${item.kind === 'board.plan.proposal' || item.kind === 'external.approval' ? item.request_id : (item.task_id ?? '')}`;

/**
 * The session the item is about; none for a milestone or a proposal, whose session_id is the lead
 * that wrote it. A lead's question relaying a session's request is about that session.
 */
export const needSession = (
  item: Pick<NeedItem, 'source' | 'session_id' | 'question'>,
): string | null =>
  item.source.table === 'sessions'
    ? item.source.id
    : item.source.table === 'milestones' || item.source.table === 'improvements'
      ? null
      : (item.question?.source?.session_id ?? item.session_id ?? null);

/** The item that answers a pending request: the lead's question relaying it, else its own. */
export const requestNeed = <T extends NeedItem>(
  needs: readonly T[],
  approvalId: string | undefined,
): T | undefined =>
  approvalId === undefined
    ? undefined
    : needs.find((n) =>
        n.kind === 'lead.question'
          ? n.question?.source?.approval_id === approvalId
          : n.source.table === 'approvals' && n.source.id === approvalId,
      );

/** Who waits: the milestone's title, the session's title, else its task's title. */
export function needWho(
  item: NeedItem,
  model: Pick<BoardModel, 'tasks' | 'milestones'>,
  sessions: readonly SnapshotSession[],
): string {
  if (item.source.table === 'milestones')
    return model.milestones?.find((m) => m.id === item.source.id)?.title ?? reasonText(item.reason);
  if (item.source.table === 'improvements' || item.source.table === 'workflow_policies')
    return reasonText(item.reason);
  const id = needSession(item);
  const task = item.task_id ? model.tasks.find((t) => t.id === item.task_id) : undefined;
  // A plan's task item is about the task, not the lead it names as its session.
  if (item.source.table === 'board_plans' && task) return task.title;
  const title = sessions.find((s) => s.id === id)?.title?.trim();
  if (item.kind === 'board.plan.proposal')
    return proposalTitle(title || (id ? shortId(id) : item.project_id));
  if (title) return title;
  return (
    task?.title ??
    (id
      ? t(
          { id: 'board.session.fallbackTitle', defaultMessage: 'Session {id}' },
          { id: shortId(id) },
        )
      : item.project_id)
  );
}

const reasonDetail = (reason: string, detail: string) =>
  t({ id: 'board.needs.reasonDetail', defaultMessage: '{reason}: {detail}' }, { reason, detail });

/** What the user is asked to do. */
export function needWhat(item: NeedItem, session?: SnapshotSession): string {
  const blocked = item.kind === 'session.merge_blocked' ? session?.merge?.reason : undefined;
  if (blocked) return reasonDetail(reasonText(item.reason), reasonText(blocked));
  if (item.background) return reasonDetail(reasonText(item.reason), item.background.description);
  if (item.step_title) return reasonDetail(reasonText(item.reason), item.step_title);
  if (item.kind !== 'permission' || item.reason !== 'permission_requested')
    return reasonText(item.reason);
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
