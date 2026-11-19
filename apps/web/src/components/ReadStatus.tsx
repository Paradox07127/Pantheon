import { useBoard } from '../data/board';
import { cachedQuery } from '../data/query-cache';
import { useProjectHead } from '../data/runtime-models';
import { t } from '../i18n';
import { dayText } from '../lib/time-text';
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
  inner,
}: {
  label: string;
  stale?: boolean;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  readAt?: number | null;
  reload: () => void;
  /** Another status on the page says the connection is down; this one then names only failures. */
  inner?: boolean;
}) {
  if (!stale && !error) return null;
  const loading = !!(noData || refreshing);
  if (!error)
    return (
      <KeptStatus label={label} loading={loading} readAt={readAt} reload={reload} inner={inner} />
    );
  return (
    <div className="read-status" role="alert">
      <span>
        {t(
          { id: 'components.readStatus.failed', defaultMessage: "{label}: couldn't read" },
          { label },
        )}
      </span>
      <span className="read-status-error" title={error}>
        {error}
      </span>
      <button type="button" className="btn" disabled={loading} onClick={reload}>
        {loading
          ? t({ id: 'components.readStatus.updatingButton', defaultMessage: 'Updating' })
          : t({ id: 'components.readStatus.retry', defaultMessage: 'Retry' })}
      </button>
    </div>
  );
}

/** Data kept on screen; while disconnected, when it was read and a way to connect again. */
function KeptStatus({
  label,
  loading,
  readAt,
  reload,
  inner,
}: {
  label: string;
  loading: boolean;
  readAt?: number | null;
  reload: () => void;
  inner?: boolean;
}) {
  const connection = useBoard((s) => s.status.state);
  if (connection !== 'live' && inner) return null;
  const disconnected = t(
    { id: 'components.readStatus.disconnected', defaultMessage: '{label}: disconnected' },
    { label },
  );
  if (connection !== 'live')
    return (
      <div className="read-status" role="status">
        <span>
          {readAt != null
            ? t(
                {
                  id: 'components.readStatus.offline',
                  defaultMessage: 'Disconnected; showing data read at {time}',
                },
                { time: dayText(readAt, Date.now(), { time: true }) },
              )
            : disconnected}
        </span>
        <button
          type="button"
          className="btn"
          disabled={connection === 'connecting'}
          onClick={() => useBoard.getState().reconnect()}
        >
          {t({ id: 'components.readStatus.reconnect', defaultMessage: 'Reconnect' })}
        </button>
      </div>
    );
  return (
    <div className="read-status" role="status">
      <span>
        {loading
          ? t(
              { id: 'components.readStatus.updating', defaultMessage: '{label}: updating' },
              { label },
            )
          : disconnected}
      </span>
      <button type="button" className="btn" disabled={loading} onClick={reload}>
        {loading
          ? t({ id: 'components.readStatus.updatingButton', defaultMessage: 'Updating' })
          : t({ id: 'components.readStatus.retry', defaultMessage: 'Retry' })}
      </button>
    </div>
  );
}

/** A page's status from the project's head read, for pages with no read of their own above all. */
export function ProjectReadStatus({ label, projectId }: { label: string; projectId: string }) {
  const head = useProjectHead(projectId);
  const live = useBoard((s) => s.status.state === 'live');
  return (
    <ReadStatus
      label={label}
      stale={!live}
      error={head.error}
      readAt={cachedQuery('project.head', projectId)?.readAt}
      reload={head.reload}
    />
  );
}
