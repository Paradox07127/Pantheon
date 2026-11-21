import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Principal } from '@pantheon/domain';
import { fixture } from '../helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

const personal: Principal = { id: 'personal:k1', role: 'personal' };

/** A project and a user config folder of its own. */
async function setup() {
  const userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-personal-actions-'));
  const f = await fixture({ managedWorkspaces: true, controlOptions: { userConfigDir } });
  cleanups.push(async () => {
    await f.close();
    rmSync(userConfigDir, { recursive: true, force: true });
  });
  return f;
}

const outcome = (run: () => unknown): { result?: unknown; code: string } => {
  try {
    return { result: run(), code: 'accepted' };
  } catch (error) {
    return { code: (error as { code?: string }).code ?? (error as Error).name };
  }
};

it('refuses approval.respond from a personal principal without recording a call', async () => {
  const f = await setup();
  expect(outcome(() => f.call('approval.respond', {}, null, personal)).code).toBe(
    'permission_denied',
  );
  const recorded = f.store.db
    .prepare("SELECT payload FROM events WHERE kind='personal.called'")
    .all() as { payload: string }[];
  expect(recorded.map((row) => JSON.parse(row.payload))).toEqual([]);
});
