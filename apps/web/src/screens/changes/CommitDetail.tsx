import { useState } from 'react';
import { FileDiff, GitCommitHorizontal, GitMerge, History, X } from 'lucide-react';
import type { RepoCommit, WorkbenchSession } from '@pantheon/protocol';
import { Clip } from '../../components/Clip';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { SessionStateIcon } from '../../components/SessionStateIcon';
import { ageText, useNow } from '../../data/needs-you';
import { useRepoCommitAfter, useRepoCommitDiff, useRepoLog } from '../../data/repo';
import { t } from '../../i18n';
import { useShell } from '../../store';
import { sessionRow } from '../sessions/session-groups';
import { HunkLines } from '../sessions/story/parts';
import { diffCells, fileBars } from './ChangedFiles';
import { FileHistory } from './FileHistory';

export const shortSha = (sha: string) => sha.slice(0, 7);

export const landingText = () =>
  t({ id: 'changes.commits.branchLanding', defaultMessage: 'Branch landing' });

/** Which session or branch landing brought a commit in; nothing when neither did. */
export function CommitAttribution({
  commit,
  sessions,
  place,
}: {
  commit: Pick<RepoCommit, 'session_id' | 'landing_id'>;
  sessions: readonly WorkbenchSession[] | null;
  place: 'list' | 'card';
}) {
  const session = commit.session_id ? sessions?.find((s) => s.id === commit.session_id) : undefined;
  return (
    <>
      {session && (
        <button
          type="button"
          className="chc-ses"
          onClick={(e) => {
            // The row would pick this commit.
            e.stopPropagation();
            useShell.getState().openSession(session.id);
          }}
        >
          <SessionStateIcon session={session} place={place} />
          <Clip text={sessionRow(session).title} />
        </button>
      )}
      {commit.session_id && sessions && !session && (
        <span className="chip">
          {t({ id: 'changes.commits.deletedSession', defaultMessage: 'Deleted session' })}
        </span>
      )}
      {commit.landing_id && <span className="chip">{landingText()}</span>}
    </>
  );
}

function CopySha({ sha }: { sha: string }) {
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(sha);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  return (
    <span className="chc-sha">
      <span className="mono">{sha}</span>
      <button
        type="button"
        className="idt-copy"
        aria-label={t({ id: 'changes.commits.copySha', defaultMessage: 'Copy {sha}' }, { sha })}
        onClick={() => void copy()}
      >
        {t({ id: 'changes.commits.copy', defaultMessage: 'Copy' })}
      </button>
      {failed && (
        <span role="alert">
          {t({ id: 'changes.commits.copyFailed', defaultMessage: "Couldn't copy" })}
        </span>
      )}
    </span>
  );
}

