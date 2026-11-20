import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { nativeEnvironment } from '@pantheon/adapters';
import {
  NATIVE_ENV_ALLOWLIST,
  requireThat,
  type Principal,
  type Project,
  type Session,
  type Workspace,
} from '@pantheon/domain';
import { checkedPath, projectAccess, resolvedPath, type ControlContext } from './context.js';
import { retryingIndexLock, runGit } from './git.js';
import { onWslAutomount } from './wsl-mount.js';

export const PATCH_BOUND = 1024 * 1024;
export const TIME_BOUND = 10000;
export const BOUND = { max_buffer: 4 * PATCH_BOUND, timeout_ms: TIME_BOUND };
// Paths name files, never pathspec patterns.
const LITERAL = '--literal-pathspecs';
const COMMIT_TIMEOUT_MS = 120000;

export async function git(cwd: string, args: string[], bound = BOUND): Promise<string> {
  const result = await runGit(cwd, args, undefined, true, bound);
  requireThat(
    result.exit_code === 0,
    'workspace_read_failed',
    result.error ?? result.stderr.toString(),
  );
  return result.stdout.toString();
}

/** The repository's worktrees that exist on disk, the main one first. */
export async function listedWorktrees(
  root: string,
): Promise<{ path: string; head_sha: string; branch: string | null }[]> {
  const listed: { path: string; head_sha: string; branch: string | null; gone?: boolean }[] = [];
  for (const line of (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
    if (line.startsWith('worktree '))
      listed.push({
        path: resolvedPath(line.slice('worktree '.length)),
        head_sha: '',
        branch: null,
      });
    const current = listed.at(-1);
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head_sha = line.slice('HEAD '.length);
    else if (line.startsWith('branch '))
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    // A bare repository has no files; a prunable worktree's folder is gone.
    else if (line === 'bare' || line.startsWith('prunable')) current.gone = true;
  }
  // A locked worktree is never prunable, even with its folder gone.
  return listed.filter((worktree) => !worktree.gone && existsSync(worktree.path));
}

/** The project's sessions whose worktree exists apart from the project's first folder. */
export function sessionWorktrees(
  ctx: ControlContext,
  projectId: string,
  root: string,
  listed: Awaited<ReturnType<typeof listedWorktrees>>,
): Map<string, Awaited<ReturnType<typeof listedWorktrees>>[number]> {
  return new Map(
    ctx.store
      .list<Session>('sessions')
      .filter((session) => session.project_id === projectId && session.workspace_id)
      .flatMap((session) => {
        const workspace = ctx.store.get<Workspace>('workspaces', session.workspace_id!);
        const worktree =
          workspace &&
          !workspace.removed_at &&
          listed.find((candidate) => candidate.path === workspace.path && candidate.path !== root);
        return worktree ? [[session.id, worktree] as const] : [];
      }),
  );
}

/** A run of userGit; `code` is the exit code, or the error code when git did not exit on its own. */
export interface UserGitResult {
  ok: boolean;
  code: number | string | null;
  stdout: Buffer;
  output: string;
}

/** Git as the user runs it: their environment, configuration, identity, filters and hooks. */
export function userGit(
  root: string,
  args: string[],
  input?: Buffer,
  maxBuffer = 4 * PATCH_BOUND,
  env: NodeJS.ProcessEnv = {},
): Promise<UserGitResult> {
  return retryingIndexLock(
    () =>
      new Promise<UserGitResult>((resolve) => {
        const child = execFile(
          'git',
          [
            // Automatic maintenance after a commit would repack the user's repository while they wait.
            '-c',
            'maintenance.auto=false',
            '-c',
            'gc.auto=0',
            // Windows git checks out CRLF and writes stat data drvfs reports differently.
            ...(onWslAutomount(root)
              ? [
                  '-c',
                  'core.autocrlf=input',
                  '-c',
                  'core.checkStat=minimal',
                  '-c',
                  'core.trustctime=false',
                ]
              : []),
            LITERAL,
            ...args,
          ],
          {
            cwd: root,
            // Signing and hooks may need the user's ssh and gpg agents.
            env: {
              ...nativeEnvironment([
                ...NATIVE_ENV_ALLOWLIST,
                'SSH_AUTH_SOCK',
                'GNUPGHOME',
                'GPG_TTY',
              ]),
              ...env,
            },
            encoding: 'buffer',
            timeout: COMMIT_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer,
          },
          (error, stdout, stderr) =>
            resolve({
              ok: !error,
              code: error ? (error.code ?? null) : 0,
              stdout,
              output: [
                stdout.toString(),
                stderr.toString(),
                error && !stderr.length ? error.message : '',
              ]
                .filter(Boolean)
                .join('\n')
                .trim(),
            }),
        );
        // A git that exits before reading its input breaks the pipe; its exit reports the failure.
        child.stdin?.on('error', () => {});
        child.stdin?.end(input);
      }),
    (result) => (result.ok ? '' : result.output),
  );
}

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
  return (
    args: string[],
    bound: { max_buffer: number; timeout_ms: number; env?: NodeJS.ProcessEnv },
  ) => runGit(source, args, undefined, true, bound);
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
