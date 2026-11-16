import { useState } from 'react';
import { BookOpen, Plus, RefreshCw } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { Skeleton } from '../../components/Skeleton';
import { useNow } from '../../data/needs-you';
import { useDelayed } from '../../lib/use-delayed';
import { t } from '../../i18n';
import './entries-footer.css';

const ROWS = [136, 112, 148, 96];

/** The entry list while it reads: a group head and four rows, then the time reading has taken. */
export function EntriesLoading() {
  const [start] = useState(() => Date.now());
  const now = useNow(100);
  const shown = useDelayed(true);
  return (
    <div className="mes-load">
      <div
        className="mes-sk"
        aria-busy="true"
        aria-label={t({ id: 'memory.status.loading.label', defaultMessage: 'Reading memory' })}
      >
        <div className="mes-head">
          <Skeleton style={{ width: 48 }} />
        </div>
        {ROWS.map((width) => (
          <div key={width} className="mes-row">
            <Skeleton style={{ width: 16 }} />
            <Skeleton style={{ width }} />
            <Skeleton className="mes-grow" />
            <Skeleton style={{ width: 32 }} />
          </div>
        ))}
      </div>
      <span className="mes-note" role="status">
        {shown && (
          <>
            <span className="mes-ell" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="mes-num">
              {t(
                {
                  id: 'memory.status.loading.time',
                  defaultMessage: 'Reading, {seconds} s',
                },
                { seconds: (Math.max(0, now - start) / 1000).toFixed(1) },
              )}
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/** The entry list could not be read: the error as it came, and a retry. */
export function EntriesError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mes-fail" role="alert">
      <span className="mes-fail-t">
        <span className="mst" data-st="bad" aria-hidden="true" />
        <span>
          {t({
            id: 'memory.status.failed',
            defaultMessage: 'Cannot read the memory directory',
          })}
        </span>
      </span>
      <span className="mes-err">{message}</span>
      <button type="button" className="btn sm" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        {t({ id: 'memory.status.retry', defaultMessage: 'Retry' })}
      </button>
    </div>
  );
}

/** No memory in the project yet. */
export function EntriesEmpty({ onCreate }: { onCreate: () => void }) {
  return (
    <EmptyState
      graphic={<BookOpen aria-hidden="true" />}
      title={t({
        id: 'memory.status.empty',
        defaultMessage: 'No memory yet. What agents propose waits in Pending review first.',
      })}
      action={{
        icon: <Plus aria-hidden="true" />,
        label: t({ id: 'memory.status.empty.create', defaultMessage: 'New memory' }),
        keys: 'N',
        onClick: onCreate,
      }}
    />
  );
}
