import { FileDiff } from 'lucide-react';
import type { SessionDiff } from '@pantheon/protocol';
import { DiffCounts } from '../../components/DiffCounts';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { PathText } from '../../components/PathText';
import { useSessionDiff } from '../../data/workbench-sessions';
import { t } from '../../i18n';
import { useShell } from '../../store';
import './changed-files.css';

type DiffFile = SessionDiff['files'][number];

/** Five cells split between added and removed lines. */
export function diffCells(additions: number, deletions: number) {
  const total = additions + deletions;
  if (!total) return null;
  const added = Math.round((additions / total) * 5);
  return (
    <span
      className="chg-dcells"
      role="img"
      aria-label={t(
        {
          id: 'changes.files.total',
          defaultMessage: '{additions} lines added, {deletions} removed',
        },
        { additions, deletions },
      )}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} data-k={i < added ? 'a' : 'd'} />
      ))}
    </span>
  );
}

/** One row per changed file, its bar scaled to the file with the most changed lines; a row opens the diff. */
function fileBars(files: readonly DiffFile[], sessionId: string) {
  const top = Math.max(1, ...files.map((f) => (f.additions ?? 0) + (f.deletions ?? 0)));
  return (
    <ul
      className="chg-dfl"
      aria-label={t({ id: 'changes.files.title', defaultMessage: 'Changed files' })}
    >
      {files.map((file) => {
        const added = file.additions ?? 0;
        const removed = file.deletions ?? 0;
        return (
          <li key={file.path}>
            <button
              type="button"
              className="chg-dfl-h"
              aria-label={t(
                { id: 'changes.files.open', defaultMessage: 'Open {path} in the diff' },
                { path: file.path },
              )}
              onClick={() => useShell.getState().openSession(sessionId, 'diff')}
            >
              <PathText path={file.path} className="mono" />
              <span className="chg-num">
                <DiffCounts additions={file.additions} deletions={file.deletions} />
              </span>
            </button>
            <span
              className="chg-dfb"
              role="img"
              aria-label={t(
                {
                  id: 'changes.files.file',
                  defaultMessage: '{path}: {additions} lines added, {deletions} removed',
                },
                { path: file.path, additions: added, deletions: removed },
              )}
            >
              <i data-k="a" style={{ flexGrow: added }} />
              <i data-k="d" style={{ flexGrow: removed }} />
              <i style={{ flexGrow: top - added - removed }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The changed files of a session, with their total in five cells beside the heading. */
export function ChangedFiles({ sessionId }: { sessionId: string }) {
  const diff = useSessionDiff(sessionId);
  const title = t({ id: 'changes.files.title', defaultMessage: 'Changed files' });
  const files = diff.data?.files ?? [];
  const sum = (pick: (f: DiffFile) => number | null) =>
    files.reduce((total, f) => total + (pick(f) ?? 0), 0);
  return (
    <section className="chg-sec" aria-label={title}>
      <div className="chg-sec-h">
        <FileDiff className="ic-sm chg-mu" aria-hidden="true" />
        <b>{title}</b>
        <span className="chg-dsum">
          {diffCells(
            sum((f) => f.additions),
            sum((f) => f.deletions),
          )}
        </span>
      </div>
      {diff.data ? (
        files.length ? (
          fileBars(files, sessionId)
        ) : (
          <span className="chg-mu">
            {t({ id: 'changes.files.none', defaultMessage: 'No changed files.' })}
          </span>
        )
      ) : diff.error ? (
        <Failure error={diff.error} onRetry={diff.reload} />
      ) : (
        <Skeleton />
      )}
    </section>
  );
}
