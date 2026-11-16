import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ShellOptions {
  shell?: string;
  timeout?: number;
}

/** The PATH printed between two markers; rc files may print before and after it. */
export const parseShellPath = (stdout: string, marker: string): string | undefined => {
  const start = stdout.indexOf(marker);
  if (start === -1) return undefined;
  const end = stdout.indexOf(marker, start + marker.length);
  if (end === -1) return undefined;
  const value = stdout.slice(start + marker.length, end);
  return value && !value.includes('\n') ? value : undefined;
};

/** The PATH of the user's login shell, or undefined when the shell fails or does not answer in time. */
export const captureShellPath = ({
  shell = process.env.SHELL || '/bin/zsh',
  timeout = 5000,
}: ShellOptions = {}): Promise<string | undefined> => {
  const marker = `__PANTHEON_PATH_${randomUUID()}__`;
  const command = `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`;
  // csh and tcsh take -l only as their sole flag.
  const csh = ['csh', 'tcsh'].includes(path.basename(shell));
  // What the rc files start shares the shell's process group.
  const group = process.platform !== 'win32';
  return new Promise((resolve) => {
    const child = spawn(shell, csh ? ['-l'] : ['-ilc', command], {
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'ignore'],
      detached: group,
    });
    let stdout = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    // An rc file that exits non-zero after printing still leaves a usable PATH.
    const done = () => {
      clearTimeout(timer);
      resolve(parseShellPath(stdout, marker));
    };
    const timer = setTimeout(() => {
      try {
        if (group) process.kill(-child.pid!, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
      done();
    }, timeout);
    child.on('error', done);
    child.on('close', done);
    if (csh) child.stdin!.on('error', () => {}).end(command);
  });
};

/**
 * The login shell PATH for the daemon. A cached value answers at once while a fresh capture
 * replaces it for the next start; without a cache the capture is awaited, falling back to
 * this process's PATH.
 */
export async function shellPath(
  cacheFile: string,
  options: ShellOptions = {},
): Promise<string | undefined> {
  let cached: string | undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(cacheFile, 'utf8')).path;
    if (typeof value === 'string' && value) cached = value;
  } catch {}
  const refresh = captureShellPath(options).then((captured) => {
    if (captured === undefined) return undefined;
    try {
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ path: captured }));
    } catch {}
    return captured;
  });
  if (cached !== undefined) return cached;
  return (await refresh) ?? process.env.PATH;
}
