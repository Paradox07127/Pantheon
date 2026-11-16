import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { claudeOneShot, claudeSubscription } from '../../packages/adapters/src/one-shot.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A `claude` stand-in whose `auth status` runs the shell body and never answers in time. */
function hungClaude(body: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-one-shot-probe-'));
  roots.push(root);
  const binary = path.join(root, 'claude');
  writeFileSync(binary, `#!/bin/sh\n${body}\n`);
  chmodSync(binary, 0o755);
  return binary;
}

const settled = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      (value) => ({ resolved: value }),
      (error: Error) => ({ rejected: error.message }),
    ),
    sleep(ms).then(() => 'still pending'),
  ]);

it('answers no once the login probe passes its deadline while ignoring SIGTERM', async () => {
  const binary = hungClaude("trap '' TERM\nsleep 15");

  expect(await settled(claudeSubscription(binary), 12000)).toEqual({ resolved: false });
}, 20000);

it('stops what the login probe started once it passes its deadline', async () => {
  const binary = hungClaude('sleep 30 &\necho $! > "$0.descendant"\nsleep 15');

  expect(await settled(claudeSubscription(binary), 12000)).toEqual({ resolved: false });
  const descendant = readFileSync(`${binary}.descendant`, 'utf8').trim();
  const running = () =>
    /^\s*[^Z\s]/.test(
      spawnSync('ps', ['-o', 'stat=', '-p', descendant], { encoding: 'utf8' }).stdout,
    );
  for (let tries = 0; running() && tries < 100; tries++) await sleep(20);
  expect(running(), 'the process the probe started still runs').toBe(false);
}, 20000);

it('stops waiting for the login probe when the caller gives up', async () => {
  const caller = new AbortController();
  const reply = claudeOneShot('prompt', 'model', caller.signal, hungClaude('sleep 15'));
  setTimeout(() => caller.abort(), 100);

  expect(await settled(reply, 2000)).toEqual({ rejected: expect.stringMatching(/abort/i) });
});
