import { expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fixture } from '../helpers.js';
import { runValidationCommand } from '../../packages/control/dist/validation-executor.js';
import type { ControlContext } from '../../packages/control/src/context.js';

/** A Control with a folder that stands for the gate candidate a verifier runs in. */
async function candidateFixture(options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options);
  const candidate = path.join(f.root, 'candidate');
  mkdirSync(candidate);
  return { ...f, candidate };
}

it('records bounded stop evidence when a verifier exceeds its timeout', async () => {
  const f = await candidateFixture();
  try {
    const result = await runValidationCommand({
      ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
      key: 'check-process:timeout:0',
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
      cwd: f.candidate,
      env: process.env,
      timeoutMs: 250,
    });
    expect(result).toMatchObject({
      timedOut: true,
      signal: 'SIGKILL',
      stopped: { reason: 'timeout', descendants: 'unconfirmed' },
    });
  } finally {
    await f.close();
  }
});

it('settles a timed-out verifier whose descendant in its own session keeps the output open', async () => {
  const f = await candidateFixture();
  try {
    const script = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'inherit' }).unref();
      setTimeout(() => {}, 30000);`;
    const result = await runValidationCommand({
      ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
      key: 'check-process:detached-output:0',
      argv: [process.execPath, '-e', script],
      cwd: f.candidate,
      env: process.env,
      timeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.duration_ms).toBeLessThan(5000);
  } finally {
    await f.close();
  }
});

it('collects test counts from verifier stdout and stderr', async () => {
  const f = await candidateFixture();
  try {
    const result = await runValidationCommand({
      ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
      key: 'summary-output',
      argv: [
        process.execPath,
        '-e',
        "console.log('Tests  4 passed (4)'); console.error('test result: FAILED. 2 passed; 1 failed; 3 ignored');",
      ],
      cwd: f.candidate,
      env: process.env,
      timeoutMs: 10000,
    });
    expect(result.exit_code).toBe(0);
    expect(result.tests).toEqual({ passed: 6, failed: 1, skipped: 3 });
  } finally {
    await f.close();
  }
});
