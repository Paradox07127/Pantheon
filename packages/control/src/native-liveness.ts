import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { linuxStartMicros } from '@pantheon/adapters';
import { DomainError, type ProcessIdentity } from '@pantheon/domain';

export interface NativeLivenessInput {
  runtime: string;
  native_id: string;
  /** The Claude configuration directory, which holds sessions/<pid>.json for each running process. */
  claudeHome: string;
  readProcess: (pid: number) => ProcessIdentity | undefined;
  /** Processes Pantheon runs for this session, which never count as holding it. */
  ownPids?: number[];
}

export type NativeHolder =
  { state: 'held'; pid: number } | { state: 'free' } | { state: 'unknown' };

/** A start time in microseconds from Linux clock ticks, a number or string of seconds, milliseconds or microseconds, or a date. */
function startMicros(value: unknown): number | undefined {
  // Claude on Linux writes the /proc starttime as a string of clock ticks since boot.
  if (process.platform === 'linux' && typeof value === 'string' && /^\d+$/.test(value.trim()))
    return linuxStartMicros(Number(value));
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : undefined;
  if (number !== undefined && Number.isFinite(number))
    return number >= 1e14 ? number : number >= 1e11 ? number * 1e3 : number * 1e6;
  // Claude writes a ctime-style date in UTC with no zone, which Date.parse would read as local time.
  const date =
    typeof value !== 'string'
      ? NaN
      : /^\w{3} \w{3} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(value.trim())
        ? Date.parse(`${value.trim()} UTC`)
        : Date.parse(value);
  return Number.isFinite(date) ? date * 1e3 : undefined;
}

/**
 * The live process that holds a native session outside Pantheon. Claude's process records are
 * undocumented, so a file that does not parse is skipped; Codex keeps no known record.
 */
export function nativeSessionHolder(input: NativeLivenessInput): NativeHolder {
  if (input.runtime !== 'claude') return { state: 'unknown' };
  const folder = path.join(input.claudeHome, 'sessions');
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'free' };
    throw error;
  }
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    let record: { pid?: unknown; procStart?: unknown; sessionId?: unknown };
    try {
      record = JSON.parse(readFileSync(path.join(folder, name), 'utf8'));
    } catch {
      continue;
    }
    const { pid, sessionId } = record ?? {},
      started = startMicros(record?.procStart);
    if (
      sessionId !== input.native_id ||
      !Number.isSafeInteger(pid) ||
      started === undefined ||
      input.ownPids?.includes(pid as number)
    )
      continue;
    const current = input.readProcess(pid as number)?.start_time_us;
    // A recorded start time a second or more away belongs to an earlier process with this pid.
    if (current !== undefined && Math.abs(current - started) < 1_000_000)
      return { state: 'held', pid: pid as number };
  }
  return { state: 'free' };
}

export function assertNativeSessionFree(input: NativeLivenessInput): void {
  const holder = nativeSessionHolder(input);
  if (holder.state === 'held')
    throw new DomainError(
      'native_session_busy',
      `Native session ${input.native_id} is open in process ${holder.pid}; end it there first`,
    );
}
