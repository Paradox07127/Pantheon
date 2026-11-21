import { useEffect, useState } from 'react';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Folder, Plus, X } from 'lucide-react';
import { create } from 'zustand';
import type { BoardSnapshot } from '@pantheon/protocol';
import { PathText } from '../../components/PathText';
import { toast } from '../../components/Toast';
import {
  argvLine,
  copyPathProblem,
  pruneStale,
  setWorktree,
  sizeText,
  splitArgv,
  useStaleWorkspaces,
  type CopyPathProblem,
  type WorktreeSetup,
} from '../../data/worktree-setup';
import { t } from '../../i18n';
import { revealText } from '../../lib/platform-text';
import { scrimFlag } from '../../lib/root-flag';
import { ipcFailure } from './editors';
import { failureText, Row, Section, type Failure } from './ProjectSettingsScreen';
import './worktrees-page.css';

type Project = BoardSnapshot['projects'][number];

type SetupRow = 'copyPaths' | 'command';

/** The worktree preparation sent from the copied files or the setup command; revision is null while sending. */
const useWorktreeSave = create<{
  sent: { project_id: string; worktree: WorktreeSetup; revision: number | null } | null;
  failure: { project_id: string; row: SetupRow; failure: Failure } | null;
}>(() => ({ sent: null, failure: null }));

async function saveWorktree(project: Project, worktree: WorktreeSetup, row: SetupRow) {
  if (useWorktreeSave.getState().sent?.project_id === project.id) return;
  useWorktreeSave.setState({
    sent: { project_id: project.id, worktree, revision: null },
    failure: null,
  });
  const result = await setWorktree(project, worktree);
  useWorktreeSave.setState(
    result.ok
      ? {
          sent: {
            project_id: project.id,
            worktree,
            revision: (result.value as Project).revision ?? project.revision + 1,
          },
          failure: null,
        }
      : { sent: null, failure: { project_id: project.id, row, failure: result.error } },
  );
}

const PROBLEM_TEXT: Record<CopyPathProblem, () => string> = {
  empty: () => t({ id: 'settings.worktreeSetup.pathEmpty', defaultMessage: 'Enter a path' }),
  duplicate: () =>
    t({ id: 'settings.worktreeSetup.pathDuplicate', defaultMessage: 'Already in the list' }),
  absolute: () =>
    t({
      id: 'settings.worktreeSetup.pathAbsolute',
      defaultMessage: 'Use a path relative to the project folder, not an absolute one',
    }),
  parent: () =>
    t({
      id: 'settings.worktreeSetup.pathParent',
      defaultMessage: 'The path cannot leave the project folder with ..',
    }),
};

