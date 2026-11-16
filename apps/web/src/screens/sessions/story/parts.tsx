import { useState } from 'react';
import type { DiffHunk } from '@pantheon/protocol';
import { t } from '../../../i18n';

export function CommandLine({ command }: { command: string }) {
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  return (
    <div className="gl-cmd">
      <code className="mono">{command}</code>
      <button
        type="button"
        className="idt-copy"
        aria-label={t(
          { id: 'sessions.panel.story.copyCommand', defaultMessage: 'Copy command {command}' },
          { command },
        )}
        onClick={() => void copy()}
      >
        {t({ id: 'sessions.panel.story.copy', defaultMessage: 'Copy' })}
      </button>
      {failed && (
        <span role="alert">
          {t({ id: 'sessions.panel.story.copyFailed', defaultMessage: "Couldn't copy" })}
        </span>
      )}
    </div>
  );
}

const lineKind = (line: string) => (line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx');

/** A hunk's header and body lines, added lines green and removed lines red. */
export function HunkLines({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="df-hunks mono">
      <div className="df-hh">{hunk.header}</div>
      {hunk.text.split('\n').map((line, i) => (
        <div key={i} className={`df-ln ${lineKind(line)}`}>
          {line}
        </div>
      ))}
    </div>
  );
}
