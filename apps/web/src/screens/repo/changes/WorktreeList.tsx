import { useId, useState } from 'react';
import { ArrowUpRight, Ellipsis, Folder, GitBranch } from 'lucide-react';
import type { BridgeResult, StaleWorkspaces, WorkbenchSession } from '@pantheon/protocol';
import { Menu, MenuItem } from '../../../components/Menu';
import { RuntimeGlyph } from '../../../components/RuntimeGlyph';
import { SessionStateIcon } from '../../../components/SessionStateIcon';
import { shortId } from '../../../data/format';
import { failureText } from '../../../data/needs-you';
import type { RepoWorktree } from '../../../data/repo';
import { sizeText } from '../../../data/worktree-setup';
import { t } from '../../../i18n';
import { revealText } from '../../../lib/platform-text';
import { usePruneConfirm } from '../../board/RepoCharts';
import { sessionRow } from '../../sessions/model';
import { fail } from '../../sessions/shared';

type Kind = RepoWorktree['kind'];

// Labels are getters, so each is read in the language loaded by then.
const GROUPS: { kind: Kind; readonly label: string }[] = [
  {
    kind: 'checkout',
    get label() {
      return t({ id: 'repo.changes.group.checkout', defaultMessage: 'Local checkout' });
    },
  },
  {
    kind: 'session',
    get label() {
      return t({ id: 'repo.changes.group.session', defaultMessage: 'Sessions' });
    },
  },
  {
    kind: 'external',
    get label() {
      return t({ id: 'repo.changes.group.external', defaultMessage: 'Outside Pantheon' });
    },
  },
];

/** The branch, or the short commit of a detached HEAD. */
const branchText = (worktree: RepoWorktree) => worktree.branch ?? shortId(worktree.head_sha);

