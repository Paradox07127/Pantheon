import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
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
  try {
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true));
    const result = await Promise.race([
      probe,
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), 7000);
      }),
    ]);
    expect(result).not.toBeNull();
    expect(result!.report.version).toBe('unprobed');
    await vi.waitFor(() =>
      expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow(),
    );
  } finally {
    clearTimeout(deadline);
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await probe;
    rmSync(root, { recursive: true, force: true });
  }
});
