import { useState } from 'react';
// The discard confirmation is this file's one dialog, and an alert dialog.
import { AlertDialog as Dialog } from '@base-ui/react/alert-dialog';
import { type BridgeResult, type WorkbenchSession } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import { Tip } from '../../components/Tip';
import { runCommand } from '../../data/commands';
import { failureText, reasonText, type NeedsYouItem } from '../../data/needs-you';
import { t } from '../../i18n';
import { scrimFlag } from '../../lib/root-flag';
export {
  AnsweredRequest,
  CALL_STATE,
  ChapterMark,
  Items,
  json,
  StateMark,
  ThreadMark,
  ToolText,
  TurnWork,
} from './items';
export { AttachmentStrip, useAttachments } from './attachments';
export {
  CompletionPopup,
  SendButton,
  useCompletion,
  useCompose,
  usePickedSkills,
  usePrefill,
  useQueueDispatch,
  useQueued,
  type CompletionItem,
  type QueuedMessage,
  type SkillRef,
} from './compose';
export { ModelMenu, type ModelChoice } from './ModelMenu';
import './thread.css';
import './discard-dialog.css';

/**
 * Resume and close of a reconciling session, and its discard once confirmed when the item allows
 * it, sent at the revision of its needs-you item.
 */
export function ResolveButtons({ item, title }: { item: NeedsYouItem; title: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const action = item.actions.find((a) => a.command === 'session.resolve');
  const discardable = item.actions.some((a) => a.command === 'session.discard' && a.allowed);
  const reason =
    action && !action.allowed
      ? action.disabled_reason
        ? reasonText(action.disabled_reason)
        : t({ id: 'sessions.parts.noReason', defaultMessage: 'The backend gave no reason' })
      : null;
  const off = busy || reason !== null;

  async function resolve(choice: 'resume_session' | 'close') {
    if (off) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.resolve',
      { session_id: item.source.id, choice },
      item.source.revision,
    ).catch((cause: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: { code: 'ipc_failed', message: String(cause) },
    }));
    setBusy(false);
    if (!result.ok) setError(failureText(result.error));
  }

  const button = (label: string, choice: 'resume_session' | 'close', pri = false) => {
    const el = (
      <button
        type="button"
        className={pri ? 'btn pri' : 'btn'}
        aria-disabled={off || undefined}
        onClick={() => void resolve(choice)}
      >
        {label}
      </button>
    );
    return reason ? <Tip content={reason}>{el}</Tip> : el;
  };

  return (
    <>
      <div className="ss-acts">
        {button(
          t({ id: 'sessions.parts.resumeSession', defaultMessage: 'Resume session' }),
          'resume_session',
          true,
        )}
        {button(t({ id: 'sessions.parts.closeSession', defaultMessage: 'Close session' }), 'close')}
        {discardable && (
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            {t({ id: 'sessions.parts.discardChanges', defaultMessage: 'Discard changes…' })}
          </button>
        )}
      </div>
      {error && (
        <span className="tr-err" role="alert">
          {error}
        </span>
      )}
      {discardable && (
        <DiscardDialog
          open={confirming}
          title={title}
          sessionId={item.source.id}
          revision={item.source.revision}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}

export function DiscardDialog(props: {
  open: boolean;
  title: string;
  sessionId: string;
  revision: number | null;
  onClose: () => void;
  onDiscarded?: () => void;
  description?: string;
  /** The listed session, whose branch, unmerged commits and changed lines the body names. */
  listed?: WorkbenchSession | null;
}) {
  const [busy, setBusy] = useState(false);
  const branch = props.listed?.branch;
  const ahead = props.listed?.ahead ?? 0;
  const changes = props.listed?.changes;
  const [error, setError] = useState<string | null>(null);

  const discard = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(
      'session.discard',
      { session_id: props.sessionId },
      props.revision,
    ).catch((cause: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: { code: 'ipc_failed', message: String(cause) },
    }));
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result.error));
      return;
    }
    props.onClose();
    props.onDiscarded?.();
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
        <Dialog.Backdrop className="pj-scrim" ref={scrimFlag} />
        <Dialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <Dialog.Title className="pj-dt">
              {t(
                { id: 'overlays.confirm.discardTitle', defaultMessage: 'Discard “{title}”?' },
                { title: props.title },
              )}
            </Dialog.Title>
          </div>
          <Dialog.Description className="pj-rm-body">
            {props.description ??
              (branch && ahead > 0
                ? t(
                    {
                      id: 'sessions.parts.discardCommits',
                      defaultMessage:
                        "{count, plural, one {# unmerged commit} other {# unmerged commits}} on branch {branch} will be deleted. This can't be undone.",
                    },
                    { count: ahead, branch },
                  )
                : t({
                    id: 'sessions.parts.discardBody',
                    defaultMessage:
                      "Deletes this session's worktree and every change in it. This can't be undone.",
                  }))}
          </Dialog.Description>
          {changes && changes.files > 0 && (
            <div className="pj-rm-stat mono">
              <DiffCounts additions={changes.additions} deletions={changes.deletions} />
              <span className="pj-rm-files">
                {t(
                  {
                    id: 'sessions.parts.discardFiles',
                    defaultMessage: '{count, plural, one {# file} other {# files}}',
                  },
                  { count: changes.files },
                )}
              </span>
            </div>
          )}
          {error && (
            <div className="pj-err" role="alert">
              <b>{error}</b>
            </div>
          )}
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <Dialog.Close className="btn">
              {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
            </Dialog.Close>
            <button
              type="button"
              className="btn dng"
              disabled={busy}
              aria-disabled={busy || undefined}
              onClick={() => void discard()}
            >
              {t({ id: 'sessions.parts.discard', defaultMessage: 'Discard' })}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
