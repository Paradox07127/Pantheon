import type { ReactNode } from 'react';
import { useBoard } from '../../data/board';
import { useRefetchTick } from '../../data/workbench-sessions';
import { t } from '../../i18n';

/** Counts up shortly after each new board event of a kind `reads` accepts, so a query reads again. */
export function useKindTick(reads: (kind: string) => boolean): number {
  const sequence = useBoard((s) => {
    for (let i = s.events.length - 1; i >= 0; i--)
      if (reads(s.events[i]!.kind)) return s.events[i]!.sequence;
    return 0;
  });
  return useRefetchTick(sequence, false);
}

export function QueryBody<T>({
  query,
  children,
}: {
  query: { data: T | null; loading: boolean; error: string | null; reload: () => void };
  children: (data: T) => ReactNode;
}) {
  if (query.data !== null) return children(query.data);
  if (query.error)
    return (
      <div className="tr-fail bd-fail" role="alert">
        <span title={query.error}>{query.error}</span>
        <button type="button" className="btn" onClick={query.reload}>
          {t({ id: 'board.query.retry', defaultMessage: 'Retry' })}
        </button>
      </div>
    );
  return (
    <div className="bd-sk" aria-busy="true">
      <span className="sk" style={{ height: 10, width: '60%' }} />
      <span className="sk" style={{ height: 10, width: '40%' }} />
    </div>
  );
}
