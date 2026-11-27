import { useState } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { ChangeRow, WorkbenchSession } from '@pantheon/protocol';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { draftKey, useDrafts } from '../../data/drafts';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { tellDraft, tellState } from './tell-model';
import './tell-box.css';

type Recipient = 'session' | 'main';

/**
 * A message about one change to the session doing it or to the main agent that started that
 * session, kept per recipient and change until sent; Enter sends it, Shift+Enter starts a new line.
 */
export function TellBox({
  row,
  session,
  main,
  draft = tellDraft(row),
}: {
  row: Pick<ChangeRow, 'id' | 'title' | 'branch'>;
  session: Pick<WorkbenchSession, 'id'>;
  /** The main agent that spawned the session; null when none did or it is not listed. */
  main: Pick<WorkbenchSession, 'id'> | null;
  /** The message's first line; the change's title and branch by default. */
  draft?: string;
}) {
  const [choice, setChoice] = useState<Recipient>('session');
  const recipient = choice === 'main' && main ? main : session;
  const target = useBoard((s) => s.board?.sessions.find((x) => x.id === recipient.id));
  const key = draftKey(target?.project_id ?? '', recipient.id, row.id);
  const text = useDrafts((s) => s.drafts[key]?.text) ?? draft;
  const setText = (value: string) => useDrafts.getState().update(key, () => ({ text: value }));
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = sentTo === key;
  const state = tellState(target);
  const input = text.trim();
  // The prefilled reference alone says nothing to the agent.
  const empty = !input || input === draft.trim();
  const send = async () => {
    if (busy || sent || empty || !target || !state.enabled) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(state.type, { session_id: target.id, input }, target.revision);
    setBusy(false);
    if (!result.ok) setError(failureText(result.error));
    else {
      useDrafts.getState().sent(key, { text, attachments: [], skills: [] });
      setSentTo(key);
    }
  };
  const title = t({ id: 'changes.tell.title', defaultMessage: 'Tell' });
  const sendName = sent
    ? t({ id: 'changes.tell.sent', defaultMessage: 'Sent' })
    : t({ id: 'changes.tell.send', defaultMessage: 'Send' });
  const button = (
    <button
      type="button"
      className="btn pri sm"
      aria-label={sendName}
      aria-busy={busy || undefined}
      disabled={busy || sent || empty}
      aria-disabled={!state.enabled || undefined}
      onClick={() => void send()}
    >
      {sendName}
      <span className="kbd" aria-hidden="true">
        ↵
      </span>
    </button>
  );
  return (
    <section className="chg-tell" aria-label={title}>
      <textarea
        className="chg-tell-ta"
        rows={2}
        aria-label={t({ id: 'changes.tell.message', defaultMessage: 'Message to the agent' })}
        value={text}
        readOnly={busy}
        onChange={(e) => {
          setText(e.target.value);
          setSentTo(null);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
          e.preventDefault();
          void send();
        }}
      />
      {error && (
        <div className="chg-tell-err" role="alert">
          {error}
        </div>
      )}
      <div className="chg-tell-f">
        {main && (
          <RadioGroup<Recipient>
            className="tb-seg"
            aria-label={t({ id: 'changes.tell.recipient', defaultMessage: 'Send to' })}
            value={choice}
            onValueChange={(value) => setChoice(value)}
          >
            <Radio.Root value="session">
              {t({ id: 'changes.tell.session', defaultMessage: 'This session' })}
            </Radio.Root>
            <Radio.Root value="main">
              {t({ id: 'changes.tell.main', defaultMessage: 'Main agent' })}
            </Radio.Root>
          </RadioGroup>
        )}
        <span className="chg-tell-gap" />
        {state.reason ? <Tip content={state.reason}>{button}</Tip> : button}
      </div>
    </section>
  );
}
