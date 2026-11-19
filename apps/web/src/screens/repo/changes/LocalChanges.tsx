import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { GitBranch, Undo2 } from 'lucide-react';
import { DiffCounts } from '../../../components/DiffCounts';
import { numbered } from '../../../components/DiffReview';
import { holdToastAction, toast } from '../../../components/Toast';
import { shortId } from '../../../data/format';
import { parsePatch } from '../../../data/patch';
import {
  commitFiles,
  discardFiles,
  discardLines,
  pushBranch,
  undoDiscard,
  useRepoWorkingDiff,
  type LocalResult,
  type RepoWorkingFile,
} from '../../../data/repo-local';
import { useProjectHead } from '../../../data/runtime-models';
import { t } from '../../../i18n';
import { keyText } from '../../../lib/shortcuts';
import { scrimFlag } from '../../../lib/root-flag';
import { Failure, Skeleton } from '../../board/BoardScreen';
import { Empty } from '../../board/Charts';
import { discardPatch, fileHeaders, lineKey } from './line-patch';

const LETTER: Record<RepoWorkingFile['status'], string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
};
const SIGN = { add: '+', del: '−', ctx: '' } as const;
const NONE: ReadonlySet<string> = new Set();
/** A renamed file goes to git by its new and its old path, so the old one leaves too. */
const pathsOf = (file: RepoWorkingFile) =>
  file.status === 'renamed' && file.old_path ? [file.path, file.old_path] : [file.path];

/** The diff lines picked for discarding, valid only for the file and the patch they were picked in. */
interface Marked {
  path: string;
  patch: string;
  keys: ReadonlySet<string>;
}

