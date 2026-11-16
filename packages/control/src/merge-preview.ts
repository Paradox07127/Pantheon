import { runGit, type GitResult } from './git.js';

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
