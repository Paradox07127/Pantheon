import { expect, it } from 'vitest';
import type { SessionComment } from '@pantheon/domain';
import { Store } from '@pantheon/store';

it('stores session comments without changing their sessions', () => {
  const store = new Store(':memory:');
  try {
    const session = { id: 'commented-session', revision: 1 };
    store.insert('sessions', session);
    const comment: SessionComment = {
      id: 'comment',
      revision: 1,
      session_id: session.id,
      path: 'src/answer.ts',
      line: 12,
      side: 'old',
      text: 'Explain this change',
      created_at: 100,
      state: 'open',
    };
    store.insert('session_comments', comment);
    expect(store.list('session_comments')).toEqual([comment]);
    expect(store.must('sessions', session.id)).toEqual(session);
  } finally {
    store.close();
  }
});
