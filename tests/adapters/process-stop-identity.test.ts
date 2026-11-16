import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { afterEach, expect, it, vi } from 'vitest';
import {
  mergeProcesses,
  readProcessIdentity,
  terminate,
} from '../../packages/adapters/src/process.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

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

it('confirms a stop once a descendant that left the group has exited unreaped', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  // After exec, node never waits for the backgrounded sleep, so it stays unreaped once it exits.
  const holder = spawn(
    'sh',
    [
      '-c',
      'sleep 1 & echo $!; exec "$0" -e "setInterval(() => {}, 1000)" "$1"',
      process.execPath,
      marker,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  children.push(holder);
  const exited = Number(
    await new Promise<string>((resolve) =>
      createInterface({ input: holder.stdout }).once('line', resolve),
    ),
  );
  for (let tries = 0; running(exited) && tries < 300; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(readProcessIdentity(exited)?.start_time_us).toEqual(expect.any(Number));
  const leader = start("console.log('ready'); setInterval(() => {}, 1000)");
  await leader.ready;
  // Stands in for a process list read while the exited sleep still descended from the leader.
  vi.mocked(execFileSync).mockImplementation(((file: string, args: string[], options: object) => {
    const listing = String(actual.execFileSync(file, args, options));
    return args[1] === 'pid=,ppid=,command='
      ? `${listing}${exited} ${leader.child.pid} sleep 1\n`
      : listing;
  }) as typeof execFileSync);
  try {
    expect(await terminate(leader.child, leader.done, Date.now() + 2000)).toMatchObject({
      stopped: true,
      leftovers: [],
    });
  } finally {
    vi.mocked(execFileSync).mockImplementation(actual.execFileSync);
  }
});
