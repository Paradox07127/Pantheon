import { useRepoStatus, type RepoStatus } from '../../../data/repo';
import { t } from '../../../i18n';
import { Failure, Skeleton } from '../../board/BoardScreen';
import { Empty } from '../../board/Charts';

type StatusFile = RepoStatus['files'][number];

/** Git's short status letter: ? for untracked, else the staged side's, else the unstaged side's. */
const letter = (file: StatusFile) => (file.untracked ? '?' : (file.index ?? file.worktree ?? ''));

/** The uncommitted files of a worktree that has no patch read: status, path and conflict. */
export function StatusFiles({ projectId, path }: { projectId: string; path: string }) {
  const status = useRepoStatus(projectId, path);
  if (!status.read)
    return status.error ? <Failure error={status.error} onRetry={status.reload} /> : <Skeleton />;
  const { files } = status.read;
  if (files.length === 0)
    return (
      <Empty text={t({ id: 'repo.changes.clean', defaultMessage: 'No uncommitted changes' })} />
    );
  return (
    <ul
      className="rpc-files"
      aria-label={t({ id: 'repo.changes.uncommittedFiles', defaultMessage: 'Uncommitted files' })}
    >
      {files.map((file) => (
        <li key={file.path} className="rpc-file">
          <span className="rpc-st mono">{letter(file)}</span>
          <span className="rpc-path mono" title={file.path}>
            {file.path}
          </span>
          {file.conflicted && (
            <span className="chip rpc-cf">
              {t({ id: 'repo.changes.conflicted', defaultMessage: 'Conflict' })}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
