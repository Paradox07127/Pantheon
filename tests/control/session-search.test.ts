import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { Store } from '@pantheon/store';
import type { Session, SessionTurn, Workspace } from '@pantheon/domain';
import { SessionSearch } from '../../packages/control/src/session-search.js';
import { eventually } from '../helpers.js';

const opened: { index: SessionSearch; store: Store }[] = [];
afterEach(async () => {
  for (const { index, store } of opened.splice(0)) {
    await index.close();
    store.close();
  }
});
function fixture(store = new Store(':memory:'), reindexGapMs = 0) {
  const index = new SessionSearch(store, reindexGapMs);
  opened.push({ index, store });
  const session = (id: string, title = 'Conversation', project_id = 'project') =>
    store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id,
      title,
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    });
  const message = (session: Session, id: string, text: string, at: number) => {
    const turn = store.insert<SessionTurn>('session_turns', {
      id,
      revision: 1,
      project_id: session.project_id,
      session_id: session.id,
      kind: 'send',
      input: text,
      delivery: 'delivered',
      state: 'completed',
    });
    store.db
      .prepare(
        'INSERT INTO events(event_id,kind,aggregate_id,aggregate_revision,project_id,causation_id,created_at,payload) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(`queued-${id}`, 'turn.queued', id, 1, session.project_id, '', at, '{}');
    return turn;
  };
  const agent = (session: Session, turn: SessionTurn, text: string) =>
    store.event('agent.message.delta', session, session.project_id, {
      kind: 'message.delta',
      turn_id: turn.id,
      text,
    });
  const search = (text: string, project_id?: string, limit = 20) =>
    index.search({ text, project_id, limit });
  const ready = () => eventually(() => search('query').indexing_complete);
  return { store, index, session, message, agent, search, ready };
}

