import { requireThat } from '@pantheon/domain';
import { runGit, type GitExecutionOptions, type GitResult } from './git.js';

/** The merge base of two commits; undefined when they share no history. */
export async function mergeBase(
  directory: string,
  left: string,
  right: string,
  bounds?: Pick<GitExecutionOptions, 'timeout_ms' | 'max_buffer'>,
): Promise<string | undefined> {
  const result = await runGit(directory, ['merge-base', left, right], undefined, true, bounds);
  // 1 with no output: no common ancestor.
  if (result.exit_code === 1 && result.stdout.length === 0) return undefined;
  requireThat(
    result.exit_code === 0,
    'workspace_read_failed',
    result.error ?? result.stderr.toString(),
  );
  return result.stdout.toString().trim();
}

export function mergePreview(
  directory: string,
  target: string,
  head: string,
  bounds?: Pick<GitExecutionOptions, 'timeout_ms' | 'max_buffer'>,
): Promise<GitResult> {
  return runGit(
    directory,
    ['merge-tree', '--write-tree', '--name-only', '-z', target, head],
    undefined,
    true,
    bounds,
  );
}
