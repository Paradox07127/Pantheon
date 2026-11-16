import { useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { Tip } from '../../components/Tip';
import { draftKey, useDrafts } from '../../data/drafts';
import { t } from '../../i18n';
import { tellLead, type RunBoardCommand, type SnapshotSession } from './panels-model';

const tellText = () => t({ id: 'board.lead.tell.title', defaultMessage: 'Tell the lead' });
import './charts.css';
import './drawer.css';

/**
 * Props for a Dialog.Root that stays mounted: `show` opens it with content, and the content stays
 * until the exit transition ends, so the popup animates out instead of vanishing.
 */
export function useDialogContent<T>() {
  const [content, setContent] = useState<T | null>(null);
  const [open, setOpen] = useState(false);
  return {
    content,
    show: (next: T) => {
      setContent(next);
      setOpen(true);
    },
    close: () => setOpen(false),
    root: {
      open,
      onOpenChange: (next: boolean) => {
        if (!next) setOpen(false);
      },
      onOpenChangeComplete: (next: boolean) => {
        if (!next) setContent(null);
      },
    },
  };
}

function TellDialog({
  lead,
  draft,
  run,
  onSent,
}: {
  lead: SnapshotSession | undefined;
  draft: string;
  run: RunBoardCommand;
  onSent: () => void;
}) {
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const input = text.trim();
  const send = async () => {
    const state = tellLead(lead);
    if (!lead || !state.enabled) {
      setError(state.reason);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await run(state.type, { session_id: lead.id, input }, lead.revision);
    setBusy(false);
    if (failure) setError(failure);
    else onSent();
  };
  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="pj-scrim" />
      <Dialog.Popup
        className="pj-dlg pj-rm pop"
        initialFocus={() => {
          const el = ref.current;
          el?.focus();
          el?.setSelectionRange(el.value.length, el.value.length);
          return false;
        }}
      >
        <div className="pj-dh">
          <Dialog.Title className="pj-dt">{tellText()}</Dialog.Title>
        </div>
        <div className="bp-dlb">
          <textarea
            ref={ref}
            className="bp-ta"
            rows={4}
            aria-label={t({ id: 'board.lead.tell.message', defaultMessage: 'Message to the lead' })}
            value={text}
            readOnly={busy}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {error && (
          <div className="pj-err" role="alert">
            <b>{error}</b>
          </div>
        )}
        <div className="pj-df">
          <span style={{ flex: 1 }} />
          <Dialog.Close className="btn ghost">
            {t({ id: 'board.lead.tell.cancel', defaultMessage: 'Cancel' })}
          </Dialog.Close>
          <button
            type="button"
            className="btn pri"
            aria-busy={busy || undefined}
            disabled={busy || !input}
            onClick={() => void send()}
          >
            {t({ id: 'board.lead.tell.send', defaultMessage: 'Send' })}
          </button>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

/**
 * A message to the lead about one task, written in the page and kept per lead and task until sent;
 * Enter sends it, Shift+Enter starts a new line.
 */
export function TellLeadBox({
  lead,
  taskId,
  draft,
  run,
}: {
  lead: SnapshotSession | undefined;
  taskId: string;
  draft: string;
  run: RunBoardCommand;
}) {
  const key = draftKey(lead?.project_id ?? '', lead?.id ?? null, taskId);
  const text = useDrafts((s) => s.drafts[key]?.text) ?? draft;
  const setText = (value: string) => useDrafts.getState().update(key, () => ({ text: value }));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = tellLead(lead);
  const input = text.trim();
  const send = async () => {
    if (busy || sent || !input || !lead || !state.enabled) return;
    setBusy(true);
    setError(null);
    const failure = await run(state.type, { session_id: lead.id, input }, lead.revision);
    setBusy(false);
    if (failure) setError(failure);
    else {
      useDrafts.getState().sent(key, { text, attachments: [], skills: [] });
      setSent(true);
    }
  };
  const effect =
    state.reason ??
    (state.type === 'session.steer'
      ? t({
          id: 'board.drawer.tell.steer',
          defaultMessage: 'The lead reads this in the turn it is running',
        })
      : t({
          id: 'board.drawer.tell.send',
          defaultMessage: 'The lead takes this as its next message',
        }));
  return (
    <div className="bd-tell">
      <textarea
        rows={2}
        aria-label={tellText()}
        value={text}
        readOnly={busy}
        onChange={(e) => {
          setText(e.target.value);
          setSent(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          void send();
        }}
      />
      {error && (
        <div className="bd-tellerr" role="alert">
          {error}
        </div>
      )}
      <div className="bd-tellf">
        <span className="bd-tellw">{effect}</span>
        <button
          type="button"
          className="btn pri sm"
          aria-busy={busy || undefined}
          disabled={busy || sent || !input || !state.enabled}
          onClick={() => void send()}
        >
          {sent
            ? t({ id: 'board.lead.tell.sent', defaultMessage: 'Sent' })
            : t({ id: 'board.lead.tell.send', defaultMessage: 'Send' })}
          <span className="kbd" aria-hidden="true">
            ↵
          </span>
        </button>
      </div>
    </div>
  );
}

/** Opens a message to the lead about one item of its plan; the plan itself only the lead edits. */
export function TellLead({
  lead,
  draft,
  label,
  run,
  className = 'btn',
  text = tellText(),
}: {
  lead: SnapshotSession | undefined;
  draft: string;
  label: string;
  run: RunBoardCommand;
  className?: string;
  text?: string;
}) {
  // Each opening gets its own number; a send finishing after a later opening leaves it alone.
  const dialog = useDialogContent<number>();
  const openings = useRef(0);
  // The lead and draft the last message went to; the sent label shows only while they hold.
  const target = `${lead?.id ?? ''}\n${draft}`;
  const [sentTo, setSentTo] = useState<string | null>(null);
  const sent = sentTo === target;
  const state = tellLead(lead);
  const opening = dialog.content;
  const shownText = sent ? t({ id: 'board.lead.tell.sent', defaultMessage: 'Sent' }) : text;
  const button = (
    <button
      type="button"
      className={className}
      aria-label={t(
        { id: 'board.lead.tell.buttonLabel', defaultMessage: '{action} {label}' },
        { action: shownText, label },
      )}
      aria-disabled={!state.enabled || undefined}
      onClick={() => {
        if (!state.enabled) return;
        setSentTo(null);
        dialog.show(++openings.current);
      }}
    >
      {shownText}
    </button>
  );
  return (
    <>
      {state.reason ? <Tip content={state.reason}>{button}</Tip> : button}
      <Dialog.Root {...dialog.root}>
        {dialog.content !== null && (
          <TellDialog
            key={dialog.content}
            lead={lead}
            draft={draft}
            run={run}
            onSent={() => {
              if (opening === openings.current) dialog.close();
              setSentTo(target);
            }}
          />
        )}
      </Dialog.Root>
    </>
  );
}
