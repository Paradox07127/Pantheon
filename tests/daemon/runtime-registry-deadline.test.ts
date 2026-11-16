import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { readProcessIdentity } from '@pantheon/adapters';
import { createRuntimeAdapter } from '../../apps/daemon/dist/runtime-registry.js';

it('finishes a version probe and kills a child that ignores SIGTERM', async () => {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'runtime-probe-'));
  const binary = path.join(root, 'runtime.mjs');
  const pidFile = path.join(root, 'pid');
  writeFileSync(
    binary,
    `#!${process.execPath}
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  const probe = createRuntimeAdapter('claude', { binary });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let started: { pid: number; start_time_us?: number } | undefined;
  try {
    await vi.waitFor(() => expect(Number(readFileSync(pidFile, 'utf8'))).toBeGreaterThan(0));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    started = { pid, start_time_us: readProcessIdentity(pid)?.start_time_us };
    const result = await Promise.race([
      probe,
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), 7000);
      }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.report.version).toBe('unprobed');
    await vi.waitFor(() => expect(() => process.kill(started!.pid, 0)).toThrow());
  } finally {
    clearTimeout(deadline);
    // Signal only the runtime this test started, never another process that took over its pid.
    const target =
      started?.start_time_us !== undefined &&
      readProcessIdentity(started.pid)?.start_time_us === started.start_time_us &&
      execFileSync('ps', ['-o', 'command=', '-p', String(started.pid)], {
        encoding: 'utf8',
      }).includes(binary)
        ? started.pid
        : undefined;
    console.info('runtime probe cleanup target', target);
    if (target !== undefined) process.kill(target, 'SIGKILL');
    await probe;
    rmSync(root, { recursive: true, force: true });
  }
});
