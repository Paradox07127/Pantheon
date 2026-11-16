import { afterEach, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
function setup() {
  const f = fixture();
  fixtures.push(f);
  const save = (key: string, dependencies: string[] = [], commit = true) => {
    const draft = f.call<MemoryRecord>('memory.propose', {
      project_id: f.project.id,
      key,
      kind: 'note',
      text: key,
      dependencies,
    });
    return commit
      ? f.call<MemoryRecord>('memory.commit', { memory_id: draft.id }, draft.revision)
      : draft;
  };
  const root = save('source');
  const child = save('child', [root.id]);
  const grandchild = save('grandchild', [child.id]);
  const retract = () => f.call<any>('memory.archive', { memory_id: root.id }, root.revision);
  const undo = () =>
    f.call<any>(
      'memory.undo_retraction',
      { memory_id: root.id },
      f.store.must<MemoryRecord>('memory_records', root.id).revision,
    );
  return { f, save, root, child, grandchild, retract, undo };
}

it('returns the whole retraction cascade and restores original records across a control restart', async () => {
  const { f, root, child, grandchild, retract, undo } = setup();
  const unrelated = f.call<MemoryRecord>('memory.propose', {
    project_id: f.project.id,
    key: 'unrelated',
    kind: 'note',
    text: 'Unrelated',
  });
  const stored = [root, child, grandchild].map((record) =>
    f.store.must<MemoryRecord>('memory_records', record.id),
  );
  const result = retract();
  expect(result.archived_ids).toEqual([root.id, child.id, grandchild.id]);
  expect(result).toMatchObject({ id: root.id, state: 'archived', reason: 'retracted' });
  const { Control } = await import('@pantheon/control');
  const control = new Control(f.store, f.files, [f.adapter]);
  try {
    const { command } = await import('@pantheon/protocol');
    const restored = control.execute(
      user,
      command(user.id, 'memory.undo_retraction', { memory_id: root.id }, result.revision),
    );
    expect(restored).toEqual({ restored_ids: [root.id, child.id, grandchild.id], skipped: [] });
    for (const before of stored) {
      const after = f.store.must<MemoryRecord>('memory_records', before.id);
      expect(after).toEqual({ ...before, revision: after.revision });
      expect(after.revision).toBeGreaterThan(before.revision);
    }
    expect(f.store.must<MemoryRecord>('memory_records', unrelated.id)).toMatchObject({
      revision: unrelated.revision,
      state: 'draft',
    });
    expect(control.memoryRecent(user, f.project.id, 1).items[0]).toMatchObject({
      kind: 'retraction_undone',
      memory_id: root.id,
    });
  } finally {
    await control.shutdown();
  }
  expect(() => undo()).toThrowError(expect.objectContaining({ code: 'memory_not_retracted' }));
});

it('restores a retracted draft as a draft', () => {
  const { f, save } = setup();
  const draft = save('draft', [], false);
  const archived = f.call<MemoryRecord>('memory.archive', { memory_id: draft.id }, draft.revision);
  f.call('memory.undo_retraction', { memory_id: draft.id }, archived.revision);
  expect(f.store.must<MemoryRecord>('memory_records', draft.id)).toMatchObject({ state: 'draft' });
});

it('refuses undo after a newer committed version even if that version was archived', () => {
  const { f, save, root, retract, undo } = setup();
  retract();
  const replacement = save(root.key);
  f.call('memory.archive', { memory_id: replacement.id }, replacement.revision);
  expect(() => undo()).toThrowError(
    expect.objectContaining({ code: 'memory_retraction_replaced' }),
  );
  expect(f.store.must<MemoryRecord>('memory_records', root.id).state).toBe('archived');
});

it('refuses an undo that would push confirmed decisions past the context budget', () => {
  const { f } = setup();
  const decide = (key: string) => {
    const draft = f.call<MemoryRecord>('memory.propose', {
      project_id: f.project.id,
      key,
      kind: 'decision',
      text: key.repeat(7000),
    });
    return f.call<MemoryRecord>('memory.commit', { memory_id: draft.id }, draft.revision);
  };
  const a = decide('a');
  const archived = f.call<MemoryRecord>('memory.archive', { memory_id: a.id }, a.revision);
  const b = decide('b');
  expect(() =>
    f.call('memory.undo_retraction', { memory_id: a.id }, archived.revision),
  ).toThrowError(expect.objectContaining({ code: 'memory_budget_exceeded' }));
  expect(f.store.must<MemoryRecord>('memory_records', a.id).state).toBe('archived');
  expect(f.store.must<MemoryRecord>('memory_records', b.id).state).toBe('active');
});

it.each(['expired', 'superseded', 'stale'] as const)(
  'refuses undo of a record archived as %s',
  (reason) => {
    const { f, root, undo } = setup();
    f.store.update('memory_records', { ...root, state: 'archived', reason }, root.revision);
    expect(() => undo()).toThrowError(expect.objectContaining({ code: 'memory_not_retracted' }));
  },
);

it('leaves edited and newly superseded dependents alone and reports each reason', () => {
  const { f, save, root, child, grandchild, retract, undo } = setup();
  retract();
  const archived = f.store.must<MemoryRecord>('memory_records', child.id);
  const edited = f.store.update(
    'memory_records',
    { ...archived, reason: 'expired' },
    archived.revision,
  );
  const replacement = save(grandchild.key);
  expect(undo()).toEqual({
    restored_ids: [root.id],
    skipped: [
      { memory_id: child.id, reason: 'changed' },
      { memory_id: grandchild.id, reason: 'replaced' },
    ],
  });
  expect(f.store.must<MemoryRecord>('memory_records', child.id)).toEqual(edited);
  expect(f.call<any>('memory.get', { memory_id: replacement.id }).state).toBe('active');
});

it.each(['archive', 'undo'] as const)(
  'rolls back a failure in the middle of memory %s including journal events and jobs',
  (operation) => {
    const { f, retract, undo } = setup();
    if (operation === 'undo') retract();
    const records = f.store.list('memory_records');
    const events = f.store.events(0, f.project.id);
    const jobs = f.store.list('memory_jobs');
    const states = f.store.list('memory_states');
    let writes = 0;
    const update = f.store.update.bind(f.store);
    const fail = vi.spyOn(f.store, 'update').mockImplementation((table, value, expected) => {
      const result = update(table, value, expected);
      if (table === 'memory_records' && ++writes === 2)
        throw new Error('interrupted memory change');
      return result;
    });
    expect(() => (operation === 'archive' ? retract() : undo())).toThrow(
      'interrupted memory change',
    );
    fail.mockRestore();
    expect(f.store.list('memory_records')).toEqual(records);
    expect(f.store.events(0, f.project.id)).toEqual(events);
    expect(f.store.list('memory_jobs')).toEqual(jobs);
    expect(f.store.list('memory_states')).toEqual(states);
    const result = operation === 'archive' ? retract() : undo();
    expect(operation === 'archive' ? result.archived_ids : result.restored_ids).toHaveLength(3);
  },
);