/** One commit beside the graph: its message, facts, who brought it in, its files and their diff. */
export function CommitDetail({
  projectId,
  sha,
  commit,
  sessions,
  onOpen,
  onClose,
}: {
  projectId: string | null;
  sha: string;
  /** The commit as the graph listed it; read here when the graph has not loaded it. */
  commit: RepoCommit | null;
  sessions: readonly WorkbenchSession[] | null;
  onOpen: (sha: string) => void;
  onClose: () => void;
}) {
  const own = useRepoLog(commit ? null : projectId, 1, 0, sha);
  const shown = commit ?? own.read?.commits[0] ?? null;
  const diff = useRepoCommitDiff(projectId, sha);
  const after = useRepoCommitAfter(projectId, sha);
  const now = useNow(60_000);
  const [picked, setPicked] = useState<string | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const files = diff.read?.files ?? [];
  const file = files.find((f) => f.path === picked) ?? files[0];
  const hunks = file ? (diff.read?.hunks ?? []).filter((h) => h.file === file.path) : [];
  const sum = (key: 'additions' | 'deletions') => files.reduce((n, f) => n + (f[key] ?? 0), 0);
  const next = after.read?.next ?? null;
  const filesName = t({ id: 'changes.commits.files', defaultMessage: 'Changed files' });
  const label = t(
    { id: 'changes.commits.detail', defaultMessage: 'Commit {sha}' },
    { sha: shortSha(sha) },
  );

  const opened = files.find((f) => f.path === history);
  // A deleted file has no lines at its commit; a file reached from co-changes may not exist there.
  const at = opened ? (opened.status === 'deleted' ? `${sha}^` : sha) : undefined;
  if (history)
    return (
      <FileHistory
        key={history}
        projectId={projectId}
        path={history}
        at={at}
        sessions={sessions}
        onOpenCommit={(commitSha) => {
          setHistory(null);
          onOpen(commitSha);
        }}
        onOpenFile={setHistory}
        onBack={() => setHistory(null)}
      />
    );
  return (
    <aside className="chg-insp" aria-label={label}>
      <div className="chg-insp-h">
        {shown && shown.parents.length > 1 ? (
          <GitMerge className="ic-sm" aria-hidden="true" />
        ) : (
          <GitCommitHorizontal className="ic-sm" aria-hidden="true" />
        )}
        <h2>
          <Clip text={shown?.subject ?? shortSha(sha)} />
        </h2>
        <button
          type="button"
          className="ib"
          aria-label={t({ id: 'changes.inspector.close', defaultMessage: 'Close' })}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div className="chg-insp-b">
        {shown ? (
          <>
            {shown.body && <pre className="chc-body">{shown.body}</pre>}
            <dl className="cpr-kv">
              <dt>{t({ id: 'changes.commits.author', defaultMessage: 'Author' })}</dt>
              <dd className="chc-line">
                <span>{shown.author}</span>
                <span className="mono chg-mu">{shown.author_email}</span>
              </dd>
              <dt>{t({ id: 'changes.commits.time', defaultMessage: 'Committed' })}</dt>
              <dd>
                <time
                  dateTime={new Date(shown.committed_at).toISOString()}
                  title={new Date(shown.committed_at).toLocaleString()}
                >
                  {ageText(shown.committed_at, now)}
                </time>
              </dd>
              <dt>{t({ id: 'changes.commits.sha', defaultMessage: 'SHA' })}</dt>
              <dd>
                <CopySha sha={shown.sha} />
              </dd>
              {shown.parents.length > 0 && (
                <>
                  <dt>
                    {t(
                      {
                        id: 'changes.commits.parents',
                        defaultMessage: '{count, plural, one {Parent} other {Parents}}',
                      },
                      { count: shown.parents.length },
                    )}
                  </dt>
                  <dd className="chc-line">
                    {shown.parents.map((parent) => (
                      <button
                        key={parent}
                        type="button"
                        className="cpr-link mono"
                        title={parent}
                        onClick={() => onOpen(parent)}
                      >
                        {shortSha(parent)}
                      </button>
                    ))}
                  </dd>
                </>
              )}
              {(shown.session_id || shown.landing_id) && (
                <>
                  <dt>{t({ id: 'changes.commits.broughtBy', defaultMessage: 'Landed by' })}</dt>
                  <dd className="chc-line">
                    <CommitAttribution commit={shown} sessions={sessions} place="card" />
                  </dd>
                </>
              )}
            </dl>
          </>
        ) : own.error ? (
          <Failure error={own.error} onRetry={own.reload} />
        ) : (
          <Skeleton />
        )}
        <section className="chg-sec" aria-label={filesName}>
          <div className="chg-sec-h">
            <FileDiff className="ic-sm chg-mu" aria-hidden="true" />
            <b>{filesName}</b>
            <span className="chg-dsum">{diffCells(sum('additions'), sum('deletions'))}</span>
          </div>
          {diff.read ? (
            files.length ? (
              fileBars(
                files,
                setPicked,
                (path) =>
                  t(
                    { id: 'changes.commits.showFile', defaultMessage: '{path}, shows its diff' },
                    { path },
                  ),
                file?.path,
                (path) => {
                  const name = t(
                    {
                      id: 'changes.commits.file.open',
                      defaultMessage: 'Open the history of {path}',
                    },
                    { path },
                  );
                  return (
                    <button
                      type="button"
                      className="ib"
                      aria-label={name}
                      title={name}
                      onClick={() => setHistory(path)}
                    >
                      <History aria-hidden="true" />
                    </button>
                  );
                },
              )
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
        {diff.read && file && (
          <section
            className="chc-diff"
            aria-label={t(
              { id: 'changes.commits.fileDiff', defaultMessage: 'Changes in {path}' },
              { path: file.path },
            )}
          >
            {diff.read.truncated ? (
              <span className="chg-mu">
                {t({
                  id: 'changes.commits.truncated',
                  defaultMessage: 'Too many changes to show in full',
                })}
              </span>
            ) : hunks.length === 0 ? (
              <span className="chg-mu">
                {t({ id: 'changes.commits.noText', defaultMessage: 'No text changes' })}
              </span>
            ) : (
              hunks.map((hunk) => <HunkLines key={hunk.id} hunk={hunk} />)
            )}
          </section>
        )}
      </div>
      {next ? (
        <div className="chg-foot">
          <button type="button" className="btn" onClick={() => onOpen(next.sha)}>
            {t({ id: 'changes.commits.next', defaultMessage: 'Next commit' })}
          </button>
        </div>
      ) : (
        after.error && (
          <div className="chg-foot">
            <Failure error={after.error} onRetry={after.reload} />
          </div>
        )
      )}
    </aside>
  );
}
