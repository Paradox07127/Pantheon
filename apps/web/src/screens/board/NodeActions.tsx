import { useRef, useState, type SyntheticEvent } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { Tip } from '../../components/Tip';
import { toast } from '../../components/Toast';
import { useBoard } from '../../data/board';
import { needsKey } from '../../data/notice-tiers';
import { useSessionPreflight } from '../../data/session-panel';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { blockedText, MergeDialog } from '../sessions/panel';
import type { PanelTab } from '../sessions/inspector-model';
import type { NodeLook } from './FlowNode';
import {
  needActions,
  needCommand,
  needSession,
  requestNeed,
  type NeedAction,
  type NeedItem,
} from './frame-model';
import { tellLeadDraft } from './panels-model';
import type { TaskDrawerProps } from './TaskDrawer';
import { TellLead } from './TellLead';

type Task = BoardModel['tasks'][number];

export interface NodeActionContext {
  /** Snapshot sessions and the command runner behind the actions. */
  tell: NonNullable<TaskDrawerProps['tell']>;
  /** The board's needs-you items; an approval is answered at the revision its item names. */
  needs: readonly NeedItem[];
}

export interface NodeActionsProps {
  task: Task;
  look: NodeLook;
  context: NodeActionContext;
}

type OpenKey = 'open' | 'review' | 'failure' | 'session';
type Action =
  | { key: 'answer'; need: NeedItem; answers: NeedAction[] }
  | { key: 'question'; need: NeedItem }
  | { key: OpenKey; sessionId: string; tab?: PanelTab }
  | { key: 'merge'; sessionId: string }
  | { key: 'ask' | 'redispatch'; leadId: string };

const OPEN_LABEL: Record<OpenKey, () => string> = {
  open: () => t({ id: 'board.node.action.open', defaultMessage: 'Open' }),
  review: () => t({ id: 'board.node.action.review', defaultMessage: 'Review' }),
  failure: () => t({ id: 'board.node.action.failure', defaultMessage: 'See failure' }),
  session: () => t({ id: 'board.node.action.session', defaultMessage: 'Open session' }),
};

const actionLabel = (action: string, title: string) =>
  t({ id: 'board.node.action.label', defaultMessage: '{action}: {title}' }, { action, title });

/** The task's newest session not discarded; a row opened without a task is its own session. */
const sessionOf = (task: Task): string | null =>
  task.claim?.session_id ?? (task.owner_session_id === undefined ? task.id : null);

/** What the user can do on the node in its state: at most three buttons. */
function nodeActions(task: Task, look: NodeLook, { tell, needs }: NodeActionContext): Action[] {
  const sessionId = sessionOf(task);
  const open = (key: OpenKey, tab?: PanelTab): Action[] =>
    sessionId ? [{ key, sessionId, ...(tab && { tab }) }] : [];
  const lead = task.owner_session_id;
  switch (look) {
    case 'approval': {
      const id = task.activity?.waiting?.approval_id;
      const need = needs.find((n) => n.source.table === 'approvals' && n.source.id === id);
      const answers = need
        ? needActions(
            need,
            tell.sessions.find((s) => s.id === needSession(need)),
            tell.sessions.find((s) => s.id === lead),
          ).filter((a) => a.key === 'approve' || a.key === 'reject')
        : [];
      return [
        ...(need && answers.length ? [{ key: 'answer' as const, need, answers }] : []),
        ...open('open'),
      ];
    }
    case 'answer': {
      // The question card answers it, on the lead's board when the lead relays it.
      const need = requestNeed(needs, task.activity?.waiting?.approval_id);
      return [...(need ? [{ key: 'question' as const, need }] : []), ...open('open')];
    }
    case 'review':
      // Only a session opened without a task merges by the user; a plan task's lead merges it.
      return [
        ...open('review', 'review'),
        ...(sessionId && !task.state && task.status === 'ready'
          ? [{ key: 'merge' as const, sessionId }]
          : []),
      ];
    case 'failed':
      return [
        ...open('failure', task.checks === 'fail' ? 'checks' : undefined),
        ...(lead ? [{ key: 'redispatch' as const, leadId: lead }] : []),
      ];
    case 'stuck':
      return [...open('session'), ...(lead ? [{ key: 'ask' as const, leadId: lead }] : [])];
    default:
      return [];
  }
}

