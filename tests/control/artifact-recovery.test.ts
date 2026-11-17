import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ArtifactFiles, Store } from '@pantheon/store';
import { Control } from '@pantheon/control';

const roots: string[] = [];
const stores = new Set<Store>();
function fixture() {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'artifact-recovery-'));
  roots.push(root);
  const files = new ArtifactFiles(path.join(root, 'artifacts'));
  let store: Store;
  const open = () => {
    if (store) {
      store.close();
      stores.delete(store);
    }
    store = new Store(path.join(root, 'control.sqlite'));
    stores.add(store);
    return new Control(store, files, []);
  };
  return {
    files,
    open,
    get store() {
      return store;
    },
    control: open(),
  };
}
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('collects stray artifact files on recover() while retaining event and nested row references', async () => {
  const f = fixture();
  const historical = f.files.put(Buffer.from('Gate check log'));
  const nested = f.files.put(Buffer.from('Nested command log'));
  const orphan = f.files.put(Buffer.from('Unregistered content'));
  const temporary = '.dead-beef.tmp';
  writeFileSync(path.join(f.files.directory, temporary), 'incomplete');
  writeFileSync(path.join(f.files.directory, 'notes.txt'), 'preserve unrelated names');
  const entity = { id: 'retained-session', revision: 1 };
  f.store.event('session.gate_checked', entity, '', { evidence: [{ log_uri: historical.uri }] });
  for (let index = 0; index < 300; index++) f.store.event('history.padding', entity, '', { index });
  f.store.insert('project_fact_versions', { ...entity, evidence: { refs: [nested.uri] } });
  await f.open().recover();
  expect(readdirSync(f.files.directory).sort()).toEqual(
    [historical.hash, nested.hash, 'notes.txt'].sort(),
  );
  const collected = f.store
    .events(0, undefined, 1000)
    .filter((e) => e.kind === 'storage.collected');
  expect(collected).toHaveLength(1);
  expect(collected[0]?.payload).toEqual({
    count: 2,
    names: expect.arrayContaining([orphan.hash, temporary]),
  });
  await f.open().recover();
  expect(f.store.events(0, undefined, 1000).filter((e) => e.kind === 'storage.collected')).toEqual(
    collected,
  );
});

it('caps collected artifact names while recording the full removal count', async () => {
  const f = fixture();
  for (let index = 0; index < 105; index++) f.files.put(Buffer.from(`orphan ${index}`));
  await f.control.recover();
  const payload = f.store.events().find((e) => e.kind === 'storage.collected')?.payload as any;
  expect(payload?.count).toBe(105);
  expect(payload.names).toHaveLength(100);
  expect(readdirSync(f.files.directory)).toEqual([]);
});

it('leaves only a temporary artifact when before_artifact_rename throws', () => {
  const f = fixture();
  f.files.failpoint = (name) => {
    if (name === 'before_artifact_rename') throw new Error('rename interrupted');
  };
  expect(() => f.files.put(Buffer.from('Interrupted candidate'))).toThrow('rename interrupted');
  expect(readdirSync(f.files.directory)).toEqual([expect.stringMatching(/^\.[a-f0-9-]+\.tmp$/)]);
});