export function WorktreesPage({ project }: { project: Project }) {
  const setup = useWorktreeSave();
  const setupSent = setup.sent?.project_id === project.id ? setup.sent : null;
  const setupFailure = setup.failure?.project_id === project.id ? setup.failure : null;
  const stale = useStaleWorkspaces(project.id);
  const [adding, setAdding] = useState<string | null>(null);
  const [problem, setProblem] = useState<CopyPathProblem | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [revealFailure, setRevealFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneFailure, setPruneFailure] = useState<string | null>(null);

  useEffect(() => {
    if (setupSent?.revision != null && project.revision >= setupSent.revision)
      useWorktreeSave.setState({ sent: null });
  }, [project.revision, setupSent]);

  const worktree = setupSent?.worktree ?? project.worktree ?? { copy_paths: [] };
  const savingSetup = setupSent !== null;
  const root = stale.read?.worktree_root;
  const bridge = window.pantheon;
  const reveal = (path: string) => {
    setRevealFailure(null);
    void bridge
      ?.revealPath(path)
      .catch(ipcFailure)
      .then((result) => {
        if (!result.ok)
          setRevealFailure(
            t(
              {
                id: 'settings.worktreeSetup.revealFailed',
                defaultMessage: 'Could not show the folder: {message}',
              },
              { message: result.error.message },
            ),
          );
      });
  };
  const closeAdd = () => {
    setAdding(null);
    setProblem(null);
  };
  const addPath = () => {
    if (adding === null || savingSetup) return;
    const entry = adding.trim();
    const found = copyPathProblem(entry, worktree.copy_paths);
    if (found) {
      setProblem(found);
      return;
    }
    closeAdd();
    void saveWorktree(
      project,
      { ...worktree, copy_paths: [...worktree.copy_paths, entry] },
      'copyPaths',
    );
  };
  const commitCommand = () => {
    if (draft === null) return;
    setDraft(null);
    const argv = splitArgv(draft);
    if (JSON.stringify(argv) === JSON.stringify(worktree.command?.argv ?? [])) return;
    const { command, ...rest } = worktree;
    void saveWorktree(
      project,
      argv.length ? { ...rest, command: { ...command, argv } } : rest,
      'command',
    );
  };
  const prune = async () => {
    setPruning(true);
    const result = await pruneStale(project.id);
    setPruning(false);
    setConfirming(false);
    if (!result.ok) {
      setPruneFailure(failureText(result.error));
      return;
    }
    toast({
      title: t(
        {
          id: 'settings.worktreeSetup.pruned',
          defaultMessage:
            '{count, plural, one {Cleaned up # worktree} other {Cleaned up # worktrees}}',
        },
        { count: (result.value as { removed: number }).removed },
      ),
    });
    stale.reload();
  };

  const setupError = (row: SetupRow) =>
    setupFailure?.row === row && (
      <div className="ps-err wt-err" role="alert">
        {failureText(setupFailure.failure)}
      </div>
    );
  const commandLabel = t({ id: 'settings.worktreeSetup.command', defaultMessage: 'Setup command' });
  const fileLabel = t({ id: 'settings.worktreeSetup.newPath', defaultMessage: 'File to copy' });
  const count = stale.read?.count ?? null;
  const size = stale.read?.size_bytes;
  const cleanupError =
    pruneFailure ?? (stale.read === null && !stale.unavailable ? stale.error : null);
  const countText =
    count === null
      ? ''
      : t(
          {
            id: 'settings.worktreeSetup.count',
            defaultMessage: '{count, plural, one {# worktree} other {# worktrees}}',
          },
          { count },
        );
  return (
    <>
      <Section title={t({ id: 'settings.worktreeSetup.title', defaultMessage: 'Worktrees' })}>
        <div className="ps-rows">
          {root !== undefined && (
            <div className="ps-row" data-setting-id="worktrees.location">
              <span className="ps-row-nm">
                {t({ id: 'settings.worktreeSetup.location', defaultMessage: 'Location' })}
                <PathText path={root} className="mono wt-path" />
              </span>
              <div className="ps-row-ct">
                {bridge && (
                  <button type="button" className="btn" onClick={() => reveal(root)}>
                    <Folder size={14} aria-hidden="true" />
                    {revealText()}
                  </button>
                )}
              </div>
            </div>
          )}
          {revealFailure !== null && (
            <div className="ps-err wt-err" role="alert">
              {revealFailure}
            </div>
          )}
          <Row
            label={t({
              id: 'settings.worktreeSetup.copyPaths',
              defaultMessage: 'Copy these files',
            })}
            settingId="worktrees.copyPaths"
          >
            {worktree.copy_paths.map((entry) => (
              <span key={entry} className="chip mono wt-chip">
                {entry}
                <button
                  type="button"
                  className="wt-rm"
                  disabled={savingSetup}
                  aria-label={t(
                    {
                      id: 'settings.worktreeSetup.removePath',
                      defaultMessage: 'Stop copying {path}',
                    },
                    { path: entry },
                  )}
                  onClick={() =>
                    void saveWorktree(
                      project,
                      { ...worktree, copy_paths: worktree.copy_paths.filter((p) => p !== entry) },
                      'copyPaths',
                    )
                  }
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
            {adding === null ? (
              <button
                type="button"
                className="ib"
                disabled={savingSetup}
                aria-label={t({
                  id: 'settings.worktreeSetup.addPath',
                  defaultMessage: 'Add a file',
                })}
                onClick={() => setAdding('')}
              >
                <Plus aria-hidden="true" />
              </button>
            ) : (
              <span className="wt-add">
                <input
                  className="inp mono wt-add-in"
                  autoFocus
                  spellCheck={false}
                  aria-label={fileLabel}
                  aria-invalid={problem !== null || undefined}
                  value={adding}
                  onChange={(e) => {
                    setAdding(e.target.value);
                    setProblem(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addPath();
                    if (e.key === 'Escape') closeAdd();
                  }}
                  onBlur={() => {
                    if (!adding.trim()) closeAdd();
                  }}
                />
                {problem !== null && (
                  <span className="ps-err" role="alert">
                    {PROBLEM_TEXT[problem]()}
                  </span>
                )}
              </span>
            )}
          </Row>
          {setupError('copyPaths')}
          <Row label={commandLabel} settingId="worktrees.setupCommand">
            <input
              className="inp mono wt-cmd"
              spellCheck={false}
              aria-label={commandLabel}
              value={draft ?? argvLine(worktree.command?.argv ?? [])}
              disabled={savingSetup}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitCommand}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCommand();
              }}
            />
          </Row>
          {setupError('command')}
        </div>
      </Section>
      <Section title={t({ id: 'settings.worktreeSetup.cleanup', defaultMessage: 'Cleanup' })}>
        <div className="ps-rows">
          <Row
            label={t({
              id: 'settings.worktreeSetup.cleanupRow',
              defaultMessage: 'Clean up old worktrees',
            })}
            settingId="worktrees.cleanup"
          >
            {count === 0 && (
              <span className="wt-meta">
                {t({
                  id: 'settings.worktreeSetup.nothingStale',
                  defaultMessage: 'Nothing to clean up',
                })}
              </span>
            )}
            {count !== null && count > 0 && (
              <>
                <span className="wt-meta wt-num">{countText}</span>
                {size !== undefined && <span className="wt-meta mono">{sizeText(size)}</span>}
              </>
            )}
            <button
              type="button"
              className="btn"
              disabled={count === null || count === 0 || pruning}
              onClick={() => {
                setPruneFailure(null);
                setConfirming(true);
              }}
            >
              {t({ id: 'settings.worktreeSetup.prune', defaultMessage: 'Clean up…' })}
            </button>
          </Row>
          {cleanupError !== null && (
            <div className="ps-err wt-err" role="alert">
              {cleanupError}
            </div>
          )}
        </div>
        <AlertDialog.Root
          open={confirming}
          onOpenChange={(next) => {
            if (!next && !pruning) setConfirming(false);
          }}
        >
          <AlertDialog.Portal>
            <AlertDialog.Backdrop className="pj-scrim" ref={scrimFlag} />
            <AlertDialog.Popup className="pj-dlg pj-rm pop">
              <div className="pj-dh">
                <AlertDialog.Title className="pj-dt">
                  {t({
                    id: 'settings.worktreeSetup.pruneTitle',
                    defaultMessage: 'Clean up old worktrees?',
                  })}
                </AlertDialog.Title>
              </div>
              <AlertDialog.Description className="pj-rm-body">
                {size === undefined
                  ? t(
                      {
                        id: 'settings.worktreeSetup.pruneBody',
                        defaultMessage:
                          '{count, plural, one {# worktree} other {# worktrees}} will be removed. Worktrees left by archived sessions are deleted; commits are not affected.',
                      },
                      { count: count ?? 0 },
                    )
                  : t(
                      {
                        id: 'settings.worktreeSetup.pruneBodySize',
                        defaultMessage:
                          '{count, plural, one {# worktree} other {# worktrees}} taking {size} will be removed. Worktrees left by archived sessions are deleted; commits are not affected.',
                      },
                      { count: count ?? 0, size: sizeText(size) },
                    )}
              </AlertDialog.Description>
              <div className="pj-df">
                <span style={{ flex: 1 }} />
                <AlertDialog.Close className="btn" disabled={pruning}>
                  {t({ id: 'sessions.parts.cancel', defaultMessage: 'Cancel' })}
                </AlertDialog.Close>
                <button
                  type="button"
                  className="btn dng"
                  disabled={pruning}
                  aria-disabled={pruning || undefined}
                  onClick={() => void prune()}
                >
                  {t({ id: 'settings.worktreeSetup.pruneConfirm', defaultMessage: 'Clean up' })}
                </button>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </Section>
    </>
  );
}
