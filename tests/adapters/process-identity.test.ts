import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { readProcessIdentity } from '../../packages/adapters/src/process.js';

it('reads a live process start time from the kernel', () => {
  const identity = readProcessIdentity(process.pid);
  expect(identity).toEqual({ pid: process.pid, start_time_us: expect.any(Number) });
  const started = (Date.now() - process.uptime() * 1000) * 1000;
  expect(Math.abs(identity!.start_time_us! - started)).toBeLessThan(1_000_000);
  expect(readProcessIdentity(process.pid)).toEqual(identity);
});

it('reports an exited process as absent', async () => {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  expect(readProcessIdentity(child.pid!)).toBeUndefined();
});

it('still reads a killed process its parent has not reaped yet', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  await once(child, 'spawn');
  const live = readProcessIdentity(child.pid!);
  process.kill(child.pid!, 'SIGKILL');
  // The event loop is blocked, so the exited child stays unreaped while it is read.
  const until = Date.now() + 200;
  while (Date.now() < until);
  expect(readProcessIdentity(child.pid!)).toEqual(live);
  await once(child, 'exit');
});

it.runIf(process.platform === 'linux')(
  'reads Linux start times from /proc as epoch microseconds',
  async () => {
    const identity = readProcessIdentity(process.pid);
    expect(readProcessIdentity(process.pid)?.start_time_us).toBe(identity?.start_time_us);
    expect(Math.abs(identity!.start_time_us! - Date.now() * 1000)).toBeLessThan(86_400_000_000);
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'close');
    expect(readProcessIdentity(child.pid!)).toBeUndefined();
  },
);
