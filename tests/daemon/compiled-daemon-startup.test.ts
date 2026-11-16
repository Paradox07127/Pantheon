import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('initializes compiled control and starts the daemon in native Node without an async import cycle, reporting the release version', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-compiled-startup-'));
  const moduleUrl = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
  try {
    // A separate native Node module graph is essential: Vitest's transformed imports
    // do not reproduce unsettled top-level await.
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      await import(${moduleUrl('../../packages/control/dist/index.js')});
      const { purposeSessionInstructions } = await import(${moduleUrl('../../packages/control/dist/context.js')});
      if (typeof purposeSessionInstructions !== 'function')
        throw new Error('Compiled modules did not initialize');
      const { startDaemon } = await import(${moduleUrl('../../apps/daemon/dist/index.js')});
      const daemon = await startDaemon({ directory: ${JSON.stringify(directory)}, adapters: [], port: 0 });
      try {
        const health = await fetch(daemon.url + '/health');
        const board = await fetch(daemon.url + '/v1/board', {
          headers: { Authorization: 'Bearer ' + daemon.token }
        });
        const { version } = await health.json();
        await board.text();
        console.log(JSON.stringify({ health: health.status, version, board: board.status, imports: 'ready' }));
      } finally { await daemon.close(); }
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).not.toContain('unsettled top-level await');
    expect(JSON.parse(child.stdout)).toEqual({
      health: 200,
      version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
        .version,
      board: 200,
      imports: 'ready',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
