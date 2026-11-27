import { spawnSync } from 'node:child_process';
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
        const { version, build_time_ms } = await health.json();
        await board.text();
        console.log(JSON.stringify({ health: health.status, version, build_time_ms, board: board.status, imports: 'ready' }));
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
      build_time_ms: Math.max(
        ...globSync(['apps/daemon/dist/**/*.js', 'packages/*/dist/**/*.js']).map(
          (file) => statSync(file).mtimeMs,
        ),
      ),
      board: 200,
      imports: 'ready',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('reads the build time past a compiled file that is gone by the time it is read', async () => {
  const { daemonBuildTime } = await import('@pantheon/domain/version');
  const daemon = mkdtempSync(path.join(os.tmpdir(), 'pantheon-build-time-'));
  try {
    mkdirSync(path.join(daemon, 'dist'));
    writeFileSync(path.join(daemon, 'dist', 'main.js'), '');
    utimesSync(path.join(daemon, 'dist', 'main.js'), 1000, 1000);
    // A link to a deleted file is listed by the glob, then fails stat as a file removed in between would.
    symlinkSync(path.join(daemon, 'removed.js'), path.join(daemon, 'dist', 'gone.js'));
    expect(daemonBuildTime(pathToFileURL(`${daemon}/`))).toBe(1_000_000);
  } finally {
    rmSync(daemon, { recursive: true, force: true });
  }
});
