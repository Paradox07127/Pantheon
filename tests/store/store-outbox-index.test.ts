import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Store, migrations } from '@pantheon/store';

it('migrates pending outbox reads to a partial index while preserving queue order', () => {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'store-outbox-index-'));
  const file = path.join(root, 'control.sqlite');
  const previous = new Store(file, Date.now, { migrations: migrations.slice(0, 1) });
  const completed = previous.enqueue('session.turn', {});
  previous.mark(completed, 'done');
  const sent = previous.enqueue('session.turn', {});
  previous.mark(sent, 'sent');
  const first = previous.enqueue('session.turn', { turn_id: 'first' });
  const second = previous.enqueue('session.turn', { turn_id: 'second' });
  previous.close();
  const store = new Store(file);
  try {
    const plan = store.db
      .prepare("EXPLAIN QUERY PLAN SELECT * FROM outbox WHERE state='pending' ORDER BY rowid")
      .all()
      .map((row) => row.detail)
      .join('\n');
    expect(plan).toContain('USING INDEX outbox_pending');
    expect(plan).not.toContain('TEMP B-TREE');
    expect(store.db.prepare('PRAGMA index_list(outbox)').all()).toContainEqual(
      expect.objectContaining({ name: 'outbox_pending', partial: 1 }),
    );
    expect(store.pending().map((job) => job.id)).toEqual([first, second]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
