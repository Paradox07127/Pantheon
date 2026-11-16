import { t } from '../i18n';
import './load-error.css';

/** A read that failed: what failed, and a retry when the read can run again. */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="lerr" role="alert">
      <span className="lerr-m">{message}</span>
      {onRetry && (
        <button type="button" className="btn sm" onClick={onRetry}>
          {t({ id: 'components.retry', defaultMessage: 'Retry' })}
        </button>
      )}
    </div>
  );
}
