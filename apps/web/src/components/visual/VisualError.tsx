import { useState } from 'react';
import { CircleX } from 'lucide-react';
import { t } from '../../i18n';
import './sandbox-frame.css';
import './visual.css';

/** A picture that did not draw: what went wrong, the error as it came, the fix request and the spec. */
export function VisualError({
  message,
  error,
  onFix,
  onViewSpec,
}: {
  message: string;
  error: string;
  /** Sends the error to the session that drew the visual and resolves to why that failed. */
  onFix?: ((error: string) => Promise<string | null>) | undefined;
  onViewSpec: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const fix = async () => {
    if (!onFix || sending) return;
    setSending(true);
    setFailed(null);
    const reason = await onFix(error);
    setSending(false);
    setFailed(reason);
  };
  return (
    <div className="vis-page-err" role="alert">
      <CircleX aria-hidden="true" />
      <span>{message}</span>
      {error && <code>{error}</code>}
      <span className="vis-err-acts">
        {onFix && (
          <button
            type="button"
            className="btn sm pri"
            disabled={sending}
            aria-busy={sending || undefined}
            onClick={() => void fix()}
          >
            {t({ id: 'visual.error.fix', defaultMessage: 'Ask the agent to fix' })}
          </button>
        )}
        <button type="button" className="btn sm" onClick={onViewSpec}>
          {t({ id: 'visual.card.viewSpec', defaultMessage: 'View spec' })}
        </button>
      </span>
      {failed && <span className="vis-msg">{failed}</span>}
    </div>
  );
}
