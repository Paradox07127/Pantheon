import { expect, it } from 'vitest';
import { Store } from '@pantheon/store';
import type { ProjectIntro } from '@pantheon/domain';

it('replaces one introduction per project without adding fields to its record', () => {
  const store = new Store(':memory:');
  try {
    store.insert('sessions', { id: 'writer', revision: 1 });
    const intro: ProjectIntro = {
      project_id: 'project',
      summary: 'Reads notes.',
      sources: ['file:README.md'],
      features: [],
      modules: [],
      languages: [],
      weeks: Array(8).fill(0),
      heads: [],
      session_id: 'writer',
      written_at: 1,
    };
    store.saveProjectIntro(intro);
    expect(store.projectIntro('project')).toEqual(intro);
    store.saveProjectIntro({ ...intro, summary: 'Reads and writes notes.' });
    expect(store.projectIntro('project')?.summary).toBe('Reads and writes notes.');
    expect(store.db.prepare('SELECT count(*) AS count FROM project_intros').get()?.count).toBe(1);
    expect(() =>
      store.transaction(() => {
        store.saveProjectIntro({ ...intro, summary: 'Rolled back' });
        throw new Error('Rollback');
      }),
    ).toThrow('Rollback');
    expect(store.projectIntro('project')?.summary).toBe('Reads and writes notes.');
    expect(store.must('sessions', 'writer')).toEqual({ id: 'writer', revision: 1 });
  } finally {
    store.close();
  }
});