/** The local checkout's uncommitted files to pick for a commit or to discard, whole or by line. */
export function LocalChanges({ projectId }: { projectId: string }) {
  const diff = useRepoWorkingDiff(projectId);
  const head = useProjectHead(projectId);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(NONE);
  const [picked, setPicked] = useState<string | null>(null);
  const [marked, setMarked] = useState<Marked | null>(null);
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  // One write to the checkout at a time; the others stay off while it runs.
  const [writing, setWriting] = useState<'commit' | 'discard' | 'undo' | null>(null);
  // The toast offering to undo the last discard, whose Undo is a write too.
  const undoToast = useRef<string | null>(null);
  useEffect(() => {
    if (undoToast.current) holdToastAction(undoToast.current, writing !== null);
  }, [writing]);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);
  // The file, or the selected lines, waiting for the user to confirm the discard.
  const [asking, setAsking] = useState<RepoWorkingFile | 'lines' | null>(null);
  // Commits made here since the read at `from`, until a read from after them lands.
  const [made, setMade] = useState<{ from: string; count: number; sha: string } | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushedAt, setPushedAt] = useState<string | null>(null);
  const patchText = diff.read?.patch ?? null;
  const parsed = useMemo(() => (patchText === null ? [] : parsePatch(patchText)), [patchText]);
  const headers = useMemo(() => (patchText === null ? [] : fileHeaders(patchText)), [patchText]);
  const files = diff.read?.files ?? [];
  const shown = files.find((f) => f.path === picked) ?? files[0];
  const shownPath = shown?.path ?? null;
  // A path whose type changed (a symlink become a file) comes as a deletion and an addition.
  const fragments = useMemo(() => parsed.filter((f) => f.path === shownPath), [parsed, shownPath]);
  const hunks = useMemo(() => fragments.flatMap((f) => f.hunks), [fragments]);
  const keys =
    marked && marked.path === shownPath && marked.patch === patchText ? marked.keys : NONE;
  // Only a modified file's lines go back through git apply -R without undoing a rename or an add.
  const pickable = shown?.status === 'modified' && fragments.length === 1;
  // Typing the commit message leaves these alone, so the shown file's lines are not built again.
  const lines = useMemo(
    () =>
      hunks.map((hunk, h) => (
        <div key={h} className="rpl-hunk">
          <div className="rpl-hh">{hunk.header}</div>
          {numbered(hunk).map((line, i) => {
            const key = lineKey(h, i);
            const number = line.kind === 'del' ? line.old : line.new;
            const toggleLine = () => {
              const next = new Set(keys);
              if (!next.delete(key)) next.add(key);
              setMarked({ path: shownPath!, patch: patchText!, keys: next });
            };
            return (
              <div key={i} className="rpl-ln" data-kind={line.kind}>
                <span className="rpl-pk">
                  {pickable && line.kind !== 'ctx' && (
                    <button
                      type="button"
                      role="checkbox"
                      className="rpl-ck"
                      aria-checked={keys.has(key)}
                      aria-label={
                        line.kind === 'add'
                          ? t(
                              {
                                id: 'repo.changes.local.pickAdded',
                                defaultMessage: 'Select added line {line}',
                              },
                              { line: number! },
                            )
                          : t(
                              {
                                id: 'repo.changes.local.pickRemoved',
                                defaultMessage: 'Select removed line {line}',
                              },
                              { line: number! },
                            )
                      }
                      onClick={toggleLine}
                    />
                  )}
                </span>
                <span className="rpl-num">{line.old ?? ''}</span>
                <span className="rpl-num">{line.new ?? ''}</span>
                <span className="rpl-sg" aria-hidden="true">
                  {SIGN[line.kind]}
                </span>
                <span className="rpl-code">{line.text}</span>
              </div>
            );
          })}
        </div>
      )),
    [hunks, pickable, keys, shownPath, patchText],
  );
  if (!diff.read)
    return diff.error ? <Failure error={diff.error} onRetry={diff.reload} /> : <Skeleton />;
  const { patch, upstream } = diff.read;
  // Writes wait for a read that landed now: what is listed may no longer be what is on disk.
  const outdated = diff.stale || diff.error !== null;
  const unread = made !== null && made.from === diff.read.head_sha;
  const headSha = unread ? made.sha : diff.read.head_sha;
  const ahead = !upstream || pushedAt === headSha ? 0 : upstream.ahead + (unread ? made.count : 0);
  async function push() {
    setPushing(true);
    setPushError(null);
    const result = await pushBranch(projectId);
    setPushing(false);
    if (!result.ok) return setPushError(result.error);
    setPushedAt(headSha);
    diff.reload();
  }
  const where = (
    <span className="rpl-where">
      <GitBranch className="ic-sm" aria-hidden="true" />
      <span className="mono">{diff.read.branch ?? 'HEAD'}</span>
      {upstream && (
        <span className="rpl-up mono" title={upstream.name}>
          {upstream.name}
          {ahead > 0 && (
            <span>
              {t({ id: 'repo.changes.ahead', defaultMessage: '{count} ahead' }, { count: ahead })}
            </span>
          )}
          {upstream.behind > 0 && (
            <span>
              {t(
                { id: 'repo.changes.behind', defaultMessage: '{count} behind' },
                { count: upstream.behind },
              )}
            </span>
          )}
        </span>
      )}
    </span>
  );
  const pushButton = ahead > 0 && (
    <button
      type="button"
      className={pushing ? 'btn rpl-push btn-busy' : 'btn rpl-push'}
      disabled={pushing}
      aria-busy={pushing || undefined}
      onClick={() => void push()}
    >
      {t(
        {
          id: 'repo.changes.local.push',
          defaultMessage: '{count, plural, one {Push # commit} other {Push # commits}}',
        },
        { count: ahead },
      )}
    </button>
  );
  const pushFailure = pushError && (
    <pre className="rpl-err" role="alert">
      {pushError}
    </pre>
  );
  // A later read failed: what is listed is the last read that landed.
  const readFailure = diff.error && <Failure error={diff.error} onRetry={diff.reload} />;
  if (!shown)
    return (
      <>
        <div className="rpc-bar">
          {where}
          {pushButton}
        </div>
        {readFailure}
        {pushFailure}
        <Empty text={t({ id: 'repo.changes.clean', defaultMessage: 'No uncommitted changes' })} />
      </>
    );
  const at = parsed.findIndex((f) => f.path === shown.path);
  const checked = files.filter((f) => !excluded.has(f.path));
  const branch = head.read?.branch ?? 'HEAD';
  const message = details.trim() ? `${summary.trim()}\n\n${details.trim()}` : summary.trim();
  const committable = checked.length > 0 && summary.trim() !== '' && !writing && !outdated;
  const commitKeys = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (committable) void commit();
  };

  const toggleFile = (path: string) => {
    const next = new Set(excluded);
    if (!next.delete(path)) next.add(path);
    setExcluded(next);
  };
  async function undo(undoId: string) {
    setWriting('undo');
    const result = await undoDiscard(projectId, undoId);
    setWriting(null);
    if (!result.ok) toast({ title: result.error, kind: 'failure' });
    diff.reload();
  }
  async function discard(run: Promise<LocalResult<{ undo_id: string }>>, title: string) {
    setWriting('discard');
    setDiscardError(null);
    const result = await run;
    setWriting(null);
    if (!result.ok)
      return setDiscardError(
        result.code === 'staged_changes'
          ? t({
              id: 'repo.changes.local.staged',
              defaultMessage: 'This file has staged changes; only the whole file can be discarded',
            })
          : result.error,
      );
    setMarked(null);
    diff.reload();
    const undoId = result.value.undo_id;
    undoToast.current = toast({
      title,
      action: {
        label: t({ id: 'repo.changes.local.undo', defaultMessage: 'Undo' }),
        run: () => void undo(undoId),
      },
    });
  }
  const discardFile = (file: RepoWorkingFile) =>
    discard(
      discardFiles(projectId, pathsOf(file)),
      t(
        { id: 'repo.changes.local.discarded', defaultMessage: 'Discarded {path}' },
        { path: file.path },
      ),
    );
  const discardSelected = () =>
    discard(
      discardLines(projectId, discardPatch(headers[at]!, hunks, keys)),
      t(
        {
          id: 'repo.changes.local.discardedLines',
          defaultMessage: '{count, plural, one {Discarded # line} other {Discarded # lines}}',
        },
        { count: keys.size },
      ),
    );
  async function commit() {
    setWriting('commit');
    setCommitError(null);
    const before = unread ? made : { from: diff.read!.head_sha, count: 0 };
    const sent = { summary, details };
    const result = await commitFiles(projectId, checked.flatMap(pathsOf), message);
    setWriting(null);
    if (!result.ok) return setCommitError(result.error);
    setMade({ from: before.from, count: before.count + 1, sha: result.value.sha });
    // Text typed while the commit ran is the next message.
    setSummary((now) => (now === sent.summary ? '' : now));
    setDetails((now) => (now === sent.details ? '' : now));
    diff.reload();
    toast({
      title: t(
        { id: 'repo.changes.local.committed', defaultMessage: 'Committed {sha}' },
        { sha: shortId(result.value.sha) },
      ),
    });
  }

  const all = checked.length === files.length ? 'true' : checked.length === 0 ? 'false' : 'mixed';
  const confirmed = () => {
    setAsking(null);
    if (asking === 'lines') void discardSelected();
    else if (asking) void discardFile(asking);
  };
  const confirmation = (
    <AlertDialog.Root
      open={asking !== null && (asking !== 'lines' || keys.size > 0)}
      onOpenChange={(next) => {
        if (!next) setAsking(null);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="pj-scrim" ref={scrimFlag} />
        <AlertDialog.Popup className="pj-dlg pj-rm pop">
          <div className="pj-dh">
            <AlertDialog.Title className="pj-dt">
              {asking === 'lines'
                ? t(
                    {
                      id: 'repo.changes.local.confirmLines',
                      defaultMessage:
                        '{count, plural, one {Discard # selected line?} other {Discard # selected lines?}}',
                    },
                    { count: keys.size },
                  )
                : t(
                    {
                      id: 'repo.changes.local.confirmFile',
                      defaultMessage: 'Discard changes to {path}?',
                    },
                    { path: asking?.path ?? '' },
                  )}
            </AlertDialog.Title>
          </div>
          <AlertDialog.Description className="pj-rm-body">
            {asking !== 'lines' && asking?.status === 'untracked'
              ? t({
                  id: 'repo.changes.local.confirmUntracked',
                  defaultMessage: 'Git does not track this file, so it will be deleted.',
                })
              : t({
                  id: 'repo.changes.local.confirmBody',
                  defaultMessage: 'These changes go back to the last commit.',
                })}
          </AlertDialog.Description>
          <div className="pj-df">
            <span style={{ flex: 1 }} />
            <AlertDialog.Close className="btn">
              {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
            </AlertDialog.Close>
            <button type="button" className="btn dng" disabled={outdated} onClick={confirmed}>
              {t({ id: 'repo.changes.local.confirmDiscard', defaultMessage: 'Discard' })}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
  return (
    <div className="rpl">
      <section
        className="rpl-side"
        aria-label={t({ id: 'repo.changes.local.files', defaultMessage: 'Local changes' })}
      >
        <div className="rpc-bar">
          <button
            type="button"
            role="checkbox"
            className="rpl-ck"
            aria-checked={all}
            aria-label={t({ id: 'repo.changes.local.all', defaultMessage: 'Select all changes' })}
            onClick={() => setExcluded(all === 'true' ? new Set(files.map((f) => f.path)) : NONE)}
          />
          <span className="rpl-title">
            {t(
              {
                id: 'repo.changes.local.count',
                defaultMessage: '{count, plural, one {# change} other {# changes}}',
              },
              { count: files.length },
            )}
          </span>
          {where}
        </div>
        {readFailure}
        <ul className="rpl-files">
          {files.map((file) => {
            const discardText = t(
              { id: 'repo.changes.local.discard', defaultMessage: 'Discard changes to {path}' },
              { path: file.path },
            );
            return (
              <li key={file.path} className="rpl-row">
                <button
                  type="button"
                  role="checkbox"
                  className="rpl-ck"
                  aria-checked={!excluded.has(file.path)}
                  aria-label={t(
                    { id: 'repo.changes.local.include', defaultMessage: 'Commit {path}' },
                    { path: file.path },
                  )}
                  onClick={() => toggleFile(file.path)}
                />
                <button
                  type="button"
                  className="rpl-pick"
                  aria-pressed={file.path === shown.path}
                  onClick={() => setPicked(file.path)}
                >
                  <span className="rpc-st mono">{LETTER[file.status]}</span>
                  <span className="rpc-path mono" title={file.path}>
                    {file.path}
                  </span>
                </button>
                <button
                  type="button"
                  className="ib rpl-drop"
                  aria-label={discardText}
                  title={discardText}
                  disabled={writing !== null || outdated}
                  onClick={() => setAsking(file)}
                >
                  <Undo2 aria-hidden="true" />
                </button>
                {file.additions !== null && file.deletions !== null && (
                  <span className="rpl-n mono">
                    <DiffCounts additions={file.additions} deletions={file.deletions} />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <div className="rpl-commit">
          <input
            className="inp"
            aria-label={t({ id: 'repo.changes.local.summary', defaultMessage: 'Commit message' })}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={commitKeys}
          />
          <textarea
            className="rpl-details"
            aria-label={t({ id: 'repo.changes.local.details', defaultMessage: 'Description' })}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            onKeyDown={commitKeys}
          />
          <button
            type="button"
            className="btn pri rpl-go"
            disabled={!committable}
            aria-busy={writing === 'commit' || undefined}
            title={keyText('Meta+Enter')}
            onClick={() => void commit()}
          >
            {t(
              {
                id: 'repo.changes.local.commit',
                defaultMessage:
                  '{count, plural, one {Commit # file to {branch}} other {Commit # files to {branch}}}',
              },
              { count: checked.length, branch },
            )}
          </button>
          {pushButton}
          {commitError && (
            <pre className="rpl-err" role="alert">
              {commitError}
            </pre>
          )}
          {pushFailure}
        </div>
      </section>
      <section
        className="rpl-diff"
        aria-label={t({ id: 'repo.changes.local.diff', defaultMessage: 'Diff' })}
      >
        <div className="rpc-bar">
          <span className="rpc-path mono rpl-title" title={shown.path}>
            {shown.path}
          </span>
          {keys.size > 0 && (
            <button
              type="button"
              className="btn sm ghost"
              disabled={writing !== null || outdated}
              onClick={() => setAsking('lines')}
            >
              {t({
                id: 'repo.changes.local.discardLines',
                defaultMessage: 'Discard selected lines',
              })}
            </button>
          )}
        </div>
        {discardError && (
          <p className="rpl-err" role="alert">
            {discardError}
          </p>
        )}
        {patch === null ? (
          <Empty
            text={t({
              id: 'repo.changes.local.tooLarge',
              defaultMessage: 'The diff is too large to show',
            })}
          />
        ) : (
          <div className="rpl-hunks mono">{lines}</div>
        )}
      </section>
      {confirmation}
    </div>
  );
}
