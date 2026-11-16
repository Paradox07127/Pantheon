import type { Principal, Project } from '@pantheon/domain';
import { checkedPath, projectAccess, type ControlContext } from './context.js';
import { runGit } from './git.js';

export const PATCH_BOUND = 1024 * 1024;
export const TIME_BOUND = 10000;

/** A landing source's real path, after the principal's read access and scope are checked. */
export function checkedSource(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  sourcePath: string,
): string {
  projectAccess(ctx, principal, projectId, 'workspace.read');
  return checkedPath(ctx, ctx.store.must<Project>('projects', projectId), sourcePath);
}

/** A Git runner in a landing source, after the principal's read access and scope are checked. */
export function sourceGit(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  sourcePath: string,
) {
  const source = checkedSource(ctx, principal, projectId, sourcePath);
  return (args: string[], bound: { max_buffer: number; timeout_ms: number }) =>
    runGit(source, args, undefined, true, bound);
}

/** Files of `git diff --numstat -z` output. */
export function numstatFiles(
  output: Buffer,
): { path: string; additions: number | null; deletions: number | null }[] {
  const tokens = output.toString().split('\0');
  const files: ReturnType<typeof numstatFiles> = [];
  for (let i = 0; i < tokens.length; i++) {
    // Only the first two tabs separate fields; a path may hold tabs.
    const [additions, deletions, ...rest] = tokens[i]!.split('\t');
    if (deletions === undefined) continue;
    const name = rest.join('\t');
    // A rename leaves the path empty and is followed by the old and the new path.
    const filePath = name ? name : tokens[(i += 2)]!;
    files.push({
      path: filePath,
      additions: additions === '-' ? null : Number(additions),
      deletions: deletions === '-' ? null : Number(deletions),
    });
  }
  return files;
}
