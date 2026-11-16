import { useState } from 'react';
import { ArrowUp, ChevronDown, Paperclip, Pencil, X } from 'lucide-react';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { composeState, type Session } from '../../data/transcript';
import { t } from '../../i18n';
import { shortcutKeys, useShortcut } from '../../lib/shortcuts';
import { commentSent, refsInput, usePrefill, useQueued, type QueuedMessage } from './compose';
import { fail } from './shared';

const NO_MESSAGES: readonly QueuedMessage[] = [];
/** Rows shown before the older ones fold into one line. */
const SHOWN = 3;

// A queued message keeps its object until it leaves the queue, so the object names its row.
const queuedRows = new WeakMap<QueuedMessage, number>();

let queuedRowCount = 0;

const queuedRowId = (message: QueuedMessage): number => {
  if (!queuedRows.has(message)) queuedRows.set(message, ++queuedRowCount);
  return queuedRows.get(message)!;
};

/** The messages queued for the session's next idle moment, one line each on the composer's top edge, newest last. */
export function QueueDock({ session }: { session: Session }) {
  const queued = useQueued((s) => s.queued[session.id]) ?? NO_MESSAGES;
  // Why the auto-send of the queue's first message failed.
  const headFailure = useQueued((s) => s.failures[session.id]) ?? null;
  const [steering, setSteering] = useState<QueuedMessage | null>(null);
  const [failed, setFailed] = useState<ReadonlyMap<QueuedMessage, string>>(new Map());
  const [open, setOpen] = useState(false);
  const steerable = composeState(session).steer.enabled;
  // The auto-send may shift the queue meanwhile, so a message is found again by identity.
  const drop = (message: QueuedMessage) => {
    const at = (useQueued.getState().queued[session.id] ?? NO_MESSAGES).indexOf(message);
    if (at >= 0) useQueued.getState().remove(session.id, at);
  };

  async function steer(message: QueuedMessage) {
    if (steering) return;
    // Off the queue while steering, so the auto-send cannot send it too; back in place on failure.
    const at = (useQueued.getState().queued[session.id] ?? NO_MESSAGES).indexOf(message);
    if (at < 0) return;
    drop(message);
    setSteering(message);
    setFailed((now) => {
      const next = new Map(now);
      next.delete(message);
      return next;
    });
    const ids = message.attachments.map((a) => a.id);
    const result = await runCommand(
      'session.steer',
      {
        session_id: session.id,
        input: message.text,
        ...(ids.length ? { attachments: ids } : {}),
        ...(message.skills.length ? { skills: message.skills } : {}),
        ...refsInput(message.refs, message.github),
      },
      session.revision,
    ).catch(fail);
    setSteering(null);
    if (result.ok) {
      for (const comment of message.comments ?? []) void commentSent(comment);
      return;
    }
    useQueued.getState().insert(session.id, at, message);
    setFailed((now) => new Map(now).set(message, failureText(result.error)));
  }

  // The keys steer with the oldest message, the one the queue would send next.
  useShortcut('steer-now', () => void steer(queued[0]!), steerable && queued.length > 0);

  if (queued.length === 0) return null;
  const hidden = open || queued.length <= SHOWN ? 0 : queued.length - SHOWN;
  const errorOf = (message: QueuedMessage) =>
    failed.get(message) ?? (message === queued[0] ? headFailure : null);
  const hiddenErrors = queued.slice(0, hidden).flatMap((m) => errorOf(m) ?? []);
  const alert = (error: string) => (
    <span key={error} className="tr-err" role="alert">
      {error}
    </span>
  );
  return (
    <div
      className="cp-qd"
      role="list"
      aria-label={t({ id: 'sessions.composer.queued', defaultMessage: 'Queued messages' })}
    >
      {hidden > 0 && (
        <div className="cp-qmore">
          <button type="button" className="cp-qmb" onClick={() => setOpen(true)}>
            <span className="cp-stg" data-kind="queued" aria-hidden="true" />
            <span className="cp-qt">
              {t(
                {
                  id: 'sessions.composer.queuedMore',
                  defaultMessage: '{count, plural, one {# more queued} other {# more queued}}',
                },
                { count: hidden },
              )}
            </span>
            <ChevronDown className="cp-qmi" aria-hidden="true" />
          </button>
          {hiddenErrors.map(alert)}
        </div>
      )}
      {queued.slice(hidden).map((message) => {
        const error = errorOf(message);
        return (
          <div key={queuedRowId(message)} className="cp-q" role="listitem">
            <div className="cp-ql">
              <span className="cp-stg" data-kind="queued" aria-hidden="true" />
              <span className="cp-qt">{message.text.split('\n', 1)[0]}</span>
              {message.attachments.length > 0 && (
                <span className="ss-qn">
                  <Paperclip className="ic-sm" aria-hidden="true" />
                  {message.attachments.length}
                </span>
              )}
              <button
                type="button"
                className="ib cp-qh"
                aria-label={t({
                  id: 'sessions.composer.editQueued',
                  defaultMessage: 'Edit queued message',
                })}
                onClick={() => {
                  usePrefill.getState().set(session.id, message);
                  drop(message);
                }}
              >
                <Pencil aria-hidden="true" />
              </button>
              {steerable && (
                <button
                  type="button"
                  className="ib"
                  aria-label={t({ id: 'sessions.composer.steerNow', defaultMessage: 'Steer now' })}
                  aria-keyshortcuts={
                    (message === queued[0] && shortcutKeys('steer-now')) || undefined
                  }
                  aria-disabled={steering !== null || undefined}
                  onClick={() => void steer(message)}
                >
                  <ArrowUp aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="ib cp-qh"
                aria-label={t({
                  id: 'sessions.composer.dropQueued',
                  defaultMessage: 'Withdraw queued message',
                })}
                onClick={() => drop(message)}
              >
                <X aria-hidden="true" />
              </button>
            </div>
            {error && alert(error)}
          </div>
        );
      })}
    </div>
  );
}
