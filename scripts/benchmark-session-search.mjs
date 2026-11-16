import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { SessionSearch } from '../packages/control/dist/session-search.js';

// The production store's source tables; no adapters or native agent histories are needed.
const cache = path.resolve('node_modules/.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(path.join(cache, 'session-search-benchmark-'));
const db = new DatabaseSync(path.join(root, 'history.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
db.exec(`
  CREATE TABLE sessions(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
  CREATE TABLE session_turns(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
  CREATE TABLE workspaces(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
  CREATE TABLE events(sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, aggregate_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
  CREATE INDEX events_aggregate ON events(aggregate_id, sequence);
`);
const insertSession = db.prepare('INSERT INTO sessions VALUES(?,1,?)');
const insertTurn = db.prepare('INSERT INTO session_turns VALUES(?,1,?)');
const insertEvent = db.prepare(
  'INSERT INTO events(kind,aggregate_id,created_at,payload) VALUES(?,?,?,?)',
);
db.exec('BEGIN');
for (let session = 0; session < 200; session++) {
  const id = `session-${session}`;
  insertSession.run(
    id,
    JSON.stringify({
      id,
      title: `Search history ${session}`,
      project_id: `project-${session % 2}`,
      runtime: 'fixture',
      state: 'open',
    }),
  );
  for (let turn = 0; turn < 100; turn++) {
    const turnId = `${id}-turn-${turn}`;
    const text = `Message ${turn}: investigate searchable text and 搜索 results. ${'Conversation context. '.repeat(20)}`;
    insertTurn.run(turnId, JSON.stringify({ id: turnId, session_id: id, input: text }));
    insertEvent.run('turn.queued', turnId, turn, '{}');
    insertEvent.run('agent.message.delta', id, turn, JSON.stringify({ turn_id: turnId, text }));
  }
}
db.exec('COMMIT');
const index = new SessionSearch({
  db,
  transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
});
try {
  const query = (text, project_id) => index.search({ text, project_id, limit: 20 });
  assert.equal(query('searchable').indexing_complete, false);
  const deadline = performance.now() + 60000;
  while (!query('').indexing_complete) {
    assert.ok(performance.now() < deadline, 'Background indexing did not finish within a minute');
    await sleep(10);
  }
  const samples = [];
  for (const text of [
    'searchable',
    '搜索',
    'SEARCHABLE',
    'history',
    'missing phrase',
    'me',
    '罕见',
    'zz',
  ]) {
    const start = performance.now();
    const result = query(text);
    const ms = performance.now() - start;
    samples.push({ text, ms: Number(ms.toFixed(2)) });
    assert.equal(result.hits.length, ['missing phrase', '罕见', 'zz'].includes(text) ? 0 : 20);
    for (const hit of result.hits)
      assert.equal(
        hit.excerpt.slice(hit.match.start, hit.match.start + hit.match.length).toLowerCase(),
        text.toLowerCase(),
      );
    assert.ok(ms < 100, `${JSON.stringify(text)} took ${ms.toFixed(2)} ms`);
  }
  console.log(
    JSON.stringify({
      sessions: 200,
      messages: 40000,
      samples,
      max_ms: Math.max(...samples.map((sample) => sample.ms)),
    }),
  );
} finally {
  await index.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
