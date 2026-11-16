import { expect, it } from 'vitest';
import { Store } from '@pantheon/store';

it.each([
  ['events_aggregate', 'aggregate_id=?', ['candidate']],
  ['events_project_kind', 'project_id=? AND kind=?', ['project', 'session.merged']],
])('uses %s for ordered event lookups', (index, where, values) => {
  const store = new Store(':memory:');
  try {
    const plan = store.db
      .prepare(`EXPLAIN QUERY PLAN SELECT payload FROM events WHERE ${where} ORDER BY sequence`)
      .all(...values);
    expect(plan.map((row) => row.detail).join('\n')).toContain(`USING INDEX ${index}`);
  } finally {
    store.close();
  }
});

it('reads the project events of the kinds from a time on, in order', () => {
  const store = new Store(':memory:');
  try {
    const entity = { id: 'session', revision: 1 };
    const old = store.event('turn.queued', entity, 'project', {}),
      recent = store.event('turn.queued', entity, 'project', {}),
      other = store.event('task.handed_back', entity, 'project', {});
    store.event('turn.queued', entity, 'elsewhere', {});
    const at = store.db.prepare('UPDATE events SET created_at=? WHERE sequence=?');
    at.run(1000, old.sequence);
    at.run(5000, recent.sequence);
    at.run(5000, other.sequence);
    expect(
      store
        .kindEventsSince('project', ['turn.queued', 'task.handed_back'], 2000)
        .map((event) => event.sequence),
    ).toEqual([recent.sequence, other.sequence]);
  } finally {
    store.close();
  }
});
