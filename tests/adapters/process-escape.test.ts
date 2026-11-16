import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import { readProcessIdentity, terminate } from '../../packages/adapters/src/process.js';
import { psUsable } from '../helpers.js';

const marker = `process-escape-${randomUUID()}`;
const spawned: { pid: number; start_time_us: number }[] = [];

function commandLine(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

afterEach(() => {
  const targets = spawned.splice(0);
  const checked = targets.map((target) => ({
    target,
    matches:
      readProcessIdentity(target.pid)?.start_time_us === target.start_time_us &&
      commandLine(target.pid).includes(marker),
  }));
  const mismatch = checked.find((entry) => !entry.matches);
  if (mismatch)
    throw new Error(`Cleanup aborted; ${mismatch.target.pid} is not the process this test started`);
  for (const { target } of checked) process.kill(target.pid, 'SIGKILL');
});

function start(source: string) {
  const child = spawn(process.execPath, ['-e', source, marker], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
  return { child, done };
}

it.skipIf(!psUsable)(
  'does not confirm a stop while a descendant that left the group and its stdio survives',
  async () => {
    const { child, done } = start(`const {spawn}=require('node:child_process');
    const escaped=spawn(process.execPath,['-e','setTimeout(()=>{},60000)',process.argv[1]],{detached:true,stdio:'ignore'});
    escaped.unref();
    console.log(escaped.pid);
    setInterval(()=>{},1000);`);
    const line = await new Promise<string>((resolve) =>
      createInterface({ input: child.stdout }).once('line', resolve),
    );
    const pid = Number(line);
    const identity = readProcessIdentity(pid);
    expect(identity?.start_time_us).toEqual(expect.any(Number));
    expect(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
    ).toBe(String(child.pid));
    spawned.push({ pid, start_time_us: identity!.start_time_us! });

    const receipt = await terminate(child, done, Date.now() + 5000);

    expect(receipt.stopped, 'a detached descendant is still running').toBe(false);
    expect(receipt.leftovers).toEqual([
      { pid, start_time_us: identity!.start_time_us, command: expect.stringContaining(marker) },
    ]);

    const again = await terminate(child, done, Date.now() + 5000);

    expect(again.stopped, 'the detached descendant still runs at the next stop').toBe(false);
    expect(again.leftovers).toEqual(receipt.leftovers);
  },
);

it('confirms a stop with no leftovers when no descendant left the group', async () => {
  const { child, done } = start('setInterval(()=>{},1000)');
  await new Promise((resolve) => child.once('spawn', resolve));

  const receipt = await terminate(child, done, Date.now() + 5000);

  expect(receipt.stopped).toBe(true);
  expect(receipt.leftovers).toEqual([]);
});

it('stops the process group when the process list cannot be read', async () => {
  const { child, done } = start('setInterval(()=>{},1000)');
  await new Promise((resolve) => child.once('spawn', resolve));
  const searchPath = process.env.PATH;
  // A directory without ps, as inside a sandbox that refuses the setuid ps.
  process.env.PATH = mkdtempSync(path.join(tmpdir(), 'no-process-list-'));
  try {
    const receipt = await terminate(child, done, Date.now() + 5000);

    expect(receipt.stopped).toBe(true);
  } finally {
    process.env.PATH = searchPath;
    child.kill('SIGKILL');
  }
});
