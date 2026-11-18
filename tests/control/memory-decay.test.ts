import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { MemoryRecord, Principal } from '@pantheon/domain';
import { workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';
import { syncMemoryFiles } from '../../packages/control/src/memory.js';

const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const f = await workbenchFixture();
  const s = await f.create();
  const start = f.store.now();
  let now = start;
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const day = (n: number) => (now = start + n * DAY);
  const agent: Principal = {
    id: 'agent',
    role: 'lead',
    session_id: s.id,
    project_id: f.project.id,
    expires_at: start + 1000 * DAY,
  };
  const propose = (
    key: string,
    kind: 'note' | 'decision',
    principal: Principal = agent,
    tags?: string[],
  ) =>
    f.call<MemoryRecord>(
      'memory.propose',
      {
        project_id: f.project.id,
        key,
        kind,
        text: `${key} text`,
        ...(tags && { tags }),
        based_on: f.call<{ signature: string }>(
          'memory.context',
          { project_id: f.project.id },
          null,
          principal,
        ).signature,
      },
      null,
      principal,
    );
  const current = () =>
    f
      .call<{ items: MemoryRecord[] }>('memory.context', { project_id: f.project.id })
      .items.map((r) => r.id);
  const stored = (id: string) => f.store.must<MemoryRecord>('memory_records', id);
  return { f, agent, day, propose, current, stored };
}

it('archives an agent note nobody read for 90 days as expired and keeps it searchable', async () => {
  const { f, day, propose, current, stored } = await setup();
  const note = propose('build-cache', 'note');
  expect(current()).toEqual([note.id]);
  day(91);
  expect(current()).toEqual([]);
  expect(f.control.memoryRead(user, f.project.id, { state: 'archived' }).records[0]).toMatchObject({
    id: note.id,
    reason: 'expired',
  });
  await f.control.tick();
  expect(stored(note.id)).toMatchObject({ state: 'archived', reason: 'expired' });
  expect(
    f
      .call<{ items: MemoryRecord[] }>('memory.search', {
        project_id: f.project.id,
        q: 'build-cache',
        state: 'archived',
      })
      .items.map((r) => r.id),
  ).toEqual([note.id]);
});

it('keeps a note current for 90 days after a session last read it', async () => {
  const { f, agent, day, propose, current } = await setup();
  const note = propose('build-cache', 'note');
  day(80);
  f.call('memory.get', { memory_id: note.id }, null, agent);
  day(120);
  expect(current()).toEqual([note.id]);
});

it('never fades decisions, handoff notes or imported notes', async () => {
  const { f, day, propose, current } = await setup();
  const own = propose('database', 'decision', user);
  f.call('memory.commit', { memory_id: own.id }, own.revision);
  const proposed = propose('framework', 'decision');
  f.call('memory.commit', { memory_id: proposed.id }, proposed.revision);
  const handoff = propose('handoff', 'note', undefined, ['handoff']);
  const memory = path.join(
    f.protectionPaths.home,
    '.claude/projects',
    f.source.replace(/[^a-zA-Z0-9]/g, '-'),
    'memory',
  );
  mkdirSync(memory, { recursive: true });
  writeFileSync(path.join(memory, 'gate.md'), 'Run gates on ws.');
  syncMemoryFiles((f.control as any).ctx, f.store.must<any>('projects', f.project.id));
  const imported = f.store
    .list<MemoryRecord>('memory_records')
    .find((r) => r.key === 'import:root0/claude-memory/gate.md' && r.state === 'active')!;
  expect(imported.authority).toBe('agent_reported');
  day(200);
  expect(current().sort()).toEqual([own.id, proposed.id, handoff.id, imported.id].sort());
});

it('moves the revision of a note at most once a day when sessions read it', async () => {
  const { f, agent, day, propose, stored } = await setup();
  const note = propose('build-cache', 'note');
  const before = stored(note.id).revision;
  day(1);
  f.call('memory.get', { memory_id: note.id }, null, agent);
  expect(stored(note.id)).toMatchObject({ revision: before + 1, last_used_at: f.store.now() });
  f.call('memory.get', { memory_id: note.id }, null, agent);
  f.call('memory.get', { memory_id: note.id });
  expect(stored(note.id).revision).toBe(before + 1);
});
