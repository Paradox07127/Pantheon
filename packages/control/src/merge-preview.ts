import { requireThat } from '@pantheon/domain';
import { runGit, type GitResult } from './git.js';

/** The merge base of two commits; undefined when they share no history. */
export async function mergeBase(
  directory: string,
  left: string,
  right: string,
): Promise<string | undefined> {
  const result = await runGit(directory, ['merge-base', left, right], undefined, true);
  // 1 with no output: no common ancestor.
  if (result.exit_code === 1 && result.stdout.length === 0) return undefined;
  requireThat(
    result.exit_code === 0,
    'workspace_read_failed',
    result.error ?? result.stderr.toString(),
  );
  return result.stdout.toString().trim();
}

export function mergePreview(directory: string, target: string, head: string): GitResult;
export function mergePreview(
  directory: string,
  target: string,
  head: string,
  asynchronous: true,
): Promise<GitResult>;
export function mergePreview(
  directory: string,
  target: string,
  head: string,
  asynchronous = false,
): GitResult | Promise<GitResult> {
  const args = ['merge-tree', '--write-tree', '--name-only', '-z', target, head];
  return asynchronous ? runGit(directory, args, undefined, true) : runGit(directory, args);
}
