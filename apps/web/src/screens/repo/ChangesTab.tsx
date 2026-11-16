import { useState } from 'react';
import { useRepoWorktrees, type RepoWorktree } from '../../data/repo';
import { useSessionList } from '../../data/workbench-sessions';
import { useStaleWorkspaces } from '../../data/worktree-setup';
import { t } from '../../i18n';
import { Failure, Skeleton } from '../board/BoardScreen';
import { Empty } from '../board/Charts';
import { LocalChanges } from './changes/LocalChanges';
import { SessionChanges } from './changes/SessionChanges';
import { StatusFiles } from './changes/StatusFiles';
import { WorktreeList } from './changes/WorktreeList';
import './changes/changes.css';

/** The first session worktree, else the local checkout, else the first listed. */
const firstShown = (worktrees: readonly RepoWorktree[]) =>
  worktrees.find((w) => w.kind === 'session') ??
  worktrees.find((w) => w.kind === 'checkout') ??
  worktrees[0];

/** The project's worktrees at the left; the picked one's changes beside them. */
export function ChangesTab({
  projectId,
  onOpenSession,
}: {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const worktrees = useRepoWorktrees(projectId);
  const sessions = useSessionList(projectId);
  const stale = useStaleWorkspaces(projectId);
  const [picked, setPicked] = useState<string | null>(null);
  if (!worktrees.read)
    return (
      <div className="bd-s12">
        {worktrees.error ? (
          <Failure error={worktrees.error} onRetry={worktrees.reload} />
        ) : (
          <Skeleton />
        )}
      </div>
    );
  const shown = worktrees.read.find((w) => w.path === picked) ?? firstShown(worktrees.read);
  if (!shown)
    return (
      <div className="bd-s12">
        <Empty text={t({ id: 'repo.changes.empty', defaultMessage: 'No changes to show yet' })} />
      </div>
    );
  const listed =
    shown.kind === 'session'
      ? (sessions.data?.find((s) => s.id === shown.session_id) ?? null)
      : null;
  return (
    <div className="bd-s12 rpc">
      <WorktreeList
        projectId={projectId}
        worktrees={worktrees.read}
        sessions={sessions.data}
        stale={stale}
        picked={shown.path}
        onPick={setPicked}
        onOpenSession={onOpenSession}
        onPruned={worktrees.reload}
      />
      <section
        className="rpc-main"
        aria-label={t({ id: 'repo.changes.changes', defaultMessage: 'Changes' })}
      >
        {shown.kind === 'session' && shown.session_id ? (
          <SessionChanges
            key={shown.session_id}
            sessionId={shown.session_id}
            listed={listed}
            worktree={shown}
            onOpenSession={onOpenSession}
          />
        ) : shown.kind === 'checkout' ? (
          <LocalChanges projectId={projectId} />
        ) : (
          <StatusFiles key={shown.path} projectId={projectId} path={shown.path} />
        )}
      </section>
    </div>
  );
}
