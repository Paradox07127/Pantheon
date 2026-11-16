import { useEffect } from 'react';
import type { RepoWorkingDiff, RepoWorkingDiffFile } from '@pantheon/protocol';
import { t } from '../i18n';
import { runCommand } from './commands';
import { failureText } from './needs-you';
import { useProjectQuery } from './project-read';
import { useFocusTick } from './workbench-sessions';

export type { RepoWorkingDiff, RepoWorkingDiffFile as RepoWorkingFile };

export type LocalResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

/** GET /v1/repo.working_diff for the project's local checkout, read again on window focus. */
export function useRepoWorkingDiff(projectId: string | null) {
  const diff = useProjectQuery<RepoWorkingDiff>(
    'repo.working_diff',
    projectId,
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as RepoWorkingDiff).files),
  );
  const focus = useFocusTick();
  const { reload } = diff;
  useEffect(() => {
    if (focus) reload();
  }, [focus, reload]);
  return diff;
}

// Their message is git's own output: a failed hook, a rejected push, a conflicting revert.
const GIT_OUTPUT = [
  'commit_failed',
  'push_rejected',
  'push_failed',
  'revert_conflict',
  'revert_failed',
];

function errorText(error: { code: string; message: string }): string {
  if (GIT_OUTPUT.includes(error.code)) return error.message;
  if (error.code === 'no_remote')
    return t({
      id: 'repo.local.noRemote',
      defaultMessage: 'This branch has no upstream and the repository has no origin remote',
    });
  if (error.code === 'dirty_checkout')
    return t({
      id: 'repo.local.dirtyCheckout',
      defaultMessage: 'The local checkout has uncommitted changes; commit or discard them first',
    });
  return failureText(error);
}

async function send<T>(
  type:
    | 'repo.discard'
    | 'repo.discard_patch'
    | 'repo.discard_undo'
    | 'repo.commit'
    | 'repo.push'
    | 'repo.revert',
  input: Record<string, unknown>,
): Promise<LocalResult<T>> {
  const result = await runCommand(type, input, null);
  if (result.ok) return { ok: true, value: result.value as T };
  return { ok: false, code: result.error.code, error: errorText(result.error) };
}

/** Throws away the worktree changes of whole files. */
export const discardFiles = (project_id: string, paths: string[]) =>
  send<{ undo_id: string }>('repo.discard', { project_id, paths });

/** Takes `patch` back out of the worktree, as `git apply -R` does. */
export const discardLines = (project_id: string, patch: string) =>
  send<{ undo_id: string }>('repo.discard_patch', { project_id, patch });

/** Puts back what a discard threw away. */
export const undoDiscard = (project_id: string, undo_id: string) =>
  send<object>('repo.discard_undo', { project_id, undo_id });

/** Commits `paths` under the user's own git identity, running the hooks. */
export const commitFiles = (project_id: string, paths: string[], message: string) =>
  send<{ sha: string }>('repo.commit', { project_id, paths, message });

/** Pushes the checked-out branch to its upstream, or to origin when it has none. */
export const pushBranch = (project_id: string) => send<object>('repo.push', { project_id });

/** Reverts a commit, or the whole session merge that ended at it, in a new commit. */
export const revertCommit = (project_id: string, sha: string) =>
  send<{ sha: string }>('repo.revert', { project_id, sha });
