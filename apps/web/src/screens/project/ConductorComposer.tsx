import { useState } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Tip } from '../../components/Tip';
import { useBoard } from '../../data/board';
import { runCommand } from '../../data/commands';
import { failureText } from '../../data/needs-you';
import { t } from '../../i18n';
import { keyText } from '../../lib/shortcuts';
import { tellState } from '../changes/tell-model';
import { sessionRow } from '../sessions/model';

/** A message to the main agent: sent while it is idle, steered into its running turn; ⌘↵ sends. */
export function ConductorComposer({ main }: { main: WorkbenchSession }) {
  const target = useBoard((s) => s.board?.sessions.find((x) => x.id === main.id));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = tellState(target);
  const input = text.trim();
  const send = async () => {
    if (busy || !input || !target || !state.enabled) return;
    setBusy(true);
    setError(null);
    const result = await runCommand(state.type, { session_id: target.id, input }, target.revision);
    setBusy(false);
    if (!result.ok) setError(failureText(result.error));
    else setText('');
  };
  const sendName = t({ id: 'project.composer.send', defaultMessage: 'Send' });
  const button = (
    <button
      type="button"
      className="btn pri sm"
      aria-label={sendName}
      aria-busy={busy || undefined}
      disabled={busy || !input}
      aria-disabled={!state.enabled || undefined}
      onClick={() => void send()}
    >
      {sendName}
      <span className="kbd" aria-hidden="true">
        {keyText('Meta+Enter')}
      </span>
    </button>
  );
  return (
    <div className="pj-cmp">
      <div className="pj-box">
        <textarea
          className="pj-ta"
          rows={2}
          aria-label={t({
            id: 'project.composer.message',
            defaultMessage: 'Message to the main agent',
          })}
          placeholder={t(
            { id: 'project.composer.placeholder', defaultMessage: 'Message {title}' },
            { title: sessionRow(main).title },
          )}
          value={text}
          readOnly={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void send();
          }}
        />
        {error && (
          <div className="pj-cerr" role="alert">
            {error}
          </div>
        )}
        <div className="pj-cf">
          {state.reason ? <Tip content={state.reason}>{button}</Tip> : button}
        </div>
      </div>
    </div>
  );
}
