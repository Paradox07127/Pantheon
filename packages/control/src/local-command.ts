import { spawn } from 'node:child_process';

export interface LocalCommandResult {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  missing?: boolean;
  timed_out?: boolean;
}
export type LocalCommand = (
  file: string,
  args: string[],
  cwd?: string,
  timeoutMs?: number,
) => Promise<LocalCommandResult>;

// After the deadline a command that traps SIGTERM gets this long before SIGKILL.
const KILL_GRACE_MS = 1000;
// Characters per stream, as execFile's default maxBuffer counts them.
const MAX_OUTPUT = 1024 * 1024;

export const localCommand: LocalCommand = (file, args, cwd, timeoutMs = 3000) =>
  new Promise((resolve) => {
    const failed = `Command failed: ${[file, ...args].join(' ')}\n`;
    // Detached, the command leads its own process group, so its descendants are signalled with it.
    const child = spawn(file, args, { cwd, detached: true });
    const output = { stdout: '', stderr: '' };
    let stopped = false;
    const collect = (name: 'stdout' | 'stderr') => (chunk: string) => {
      if (stopped) return;
      output[name] += chunk;
      if (output[name].length <= MAX_OUTPUT) return;
      output[name] = output[name].slice(0, MAX_OUTPUT);
      clearTimeout(deadline);
      stop({
        stdout: output.stdout,
        stderr: output.stderr || `${name} maxBuffer length exceeded`,
        exit_code: null,
        missing: false,
        timed_out: false,
      });
    };
    child.stdout.setEncoding('utf8').on('data', collect('stdout'));
    child.stderr.setEncoding('utf8').on('data', collect('stderr'));
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(deadline);
      resolve({
        stdout: output.stdout,
        stderr: output.stderr || error.message,
        exit_code: null,
        missing: error.code === 'ENOENT',
        timed_out: false,
      });
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      resolve({
        stdout: output.stdout,
        stderr: output.stderr || (code === 0 ? '' : failed),
        exit_code: code,
        missing: false,
        timed_out: false,
      });
    });
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    // Settles at once and leaves the rest of the output uncollected.
    const stop = (result: LocalCommandResult) => {
      stopped = true;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
      resolve(result);
    };
    const deadline = setTimeout(
      () =>
        stop({
          stdout: output.stdout,
          stderr: output.stderr || failed,
          exit_code: null,
          timed_out: true,
        }),
      timeoutMs,
    );
  });
