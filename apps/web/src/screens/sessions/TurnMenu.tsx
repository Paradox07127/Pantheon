import { useEffect, useRef, useState } from 'react';
import type { SessionTurn } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { CheckIcon, Copy, Ellipsis, GitFork, SquarePen, Undo2, X } from 'lucide-react';
import { create } from 'zustand';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import type { DraftAttachment, GithubRef, SkillRef } from '../../data/drafts';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { usePrefill } from './parts';
import { fail } from './shared';
import { useThreadFind } from './ThreadFind';
import './runtime-events.css';

interface TurnScopes {
  /** The turn whose changes the inspector shows next, by session id. */
  scopes: Readonly<Record<string, string>>;
  set: (sessionId: string, turnId: string) => void;
  take: (sessionId: string) => string | undefined;
}

export const useTurnScope = create<TurnScopes>()((set, get) => ({
  scopes: {},
  set: (sessionId, turnId) => set((s) => ({ scopes: { ...s.scopes, [sessionId]: turnId } })),
  take: (sessionId) => {
    const turnId = get().scopes[sessionId];
    if (turnId !== undefined)
      set((s) => {
        const { [sessionId]: _, ...rest } = s.scopes;
        return { scopes: rest };
      });
    return turnId;
  },
}));

/** The session's revision when a command is sent: the turn rows do not render again as it moves. */
const revisionNow = (sessionId: string) =>
  useBoard.getState().board?.sessions.find((s) => s.id === sessionId)?.revision ?? null;

/** Copies the text; the icon then says whether it worked until the pointer leaves. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <button
      type="button"
      className="ib ss-ab"
      aria-label={
        copied === 'ok'
          ? t({ id: 'sessions.thread.copied', defaultMessage: 'Copied' })
          : copied === 'failed'
            ? t({ id: 'sessions.thread.copyFailed', defaultMessage: "Couldn't copy" })
            : t({ id: 'sessions.thread.copy', defaultMessage: 'Copy' })
      }
      onClick={() => void copy()}
      onPointerLeave={() => setCopied(null)}
      onBlur={() => setCopied(null)}
    >
      {copied === 'ok' ? (
        <CheckIcon aria-hidden="true" />
      ) : copied === 'failed' ? (
        <X aria-hidden="true" />
      ) : (
        <Copy aria-hidden="true" />
      )}
    </button>
  );
}

const forkLabel = () => t({ id: 'sessions.thread.fork', defaultMessage: 'Fork from here' });
export const forkStepLabel = () =>
  t({ id: 'sessions.thread.forkStep', defaultMessage: 'Fork from before this step' });

type RollbackScope = 'both' | 'files' | 'conversation';

/**
 * The actions under a message the user sent: copy, and on an ended turn of a live worktree session
 * rewrite, roll back and fork; the menu holds the turn's changes and the search of the thread.
 */
