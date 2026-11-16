import { afterEach, expect, it } from 'vitest';
import { Store } from '@pantheon/store';
import type { Session, SessionTurn } from '@pantheon/domain';
import { SessionSearch } from '../../packages/control/src/session-search.js';
import { eventually } from '../helpers.js';

const opened: { index: SessionSearch; store: Store }[] = [];
afterEach(async () => {
  for (const { index, store } of opened.splice(0)) {
    await index.close();
    store.close();
  }
});
function fixture(store = new Store(':memory:')) {
  const index = new SessionSearch(store, 0);
  opened.push({ index, store });
  const session = store.insert<Session>('sessions', {
    id: 'session',
    revision: 1,
    project_id: 'project',
    title: 'Conversation',
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
  });
  const event = (kind: string, aggregate: string, at: number, payload: unknown = {}) =>
    Number(
      store.db
        .prepare(
          'INSERT INTO events(event_id,kind,aggregate_id,aggregate_revision,project_id,causation_id,created_at,payload) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          `event-${Math.random()}`,
          kind,
          aggregate,
          1,
          'project',
          '',
          at,
          JSON.stringify(payload),
        ).lastInsertRowid,
    );
  const turn = (id: string, input: string, origin?: SessionTurn['origin']) =>
    store.insert<SessionTurn>('session_turns', {
      id,
      revision: 1,
      project_id: 'project',
      session_id: session.id,
      kind: 'send',
      input,
      delivery: 'delivered',
      state: 'completed',
      ...(origin ? { origin } : {}),
    });
  const delta = (turn_id: string, text: string, at = 2000) =>
    event('agent.message.delta', session.id, at, { kind: 'message.delta', turn_id, text });
  const hits = (text: string) =>
    index
      .search({ text, limit: 20 })
      .hits.map((hit) => [
        hit.kind,
        hit.kind === 'message' ? `${hit.speaker}:${hit.turn_id}` : '',
        hit.at,
        hit.excerpt,
      ]);
  const ready = () => eventually(() => index.search({ text: 'query', limit: 1 }).indexing_complete);
  return { store, index, session, event, turn, delta, hits, ready };
}
const iso = (ms: number) => new Date(ms).toISOString();

it('appends a streamed reply across updates without repeating earlier text', async () => {
  const f = fixture();
  f.turn('turn', 'Question');
  f.event('turn.queued', 'turn', 1000);
  f.delta('turn', 'Agent nee', 2000);
  await f.ready();
  f.delta('turn', 'dle', 3000);
  await f.ready();
  f.delta('turn', ' done', 4000);
  await f.ready();
  expect(f.hits('needle')).toEqual([['message', 'agent:turn', iso(4000), 'Agent needle done']]);
});

it('orders tied messages as a rebuild would, whichever update added them', async () => {
  const f = fixture();
  f.turn('first', 'needle first');
  f.event('turn.queued', 'first', 1000);
  await f.ready();
  f.turn('second', 'needle second');
  f.event('turn.queued', 'second', 1000);
  await f.ready();
  f.delta('second', 'needle reply second', 1000);
  await f.ready();
  f.delta('first', 'needle reply first', 1000);
  await f.ready();
  expect(f.hits('needle').map((hit) => hit[1])).toEqual([
    'agent:first',
    'agent:second',
    'user:second',
  ]);
});

it('rebuilds a session after events were pruned', async () => {
  const f = fixture();
  f.turn('turn', 'Question');
  f.delta('turn', 'Pruned words', 2000);
  const kept = f.delta('turn', ' kept words', 3000);
  await f.ready();
  f.store.pruneEvents(kept);
  f.store.update('sessions', { ...f.session, title: 'Renamed' }, f.session.revision);
  await f.ready();
  expect(f.hits('Pruned')).toEqual([]);
  expect(f.hits('kept')).toEqual([['message', 'agent:turn', iso(3000), ' kept words']]);
});

it('drops the documents of a removed turn and its events from the session activity', async () => {
  const f = fixture();
  f.turn('kept', 'Kept question');
  f.event('turn.queued', 'kept', 1000);
  const removed = f.turn('removed', 'Removed question');
  f.event('turn.queued', 'removed', 5000);
  await f.ready();
  expect(f.hits('Conversation')).toEqual([['title', '', iso(5000), 'Conversation']]);
  f.store.remove('session_turns', removed.id, removed.revision);
  await f.ready();
  expect(f.hits('Removed')).toEqual([]);
  expect(f.hits('Conversation')).toEqual([['title', '', iso(1000), 'Conversation']]);
});

it('finds a reply streamed before its turn joined the session', async () => {
  const f = fixture();
  f.turn('turn', 'Question');
  f.delta('late', 'Early reply', 2000);
  await f.ready();
  expect(f.hits('Early')).toEqual([]);
  f.turn('late', 'Late question');
  await f.ready();
  expect(f.hits('Early')).toEqual([['message', 'agent:late', iso(2000), 'Early reply']]);
});

it('uses the queue time recorded before a new turn joined the session', async () => {
  const f = fixture();
  f.turn('turn', 'Question');
  f.event('turn.queued', 'late', 3000);
  await f.ready();
  f.turn('late', 'Late question');
  await f.ready();
  expect(f.hits('Late')).toEqual([['message', 'user:late', iso(3000), 'Late question']]);
});

it('uses the queue time of a known turn whose input becomes searchable', async () => {
  const f = fixture();
  const tracked = f.turn('tracked', 'Tracker note', 'tracker');
  f.event('turn.queued', 'tracked', 3000);
  await f.ready();
  expect(f.hits('Tracker')).toEqual([]);
  const { origin: _, ...plain } = tracked;
  f.store.update('session_turns', plain, tracked.revision);
  await f.ready();
  expect(f.hits('Tracker')).toEqual([['message', 'user:tracked', iso(3000), 'Tracker note']]);
});

it('upgrades an index written without message positions', async () => {
  const store = new Store(':memory:');
  store.db.exec(`
    CREATE TABLE session_search_documents (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
      turn_id TEXT, speaker TEXT, body TEXT NOT NULL, folded TEXT NOT NULL,
      pairs TEXT NOT NULL, at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX session_search_order ON session_search_documents(
      (kind='message'), at DESC, session_id, kind DESC, id DESC
    );
  `);
  const f = fixture(store);
  f.turn('turn', 'Upgraded question');
  await f.ready();
  expect(f.hits('Upgraded')).toEqual([['message', 'user:turn', iso(0), 'Upgraded question']]);
  expect(
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='session_search_order'").get(),
  ).toBeUndefined();
});
