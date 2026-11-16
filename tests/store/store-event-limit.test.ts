import { expect, it } from 'vitest';
import { Store } from '@pantheon/store';

it('reads at most the requested number of events after a sequence, in order', () => {
  const store = new Store(':memory:');
  try {
    const entity = { id: 'aggregate', revision: 1 };
    for (let i = 0; i < 300; i++)
      store.event('turn.running', entity, i % 2 ? 'project-b' : 'project-a', {});
    expect(store.events(0)).toHaveLength(256);
    expect(store.events(0, undefined, 300)).toHaveLength(300);
    const page = store.events(10, 'project-a', 3);
    expect(page.map((e) => e.sequence)).toEqual([11, 13, 15]);
    expect(store.events(0, 'project-b', 2000)).toHaveLength(150);
  } finally {
    store.close();
  }
});
