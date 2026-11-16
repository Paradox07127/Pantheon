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
