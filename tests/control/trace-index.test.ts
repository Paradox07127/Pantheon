import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceIndex } from '@pantheon/control';

const cleanups: (() => unknown)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

it('does not reread an unchanged transcript whose probe found no metadata row', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-trace-pending-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'claude/projects/work');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'transcript.jsonl');
  const placed = JSON.stringify({ type: 'user', sessionId: 'native-one', cwd: '/work' }) + '\n';
  writeFileSync(
    file,
    JSON.stringify({ type: 'user', note: 'x'.repeat(placed.length - 26) }) + '\n',
  );
  // Whole seconds, so restoring the mtime restores it exactly.
  utimesSync(file, 1_800_000_000, 1_800_000_000);
  const index = new TraceIndex({
    file: path.join(root, 'trace-cache.sqlite'),
    claudeHomes: [path.join(root, 'claude')],
    codexHomes: [],
  });
  cleanups.push(() => index.close());
  await index.scan([], 60_000);
  expect(index.unassignedRecords()).toEqual([]);
  const size = statSync(file).size;
  writeFileSync(file, placed);
  expect(statSync(file).size).toBe(size);
  utimesSync(file, 1_800_000_000, 1_800_000_000);
  await index.scan([], 60_000);
  expect(index.unassignedRecords()).toEqual([]);
  utimesSync(file, 1_800_000_000, 1_800_000_001);
  await index.scan([], 60_000);
  expect(index.unassignedRecords().map((r) => r.native_id)).toEqual(['native-one']);
});
