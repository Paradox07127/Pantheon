import { currentLocale, t } from '../i18n';
import './read-status.css';

/** Freshness of an observation kept visible while its source is unavailable. */
export function ReadStatus({
  label,
  stale,
  loading: noData,
  refreshing,
  error,
  readAt,
  reload,
}: {
  label: string;
  stale?: boolean;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  readAt?: number | null;
  reload: () => void;
}) {
  if (!stale && !error) return null;
  const loading = noData || refreshing;
  return (
    <div className="read-status" role={error ? 'alert' : 'status'}>
      <span>
        {error
          ? t(
              { id: 'components.readStatus.failed', defaultMessage: "{label}: couldn't read" },
              { label },
            )
          : loading
            ? t(
                { id: 'components.readStatus.updating', defaultMessage: '{label}: updating' },
                { label },
              )
            : t(
                {
                  id: 'components.readStatus.disconnected',
                  defaultMessage: '{label}: disconnected',
                },
                { label },
              )}
      </span>
      {stale && (
        <span>
          {t({ id: 'components.readStatus.stale', defaultMessage: 'Data is out of date' })}
        </span>
      )}
      {readAt != null && (
        <time
          dateTime={new Date(readAt).toISOString()}
          title={new Date(readAt).toLocaleString(currentLocale(), { hour12: false })}
        >
          {t(
            { id: 'components.readStatus.readAt', defaultMessage: 'Last read {time}' },
            { time: new Date(readAt).toLocaleTimeString(currentLocale(), { hour12: false }) },
          )}
        </time>
      )}
      {error && (
        <span className="read-status-error" title={error}>
          {error}
        </span>
      )}
      <button type="button" className="btn" disabled={loading} onClick={reload}>
        {loading
          ? t({ id: 'components.readStatus.updatingButton', defaultMessage: 'Updating' })
          : error
            ? t({ id: 'components.readStatus.retry', defaultMessage: 'Retry' })
            : t({ id: 'components.readStatus.refresh', defaultMessage: 'Refresh' })}
      </button>
    </div>
  );
}