export function TurnActions(props: {
  sessionId: string;
  turnId: string;
  input: string;
  attachments: readonly DraftAttachment[];
  skills: readonly SkillRef[];
  refs: NonNullable<SessionTurn['refs']>;
  /** An ended turn of a live worktree session: it can be rolled back to and forked from. */
  rollable: boolean;
  /** The turn started from a checkpoint, so its own changes can be read and rolled back to. */
  checkpointed: boolean;
  busy: boolean;
  /** The project's listed sessions, read when a rewrite puts the turn's references back. */
  sessions?: () => readonly WorkbenchSession[];
}) {
  // Each turn has these actions, so the Base UI roots mount only once the pointer or focus reaches the menu.
  const [reached, setReached] = useState<'pointer' | 'focus' | 'click' | null>(null);
  const [dialog, setDialog] = useState<'rollback' | 'rewrite' | 'fork' | null>(null);
  const [asked, setAsked] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // The trigger that took focus was replaced by the menu's own.
  useEffect(() => {
    if (reached === 'focus') trigger.current?.focus();
  }, [reached]);
  const ask = (next: 'rollback' | 'rewrite' | 'fork') => {
    setDialog(next);
    setAsked(true);
  };
  const label = t({ id: 'sessions.screen.turnActions', defaultMessage: 'Turn actions' });
  const changes = props.rollable && props.checkpointed;
  const stuck = props.busy || !props.checkpointed;
  return (
    <div
      className="ss-macts"
      role="toolbar"
      aria-label={t({ id: 'sessions.thread.messageActions', defaultMessage: 'Message actions' })}
    >
      <CopyButton text={props.input} />
      {props.rollable && (
        <>
          <button
            type="button"
            className="ib ss-ab"
            aria-label={t({ id: 'sessions.thread.rewrite', defaultMessage: 'Rewrite and resend' })}
            disabled={stuck}
            onClick={() => ask('rewrite')}
          >
            <SquarePen aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ib ss-ab"
            aria-label={t({ id: 'sessions.thread.rollback', defaultMessage: 'Roll back to here' })}
            disabled={stuck}
            onClick={() => ask('rollback')}
          >
            <Undo2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ib ss-ab"
            aria-label={forkLabel()}
            disabled={!props.checkpointed}
            onClick={() => ask('fork')}
          >
            <GitFork aria-hidden="true" />
          </button>
        </>
      )}
      {reached ? (
        <Menu.Root defaultOpen={reached === 'click'}>
          <Menu.Trigger ref={trigger} className="ib ss-ab" aria-label={label}>
            <Ellipsis aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} style={{ zIndex: 40 }}>
              <Menu.Popup className="wmenu pop">
                {changes && (
                  <Menu.Item
                    onClick={() => {
                      useTurnScope.getState().set(props.sessionId, props.turnId);
                      useShell.getState().openSession(props.sessionId, 'changes');
                    }}
                  >
                    {t({
                      id: 'sessions.screen.turnChanges',
                      defaultMessage: "View this turn's changes",
                    })}
                  </Menu.Item>
                )}
                <Menu.Item
                  onClick={() => useThreadFind.getState().show(props.sessionId, trigger.current)}
                >
                  {t({ id: 'sessions.thread.find', defaultMessage: 'Search in session' })}
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      ) : (
        <button
          type="button"
          className="ib ss-ab"
          aria-label={label}
          aria-haspopup="menu"
          onPointerEnter={() => setReached('pointer')}
          onFocus={() => setReached('focus')}
          onClick={() => setReached('click')}
        >
          <Ellipsis aria-hidden="true" />
        </button>
      )}
      {asked && (
        <>
          <RollbackDialog
            open={dialog === 'rollback' || dialog === 'rewrite'}
            rewrite={dialog === 'rewrite'}
            sessionId={props.sessionId}
            turnId={props.turnId}
            input={props.input}
            attachments={props.attachments}
            skills={props.skills}
            refs={props.refs}
            {...(props.sessions ? { sessions: props.sessions } : {})}
            onClose={() => setDialog(null)}
          />
          <ForkDialog
            open={dialog === 'fork'}
            sessionId={props.sessionId}
            before={props.turnId}
            input={props.input}
            attachments={props.attachments}
            skills={props.skills}
            refs={props.refs}
            onClose={() => setDialog(null)}
          />
        </>
      )}
    </div>
  );
}

/**
 * Copy, and fork when `fork` is set, under an ended turn's reply. A fork starts from the next turn's
 * checkpoint, or after the last turn from the current files; a merging session refuses it.
 */
