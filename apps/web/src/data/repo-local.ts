import type { RepoWorkingDiff, RepoWorkingDiffFile } from '@pantheon/protocol';
import { t } from '../i18n';
import { runCommand } from './commands';
import { failureText } from './needs-you';
import { REPOSITORY_KINDS, useProjectQuery } from './project-read';

export type { RepoWorkingDiff, RepoWorkingDiffFile as RepoWorkingFile };

export type LocalResult<T> = { ok: true; value: T } | { ok: false; code: string; error: string };

/** GET /v1/repo.working_diff for the project's first folder, read again on window focus. */
export const useRepoWorkingDiff = (projectId: string | null) =>
  useProjectQuery<RepoWorkingDiff>(
    'repo.working_diff',
    projectId,
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as RepoWorkingDiff).files),
    undefined,
    { kinds: REPOSITORY_KINDS },
  );

// Their message is git's own output: a failed hook, a rejected push.
const GIT_OUTPUT = ['commit_failed', 'push_rejected', 'push_failed'];

export function localErrorText(error: { code: string; message: string }): string {
  if (GIT_OUTPUT.includes(error.code)) return error.message;
  if (error.code === 'no_remote')
    return t({
      id: 'changes.local.noRemote',
      defaultMessage: 'This branch has no upstream and the repository has no origin remote',
    });
  if (error.code === 'staged_changes')
    return t({
      id: 'changes.local.staged',
      defaultMessage: 'This file has staged changes; only the whole file can be discarded',
    });
  if (error.code === 'undo_expired')
    return t({
      id: 'changes.local.undoExpired',
      defaultMessage: 'More than 10 minutes have passed; this can no longer be undone',
    });
  return failureText(error);
}

async function send<T>(
  type: 'repo.discard' | 'repo.discard_patch' | 'repo.discard_undo' | 'repo.commit' | 'repo.push',
  input: Record<string, unknown>,
): Promise<LocalResult<T>> {
  const result = await runCommand(type, input, null);
  if (result.ok) return { ok: true, value: result.value as T };
  return { ok: false, code: result.error.code, error: localErrorText(result.error) };
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
