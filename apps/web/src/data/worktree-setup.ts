import { useEffect } from 'react';
import type { BoardSnapshot, StaleWorkspaces } from '@pantheon/protocol';
import { runCommand } from './commands';
import { useProjectQuery } from './project-read';

type Project = BoardSnapshot['projects'][number];
export type WorktreeSetup = NonNullable<Project['worktree']>;
export type { StaleWorkspaces };

/** How long to wait before reading a stale count again while its size is still being measured. */
export const STALE_SIZE_RETRY_MS = 2000;

/** project.worktree.set at the project's revision; no command clears the preparation command. */
export const worktreeRequest = (
  project: Pick<Project, 'id' | 'revision'>,
  worktree: WorktreeSetup,
) => ({
  type: 'project.worktree.set' as const,
  input: {
    project_id: project.id,
    copy_paths: worktree.copy_paths,
    ...(worktree.command ? { command: worktree.command } : {}),
  },
  expected_revision: project.revision,
});

/** Saves the files a new worktree gets and the command run in it before the session starts. */
export function setWorktree(project: Pick<Project, 'id' | 'revision'>, worktree: WorktreeSetup) {
  const request = worktreeRequest(project, worktree);
  return runCommand(request.type, request.input, request.expected_revision);
}

/** Removes the worktrees archived sessions left behind; answers `{ removed }`. */
export const pruneStale = (projectId: string) =>
  runCommand('workspace.prune_stale', { project_id: projectId }, null);

const validStale = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as StaleWorkspaces).count === 'number';

/** The project's worktrees, read again shortly while a size is still unknown. */
export function useStaleWorkspaces(projectId: string) {
  const stale = useProjectQuery<StaleWorkspaces>('workspace.stale', projectId, validStale);
  const measuring =
    stale.read !== null &&
    (stale.read.size_bytes === undefined || (stale.read.worktree_disk?.unmeasured ?? 0) > 0);
  const { reload, read } = stale;
  useEffect(() => {
    if (!measuring) return;
    const timer = setTimeout(reload, STALE_SIZE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [measuring, read, reload]);
  return stale;
}

/** Splits a command line at spaces; quoted text stays one argument, without its quotes. */
export function splitArgv(line: string): string[] {
  const argv: string[] = [];
  let current: string | null = null;
  let quote: string | null = null;
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = null;
      else current = (current ?? '') + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current ??= '';
    } else if (/\s/.test(char)) {
      if (current !== null) argv.push(current);
      current = null;
    } else current = (current ?? '') + char;
  }
  if (current !== null) argv.push(current);
  return argv;
}

/** The command line `splitArgv` reads back as `argv`. */
export const argvLine = (argv: readonly string[]) =>
  argv
    .map((arg) => {
      if (arg && !/[\s"']/.test(arg)) return arg;
      if (!arg.includes('"')) return `"${arg}"`;
      // Adjacent quoted runs join into one argument, so each ' goes in double quotes of its own.
      return arg
        .split("'")
        .map((run) => `'${run}'`)
        .join(`"'"`);
    })
    .join(' ');

export type CopyPathProblem = 'empty' | 'duplicate' | 'absolute' | 'parent';

/** Why a path cannot join the copied files, or null when it can. */
export function copyPathProblem(
  entry: string,
  existing: readonly string[],
): CopyPathProblem | null {
  if (!entry) return 'empty';
  if (/^([\\/]|[A-Za-z]:)/.test(entry)) return 'absolute';
  if (entry.split(/[\\/]/).includes('..')) return 'parent';
  if (existing.includes(entry)) return 'duplicate';
  return null;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Bytes in the largest unit that keeps the number at 1 or more, to one decimal. */
export function sizeText(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : Number(value.toFixed(1))} ${UNITS[unit]}`;
}