it('finds titles, branches, user input and assembled agent replies but excludes tools and thinking', async () => {
  const f = fixture();
  const root = mkdtempSync(path.resolve('search-branch-'));
  try {
    expect(
      spawnSync('git', ['init', '--quiet', '--initial-branch=branch-needle'], { cwd: root }).status,
    ).toBe(0);
    const session = f.session('session', 'Title needle');
    f.store.insert<Workspace>('workspaces', {
      id: 'workspace',
      revision: 1,
      project_id: session.project_id,
      path: root,
      kind: 'in_place',
      owner: 'user',
      ownership_epoch: 1,
    });
    f.store.update('sessions', { ...session, workspace_id: 'workspace' }, session.revision);
    const turn = f.message(session, 'turn', 'User needle', 1000);
    f.agent(session, turn, 'Agent nee');
    f.agent(session, turn, 'dle');
    f.store.event('agent.tool.started', session, session.project_id, { input: 'tool-secret' });
    f.store.event('agent.tool.completed', session, session.project_id, { output: 'tool-secret' });
    f.store.event('agent.reasoning', session, session.project_id, { text: 'thinking-secret' });
    await f.ready();
    expect(f.search('needle').hits.map((hit) => hit.kind)).toEqual([
      'title',
      'branch',
      'message',
      'message',
    ]);
    expect(f.search('User needle').hits[0]).toMatchObject({
      session_id: session.id,
      project_id: session.project_id,
      title: session.title,
      kind: 'message',
      turn_id: turn.id,
      speaker: 'user',
      at: new Date(1000).toISOString(),
      archived: false,
    });
    expect(f.search('Agent needle').hits[0]).toMatchObject({
      turn_id: turn.id,
      speaker: 'agent',
    });
    expect(f.search('tool-secret').hits).toEqual([]);
    expect(f.search('thinking-secret').hits).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('returns a centered excerpt with UTF-16 match offsets, ignores case and finds two Chinese characters', async () => {
  const f = fixture(),
    session = f.session('session');
  const text = '😀'.repeat(80) + 'MiXeD 搜索匹配' + ' suffix'.repeat(40);
  f.message(session, 'turn', text, 1000);
  await f.ready();
  for (const query of ['mixed', '搜索', 'MI', '匹配']) {
    const hit = f.search(query).hits[0]!;
    expect(hit.excerpt.length).toBeLessThanOrEqual(122);
    expect(
      hit.excerpt.slice(hit.match.start, hit.match.start + hit.match.length).toLowerCase(),
    ).toBe(query.toLowerCase());
  }
  expect(f.search(' ').hits).toEqual([]);
  expect(f.search('x').hits).toEqual([]);
});

it('orders metadata before messages and newest first, caps each kind and filters projects including archived sessions', async () => {
  const f = fixture(),
    older = f.session('older', 'Needle old'),
    newer = f.session('newer', 'Needle new', 'other');
  f.store.update(
    'sessions',
    { ...older, archived_at: new Date(1000).toISOString() },
    older.revision,
  );
  for (let i = 0; i < 5; i++) f.message(older, `old-${i}`, 'needle', 1000 + i);
  f.message(newer, 'new', 'needle', 2000);
  await f.ready();
  const hits = f.search('needle').hits;
  expect(
    hits.map((hit) => [hit.session_id, hit.kind, hit.kind === 'message' ? hit.turn_id : undefined]),
  ).toEqual([
    ['newer', 'title', undefined],
    ['older', 'title', undefined],
    ['newer', 'message', 'new'],
    ['older', 'message', 'old-4'],
    ['older', 'message', 'old-3'],
    ['older', 'message', 'old-2'],
  ]);
  expect(f.search('needle', 'project').hits).toHaveLength(4);
  expect(f.search('needle', 'project').hits.every((hit) => hit.archived)).toBe(true);
  expect(f.search('needle', undefined, 2).hits).toEqual(hits.slice(0, 2));
});

it('reports pending indexing and follows new messages, renames, deletion and transaction rollback', async () => {
  const f = fixture(),
    session = f.session('session', 'Original title');
  expect(f.search('Original').indexing_complete).toBe(false);
  await f.ready();
  expect(f.search('Original').hits).toHaveLength(1);
  const turn = f.message(session, 'new', 'Fresh message', 1000);
  f.agent(session, turn, 'Fresh reply');
  f.store.update('sessions', { ...session, title: 'Renamed title' }, session.revision);
  await f.ready();
  expect(f.search('Fresh').hits).toHaveLength(2);
  expect(f.search('Original').hits).toEqual([]);
  expect(f.search('Renamed').hits).toHaveLength(1);
  expect(() =>
    f.store.transaction(() => {
      f.store.remove('sessions', session.id, 2);
      throw new Error('rollback');
    }),
  ).toThrow('rollback');
  expect(f.search('Fresh').hits).toHaveLength(2);
  f.store.remove('sessions', session.id, 2);
  expect(f.search('Fresh').hits).toEqual([]);
});

it('backfills existing data without blocking the constructor and catches changes made while closed', async () => {
  const store = new Store(':memory:');
  store.insert<Session>('sessions', {
    id: 'existing',
    revision: 1,
    project_id: 'project',
    title: 'Historical title',
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
  });
  const turn = store.insert<SessionTurn>('session_turns', {
    id: 'historical-turn',
    revision: 1,
    project_id: 'project',
    session_id: 'existing',
    input: 'Historical user input',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
  });
  store.event('agent.message.delta', { id: 'existing', revision: 1 }, 'project', {
    kind: 'message.delta',
    turn_id: turn.id,
    text: 'Historical agent reply',
  });
  const f = fixture(store);
  expect(f.search('Historical')).toEqual({ hits: [], indexing_complete: false });
  await f.ready();
  expect(f.search('Historical').hits).toHaveLength(3);
  await f.index.close();
  const session = store.must<Session>('sessions', 'existing');
  store.update('sessions', { ...session, title: 'Offline rename' }, session.revision);
  const next = fixture(store);
  opened.splice(
    opened.findIndex((entry) => entry.index === f.index),
    1,
  );
  const cached = next.search('Historical');
  expect(cached.indexing_complete).toBe(false);
  expect(cached.hits).toHaveLength(3);
  expect(cached.hits[0]).toMatchObject({ kind: 'title', session_id: 'existing' });
  await next.ready();
  expect(next.search('Offline').hits).toHaveLength(1);
  expect(next.search('Historical').hits.map((hit) => hit.kind)).toEqual(['message', 'message']);
});

it('waits before indexing a session again while its reply keeps streaming', async () => {
  const f = fixture(undefined, 1000),
    session = f.session('session'),
    turn = f.message(session, 'turn', 'Question', 1000);
  await f.ready();
  f.agent(session, turn, 'Streamed reply');
  await sleep(100);
  expect(f.search('Streamed')).toEqual({ hits: [], indexing_complete: false });
  await f.ready();
  expect(f.search('Streamed').hits).toHaveLength(1);
});
