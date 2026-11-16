import { afterEach, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProcess, readProcessIdentity } from '../../packages/adapters/src/process.js';
import { psUsable } from '../helpers.js';

const fakeSsh = fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url));
const marker = `device-stop-${randomUUID()}`;
const roots: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
/** Processes this file started without a handle, by pid and start time. */
const started: { pid: number; start_time_us: number }[] = [];
const decoys: ChildProcess[] = [];

/** As the device stop check counts it: an exited process nobody has reaped is not running. */
function running(pid: number): boolean {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  return /^\s*[^Z\s]/.test(state);
}

function commandLine(pid: number): string {
  return spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
}

/** Kills the started processes still running as themselves; aborts if one lacks this run's marker. */
function killStarted(): void {
  const targets = started
    .splice(0)
    .filter(
      (target) =>
        running(target.pid) &&
        readProcessIdentity(target.pid)?.start_time_us === target.start_time_us,
    );
  console.info('device stop cleanup targets', targets);
  const mismatch = targets.find((target) => !commandLine(target.pid).includes(marker));
  if (mismatch)
    throw new Error(`Cleanup aborted; ${mismatch.pid} is not the process this test started`);
  for (const target of targets) process.kill(target.pid, 'SIGKILL');
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  killStarted();
  for (const decoy of decoys.splice(0)) decoy.kill('SIGKILL');
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-device-stop-'));
  roots.push(root);
  return root;
}

async function written(pidFile: string): Promise<number> {
  const pid = await vi.waitFor(() => {
    const value = Number(readFileSync(pidFile, 'utf8'));
    expect(value).toBeGreaterThan(0);
    return value;
  });
  started.push({ pid, start_time_us: readProcessIdentity(pid)!.start_time_us! });
  return pid;
}

function deviceProcess(root: string, plainTransport: string[], command: string, args: string[]) {
  const rpc = new JsonRpcProcess(
    command,
    args,
    undefined,
    undefined,
    {},
    {
      remote: {
        transport: [process.execPath, fakeSsh, root],
        plain_transport: plainTransport,
        binary: command,
      },
    },
  );
  rpc.on('protocolError', () => {});
  closers.push(() => rpc.close(Date.now() + 2000));
  return rpc;
}

/** A device runtime that starts a tool in a session of its own, then serves stdin until EOF. */
async function escapingRuntime(root: string, plainTransport: string[]) {
  const pidFile = path.join(root, 'tool.pid');
  const runtime = path.join(root, 'runtime.cjs');
  writeFileSync(
    runtime,
    `const tool = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', ${JSON.stringify(marker)}], { detached: true, stdio: 'ignore' });
tool.unref();
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(tool.pid));
process.stdin.resume();
`,
  );
  const rpc = deviceProcess(root, plainTransport, process.execPath, [runtime]);
  return { rpc, tool: await written(pidFile) };
}

/** A process group of its own that the stops below must never signal. */
function decoyGroup(): number {
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], {
    detached: true,
    stdio: 'ignore',
  });
  decoys.push(decoy);
  return decoy.pid!;
}

/** A device link that, from the second stop on, hands the stop another group's number. */
function retargetingLink(root: string, group: number): string[] {
  const link = path.join(root, 'retarget.sh');
  writeFileSync(
    link,
    `script=$3
if [ -e "$1" ]; then script=$(printf '%s\\n' "$script" | sed "1s/^g=.*/g=$2/"); fi
: > "$1"
exec /bin/sh -c "$script"
`,
  );
  return ['/bin/sh', link, path.join(root, 'stops'), String(group)];
}

it.skipIf(!psUsable)(
  'keeps checking a device descendant that left the group at a later stop',
  async () => {
    const { rpc, tool } = await escapingRuntime(tempRoot(), ['/bin/sh', '-c']);

    expect(await rpc.close(Date.now() + 5000)).toMatchObject({
      stopped: false,
      reason: 'Descendants that left the device process group are still running',
    });
    expect((await rpc.close(Date.now() + 5000)).stopped, 'the tool still runs').toBe(false);

    killStarted();
    await vi.waitFor(() => expect(running(tool)).toBe(false));
    expect((await rpc.close(Date.now() + 5000)).stopped).toBe(true);
  },
);

it.skipIf(!psUsable)(
  'never signals a device group number again once a stop saw the group empty',
  async () => {
    const root = tempRoot();
    const decoy = decoyGroup();
    const { rpc } = await escapingRuntime(root, retargetingLink(root, decoy));

    expect((await rpc.close(Date.now() + 5000)).stopped).toBe(false);
    await rpc.close(Date.now() + 5000);

    expect(running(decoy), 'the group that took over the number still runs').toBe(true);
  },
);

it.skipIf(!psUsable)(
  'does not signal a device group number none of its recorded processes still holds',
  async () => {
    const root = tempRoot();
    const decoy = decoyGroup();
    const pidFile = path.join(root, 'runtime.pid');
    const markerFile = path.join(root, marker);
    writeFileSync(markerFile, '');
    // The runtime ignores SIGTERM, so its group outlives the first stop's deadline.
    const rpc = deviceProcess(root, retargetingLink(root, decoy), '/bin/sh', [
      '-c',
      `trap '' TERM; echo $$ > '${pidFile}'; exec cat - '${markerFile}'`,
    ]);
    const runtime = await written(pidFile);

    expect((await rpc.close(Date.now() + 1000)).stopped).toBe(false);
    killStarted();
    await vi.waitFor(() => expect(running(runtime)).toBe(false));
    const again = await rpc.close(Date.now() + 5000);

    expect(running(decoy), 'the group that took over the number still runs').toBe(true);
    expect(again.stopped).toBe(false);
  },
);
