import { expect, it } from 'vitest';
import { localCommand } from '../../packages/control/dist/local-command.js';

it('settles at its deadline as timed out when the command ignores SIGTERM', async () => {
  const started = Date.now();
  const result = await localCommand(
    process.execPath,
    [
      '-e',
      'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setTimeout(() => process.exit(0), 5000)',
    ],
    undefined,
    1000,
  );
  // Without the marker the deadline came before the command trapped SIGTERM.
  expect(result.stdout).toBe('ready\n');
  expect(result.timed_out).toBe(true);
  // Past this the call waited for the SIGKILL that follows the grace period.
  expect(Date.now() - started).toBeLessThan(1900);
});

it('stops a command at a mebibyte of output and keeps only that much', async () => {
  const started = Date.now();
  const result = await localCommand(
    process.execPath,
    ['-e', 'process.stdout.write("x".repeat(4 * 1024 * 1024)); setTimeout(() => {}, 10000)'],
    undefined,
    5000,
  );
  expect(result.stdout).toHaveLength(1024 * 1024);
  expect(result).toMatchObject({
    stderr: 'stdout maxBuffer length exceeded',
    exit_code: null,
    timed_out: false,
  });
  expect(Date.now() - started).toBeLessThan(4000);
});