export function ReplyActions(props: {
  sessionId: string;
  text: string;
  fork: { before: string | null } | null;
  merging: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  return (
    <div
      className="ss-macts ss-racts"
      role="toolbar"
      aria-label={t({ id: 'sessions.thread.replyActions', defaultMessage: 'Reply actions' })}
    >
      <CopyButton text={props.text} />
      {props.fork && (
        <button
          type="button"
          className="ib ss-ab"
          aria-label={forkLabel()}
          disabled={props.fork.before === null && props.merging}
          onClick={() => {
            setOpen(true);
            setAsked(true);
          }}
        >
          <GitFork aria-hidden="true" />
        </button>
      )}
      {asked && props.fork && (
        <ForkDialog
          open={open}
          sessionId={props.sessionId}
          before={props.fork.before}
          input=""
          attachments={[]}
          skills={[]}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** The way back to the checkpoint taken before `turnId`: rolls the worktree back to it once confirmed. */
export function CheckpointBack(props: { sessionId: string; turnId: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn ghost sm"
        disabled={props.busy}
        onClick={() => {
          setOpen(true);
          setAsked(true);
        }}
      >
        {t({ id: 'sessions.thread.checkpointBack', defaultMessage: 'Go back here' })}
      </button>
      {asked && (
        <RollbackDialog
          open={open}
          rewrite={false}
          checkpoint
          sessionId={props.sessionId}
          turnId={props.turnId}
          input=""
          attachments={[]}
          skills={[]}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** Opens a new worktree session from the checkpoint before `before`, else the current files, with `input` as its first message. */
export function ForkDialog(props: {
  open: boolean;
  sessionId: string;
  before: string | null;
  /** The tool call of a turn the fork starts before, in place of `before`. */
  beforeSpan?: string;
  input: string;
  attachments: readonly DraftAttachment[];
  skills: readonly SkillRef[];
  refs?: NonNullable<SessionTurn['refs']>;
  onClose: () => void;
}) {
  const [text, setText] = useState(props.input);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = text.trim() === '';

  const fork = async () => {
    if (busy || empty) return;
    setBusy(true);
    setError(null);
    const ids = props.attachments.map((a) => a.id);
    const result = await runCommand(
      'session.fork',
      {
        session_id: props.sessionId,
        ...(props.before ? { before_turn_id: props.before } : {}),
        ...(props.beforeSpan ? { before_span_id: props.beforeSpan } : {}),
        input: text.trim(),
        ...(ids.length ? { attachments: ids } : {}),
        ...(props.skills.length ? { skills: props.skills } : {}),
        ...(props.refs?.length ? { refs: props.refs } : {}),
      },
      // The fork is a new session; the source's revision would be refused.
      null,
    ).catch(fail);
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.error));
      return;
    }
    props.onClose();
    const id = (result.value as { id?: unknown } | null)?.id;
    if (typeof id === 'string') useShell.getState().openSession(id);
  };

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(next) => {
        if (next) return;
        setError(null);
        props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" />
        <Dialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <Dialog.Title className="pj-dt">
              {props.beforeSpan ? forkStepLabel() : forkLabel()}
            </Dialog.Title>
          </div>
          <Dialog.Description className="pj-rm-body">
            {props.beforeSpan
              ? t({
                  id: 'sessions.thread.forkStepBody',
                  defaultMessage:
                    'Opens a new session in its own worktree with the current files and the conversation up to before this step. This session stays as it is.',
                })
              : props.before
                ? t({
                    id: 'sessions.thread.forkBody',
                    defaultMessage:
                      'Opens a new session in its own worktree with the files from before this turn and a record of the conversation before it. This session stays as it is.',
                  })
                : t({
                    id: 'sessions.thread.forkNowBody',
                    defaultMessage:
                      'Opens a new session in its own worktree with the current files and a record of the conversation. This session stays as it is.',
                  })}
          </Dialog.Description>
          <textarea
            className="ss-fkta"
            rows={4}
            value={text}
            aria-label={t({
              id: 'sessions.thread.forkInput',
              defaultMessage: 'First message of the new session',
            })}
            onChange={(e) => setText(e.target.value)}
          />
          {error && (
            <div className="pj-err" role="alert">
              <b>{error}</b>
            </div>
          )}
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <Dialog.Close className="btn ghost">
              {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
            </Dialog.Close>
            <button
              type="button"
              className="btn pri"
              disabled={busy || empty}
              aria-disabled={busy || empty || undefined}
              onClick={() => void fork()}
            >
              {t({ id: 'sessions.thread.forkConfirm', defaultMessage: 'Fork' })}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function RollbackDialog(props: {
  open: boolean;
  /** Puts the turn's input, attachments and skills back into the composer once rolled back. */
  rewrite: boolean;
  /** Asked from the checkpoint row, which names the checkpoint rather than the turn after it. */
  checkpoint?: boolean;
  /**
   * The words of a place that shows neither the turn nor its checkpoint, so they name both; such a
   * place restores the files only and offers no choice.
   */
  copy?: { title: string; body: string };
  sessionId: string;
  turnId: string;
  input: string;
  attachments: readonly DraftAttachment[];
  skills: readonly SkillRef[];
  refs?: NonNullable<SessionTurn['refs']>;
  /** The project's listed sessions, which give the cards of the sessions in `refs`. */
  sessions?: () => readonly WorkbenchSession[];
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<RollbackScope>('both');
  // The words of another place say what goes back, so it offers no choice.
  const scoped = !props.copy;
  // Rewriting sends the turn again, which only a conversation without it can take.
  const rewrite = props.rewrite && scope !== 'files';

  const rollback = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.rollback',
      { session_id: props.sessionId, turn_id: props.turnId, scope: scoped ? scope : 'files' },
      revisionNow(props.sessionId),
    ).catch(fail);
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.error));
      return;
    }
    if (rewrite) {
      const listed = props.sessions?.() ?? [];
      const refs = (props.refs ?? []).flatMap((r) =>
        r.kind === 'session' ? listed.filter((s) => s.id === r.id) : [],
      );
      // The turn keeps no title of a pull request or issue, so its card shows the number alone.
      const github = (props.refs ?? []).flatMap((r): GithubRef[] =>
        r.kind === 'session' ? [] : [{ kind: r.kind, number: r.number, title: '' }],
      );
      usePrefill.getState().set(props.sessionId, {
        text: props.input,
        attachments: props.attachments,
        skills: props.skills,
        ...(refs.length ? { refs } : {}),
        ...(github.length ? { github } : {}),
      });
    }
    props.onClose();
  };

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(next) => {
        if (next) return;
        setError(null);
        props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="pj-scrim" />
        <Dialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <Dialog.Title className="pj-dt">
              {props.copy
                ? props.copy.title
                : props.rewrite
                  ? t({ id: 'sessions.screen.rewriteTitle', defaultMessage: 'Rewrite from here' })
                  : props.checkpoint
                    ? t({
                        id: 'sessions.thread.checkpointTitle',
                        defaultMessage: 'Go back to this checkpoint',
                      })
                    : t({
                        id: 'sessions.screen.rollbackTitle',
                        defaultMessage: 'Roll back to before this turn',
                      })}
            </Dialog.Title>
          </div>
          <Dialog.Description className="pj-rm-body">
            {props.copy
              ? props.copy.body
              : scope === 'files'
                ? t({
                    id: 'sessions.screen.rollbackFilesBody',
                    defaultMessage:
                      "The worktree's files and commits go back to where they were before this turn began; later changes are discarded, and the conversation stays as it is.",
                  })
                : scope === 'conversation'
                  ? t({
                      id: 'sessions.screen.rollbackConversationBody',
                      defaultMessage:
                        "The conversation goes back to before this turn, and the turns after it are discarded; the worktree's files stay as they are.",
                    })
                  : t({
                      id: 'sessions.screen.rollbackBothBody',
                      defaultMessage:
                        "The worktree's files and commits go back to where they were before this turn began, and the conversation goes back to before it too; later changes and turns are discarded.",
                    })}
          </Dialog.Description>
          {scoped && (
            <RadioGroup<RollbackScope>
              className="seg ss-rbs"
              aria-label={t({
                id: 'sessions.screen.rollbackScope',
                defaultMessage: 'What to roll back',
              })}
              value={scope}
              onValueChange={setScope}
            >
              <Radio.Root value="both">
                {t({
                  id: 'sessions.screen.rollbackBoth',
                  defaultMessage: 'Files and conversation',
                })}
              </Radio.Root>
              <Radio.Root value="files">
                {t({ id: 'sessions.screen.rollbackFiles', defaultMessage: 'Files only' })}
              </Radio.Root>
              <Radio.Root value="conversation">
                {t({
                  id: 'sessions.screen.rollbackConversation',
                  defaultMessage: 'Conversation only',
                })}
              </Radio.Root>
            </RadioGroup>
          )}
          {error && (
            <div className="pj-err" role="alert">
              <b>{error}</b>
            </div>
          )}
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <Dialog.Close className="btn ghost">
              {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
            </Dialog.Close>
            <button
              type="button"
              className="btn dng"
              disabled={busy}
              aria-disabled={busy || undefined}
              onClick={() => void rollback()}
            >
              {rewrite
                ? t({
                    id: 'sessions.screen.rollbackRewrite',
                    defaultMessage: 'Roll back and rewrite',
                  })
                : t({ id: 'sessions.screen.rollback', defaultMessage: 'Roll back' })}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
