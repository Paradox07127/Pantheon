import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import { mergeProcesses, terminate } from '../../packages/adapters/src/process.js';

const marker = `process-stop-identity-${randomUUID()}`;
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  // Each child is still unreaped while its exit code is unset, so its pid is still its own.
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

function start(source: string) {
  const child = spawn(process.execPath, ['-e', source, marker], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const ready = new Promise<string>((resolve) =>
    createInterface({ input: child.stdout }).once('line', resolve),
  );
  return { child, done, ready };
}

function running(pid: number): boolean {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  return /^\s*[^Z\s]/.test(state);
}

it('keeps a process that took over the pid of an earlier one in the stop snapshot', () => {
  const earlier = [{ pid: 4242, start_time_us: 1_000_000, command: 'exited tool' }];
  const reused = { pid: 4242, start_time_us: 2_000_000, command: 'new tool' };

  expect(mergeProcesses(earlier, [reused, { ...earlier[0]! }])).toEqual([...earlier, reused]);
});

it('does not signal a group number none of the members it saw still holds', async () => {
  const first = start(
    "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
  );
  await first.ready;
  // A deadline already passed sends one SIGTERM, which the group ignores, and leaves it running.
  expect((await terminate(first.child, first.done, Date.now())).stopped).toBe(false);
  first.child.kill('SIGKILL');
  await first.done;
  const decoy = start("console.log('ready'); setInterval(() => {}, 1000)");
  await decoy.ready;
  // Stands in for the group number passing to another group between the stops.
  Object.defineProperty(first.child, 'pid', { value: decoy.child.pid });

  const again = await terminate(first.child, first.done, Date.now() + 1000);

  expect(running(decoy.child.pid!), 'the group that took over the number still runs').toBe(true);
  expect(again.stopped).toBe(false);
});
