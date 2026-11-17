import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import type { AppLogs, inputSchemas } from '@pantheon/protocol';
import type { ControlContext } from './context.js';

/** How much of the end of the daemon log a read looks at. */
const LOG_TAIL_BYTES = 4 * 1024 * 1024;

/** The last lines of the log the desktop app writes the daemon's output to. */
export function appLogs(
  ctx: ControlContext,
  input: ReturnType<(typeof inputSchemas)['app.logs']['parse']>,
): AppLogs {
  const userData = ctx.protectionPaths?.desktopUserDataDir;
  if (userData === undefined) return { lines: [] };
  let fd: number;
  try {
    fd = openSync(path.join(userData, 'logs', 'daemon.log'), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [] };
    throw error;
  }
  let text: string;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
    // A read that starts inside the file starts inside a line, which is dropped.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
  const lines = text
    .split('\n')
    .filter((line) => line !== '' && (input.grep === undefined || line.includes(input.grep)));
  return { lines: lines.slice(-input.lines) };
}
