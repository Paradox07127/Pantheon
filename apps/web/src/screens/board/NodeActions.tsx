import { useState, type SyntheticEvent } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import { needsKey } from '../../data/notice-tiers';
import { useSessionPreflight } from '../../data/session-panel';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { blockedText, MergeDialog } from '../sessions/panel';
import type { PanelTab } from '../sessions/inspector-model';
import type { NodeLook } from './FlowNode';
import { requestNeed, type NeedItem } from './frame-model';
import { tellLeadDraft } from './panels-model';
import type { TaskDrawerProps } from './TaskDrawer';
import { TellLead } from './TellLead';

type Task = BoardModel['tasks'][number];

export interface NodeActionContext {
  /** Snapshot sessions and the command runner behind the actions. */
  tell: NonNullable<TaskDrawerProps['tell']>;
  /** The board's needs-you items; a question opens the item that answers it. */
  needs: readonly NeedItem[];
  /** Present while the board's needs-you strip lists these needs; a question jumps to its row there. */
  onAskNeed?: (key: string) => void;
}

export interface NodeActionsProps {
  task: Task;
  look: NodeLook;
  context: NodeActionContext;
}

type OpenKey = 'open' | 'review' | 'failure' | 'session';
type Action =
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
function nodeActions(task: Task, look: NodeLook, { needs }: NodeActionContext): Action[] {
  const sessionId = sessionOf(task);
  const open = (key: OpenKey, tab?: PanelTab): Action[] =>
    sessionId ? [{ key, sessionId, ...(tab && { tab }) }] : [];
  const lead = task.owner_session_id;
  switch (look) {
    // The needs-you strip allows or denies it.
    case 'approval':
      return open('open');
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
                  key &&
                  (context.onAskNeed
                    ? context.onAskNeed(key)
                    : useShell.getState().openProjectNeed(action.need.project_id, key))
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
