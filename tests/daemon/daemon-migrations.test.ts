import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startDaemon } from '../../apps/daemon/src/index.js';
import { Control } from '@pantheon/control';
import { Store, migrations } from '@pantheon/store';

const lock = vi.hoisted(() => ({ held: false, closes: 0 }));
vi.mock('node:net', async (original) => {
  const actual = await original<
    typeof import('node:net') & { default: typeof import('node:net') }
  >();
  return {
    ...actual,
    default: {
      ...actual.default,
      createServer: () => {
        const server = Object.assign(new EventEmitter(), {
          listen: (_socket: string, ready: () => void) => {
            if (lock.held) server.emit('error', new Error('Directory lock is still held'));
            else {
              lock.held = true;
              ready();
            }
          },
          close: (ready: () => void) => {
            lock.held = false;
            lock.closes++;
            ready();
          },
        });
        return server;
      },
    },
  };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: (file: string, mode: number) => {
      if (!file.endsWith('.sock')) actual.chmodSync(file, mode);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('releases the startup lock and writes no manifest when the database belongs to a newer build', async () => {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(path.join(cache, 'daemon-migrations-'));
  roots.push(directory);
  const file = path.join(directory, 'control.sqlite');
  const store = new Store(file, Date.now, {
    migrations: [
      ...migrations,
      {
        version: migrations.at(-1)!.version + 1,
        up: (db: DatabaseSync) => db.exec('CREATE TABLE future_data (value TEXT) STRICT;'),
      },
    ],
  });
  store.close();
  const recover = vi.spyOn(Control.prototype, 'recover').mockImplementation(() => {
    throw new Error('Recovery must not run for an incompatible schema');
  });
  const before = readFileSync(file);
  for (let attempt = 0; attempt < 2; attempt++) {
    const daemon = await startDaemon({ directory, adapters: [] }).catch((error) => error);
    if (daemon?.close) await daemon.close();
    expect(daemon).toMatchObject({ code: 'schema_incompatible' });
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(path.join(directory, 'daemon.lock.sock'))).toBe(false);
    expect(existsSync(path.join(directory, 'daemon.json'))).toBe(false);
    expect(existsSync(path.join(directory, 'user.token'))).toBe(false);
    expect(existsSync(path.join(directory, 'artifacts'))).toBe(false);
  }
  expect(lock.closes).toBe(2);
  expect(recover).not.toHaveBeenCalled();
});
