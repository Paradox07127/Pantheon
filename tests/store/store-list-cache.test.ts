import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '@pantheon/store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fileStore(): { store: Store; file: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-list-'));
  roots.push(root);
  const file = path.join(root, 'control.sqlite');
  return { store: new Store(file), file };
}

const titles = (store: Store) =>
  store.list<{ id: string; revision: number; title: string }>('sessions').map((row) => row.title);

it.each([
  {
    name: 'an update through the store',
    write: (store: Store) => store.update('sessions', { id: 'a', revision: 1, title: 'A2' }, 1),
    after: ['A2', 'B'],
  },
  {
    name: 'a removal through the store',
    write: (store: Store) => store.remove('sessions', 'b', 1),
    after: ['A'],
  },
  {
    name: 'a write made on the database directly',
    write: (store: Store) => store.db.prepare("DELETE FROM sessions WHERE id='a'").run(),
    after: ['B'],
  },
  {
    name: 'a rolled-back transaction',
    write: (store: Store) =>
      expect(() =>
        store.transaction(() => {
          store.insert('sessions', { id: 'c', revision: 1, title: 'C' });
          expect(titles(store)).toEqual(['A', 'B', 'C']);
          throw new Error('rolled back');
        }),
      ).toThrow('rolled back'),
    after: ['A', 'B'],
  },
])('lists the rows after $name', ({ write, after }) => {
  const { store } = fileStore();
  try {
    store.insert('sessions', { id: 'a', revision: 1, title: 'A' });
    store.insert('sessions', { id: 'b', revision: 1, title: 'B' });
    expect(titles(store)).toEqual(['A', 'B']);
    write(store);
    expect(titles(store)).toEqual(after);
  } finally {
    store.close();
  }
});

it('lists the rows another connection committed', () => {
  const { store, file } = fileStore();
  const other = new Store(file);
  try {
    store.insert('sessions', { id: 'a', revision: 1, title: 'A' });
    expect(titles(store)).toEqual(['A']);
    other.insert('sessions', { id: 'b', revision: 1, title: 'B' });
    expect(titles(store)).toEqual(['A', 'B']);
  } finally {
    other.close();
    store.close();
  }
});

it('shares frozen rows and gives each caller its own array', () => {
  const { store } = fileStore();
  try {
    store.insert('sessions', { id: 'a', revision: 1, title: 'A', tags: ['x'] });
    const rows = store.list<{ id: string; revision: number; tags: string[] }>('sessions');
    expect(() => rows[0]!.tags.push('y')).toThrow(TypeError);
    rows.pop();
    expect(store.list('sessions')).toHaveLength(1);
  } finally {
    store.close();
  }
});
