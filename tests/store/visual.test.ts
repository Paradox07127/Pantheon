import { expect, it } from 'vitest';
import { Store } from '@pantheon/store';

it('keeps durable visual records beside sessions', () => {
  const store = new Store(':memory:');
  try {
    const session = { id: 'drawing-session', revision: 1 };
    store.insert('sessions', session);
    const visual = {
      id: 'chart',
      revision: 1,
      project_id: 'project',
      session_id: session.id,
      title: 'Chart',
      kind: 'mermaid',
      spec: { source: 'graph LR' },
      created_at: 1,
      updated_at: 1,
    };
    store.insert('visuals', visual);
    expect(store.must('visuals', visual.id)).toEqual(visual);
    expect(store.must('sessions', session.id)).toEqual(session);
    expect(() =>
      store.transaction(() => {
        store.remove('visuals', visual.id, visual.revision);
        throw new Error('Rollback');
      }),
    ).toThrow('Rollback');
    expect(store.must('visuals', visual.id)).toEqual(visual);
  } finally {
    store.close();
  }
});
