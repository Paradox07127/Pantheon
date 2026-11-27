import type { CSSProperties } from 'react';
import { ArrowLeft, FileText } from 'lucide-react';
import type { RepoBlame, RepoFileHistory, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { ageText, useNow } from '../../data/needs-you';
import { useRepoBlame, useRepoFileHistory } from '../../data/repo';
import { t } from '../../i18n';
import { listText } from '../../lib/list-text';
import { sessionRow } from '../sessions/session-groups';
import { CommitAttribution, shortSha } from './CommitDetail';
import './file-history.css';

/** Lines drawn in the blame; there is no virtual scroll to draw the rest on demand. */
const SHOWN_LINES = 2000;

type Chunk = RepoBlame['chunks'][number];

const sessionName = (id: string, sessions: readonly WorkbenchSession[] | null) => {
  const session = sessions?.find((s) => s.id === id);
  return session ? sessionRow(session).title : id;
};

/** Each shown line's sessions whose worktree changes it unmerged; an insertion marks the line it follows, line 1 at the top. */
function pendingLines(blame: RepoBlame, shown: number) {
  const marks = new Map<number, string[]>();
  for (const { session_id, ranges } of blame.pending)
    for (const { start, count } of ranges) {
      const first = Math.max(start, 1);
      const last = Math.min(first + Math.max(count, 1) - 1, shown);
      for (let n = first; n <= last; n++) {
        const at = marks.get(n) ?? [];
        if (!at.includes(session_id)) marks.set(n, [...at, session_id]);
      }
    }
  return marks;
}

function blameLines(
  blame: RepoBlame,
  sessions: readonly WorkbenchSession[] | null,
  now: number,
  onOpenCommit: (sha: string) => void,
) {
  if (blame.text === undefined)
    return (
      <span className="chg-mu">
        {t({
          id: 'changes.commits.file.binary',
          defaultMessage: 'Binary file, contents not shown',
        })}
      </span>
    );
  const lines = blame.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const shown = Math.min(lines.length, SHOWN_LINES);
  const marks = pendingLines(blame, shown);
  const runs = blame.chunks
    .filter((c) => c.start <= shown)
    .map((c): Chunk => ({ ...c, count: Math.min(c.count, shown - c.start + 1) }));
  return (
    <>
      {(blame.truncated || lines.length > shown) && (
        <span className="chg-mu">
          {t(
            {
              id: 'changes.commits.file.partial',
              defaultMessage:
                'Only the first {count, plural, one {# line} other {# lines}} are shown',
            },
            { count: shown },
          )}
        </span>
      )}
      <div className="chf-lines">
        {runs.map((chunk) => (
          <div key={chunk.start} className="chf-chunk">
            <div className="chf-who">
              <button
                type="button"
                className="cpr-link mono"
                title={chunk.sha}
                onClick={() => onOpenCommit(chunk.sha)}
              >
                {shortSha(chunk.sha)}
              </button>
              <Clip text={chunk.author} />
              <time className="chg-mu" dateTime={new Date(chunk.at).toISOString()}>
                {ageText(chunk.at, now)}
              </time>
              <CommitAttribution commit={chunk} sessions={sessions} place="list" />
            </div>
            <div className="chf-code-col">
              {lines.slice(chunk.start - 1, chunk.start - 1 + chunk.count).map((code, i) => {
                const n = chunk.start + i;
                const pending = marks.get(n) ?? [];
                return (
                  <div key={n} className="chf-ln" data-pending={pending.length > 0 || undefined}>
                    <span className="chf-n">{n}</span>
                    <span className="chf-code">{code}</span>
                    {pending.length > 0 && (
                      <span className="chf-marks">
                        {pending.map((id) => {
                          const label = t(
                            {
                              id: 'changes.commits.file.pending',
                              defaultMessage: "{name}'s unmerged change",
                            },
                            { name: sessionName(id, sessions) },
                          );
                          return (
                            <span
                              key={id}
                              className="chf-mark"
                              role="img"
                              aria-label={label}
                              title={label}
                            />
                          );
                        })}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function historyParts(
  history: RepoFileHistory,
  sessions: readonly WorkbenchSession[] | null,
  now: number,
  onOpenCommit: (sha: string) => void,
  onOpenFile: (path: string) => void,
) {
  const top = Math.max(1, ...history.weekly.map((w) => w.count));
  const changesName = t({ id: 'changes.commits.file.changes', defaultMessage: 'Commits' });
  const cochangeName = t({
    id: 'changes.commits.file.cochange',
    defaultMessage: 'Often changed with it',
  });
  return (
    <>
      <div
        className="chf-weeks"
        role="img"
        aria-label={t(
          {
            id: 'changes.commits.file.weekly',
            defaultMessage: 'Commits in each of the last {weeks} weeks: {counts}',
          },
          {
            weeks: history.weekly.length,
            counts: listText(...history.weekly.map((w) => String(w.count))),
          },
        )}
      >
        {history.weekly.map((w) => (
          <i key={w.start} style={{ '--v': `${(w.count / top) * 100}%` } as CSSProperties} />
        ))}
      </div>
      <section className="chg-sec" aria-label={changesName}>
        <b>{changesName}</b>
        <ul className="chf-list">
          {history.changes.map((c) => (
            <li key={c.sha}>
              <button type="button" className="chf-row" onClick={() => onOpenCommit(c.sha)}>
                <span className="mono chg-mu">{shortSha(c.sha)}</span>
                <Clip text={c.subject} />
                <time className="chg-mu" dateTime={new Date(c.committed_at).toISOString()}>
                  {ageText(c.committed_at, now)}
                </time>
              </button>
              <CommitAttribution commit={c} sessions={sessions} place="list" />
            </li>
          ))}
        </ul>
      </section>
      {history.cochange.length > 0 && (
        <section className="chg-sec" aria-label={cochangeName}>
          <b>{cochangeName}</b>
          <ul className="chf-list">
            {history.cochange.map((c) => (
              <li key={c.path}>
                <button
                  type="button"
                  className="chf-co"
                  title={c.path}
                  onClick={() => onOpenFile(c.path)}
                >
                  <FileText className="ic-sm chg-mu" aria-hidden="true" />
                  <Clip text={c.path} className="mono" />
                  <span className="chg-mu chg-num">
                    {t(
                      {
                        id: 'changes.commits.file.together',
                        defaultMessage: '{count, plural, one {# time} other {# times}}',
                      },
                      { count: c.together },
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** One file in the commit's place: who last changed each line, and the file's history. */
export function FileHistory({
  projectId,
  path,
  at,
  sessions,
  onOpenCommit,
  onOpenFile,
  onBack,
}: {
  projectId: string | null;
  path: string;
  /** The revision the lines are read at; HEAD without one. */
  at?: string;
  sessions: readonly WorkbenchSession[] | null;
  onOpenCommit: (sha: string) => void;
  onOpenFile: (path: string) => void;
  onBack: () => void;
}) {
  const blame = useRepoBlame(projectId, path, at);
  const history = useRepoFileHistory(projectId, path);
  const now = useNow(60_000);
  const blameName = t({ id: 'changes.commits.file.blame', defaultMessage: 'Lines' });
  const historyName = t({ id: 'changes.commits.file.history', defaultMessage: 'History' });
  return (
    <aside
      className="chg-insp"
      data-wide=""
      aria-label={t(
        { id: 'changes.commits.file.label', defaultMessage: 'History of {path}' },
        { path },
      )}
    >
      <div className="chg-insp-h">
        <button
          type="button"
          className="ib"
          aria-label={t({ id: 'changes.commits.file.back', defaultMessage: 'Back to the commit' })}
          onClick={onBack}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <h2>
          <Clip text={path} className="mono" />
        </h2>
      </div>
      <div className="chg-insp-b">
        <section className="chg-sec" aria-label={historyName}>
          {history.error && <Failure error={history.error} onRetry={history.reload} />}
          {history.read
            ? historyParts(history.read, sessions, now, onOpenCommit, onOpenFile)
            : !history.error && <Skeleton />}
        </section>
        <section className="chg-sec" aria-label={blameName}>
          <b>{blameName}</b>
          {blame.error && <Failure error={blame.error} onRetry={blame.reload} />}
          {blame.read
            ? blameLines(blame.read, sessions, now, onOpenCommit)
            : !blame.error && <Skeleton />}
        </section>
      </div>
    </aside>
  );
}
