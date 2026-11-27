import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Tabs } from '@base-ui/react/tabs';
import { GitBranch, Undo2 } from 'lucide-react';
import { numbered } from '../../components/DiffReview';
import { EmptyState } from '../../components/EmptyState';
import { Failure, Skeleton } from '../../components/PanelBoundary';
import { closeNotice, holdToastAction, toast } from '../../components/Toast';
import { parsePatch } from '../../data/patch';
import {
  commitFiles,
  discardFiles,
  discardLines,
  pushBranch,
  undoDiscard,
  useRepoWorkingDiff,
  type LocalResult,
  type RepoWorkingFile,
} from '../../data/repo-local';
import { useNow } from '../../data/needs-you';
import { t } from '../../i18n';
import { scrimFlag } from '../../lib/root-flag';
import { useShell, type ShellState } from '../../store';
import { fileBars } from './ChangedFiles';
import { discardPatch, fileHeaders, lineKey } from './line-patch';
import './local-changes.css';

const SIGN = { add: '+', del: '−', ctx: '' } as const;
const NONE: ReadonlySet<string> = new Set();
/** A renamed file goes to git by its new and its old path, so the old one leaves too. */
const pathsOf = (file: RepoWorkingFile) =>
  file.status === 'renamed' && file.old_path ? [file.path, file.old_path] : [file.path];
/** The rows git takes as one: a rename, and a new file at its old path that the rename's paths carry too. */
const together = (file: RepoWorkingFile, files: readonly RepoWorkingFile[]) =>
  files.filter(
    (f) =>
      f === file ||
      (file.status === 'renamed' && f.path === file.old_path) ||
      (f.status === 'renamed' && f.old_path === file.path),
  );
const pathsOfAll = (rows: readonly RepoWorkingFile[]) => [...new Set(rows.flatMap(pathsOf))];
/** How long the daemon keeps a discard's backup. */
const UNDO_MS = 10 * 60_000;

/** The last discard, which the panel offers to undo until it is undone, expires or another replaces it. */
type Discarded = ShellState['lastDiscard'][string];

/** The diff lines picked for discarding, valid only for the file and the patch they were picked in. */
interface Marked {
  path: string;
  patch: string;
  keys: ReadonlySet<string>;
}

type Write = 'commit' | 'push' | 'discard' | 'undo';

/**
 * The project folder's uncommitted files: tick some to commit them, discard a file or picked lines
 * with an undo, and push the branch.
 */
