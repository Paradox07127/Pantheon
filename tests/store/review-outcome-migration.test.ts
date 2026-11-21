import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Store, migrations } from '@pantheon/store';

const roots: string[] = [];
const stores: InstanceType<typeof Store>[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databaseFile() {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'review-outcome-migration-'));
  roots.push(root);
  return path.join(root, 'control.sqlite');
}

const finding = (id: string, outcome?: string) => ({
  id,
  review_id: 'saved-review',
  runtime: 'codex',
  round: 1,
  location: 'src/a.ts:1',
  quote: 'a',
  evidence: 'b',
  impact: 'c',
  status: 'open',
  blocking: true,
  ...(outcome
    ? { resolution: { outcome, note: 'kept', resolved_at: 1, resolved_by: 'local-user' } }
    : {}),
});

it('records a saved adopted finding as fixed and a dismissed one as wrong', () => {
  const file = databaseFile();
  const before = new Store(file, () => 1700000000000, {
    migrations: migrations.filter((migration) => migration.version <= 16),
  });
  before.insert('reviews', {
    id: 'saved-review',
    revision: 3,
    project_id: 'project',
    round: 1,
    runtimes: ['codex'],
    state: 'completed',
    session_ids: [],
    findings: [finding('kept', 'adopted'), finding('refuted', 'dismissed'), finding('open')],
  });
  before.close();

  const store = new Store(file, () => 1700000000000);
  stores.push(store);
  const review = store.get<{
    id: string;
    revision: number;
    findings: ReturnType<typeof finding>[];
  }>('reviews', 'saved-review')!;
  expect(review.findings).toEqual([
    finding('kept', 'fixed'),
    finding('refuted', 'wrong'),
    finding('open'),
  ]);
  expect(review.revision).toBe(3);
});
