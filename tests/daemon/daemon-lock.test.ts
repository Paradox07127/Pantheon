import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startDaemon } from '@pantheon/daemon';

/** Leaves a socket whose listener was killed, as an unclean exit does. */
function staleSocket(directory: string): void {
  const stale = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import net from 'node:net';
      net.createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'));`,
      path.join(directory, 'daemon.lock.sock'),
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(stale.signal, stale.stderr).toBe('SIGKILL');
}

it('reclaims a stale socket past a reclaim file left by a starter that died', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-lock-'));
  try {
    staleSocket(directory);
    const gone = spawnSync(process.execPath, ['-e', '']).pid!;
    writeFileSync(path.join(directory, 'daemon.lock.sock.reclaim'), String(gone));
    const daemon = await startDaemon({ directory, adapters: [], intervalMs: 60_000 });
    await daemon.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('allows only one concurrent starter to reclaim a stale daemon socket', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pantheon-lock-'));
  const daemons: Awaited<ReturnType<typeof startDaemon>>[] = [];
  try {
    const stale = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import net from 'node:net';
        net.createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'));`,
        path.join(directory, 'daemon.lock.sock'),
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(stale.signal, stale.stderr).toBe('SIGKILL');
    const starts = await Promise.allSettled([
      startDaemon({ directory, adapters: [], intervalMs: 60_000 }),
      startDaemon({ directory, adapters: [], intervalMs: 60_000 }),
    ]);
    for (const result of starts) if (result.status === 'fulfilled') daemons.push(result.value);
    expect(daemons).toHaveLength(1);
    expect(starts.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'daemon_running' },
    });
    expect((await fetch(daemons[0]!.url + '/health')).status).toBe(200);
  } finally {
    for (const daemon of daemons) await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