export function LocalChanges({ projectId }: { projectId: string | null }) {
  const diff = useRepoWorkingDiff(projectId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(NONE);
  const [picked, setPicked] = useState<string | null>(null);
  const [marked, setMarked] = useState<Marked | null>(null);
  const [message, setMessage] = useState('');
  // One write to the folder at a time; the others stay off while it runs.
  const [writing, setWriting] = useState<Write | null>(null);
  // The file, or the picked lines, waiting for the user to confirm the discard, and the read it was asked in.
  const [asking, setAsking] = useState<{ what: RepoWorkingFile | 'lines'; seen: string } | null>(
    null,
  );
  // Kept outside the tab, which unmounts on every switch, while the backup lasts.
  const stored = useShell((s) => (projectId ? s.lastDiscard[projectId] : undefined));
  useNow(30_000);
  const discarded = stored && Date.now() - stored.at < UNDO_MS ? stored : null;
  const setDiscarded = (change: (now: Discarded | undefined) => Discarded | undefined) => {
    if (!projectId) return;
    const { [projectId]: now, ...rest } = useShell.getState().lastDiscard;
    const next = change(now);
    useShell.setState({ lastDiscard: next ? { ...rest, [projectId]: next } : rest });
  };
  // The toast offering to undo the last discard, whose undo is a write too.
  const undoToast = useRef<string | null>(null);
  useEffect(() => {
    if (undoToast.current) holdToastAction(undoToast.current, writing !== null);
  }, [writing]);
  const seen = useMemo(() => JSON.stringify(diff.read), [diff.read]);
  // A confirmation asked over another read may name what is no longer on disk.
  const asked = asking?.seen === seen ? asking.what : null;
  useEffect(() => {
    if (asking && asking.seen !== seen) setAsking(null);
  }, [asking, seen]);
  const patchText = diff.read?.patch ?? null;
  const parsed = useMemo(() => (patchText === null ? [] : parsePatch(patchText)), [patchText]);
  const headers = useMemo(() => (patchText === null ? [] : fileHeaders(patchText)), [patchText]);

  const files = diff.read?.files ?? [];
  const shown = files.find((f) => f.path === picked) ?? files[0];
  // A path whose type changed (a symlink become a file) comes as a deletion and an addition.
  const fragments = parsed.filter((f) => f.path === shown?.path);
  const hunks = fragments.flatMap((f) => f.hunks);
  const keys =
    marked && marked.path === shown?.path && marked.patch === patchText ? marked.keys : NONE;
  // Only a modified file's lines go back through git apply -R without undoing a rename or an add.
  const pickable = shown?.status === 'modified' && fragments.length === 1;
  // Writes wait for a read that landed now: what is listed may no longer be what is on disk.
  const outdated = diff.stale || diff.error !== null;
  const busy = writing !== null || outdated;
  const checked = files.filter((f) => selected.has(f.path));

  async function write<T>(kind: Write, go: (id: string) => Promise<LocalResult<T>>) {
    if (!projectId) return null;
    setWriting(kind);
    const result = await go(projectId);
    setWriting(null);
    if (!result.ok) toast({ title: result.error, kind: 'failure' });
    diff.reload();
    return result;
  }
  async function push() {
    if ((await write('push', pushBranch))?.ok)
      toast({ title: t({ id: 'changes.local.pushed', defaultMessage: 'Pushed' }) });
  }
  async function commit() {
    const sent = message;
    const sentFiles = checked.map((f) => f.path);
    const done = await write('commit', (id) => commitFiles(id, pathsOfAll(checked), sent.trim()));
    if (!done?.ok) return;
    // Text typed and files ticked while the commit ran are for the next one.
    setMessage((now) => (now === sent ? '' : now));
    setSelected((now) => new Set([...now].filter((path) => !sentFiles.includes(path))));
    toast({
      title: t(
        { id: 'changes.local.committed', defaultMessage: 'Committed {sha}' },
        { sha: done.value.sha.slice(0, 7) },
      ),
    });
  }
  async function undo(last: Discarded) {
    const done = await write('undo', (id) => undoDiscard(id, last.undoId));
    if (!done) return;
    if (done.ok) toast({ title: t({ id: 'changes.local.undone', defaultMessage: 'Put back' }) });
    // Any other failure leaves the backup in place, so the undo can be tried again.
    if (done.ok || done.code === 'undo_expired') {
      setDiscarded((now) => (now?.undoId === last.undoId ? undefined : now));
      closeNotice(last.toast);
    }
  }
  async function discard(
    go: (id: string) => Promise<LocalResult<{ undo_id: string }>>,
    title: string,
  ) {
    const done = await write('discard', go);
    if (!done?.ok) return;
    const last: Discarded = { undoId: done.value.undo_id, title, toast: '', at: Date.now() };
    last.toast = toast({
      title,
      action: {
        label: t({ id: 'changes.local.undo', defaultMessage: 'Undo' }),
        run: () => void undo(last),
      },
    });
    undoToast.current = last.toast;
    setDiscarded(() => last);
    setMarked(null);
  }
  const confirmed = () => {
    setAsking(null);
    if (asked === 'lines' && shown) {
      const header = headers[parsed.findIndex((f) => f.path === shown.path)]!;
      void discard(
        (id) => discardLines(id, discardPatch(header, hunks, keys)),
        t(
          {
            id: 'changes.local.discardedLinesIn',
            defaultMessage:
              '{count, plural, one {Discarded # line in {path}} other {Discarded # lines in {path}}}',
          },
          { count: keys.size, path: shown.path },
        ),
      );
    } else if (asked && asked !== 'lines') {
      const file = asked;
      void discard(
        (id) => discardFiles(id, pathsOfAll(together(file, files))),
        t(
          { id: 'changes.local.discarded', defaultMessage: 'Discarded {path}' },
          { path: file.path },
        ),
      );
    }
  };

  const panel = (body: ReactNode) => (
    <Tabs.Panel className="chg" value="local">
      <div className="chg-main">
        {diff.read && where()}
        {diff.error && <Failure error={diff.error} onRetry={diff.reload} />}
        {discarded && (
          <div
            className="chl-undo"
            role="group"
            aria-label={t({ id: 'changes.local.lastDiscard', defaultMessage: 'Last discard' })}
          >
            <span className="chl-undo-what">{discarded.title}</span>
            <button
              type="button"
              className="btn sm"
              disabled={writing !== null}
              aria-busy={writing === 'undo' || undefined}
              onClick={() => void undo(discarded)}
            >
              {t({ id: 'changes.local.undo', defaultMessage: 'Undo' })}
            </button>
          </div>
        )}
        {body}
      </div>
    </Tabs.Panel>
  );
  function where() {
    const { branch, upstream } = diff.read!;
    const pushable = upstream === null || upstream.ahead > 0;
    return (
      <div className="chl-bar">
        <GitBranch className="ic-sm chg-mu" aria-hidden="true" />
        <span className="mono">
          {branch ?? t({ id: 'changes.local.detached', defaultMessage: 'Detached HEAD' })}
        </span>
        {upstream ? (
          <>
            <span className="mono chg-mu">{upstream.name}</span>
            {upstream.ahead > 0 && (
              <span className="chl-n">
                {t(
                  { id: 'changes.local.ahead', defaultMessage: '{count} ahead' },
                  { count: upstream.ahead },
                )}
              </span>
            )}
            {upstream.behind > 0 && (
              <span className="chl-n">
                {t(
                  { id: 'changes.local.behind', defaultMessage: '{count} behind' },
                  { count: upstream.behind },
                )}
              </span>
            )}
          </>
        ) : (
          <span className="chg-mu">
            {t({ id: 'changes.local.noUpstream', defaultMessage: 'No upstream' })}
          </span>
        )}
        <button
          type="button"
          className="btn chl-push"
          disabled={!pushable || branch === null || busy}
          aria-busy={writing === 'push' || undefined}
          onClick={() => void push()}
        >
          {t({ id: 'changes.local.push', defaultMessage: 'Push' })}
        </button>
      </div>
    );
  }

  if (!diff.read) return panel(!diff.error && <Skeleton />);
  if (!shown)
    return panel(
      <EmptyState
        inline
        title={t({ id: 'changes.local.clean', defaultMessage: 'No uncommitted changes' })}
      />,
    );

  const toggle = (file: RepoWorkingFile) => {
    const next = new Set(selected);
    const on = !selected.has(file.path);
    for (const row of together(file, files)) on ? next.add(row.path) : next.delete(row.path);
    setSelected(next);
  };
  const toggleLine = (key: string) => {
    const next = new Set(keys);
    if (!next.delete(key)) next.add(key);
    setMarked({ path: shown.path, patch: patchText!, keys: next });
  };
  const linked = asked && asked !== 'lines' ? together(asked, files) : [];
  const fileDiff = t(
    { id: 'changes.local.fileDiff', defaultMessage: 'Changes in {path}' },
    { path: shown.path },
  );
  return panel(
    <div className="chl">
      <section
        className="chl-side"
        aria-label={t({ id: 'changes.local.files', defaultMessage: 'Local changes' })}
      >
        <div className="chl-files">
          {files.map((file, i) => (
            <button
              key={file.path}
              type="button"
              role="checkbox"
              className="chl-ck"
              style={{ gridRow: i + 1 }}
              aria-checked={selected.has(file.path)}
              aria-label={t(
                { id: 'changes.local.include', defaultMessage: 'Commit {path}' },
                { path: file.path },
              )}
              onClick={() => toggle(file)}
            />
          ))}
          {fileBars(
            files,
            setPicked,
            (path) =>
              t(
                { id: 'changes.local.showFile', defaultMessage: '{path}, shows its diff' },
                { path },
              ),
            shown.path,
          )}
          {files.map((file, i) => {
            const label = t(
              { id: 'changes.local.discard', defaultMessage: 'Discard changes to {path}' },
              { path: file.path },
            );
            return (
              <button
                key={file.path}
                type="button"
                className="ib chl-drop"
                style={{ gridRow: i + 1 }}
                aria-label={label}
                title={label}
                disabled={busy}
                onClick={() => setAsking({ what: file, seen })}
              >
                <Undo2 aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <div className="chl-commit">
          <input
            className="inp"
            aria-label={t({ id: 'changes.local.message', defaultMessage: 'Commit message' })}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            type="button"
            className="btn pri"
            disabled={checked.length === 0 || message.trim() === '' || busy}
            aria-busy={writing === 'commit' || undefined}
            onClick={() => void commit()}
          >
            {t({ id: 'changes.local.commit', defaultMessage: 'Commit selected files' })}
          </button>
        </div>
      </section>
      <section className="chl-diff" aria-label={fileDiff}>
        <div className="chl-dh">
          <span className="mono">{shown.path}</span>
          {keys.size > 0 && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => setAsking({ what: 'lines', seen })}
            >
              {t({ id: 'changes.local.discardLines', defaultMessage: 'Discard selected lines' })}
            </button>
          )}
        </div>
        {patchText === null ? (
          <span className="chg-mu">
            {t({
              id: 'changes.local.truncated',
              defaultMessage: 'Too many changes; only the file list is shown',
            })}
          </span>
        ) : hunks.length === 0 ? (
          <span className="chg-mu">
            {t({ id: 'changes.local.noText', defaultMessage: 'No text changes' })}
          </span>
        ) : (
          hunks.map((hunk, h) => (
            <div key={h} className="df-hunks mono chl-hunk">
              <div className="df-hh">{hunk.header}</div>
              {numbered(hunk).map((line, i) => {
                const key = lineKey(h, i);
                return (
                  <div key={i} className={`df-ln ${line.kind} chl-ln`}>
                    <span className="chl-pk">
                      {pickable && line.kind !== 'ctx' && (
                        <button
                          type="button"
                          role="checkbox"
                          className="chl-lk"
                          aria-checked={keys.has(key)}
                          aria-label={
                            line.kind === 'add'
                              ? t(
                                  {
                                    id: 'changes.local.pickAdded',
                                    defaultMessage: 'Select added line {line}',
                                  },
                                  { line: line.new! },
                                )
                              : t(
                                  {
                                    id: 'changes.local.pickRemoved',
                                    defaultMessage: 'Select removed line {line}',
                                  },
                                  { line: line.old! },
                                )
                          }
                          onClick={() => toggleLine(key)}
                        />
                      )}
                    </span>
                    <span className="chl-sg" aria-hidden="true">
                      {SIGN[line.kind]}
                    </span>
                    <span className="chl-code">{line.text}</span>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </section>
      <AlertDialog.Root
        open={asked !== null && (asked !== 'lines' || keys.size > 0)}
        onOpenChange={(next) => {
          if (!next) setAsking(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="pj-scrim" ref={scrimFlag} />
          <AlertDialog.Popup className="pj-dlg pj-rm pop">
            <div className="pj-dh">
              <AlertDialog.Title className="pj-dt">
                {asked === 'lines'
                  ? t(
                      {
                        id: 'changes.local.confirmLines',
                        defaultMessage:
                          '{count, plural, one {Discard # selected line?} other {Discard # selected lines?}}',
                      },
                      { count: keys.size },
                    )
                  : linked.length > 1
                    ? t(
                        {
                          id: 'changes.local.confirmLinked',
                          defaultMessage: 'Discard changes to {path} and {other}?',
                        },
                        { path: asked!.path, other: linked.find((f) => f !== asked)!.path },
                      )
                    : t(
                        {
                          id: 'changes.local.confirmFile',
                          defaultMessage: 'Discard changes to {path}?',
                        },
                        { path: asked?.path ?? '' },
                      )}
              </AlertDialog.Title>
            </div>
            {linked.some((f) => f.status === 'untracked') && (
              <AlertDialog.Description className="pj-rm-body">
                {t({
                  id: 'changes.local.confirmUntracked',
                  defaultMessage: 'Git does not track this file, so it will be deleted.',
                })}
              </AlertDialog.Description>
            )}
            <div className="pj-df">
              <AlertDialog.Close className="btn">
                {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
              </AlertDialog.Close>
              <button type="button" className="btn dng" disabled={busy} onClick={confirmed}>
                {t({ id: 'changes.local.confirmDiscard', defaultMessage: 'Discard' })}
              </button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>,
  );
}
