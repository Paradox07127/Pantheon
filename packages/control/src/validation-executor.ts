import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { TestCounts } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { trackChildProcess } from './child-processes.js';
import { copyDependencyFolders } from './dependency-folders.js';
import { textLimit } from './files.js';
import { GateTestCounts } from './gate-test-counts.js';

export interface ValidationInput {
  ctx: ControlContext;
  key: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  cancelled?: () => boolean;
}

export interface ValidationResult {
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  duration_ms: number;
  stdout: Buffer;
  stderr: Buffer;
  log: Buffer;
  tail: string;
  tests?: TestCounts;
  timedOut: boolean;
  stdout_sha256: string;
  stderr_sha256: string;
  output_truncated: boolean;
  error?: string;
  stopped?: {
    reason: 'timeout' | 'shutdown' | 'cancelled';
    signal: NodeJS.Signals | null;
    descendants: 'unconfirmed';
  };
}

/** Returns false when shutdown stopped the copy before it finished. */
export async function copyCandidateDependencies(
  ctx: ControlContext,
  key: string,
  source: string,
  clone: string,
  cancelled?: () => boolean,
): Promise<boolean> {
  const copying = new AbortController();
  const poll = setInterval(() => {
    if (ctx.closing || cancelled?.()) copying.abort();
  }, 50);
  try {
    await copyDependencyFolders(source, clone, copying.signal);
    return true;
  } catch (error) {
    if (copying.signal.aborted) return false;
    throw error;
  } finally {
    clearInterval(poll);
  }
}

export async function runValidationCommand(input: ValidationInput): Promise<ValidationResult> {
  const started = performance.now();
  if (input.cancelled?.())
    return {
      exit_code: null,
      signal: null,
      duration_ms: performance.now() - started,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      log: Buffer.alloc(0),
      tail: '',
      timedOut: false,
      stdout_sha256: createHash('sha256').digest('hex'),
      stderr_sha256: createHash('sha256').digest('hex'),
      output_truncated: false,
      error: 'cancelled',
    };
  return new Promise<ValidationResult>((resolve) => {
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [],
      log: Buffer[] = [];
    const tests = new GateTestCounts();
    const outHash = createHash('sha256'),
      errHash = createHash('sha256');
    let outSize = 0,
      errSize = 0,
      logSize = 0,
      timedOut = false,
      cancelled = false,
      error: string | undefined,
      tail = '';
    const child = spawn(input.argv[0]!, input.argv.slice(1), {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = trackChildProcess(input.ctx, input.key, child, (failure) => {
      error = String(failure);
    });
    let drain: NodeJS.Timeout | undefined;
    // A descendant in its own session can keep the output pipes open after the group is
    // stopped, and the run settles only once they close.
    const halt = () => {
      stop();
      drain ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      halt();
    }, input.timeoutMs);
    const cancellation = setInterval(() => {
      if (input.cancelled?.()) {
        cancelled = true;
        halt();
      }
    }, 50);
    const collect = (bytes: Buffer, channel: 'stdout' | 'stderr') => {
      tests.write(bytes.toString('utf8'), channel);
      tail = (tail + bytes.toString('utf8')).slice(-4000);
      const size = channel === 'stdout' ? outSize : errSize;
      (channel === 'stdout' ? outHash : errHash).update(bytes);
      const kept = bytes.subarray(0, Math.max(0, textLimit - size));
      if (kept.length) (channel === 'stdout' ? stdout : stderr).push(Buffer.from(kept));
      const combined = bytes.subarray(0, Math.max(0, textLimit - logSize));
      if (combined.length) log.push(Buffer.from(combined));
      if (channel === 'stdout') outSize += bytes.length;
      else errSize += bytes.length;
      logSize += bytes.length;
    };
    child.stdout.on('data', (bytes: Buffer) => collect(bytes, 'stdout'));
    child.stderr.on('data', (bytes: Buffer) => collect(bytes, 'stderr'));
    child.on('error', (failure) => {
      error = String(failure);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(drain);
      clearInterval(cancellation);
      // Reap ordinary background children even when they closed their stdio and
      // the leader exited successfully. Deliberately detached groups remain unconfirmed.
      stop();
      const counts = tests.finish();
      resolve({
        ...(counts ? { tests: counts } : {}),
        exit_code: error ? null : code,
        signal,
        duration_ms: performance.now() - started,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        log: Buffer.concat(log),
        tail,
        timedOut,
        stdout_sha256: outHash.digest('hex'),
        stderr_sha256: errHash.digest('hex'),
        output_truncated: outSize > textLimit || errSize > textLimit || logSize > textLimit,
        error,
        ...(timedOut || input.ctx.closing || cancelled
          ? {
              stopped: {
                reason: cancelled
                  ? ('cancelled' as const)
                  : timedOut
                    ? ('timeout' as const)
                    : ('shutdown' as const),
                signal,
                descendants: 'unconfirmed' as const,
              },
            }
          : {}),
      });
    });
  });
}