function Row({
  worktree,
  listed,
  picked,
  onPick,
  onOpenSession,
}: {
  worktree: RepoWorktree;
  listed: WorkbenchSession | null;
  picked: boolean;
  onPick: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const session = worktree.kind === 'session';
  const conflicted = (worktree.conflicts ?? 0) > 0;
  const openText = t({ id: 'repo.changes.openSession', defaultMessage: 'Open session' });
  const [error, setError] = useState<string | null>(null);
  const bridge = window.pantheon;
  const run = (action: () => Promise<BridgeResult<unknown>>) => {
    setError(null);
    void action()
      .catch(fail)
      .then((result) => {
        if (!result.ok) setError(failureText(result.error));
      });
  };
  const name = session && listed ? sessionRow(listed).title : branchText(worktree);
  return (
    <li className="rpc-row">
      <button type="button" className="rpc-pick" aria-pressed={picked} onClick={onPick}>
        {listed ? (
          <span className="rpc-av">
            <RuntimeGlyph runtime={listed.runtime} size={16} />
            <SessionStateIcon session={listed} place="list" />
          </span>
        ) : session ? (
          <GitBranch className="ic-sm" aria-hidden="true" />
        ) : (
          <Folder className="ic-sm" aria-hidden="true" />
        )}
        {session ? (
          <span className="rpc-name">
            {listed ? sessionRow(listed).title : branchText(worktree)}
          </span>
        ) : (
          <span className="rpc-name mono" title={worktree.path}>
            {worktree.path}
          </span>
        )}
        <span className="rpc-meta">
          <span className="rpc-br" title={branchText(worktree)}>
            {branchText(worktree)}
          </span>
          {conflicted ? (
            <span className="chip rpc-cf">
              {t({ id: 'repo.changes.willConflict', defaultMessage: 'Will conflict' })}
            </span>
          ) : (
            <>
              {worktree.ahead > 0 && (
                <span>
                  {t(
                    { id: 'repo.changes.ahead', defaultMessage: '{count} ahead' },
                    { count: worktree.ahead },
                  )}
                </span>
              )}
              {worktree.behind > 0 && (
                <span>
                  {t(
                    { id: 'repo.changes.behind', defaultMessage: '{count} behind' },
                    { count: worktree.behind },
                  )}
                </span>
              )}
              {session && (worktree.additions > 0 || worktree.deletions > 0) && (
                <span className="mono">
                  <span className="rpl-add" data-zero={worktree.additions === 0 || undefined}>
                    +{worktree.additions}
                  </span>{' '}
                  <span className="rpl-del" data-zero={worktree.deletions === 0 || undefined}>
                    −{worktree.deletions}
                  </span>
                </span>
              )}
            </>
          )}
          {worktree.uncommitted > 0 && (
            <span>
              {t(
                {
                  id: 'repo.changes.uncommitted',
                  defaultMessage: '{count, plural, one {# uncommitted} other {# uncommitted}}',
                },
                { count: worktree.uncommitted },
              )}
            </span>
          )}
        </span>
      </button>
      {session && worktree.session_id && (
        <button
          type="button"
          className="ib"
          aria-label={openText}
          title={openText}
          onClick={() => onOpenSession(worktree.session_id!)}
        >
          <ArrowUpRight className="ic-sm" aria-hidden="true" />
        </button>
      )}
      <Menu
        label={t({ id: 'repo.changes.actions', defaultMessage: 'Worktree actions' })}
        align="end"
        trigger={
          <button
            type="button"
            className="ib rpc-more"
            aria-label={t(
              { id: 'repo.changes.actionsOf', defaultMessage: 'Actions for {name}' },
              { name },
            )}
          >
            <Ellipsis className="ic-sm" aria-hidden="true" />
          </button>
        }
      >
        {bridge?.openInEditor && listed?.workspace_id && (
          <MenuItem onClick={() => run(() => bridge.openInEditor(listed.workspace_id!))}>
            {t({ id: 'repo.changes.openInEditor', defaultMessage: 'Open in editor' })}
          </MenuItem>
        )}
        {bridge?.revealPath && (
          <MenuItem onClick={() => run(() => bridge.revealPath(worktree.path))}>
            {revealText()}
          </MenuItem>
        )}
        <MenuItem onClick={() => void navigator.clipboard.writeText(worktree.path)}>
          {t({ id: 'repo.changes.copyPath', defaultMessage: 'Copy path' })}
        </MenuItem>
        {worktree.branch && (
          <MenuItem onClick={() => void navigator.clipboard.writeText(worktree.branch!)}>
            {t({ id: 'repo.changes.copyBranch', defaultMessage: 'Copy branch name' })}
          </MenuItem>
        )}
      </Menu>
      {error && (
        <span className="ss-cerr rpc-err" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

/** The worktrees by kind, the picked one marked, over the cleanup of stale ones when there are any. */
export function WorktreeList({
  projectId,
  worktrees,
  sessions,
  stale,
  picked,
  onPick,
  onOpenSession,
  onPruned,
}: {
  projectId: string;
  worktrees: readonly RepoWorktree[];
  sessions: readonly WorkbenchSession[] | null;
  stale: { read: StaleWorkspaces | null; reload: () => void };
  picked: string;
  onPick: (path: string) => void;
  onOpenSession: (sessionId: string) => void;
  onPruned: () => void;
}) {
  const prefix = useId();
  const confirm = usePruneConfirm(projectId, stale, onPruned);
  const count = stale.read?.count ?? 0;
  return (
    <aside
      className="rpc-wts"
      aria-label={t({ id: 'repo.changes.worktrees', defaultMessage: 'Worktrees' })}
    >
      {GROUPS.map(({ kind, label }) => {
        const rows = worktrees.filter((w) => w.kind === kind);
        if (rows.length === 0) return null;
        const head = `${prefix}-${kind}`;
        return (
          <div key={kind} className="rpc-grp">
            <h3 id={head} className="rpc-gh">
              {label}
              {kind !== 'checkout' && <span className="rpc-ct">{rows.length}</span>}
            </h3>
            <ul className="rpc-list" aria-labelledby={head}>
              {rows.map((w) => (
                <Row
                  key={w.path}
                  worktree={w}
                  listed={sessions?.find((s) => s.id === w.session_id) ?? null}
                  picked={w.path === picked}
                  onPick={() => onPick(w.path)}
                  onOpenSession={onOpenSession}
                />
              ))}
            </ul>
          </div>
        );
      })}
      {count > 0 && (
        <div className="rpc-prune">
          <span className="rpc-stale">
            {t(
              {
                id: 'repo.changes.stale',
                defaultMessage: '{count, plural, other {Merged, not cleaned up #}}',
              },
              { count },
            )}
          </span>
          {stale.read?.size_bytes !== undefined && (
            <span className="rpc-size">{sizeText(stale.read.size_bytes)}</span>
          )}
          <button type="button" className="btn sm" disabled={confirm.pruning} onClick={confirm.ask}>
            {t({ id: 'repo.changes.prune', defaultMessage: 'Clean up' })}
          </button>
          {confirm.dialog}
        </div>
      )}
    </aside>
  );
}