/** Allow once and deny, sent like the needs-you strip sends them; an accepted answer keeps both off. */
function Answer({
  task,
  need,
  answers,
  run,
}: {
  task: Task;
  need: NeedItem;
  answers: NeedAction[];
  run: NodeActionContext['tell']['run'];
}) {
  const [busy, setBusy] = useState(false);
  // A second press before the next render still sees the first.
  const sent = useRef(false);
  const press = async (action: NeedAction) => {
    const command = needCommand(need, action.key);
    if (sent.current || action.reason || !command) return;
    sent.current = true;
    setBusy(true);
    const failure = await run(command.type, command.input, command.revision);
    if (!failure) return;
    sent.current = false;
    setBusy(false);
    toast({ title: failure, kind: 'failure' });
  };
  return answers.map((action) => {
    const off = busy || action.reason !== null;
    const button = (
      <button
        key={action.key}
        type="button"
        className={action.key === 'approve' ? 'btn sm pri' : 'btn sm'}
        aria-label={actionLabel(action.label, task.title)}
        aria-disabled={off || undefined}
        aria-busy={busy || undefined}
        onClick={() => void press(action)}
      >
        {action.label}
      </button>
    );
    return action.reason ? (
      <Tip key={action.key} content={action.reason}>
        {button}
      </Tip>
    ) : (
      button
    );
  });
}

/** Merges after the session panel's confirmation, off with the reason while the preflight refuses. */
function MergeButton({ task, sessionId }: { task: Task; sessionId: string }) {
  const [confirm, setConfirm] = useState(false);
  const read = useSessionPreflight(sessionId);
  const preflight = read.data;
  const revision = useBoard(
    (s) => s.board?.sessions.find((k) => k.id === sessionId)?.revision ?? null,
  );
  const reason = preflight && !preflight.can_merge ? blockedText(preflight.blocked_reason) : null;
  const label = t({ id: 'board.node.action.merge', defaultMessage: 'Merge' });
  const button = (
    <button
      type="button"
      className="btn sm"
      aria-label={actionLabel(label, task.title)}
      disabled={!preflight}
      aria-disabled={reason ? true : undefined}
      onClick={
        reason || !preflight
          ? undefined
          : () => {
              read.reload();
              setConfirm(true);
            }
      }
    >
      {label}
    </button>
  );
  return (
    <>
      {reason ? <Tip content={reason}>{button}</Tip> : button}
      {(preflight || confirm) && (
        <MergeDialog
          open={confirm}
          sessionId={sessionId}
          revision={revision}
          preflight={preflight}
          error={read.error}
          source={task.title}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}

// A press or key on a button, or in a dialog it opened, neither selects nor opens the node.
const keep = (e: SyntheticEvent) => e.stopPropagation();

/** The node's sixth layer: the buttons for what its state lets the user do; nothing when none. */
export function NodeActions({ task, look, context }: NodeActionsProps) {
  const shown = nodeActions(task, look, context);
  if (!shown.length) return null;
  const { run, sessions } = context.tell;
  const draft = tellLeadDraft('task', task.title, task.id);
  return (
    <div className="bd-nrow bd-nact nodrag nopan" onClick={keep} onKeyDown={keep}>
      {shown.map((action) => {
        switch (action.key) {
          case 'answer':
            return (
              <Answer
                key={`answer:${action.need.source.id}`}
                task={task}
                need={action.need}
                answers={action.answers}
                run={run}
              />
            );
          case 'question': {
            const label = t({ id: 'board.node.action.answer', defaultMessage: 'Answer' });
            const key = needsKey(action.need);
            return (
              <button
                key={`question:${action.need.source.id}`}
                type="button"
                className="btn sm pri"
                aria-label={actionLabel(label, task.title)}
                onClick={() =>
                  key && useShell.getState().openProjectNeed(action.need.project_id, key)
                }
              >
                {label}
              </button>
            );
          }
          case 'merge':
            return <MergeButton key="merge" task={task} sessionId={action.sessionId} />;
          case 'ask':
          case 'redispatch':
            return (
              <TellLead
                key={action.key}
                lead={sessions.find((s) => s.id === action.leadId)}
                draft={draft}
                label={task.title}
                run={run}
                className="btn sm"
                text={
                  action.key === 'ask'
                    ? t({ id: 'board.node.action.ask', defaultMessage: 'Ask the lead' })
                    : t({
                        id: 'board.node.action.redispatch',
                        defaultMessage: 'Have the lead redispatch',
                      })
                }
              />
            );
          default: {
            const label = OPEN_LABEL[action.key]();
            return (
              <button
                key={action.key}
                type="button"
                className={action.key === 'open' ? 'btn sm ghost' : 'btn sm'}
                aria-label={actionLabel(label, task.title)}
                onClick={() => useShell.getState().openSession(action.sessionId, action.tab)}
              >
                {label}
              </button>
            );
          }
        }
      })}
    </div>
  );
}
