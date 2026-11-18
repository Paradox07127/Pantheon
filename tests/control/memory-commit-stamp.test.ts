import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { MemoryRecord, Principal } from '@pantheon/domain';
import { git, workbenchFixture } from './workbench-fixture.js';

async function setup() {
  const f = await workbenchFixture();
  const s = await f.create();
  const agent: Principal = {
    id: 'agent',
    role: 'lead',
    session_id: s.id,
    project_id: f.project.id,
    expires_at: f.store.now() + 60_000,
  };
  const propose = async (key: string, references?: { kind: 'file' | 'url'; uri: string }[]) => {
    const r = await f.call<MemoryRecord | Promise<MemoryRecord>>(
      'memory.propose',
      {
        project_id: f.project.id,
        key,
        kind: 'note',
        text: `${key} text`,
        ...(references && { references }),
        based_on: f.call<{ signature: string }>(
          'memory.context',
          { project_id: f.project.id },
          null,
          agent,
        ).signature,
      },
      null,
      agent,
    );
    return f.store.must<MemoryRecord>('memory_records', r.id);
  };
  return { f, propose, root: f.project.roots[0]! };
}

it('stores the HEAD commit of the project on an agent note with a file reference', async () => {
  const { propose, root } = await setup();
  const note = await propose('answer-file', [{ kind: 'file', uri: 'answer.txt' }]);
  expect(note.verified_commit).toBe(git(root, 'rev-parse', 'HEAD').toString().trim());
  expect(note.state).toBe('active');
});

it('stores no commit on an agent note without a file reference', async () => {
  const { propose } = await setup();
  expect((await propose('plain')).verified_commit).toBeUndefined();
  const linked = await propose('linked', [{ kind: 'url', uri: 'https://example.com/guide' }]);
  expect(linked.verified_commit).toBeUndefined();
});

it('stores no commit when the project root is not a git folder and still activates the note', async () => {
  const { propose, root } = await setup();
  rmSync(path.join(root, '.git'), { recursive: true, force: true });
  // An empty .git keeps git from finding a repository around the test folder.
  mkdirSync(path.join(root, '.git'));
  const note = await propose('answer-file', [{ kind: 'file', uri: 'answer.txt' }]);
  expect(note.verified_commit).toBeUndefined();
  expect(note.state).toBe('active');
});
