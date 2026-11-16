import { expect, it, vi } from 'vitest';
import { workbenchFixture } from './workbench-fixture.js';
import { user } from '../helpers.js';
import type { MemorySummary } from '@pantheon/domain';
import path from 'node:path';
import { Store } from '@pantheon/store';
import { backfillMemoryIndex, indexMemory } from '../../packages/control/dist/memory-catalog.js';

function catalogFixture() {
  const f = workbenchFixture();
  const save = (key: string, text: string, extra: Record<string, unknown> = {}, commit = true) => {
    const draft = f.call<any>('memory.propose', {
      project_id: f.project.id,
      kind: 'note',
      key,
      text,
      ...extra,
    });
    return commit ? f.call<any>('memory.commit', { memory_id: draft.id }, draft.revision) : draft;
  };
  const directory = (filters: Record<string, unknown> = {}) =>
    (f.control as any).memoryRead(user, f.project.id, filters);
  return { ...f, save, directory };
}

/** A new Store on the fixture's database, as a daemon that starts on an older database opens it. */
const openedAgain = (f: ReturnType<typeof catalogFixture>) =>
  new Store(path.join(f.root, 'state/control.sqlite'));

it('pages a metadata-only directory and reads one selected version on demand', () => {
  const f = catalogFixture();
  for (let i = 0; i < 5; i++)
    f.save('note-' + i, 'Long body '.repeat(500), { title: 'Record ' + i, tags: ['manual'] });
  const valid = vi.spyOn(f.control.files, 'valid');
  const page = f.directory({ limit: 2 });
  expect(page.records).toHaveLength(2);
  expect(page.records[0]).not.toHaveProperty('text');
  expect(valid).not.toHaveBeenCalled();
  const next = f.directory({ limit: 2, cursor: page.next_cursor });
  expect(new Set([...page.records, ...next.records].map((r: any) => r.id)).size).toBe(4);
  const detail = (f.control as any).memoryItem(user, f.project.id, page.records[0].id);
  expect(detail.text).toBe('Long body '.repeat(500));
  expect(valid).toHaveBeenCalledTimes(1);
});

it('searches short Chinese text and exact metadata without opening artifact bodies', () => {
  const f = catalogFixture();
  const wanted = f.save('storage-rule', '项目数据库使用本地 SQLite，旧版本保留供审计。', {
    title: '数据存储',
    summary: '本地数据库与审计',
    tags: ['数据库', 'manual'],
  });
  f.save('unrelated', 'Remote rendering notes');
  const valid = vi.spyOn(f.control.files, 'valid');
  for (const q of ['库', '数据库', 'SQLite', 'storage-rule', '数据存储']) {
    const result = f.call<any>('memory.search', { project_id: f.project.id, q });
    expect(result.items[0].id).toBe(wanted.id);
    expect(result.items[0].reasons.length).toBeGreaterThan(0);
    expect(result.items[0]).not.toHaveProperty('text');
  }
  expect(valid).not.toHaveBeenCalled();
  expect(
    f.call<any>('memory.search', { project_id: f.project.id, q: '', tag: 'missing' }).items,
  ).toEqual([]);
});

it('uses one current-state gate for directory, graph, reverse dependencies and historical access', () => {
  const f = catalogFixture();
  const a = f.save('storage', 'Original decision', { kind: 'decision' });
  const dependent = f.save('analysis', 'Derived note', { dependencies: [a.id] });
  const replacement = f.save('storage', 'Replacement decision', { kind: 'decision' });
  expect(f.directory().records.map((r: any) => r.id)).toEqual([replacement.id]);
  const related = f.call<any>('memory.related' as any, {
    project_id: f.project.id,
    memory_id: replacement.id,
  });
  expect(related.items.map((r: any) => r.id)).not.toContain(a.id);
  const history = (f.control as any).memoryGraph(user, {
    project_id: f.project.id,
    memory_id: replacement.id,
    state: 'all',
    depth: 2,
  });
  expect(
    history.edges.some(
      (e: any) => e.kind === 'supersedes' && e.from === replacement.id && e.to === a.id,
    ),
  ).toBe(true);
  expect(history.nodes.some((n: any) => n.id === dependent.id && n.state === 'archived')).toBe(
    true,
  );
  const s = f.create();
  const p = {
    id: 'agent',
    role: 'lead' as const,
    session_id: s.id,
    project_id: f.project.id,
    expires_at: Date.now() + 60000,
  };
  expect(() =>
    f.call(
      'memory.related' as any,
      { project_id: f.project.id, memory_id: replacement.id, state: 'all' },
      null,
      p,
    ),
  ).toThrow();
});

it('bounds the graph and keeps shared tags as optional tag nodes, not dependency edges', () => {
  const f = catalogFixture();
  const a = f.save('root', 'Root note', { tags: ['shared'] });
  for (let i = 0; i < 12; i++)
    f.save('child-' + i, 'Related note', { dependencies: [a.id], tags: ['shared'] });
  const graph = (f.control as any).memoryGraph(user, {
    project_id: f.project.id,
    memory_id: a.id,
    depth: 2,
    max_nodes: 5,
    include_tags: true,
  });
  expect(graph.nodes.length).toBeLessThanOrEqual(5);
  expect(graph.truncated).toBe(true);
  expect(
    graph.edges.every(
      (e: any) =>
        graph.nodes.some((n: any) => n.id === e.from) &&
        graph.nodes.some((n: any) => n.id === e.to),
    ),
  ).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(48000);
  const tags = f.call<any>('memory.related' as any, {
    project_id: f.project.id,
    memory_id: a.id,
    relation: 'tag',
  });
  expect(tags.items[0].reasons).toContain('shared_tag:shared');
});

it('rejects stale pagination after replacement and never mixes directory generations', () => {
  const f = catalogFixture();
  const first = f.save('versioned', 'before');
  f.save('second', 'other');
  const page = f.directory({ limit: 1 });
  f.save('versioned', 'after');
  expect(() => f.directory({ limit: 1, cursor: page.next_cursor })).toThrowError(
    expect.objectContaining({ code: 'revision_conflict' }),
  );
  expect(f.directory().records.map((r: any) => r.id)).not.toContain(first.id);
});

it('backfills legacy archived text in bounded batches even behind corrupt bodies', async () => {
  const { unlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = catalogFixture();
  for (let i = 0; i < 17; i++) {
    const r = f.save('corrupt-' + i, 'unique corrupt text ' + i);
    f.call('memory.archive', { memory_id: r.id }, r.revision);
    unlinkSync(join(f.control.files.directory, r.body_hash));
  }
  const valid = f.save('legacy', '历史数据库索引', {}, false);
  f.store.db.prepare('DELETE FROM memory_search').run();
  expect(f.directory({ state: 'all' }).index_pending).toBe(18);
  const read = vi.spyOn(f.control.files, 'valid');
  expect(f.directory({ state: 'draft' }).records[0]).toMatchObject({
    title: 'legacy',
    summary: '',
    tags: [],
    indexed: false,
  });
  expect(read).not.toHaveBeenCalled();
  await f.control.tick();
  await f.control.tick();
  expect(
    f.call<any>('memory.search', { project_id: f.project.id, state: 'draft', q: '数据库' }).items[0]
      .id,
  ).toBe(valid.id);
  expect(f.directory({ state: 'all' }).index_pending).toBe(17);
  expect(f.call<any>('memory.search', { project_id: f.project.id, q: '数据库' }).items).toEqual([]);
});

it('skips idle index passes and finds missing rows by lookup however many versions exist', () => {
  const f = catalogFixture();
  const seed = f.store.must<any>('memory_records', f.save('seed', 'Seed body').id);
  const ctx = (f.control as any).ctx;
  f.store.transaction(() => {
    for (let i = 0; i < 3000; i++) f.store.insert('memory_records', { ...seed, id: 'bulk-' + i });
    f.store.db
      .prepare(
        "INSERT INTO memory_search(rowid,id,body) SELECT rowid,id,'bulk' FROM memory_records WHERE id LIKE 'bulk-%'",
      )
      .run();
  });
  backfillMemoryIndex(ctx);
  const prepare = vi.spyOn(f.store.db, 'prepare');
  for (let i = 0; i < 5; i++) expect(backfillMemoryIndex(ctx)).toBe(0);
  expect(prepare.mock.calls.filter(([sql]) => sql.includes('memory_search'))).toEqual([]);
  prepare.mockRestore();
  f.save('later', 'Later body');
  const started = performance.now();
  expect(backfillMemoryIndex(ctx)).toBe(0);
  expect(performance.now() - started).toBeLessThan(150);
});

it('rekeys search rows that do not share their record rowid without rereading bodies', () => {
  const f = catalogFixture();
  const saved = ['alpha', 'beta', 'gamma'].map((key) => f.save(key, key + ' recorded text'));
  const db = f.store.db;
  const rows = db.prepare('SELECT id, body FROM memory_search ORDER BY rowid').all();
  db.prepare('DELETE FROM memory_search').run();
  rows
    .reverse()
    .forEach((row, i) =>
      db
        .prepare('INSERT INTO memory_search(rowid,id,body) VALUES(?,?,?)')
        .run(100 + i, String(row.id), String(row.body)),
    );
  const read = vi.spyOn(f.control.files, 'valid');
  const opened = openedAgain(f);
  try {
    backfillMemoryIndex({ ...(f.control as any).ctx, store: opened });
  } finally {
    opened.close();
  }
  expect(read).not.toHaveBeenCalled();
  expect(
    db
      .prepare(
        'SELECT count(*) AS n FROM memory_search f JOIN memory_records r ON r.rowid=f.rowid AND r.id=f.id',
      )
      .get(),
  ).toEqual({ n: 3 });
  expect(db.prepare('SELECT count(*) AS n FROM memory_search').get()).toEqual({ n: 3 });
  expect(
    f
      .call<any>('memory.search', { project_id: f.project.id, q: 'beta' })
      .items.map((r: any) => r.id),
  ).toEqual([saved[1].id]);
  expect(f.directory({ state: 'all' }).index_pending).toBe(0);
});

it('keeps the search rows of other memories when a memory is written before older rows are rekeyed', () => {
  const f = catalogFixture();
  const [bravo, charlie] = [
    f.save('second', 'Bravo recorded text'),
    f.save('third', 'Charlie recorded text'),
  ];
  const db = f.store.db;
  const position = (id: string) =>
    Number(db.prepare('SELECT rowid AS n FROM memory_records WHERE id=?').get(id)!.n);
  // An older row of one memory sits at the rowid of another.
  const rows = db.prepare('SELECT id, body FROM memory_search').all();
  db.prepare('DELETE FROM memory_search').run();
  for (const row of rows)
    db.prepare('INSERT INTO memory_search(rowid,id,body) VALUES(?,?,?)').run(
      row.id === bravo.id ? position(charlie.id) : 1000,
      String(row.id),
      String(row.body),
    );
  const opened = openedAgain(f);
  try {
    indexMemory(
      { ...(f.control as any).ctx, store: opened },
      f.store.must<any>('memory_records', charlie.id),
      'Charlie recorded text',
    );
  } finally {
    opened.close();
  }
  const search = (q: string) =>
    f.call<any>('memory.search', { project_id: f.project.id, q }).items.map((r: any) => r.id);
  expect(search('Bravo')).toEqual([bravo.id]);
  expect(search('Charlie')).toEqual([charlie.id]);
});

it('preserves authoritative file references and reports changed or unavailable originals', async () => {
  const { writeFileSync, symlinkSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = catalogFixture();
  const r = f.save('manual', 'Reviewed manual excerpt', {
    references: [
      { kind: 'file', uri: 'answer.txt' },
      { kind: 'url', uri: 'https://example.com/manual' },
    ],
  });
  expect(
    (f.control.memoryItem(user, f.project.id, r.id) as any).reference_status.map(
      (s: any) => s.status,
    ),
  ).toEqual(['unchanged', 'unverified']);
  writeFileSync(join(f.source, 'answer.txt'), 'x'.repeat(2_000_001));
  expect((f.control.memoryItem(user, f.project.id, r.id) as any).reference_status[0].status).toBe(
    'changed',
  );
  expect(f.call<any>('memory.get', { memory_id: r.id }).text).toBe('Reviewed manual excerpt');
  symlinkSync(f.root, join(f.source, 'escape'));
  expect(() =>
    f.save('outside', 'Bad source', {
      references: [{ kind: 'file', uri: 'escape/state/control.sqlite' }],
    }),
  ).toThrowError(expect.objectContaining({ code: 'scope_violation' }));
  expect(() =>
    f.save('missing', 'Bad source', { references: [{ kind: 'file', uri: 'missing.md' }] }),
  ).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
});

it('follows reverse dependencies and restoration identity while keeping tags noncausal', () => {
  const f = catalogFixture();
  const root = f.save('root', 'Independent source', { tags: ['shared'] });
  const child = f.save('child', 'Dependent result', { dependencies: [root.id] });
  const unrelated = f.save('unrelated', 'Same topic only', { tags: ['shared'] });
  const related = f.call<any>('memory.related', {
    project_id: f.project.id,
    memory_id: root.id,
    relation: 'dependent',
  });
  expect(related.items.map((r: any) => r.id)).toEqual([child.id]);
  expect(related.items[0].reasons).toContain('dependent:depends_on');
  const graph = f.control.memoryGraph(user, {
    project_id: f.project.id,
    memory_id: root.id,
    include_tags: true,
  });
  expect(graph.nodes.some((n) => n.id === unrelated.id)).toBe(false);
  expect(graph.nodes.some((n) => n.kind === 'tag')).toBe(true);
  f.call('memory.archive', { memory_id: root.id }, root.revision);
  const restored = f.call<any>(
    'memory.restore',
    { memory_id: root.id },
    f.store.must<any>('memory_records', root.id).revision,
  );
  const history = f.control.memoryGraph(user, {
    project_id: f.project.id,
    memory_id: restored.id,
    state: 'all',
  });
  expect(
    history.edges.some(
      (e) => e.from === restored.id && e.to === root.id && e.kind === 'restored_from',
    ),
  ).toBe(true);
  expect(() =>
    f.call('memory.related', { project_id: f.project.id, memory_id: restored.id }),
  ).toThrow();
});

it('rechecks related-read retries and refuses to erase dependency evidence during restoration', async () => {
  const { command } = await import('@pantheon/protocol');
  const f = catalogFixture();
  const root = f.save('root', 'Source');
  const child = f.save('child', 'Derived conclusion', { dependencies: [root.id] });
  const request = command(user.id, 'memory.related', {
    project_id: f.project.id,
    memory_id: root.id,
  });
  expect((f.control.execute(user, request) as any).items.map((r: any) => r.id)).toEqual([child.id]);
  f.call('memory.archive', { memory_id: child.id }, child.revision);
  expect((f.control.execute(user, request) as any).items).toEqual([]);
  f.call('memory.archive', { memory_id: root.id }, root.revision);
  const draft = f.call<any>(
    'memory.restore',
    { memory_id: child.id },
    f.store.must<any>('memory_records', child.id).revision,
  );
  expect(draft.dependencies).toEqual([root.id]);
  expect(() => f.call('memory.commit', { memory_id: draft.id }, draft.revision)).toThrowError(
    expect.objectContaining({ code: 'invalid_state' }),
  );
});

it('uses existing source-session identity only within the same project without opening artifacts', () => {
  const f = catalogFixture();
  const r = f.save('analysis', 'Observed outcome');
  const s = f.create();
  f.store.update('sessions', { ...s, runtime_review: { memory_id: r.id } } as any, s.revision);
  f.store.insert('sessions', {
    ...s,
    id: 'other-project-session',
    project_id: 'other-project',
    runtime_review: { memory_id: r.id },
  } as any);
  const valid = vi.spyOn(f.control.files, 'valid');
  const graph = f.control.memoryGraph(user, { project_id: f.project.id, memory_id: r.id });
  expect(graph.nodes.some((n) => n.id === 'session:' + s.id)).toBe(true);
  expect(graph.nodes.some((n) => n.id === 'session:other-project-session')).toBe(false);
  expect(valid).not.toHaveBeenCalled();
});

it('keeps a connected neighborhood when dense graphs hit edge and byte limits', () => {
  const f = catalogFixture();
  const ids: string[] = [];
  for (let i = 0; i < 41; i++)
    ids.push(
      f.save('dense-' + i, 'Evidence ' + i, {
        title: '图'.repeat(158) + i,
        dependencies: ids.slice(-32),
        references: [{ kind: 'url', uri: 'https://example.com/source-' + i }],
      }).id,
    );
  const graph = f.control.memoryGraph(user, {
    project_id: f.project.id,
    memory_id: ids.at(-1),
    depth: 2,
    max_nodes: 80,
  });
  expect(graph.truncated).toBe(true);
  expect(graph.edges.length).toBeLessThanOrEqual(160);
  expect(Buffer.byteLength(JSON.stringify(graph))).toBeLessThanOrEqual(48000);
  const reached = new Set([ids.at(-1)]);
  for (let i = 0; i < graph.nodes.length; i++)
    for (const edge of graph.edges) {
      if (reached.has(edge.from)) reached.add(edge.to);
      if (reached.has(edge.to)) reached.add(edge.from);
    }
  expect(graph.nodes.every((n) => reached.has(n.id))).toBe(true);
  expect(() =>
    f.control.memoryGraph(user, { project_id: f.project.id, memory_id: ids[0], depth: 3 }),
  ).toThrow();
});

it('graphs all filtered project records and counts nodes before truncation', () => {
  const f = catalogFixture();
  for (let i = 0; i < 85; i++)
    f.save('project-note-' + i, 'Project evidence', { tags: ['project'] });
  f.save('unmatched', 'Other evidence', { kind: 'decision' });
  f.save('draft', 'Unconfirmed evidence', { tags: ['project'] }, false);
  const input = { project_id: f.project.id, tag: 'project', q: 'evidence', kind: 'note' };
  const graph = f.control.memoryGraph(user, input);
  expect(graph.total).toBe(85);
  expect(graph.nodes).toHaveLength(80);
  expect(graph.truncated).toBe(true);
  const limited = f.control.memoryGraph(user, { ...input, max_nodes: 3 });
  expect(limited.total).toBe(85);
  expect(limited.nodes).toHaveLength(3);
  expect(limited.truncated).toBe(true);
  const full = f.control.memoryGraph(user, { ...input, max_nodes: 200 });
  expect(full.total).toBe(85);
  expect(full.nodes).toHaveLength(85);
  expect(full.truncated).toBe(false);
  expect(f.control.memoryGraph(user, { project_id: f.project.id, tag: 'missing' })).toMatchObject({
    nodes: [],
    edges: [],
    total: 0,
    truncated: false,
  });
});

it('projects graph summaries, task titles and full source URIs without mixing node fields', () => {
  const f = catalogFixture();
  const lead = f.create();
  f.store.insert('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    tasks: [{ id: 'catalog-task', title: 'Review the catalog', depends_on: [] }],
    generations: { 'catalog-task': { generation: 1, contract: 'catalog' } },
  } as any);
  const r = f.save('task-note', 'Full record text', {
    summary: 'First summary line '.repeat(8) + '\nSecond line',
    task: { lead_session_id: lead.id, id: 'catalog-task', generation: 1 },
    references: [
      { kind: 'url', uri: 'https://example.com/complete/source?view=all', label: 'Source' },
    ],
    tags: ['catalog'],
  });
  const graph = f.control.memoryGraph(user, {
    project_id: f.project.id,
    memory_id: r.id,
    include_tags: true,
  });
  expect(graph.nodes.find((n) => n.id === r.id)).toMatchObject({
    summary: r.summary.split('\n')[0].slice(0, 120),
    task: { id: 'catalog-task', title: 'Review the catalog' },
  });
  expect(graph.nodes.find((n) => n.kind === 'source')).toMatchObject({
    uri: 'https://example.com/complete/source?view=all',
  });
  for (const node of graph.nodes) {
    if (node.kind === 'source' || node.kind === 'tag') {
      expect(node).not.toHaveProperty('summary');
      expect(node).not.toHaveProperty('task');
    } else expect(node).not.toHaveProperty('uri');
  }
  expect(graph.total).toBe(3);
  expect(f.directory().facets.tasks).toEqual([
    { id: 'catalog-task', lead_session_id: lead.id, title: 'Review the catalog' },
  ]);
  const plan = f.store.must<any>('board_plans', lead.id);
  f.store.update('board_plans', { ...plan, tasks: [] }, plan.revision);
  expect(f.directory({ state: 'all' }).facets.tasks).toEqual([
    { id: 'catalog-task', lead_session_id: lead.id },
  ]);
});

it('filters the graph by several memory and source kinds before it cuts', () => {
  const f = catalogFixture();
  for (let i = 0; i < 6; i++) f.save('early-note-' + i, 'Filler');
  const report = f.save('graph-report', 'Report', {
    kind: 'report',
    references: [{ kind: 'url', uri: 'https://example.com/report' }],
  });
  const decision = f.save('graph-decision', 'Decision', { kind: 'decision' });
  for (let i = 0; i < 6; i++) f.save('late-note-' + i, 'Filler');
  const s = f.create();
  f.store.update('sessions', { ...s, runtime_review: { memory_id: report.id } } as any, s.revision);
  const graph = f.control.memoryGraph(user, {
    project_id: f.project.id,
    state: 'all',
    kind: ['report', 'decision', 'session'],
    max_nodes: 3,
  });
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(
    [report.id, decision.id, 'session:' + s.id].sort(),
  );
  expect(graph).toMatchObject({ total: 3, truncated: false });
});

it('reads a referenced report of a runtime analysis as active until a later decision', () => {
  const f = catalogFixture();
  const report = f.save('analysis-report', 'Report', {
    kind: 'report',
    references: [{ kind: 'url', uri: 'https://example.com/report' }],
  });
  const s = f.create();
  f.store.update('sessions', { ...s, runtime_review: { memory_id: report.id } } as any, s.revision);
  const state = () =>
    f.directory().records.find((r: MemorySummary) => r.id === report.id)?.state ?? 'not listed';
  expect(state()).toBe('active');
  expect(f.control.memoryItem(user, f.project.id, report.id)).toMatchObject({ state: 'active' });
  f.save('later-decision', 'Decision', { kind: 'decision' });
  expect(state()).toBe('not listed');
  expect(f.control.memoryItem(user, f.project.id, report.id)).toMatchObject({
    state: 'archived',
    reason: 'stale',
  });
});

it('draws the sources of every memory under a source-only kind filter, without the memories', () => {
  const f = catalogFixture();
  const report = f.save('source-report', 'Report', {
    kind: 'report',
    references: [{ kind: 'url', uri: 'https://example.com/report' }],
  });
  const note = f.save('source-note', 'Note', {
    references: [
      { kind: 'url', uri: 'https://example.com/note' },
      { kind: 'file', uri: 'answer.txt' },
    ],
  });
  const urls = f.control.memoryGraph(user, { project_id: f.project.id, kind: ['url'] });
  expect(urls.nodes.map((n) => n.source_kind).sort()).toEqual(['url', 'url']);
  expect(urls.nodes.some((n) => n.id === report.id || n.id === note.id)).toBe(false);
  expect(urls.edges).toEqual([]);
  expect(urls).toMatchObject({ total: 2, truncated: false });
  const reportUrls = f.control.memoryGraph(user, {
    project_id: f.project.id,
    kind: ['report', 'url'],
  });
  expect(reportUrls.nodes.map((n) => n.kind).sort()).toEqual(['report', 'source']);
  const reports = f.control.memoryGraph(user, { project_id: f.project.id, kind: ['report'] });
  expect(reports.nodes.map((n) => n.id)).toEqual([report.id]);
});

it('draws no tag nodes under a source-only kind filter, which draws no memory to link them to', () => {
  const f = catalogFixture();
  f.save('tagged-report', 'Report', {
    kind: 'report',
    tags: ['retry'],
    references: [{ kind: 'url', uri: 'https://example.com/report' }],
  });
  const urls = f.control.memoryGraph(user, {
    project_id: f.project.id,
    kind: ['url'],
    include_tags: true,
  });
  expect(urls.nodes.map((n) => n.kind)).toEqual(['source']);
  expect(urls).toMatchObject({ total: 1, truncated: false });
  const reports = f.control.memoryGraph(user, {
    project_id: f.project.id,
    kind: ['report'],
    include_tags: true,
  });
  expect(reports.nodes.map((n) => n.kind).sort()).toEqual(['report', 'tag']);
});

it('keeps the focused memory in a graph that is cut', () => {
  const f = catalogFixture();
  for (let i = 0; i < 8; i++) f.save('cut-note-' + i, 'Filler');
  const input = { project_id: f.project.id, max_nodes: 3 };
  const cut = f.control.memoryGraph(user, input);
  const outside = f
    .directory({ limit: 20 })
    .records.map((r: MemorySummary) => r.id)
    .find((id: string) => !cut.nodes.some((n) => n.id === id))!;
  const kept = f.control.memoryGraph(user, { ...input, keep: outside });
  expect(kept.nodes).toHaveLength(3);
  expect(kept.nodes.some((n) => n.id === outside)).toBe(true);
  expect(kept.truncated).toBe(true);
  expect(f.control.memoryGraph(user, { ...input, keep: 'gone-memory' }).nodes).toHaveLength(3);
});

it('carries the lead session and generation on graph task nodes', () => {
  const f = catalogFixture();
  const leads = [f.create(), f.create()];
  for (const lead of leads)
    f.store.insert('board_plans', {
      id: lead.id,
      revision: 1,
      project_id: f.project.id,
      tasks: [{ id: 'shared-task', title: 'Task of ' + lead.id, depends_on: [] }],
      generations: { 'shared-task': { generation: 2, contract: 'shared' } },
    } as any);
  const records = leads.map((lead) =>
    f.save('scoped-' + lead.id, 'Scoped', {
      task: { lead_session_id: lead.id, id: 'shared-task', generation: 2 },
    }),
  );
  const graph = f.control.memoryGraph(user, { project_id: f.project.id });
  leads.forEach((lead, i) =>
    expect(graph.nodes.find((n) => n.id === records[i].id)!.task).toEqual({
      id: 'shared-task',
      lead_session_id: lead.id,
      generation: 2,
      title: 'Task of ' + lead.id,
    }),
  );
});

it('returns recent lifecycle events newest first without record text or other projects', () => {
  const f = catalogFixture();
  const r = f.save('recent-note', 'Private record body', { title: 'Recent title' });
  f.call('memory.archive', { memory_id: r.id }, r.revision);
  const restored = f.call<any>(
    'memory.restore',
    {
      memory_id: r.id,
    },
    f.store.must<any>('memory_records', r.id).revision,
  );
  f.store.event('memory.proposed', { id: 'other-memory', revision: 1 }, 'other-project', {});
  const recent = (f.control as any).memoryRecent(user, f.project.id, 10);
  expect(recent.items.map((e: any) => e.kind)).toEqual([
    'restored',
    'archived',
    'committed',
    'proposed',
  ]);
  expect(recent.items.map((e: any) => e.memory_id)).toEqual([restored.id, r.id, r.id, r.id]);
  for (const event of recent.items) {
    expect(event).toMatchObject({
      key: 'recent-note',
      title: 'Recent title',
      actor: user.id,
      memory_kind: 'note',
    });
    if (event.memory_id === r.id) expect(event.reason).toBe('retracted');
    else expect(event).not.toHaveProperty('reason');
  }
  expect(JSON.stringify(recent)).not.toContain('Private record body');
  expect((f.control as any).memoryRecent(user, f.project.id, 1).items).toEqual(
    recent.items.slice(0, 1),
  );
  expect(recent.items.every((e: any, i: number) => !i || recent.items[i - 1].at >= e.at)).toBe(
    true,
  );
});

it.each(['superseded', 'retracted', 'expired', 'stale'] as const)(
  'reports the record kind and %s archive reason in recent rows',
  (reason) => {
    const f = catalogFixture();
    const basis = f.save('basis', 'Source');
    const record = f.save('recent', 'Evidence', {
      kind: 'report',
      dependencies: [basis.id],
      expires_at: Date.now() + 60000,
    });
    if (reason === 'superseded') f.save('recent', 'Replacement', { kind: 'report' });
    if (reason === 'retracted') f.call('memory.archive', { memory_id: record.id }, record.revision);
    if (reason === 'stale') f.call('memory.archive', { memory_id: basis.id }, basis.revision);
    if (reason === 'expired') {
      vi.spyOn(f.store, 'now').mockReturnValue(record.expires_at);
      f.call('memory.maintain', { project_id: f.project.id });
    }
    expect(f.control.memoryRecent(user, f.project.id, 50).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memory_id: record.id, memory_kind: 'report', reason }),
      ]),
    );
  },
);

it('includes the proposing session in directory, search and related summaries', () => {
  const f = catalogFixture();
  const basis = f.save('basis', 'Source');
  const session = f.create();
  const principal = {
    id: 'agent',
    role: 'lead' as const,
    session_id: session.id,
    project_id: f.project.id,
    expires_at: Date.now() + 60000,
  };
  const packet = f.call<any>('memory.context', { project_id: f.project.id }, null, principal);
  const draft = f.call<any>(
    'memory.propose',
    {
      project_id: f.project.id,
      key: 'agent-note',
      kind: 'note',
      text: 'Agent evidence',
      dependencies: [basis.id],
      based_on: packet.signature,
    },
    null,
    principal,
  );
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const directory = f.directory().records.find((r: MemorySummary) => r.id === draft.id);
  const search = f.call<any>('memory.search', { project_id: f.project.id, q: 'agent-note' });
  const related = f.call<any>('memory.related', {
    project_id: f.project.id,
    memory_id: basis.id,
    relation: 'dependent',
  });
  for (const summary of [directory, search.items[0], related.items[0]])
    expect(summary.author_session_id).toBe(session.id);
});

it('numbers committed versions by commit order within the exact key and task scope', () => {
  const f = catalogFixture();
  const lead = f.create();
  const otherLead = f.create();
  for (const session of [lead, otherLead])
    f.store.insert('board_plans', {
      id: session.id,
      revision: 1,
      project_id: f.project.id,
      tasks: [
        { id: 'review', title: 'Review', depends_on: [] },
        { id: 'implementation', title: 'Implementation', depends_on: [] },
      ],
      generations: { review: { generation: 1, contract: 'review' } },
    } as any);
  const first = f.save('versioned', 'First');
  const task = { lead_session_id: lead.id, id: 'review', generation: 1 };
  const scoped = f.save('versioned', 'Task first', { task });
  const otherTask = f.save('versioned', 'Other task', { task: { ...task, id: 'implementation' } });
  const other = f.save('versioned', 'Other lead', {
    task: { ...task, lead_session_id: otherLead.id },
  });
  const later = f.save('versioned', 'Second');
  const taskLater = f.save('versioned', 'Task second', { task });
  const plan = f.store.must<any>('board_plans', lead.id);
  f.store.update(
    'board_plans',
    { ...plan, generations: { review: { generation: 2, contract: 'revised review' } } },
    plan.revision,
  );
  const generation = f.save('versioned', 'New generation', { task: { ...task, generation: 2 } });
  const draft = f.save('versioned', 'Draft', {}, false);
  const read = f.directory({ state: 'all', limit: 50 });
  const versions = new Map(read.records.map((r: MemorySummary) => [r.id, r.version]));
  for (const record of [first, scoped, otherTask, other, generation])
    expect(versions.get(record.id)).toBe(1);
  for (const record of [later, taskLater]) expect(versions.get(record.id)).toBe(2);
  expect(read.records.find((r: MemorySummary) => r.id === draft.id)).not.toHaveProperty('version');
  f.store.event('memory.delivered', lead, f.project.id, {
    turn_id: 'catalog-turn',
    memory_ids: [first.id, later.id, scoped.id, taskLater.id],
  });
  expect(f.control.memoryTurn(user, lead.id, 'catalog-turn').items.map((r) => r.version)).toEqual([
    1, 2, 1, 2,
  ]);
});

it('exposes archive metadata and the invalid basis before and after maintenance', () => {
  const f = catalogFixture();
  const basis = f.save('basis', 'Source');
  const dependent = f.save('dependent', 'Derived', { dependencies: [basis.id] });
  const expiring = f.save('temporary', 'Temporary', { expires_at: Date.now() + 60000 });
  const replacement = f.save('basis', 'New source');
  const archived = f.directory({ state: 'archived' });
  expect(archived.records.find((r: MemorySummary) => r.id === basis.id)).toMatchObject({
    superseded_by: replacement.id,
    archived_at: expect.any(Number),
  });
  expect(archived.records.find((r: MemorySummary) => r.id === dependent.id)).toMatchObject({
    reason: 'stale',
    basis_id: basis.id,
    archived_at: expect.any(Number),
  });
  expect(f.directory().records.find((r: MemorySummary) => r.id === expiring.id)).toMatchObject({
    expires_at: expiring.expires_at,
  });
  vi.spyOn(f.store, 'now').mockReturnValue(expiring.expires_at);
  const child = f.save('child', 'Derived from replacement', { dependencies: [replacement.id] });
  expect(
    f.directory({ state: 'archived' }).records.find((r: MemorySummary) => r.id === expiring.id),
  ).toMatchObject({
    expires_at: expiring.expires_at,
    archived_at: expect.any(Number),
    reason: 'expired',
  });
  const stored = f.store.must<any>('memory_records', replacement.id);
  f.store.update(
    'memory_records',
    { ...stored, state: 'archived', reason: 'retracted' },
    stored.revision,
  );
  expect(
    f.directory({ state: 'archived' }).records.find((r: MemorySummary) => r.id === child.id),
  ).toMatchObject({ basis_id: replacement.id, reason: 'stale' });
  const active = f.save('independent', 'Independent');
  const summary = f.directory().records.find((r: MemorySummary) => r.id === active.id);
  for (const field of [
    'author_session_id',
    'superseded_by',
    'expires_at',
    'archived_at',
    'basis_id',
  ])
    expect(summary).not.toHaveProperty(field);
});

it('includes committed versions on items and graph records while leaving drafts unnumbered', () => {
  const f = catalogFixture();
  const first = f.save('versioned', 'First version');
  const second = f.save('versioned', 'Second version');
  const draft = f.save('versioned', 'Uncommitted version', {}, false);
  const summaries = f.control.memoryRead(user, f.project.id, { state: 'all' }).records;
  const graph = f.control.memoryGraph(user, { project_id: f.project.id, state: 'all' });
  for (const [record, version] of [
    [first, 1],
    [second, 2],
  ] as const) {
    expect(summaries.find((r) => r.id === record.id)?.version).toBe(version);
    expect(f.control.memoryItem(user, f.project.id, record.id)).toHaveProperty('version', version);
    expect(graph.nodes.find((n) => n.id === record.id)).toHaveProperty('version', version);
  }
  expect(f.control.memoryItem(user, f.project.id, draft.id)).not.toHaveProperty('version');
  expect(graph.nodes.find((n) => n.id === draft.id)).not.toHaveProperty('version');
});

it('resolves archived summary replacement versions and basis titles while the records exist', () => {
  const f = catalogFixture();
  const basis = f.save('basis', 'Original source', { title: 'Reviewed source' });
  const dependent = f.save('dependent', 'Derived note', { dependencies: [basis.id] });
  const replacement = f.save('basis', 'Replacement source');
  const archived = f.control.memoryRead(user, f.project.id, { state: 'archived' }).records;
  expect(archived.find((r) => r.id === basis.id)).toMatchObject({
    superseded_by: replacement.id,
    superseded_by_version: 2,
  });
  expect(archived.find((r) => r.id === dependent.id)).toMatchObject({
    basis_id: basis.id,
    basis_title: 'Reviewed source',
  });
  const nextDependent = f.save('next-dependent', 'Derived from replacement', {
    dependencies: [replacement.id],
  });
  f.call('memory.archive', { memory_id: replacement.id }, replacement.revision);
  expect(
    f.control
      .memoryRead(user, f.project.id, { state: 'archived' })
      .records.find((r) => r.id === nextDependent.id),
  ).toMatchObject({ basis_id: replacement.id, basis_title: 'basis' });
  f.store.remove(
    'memory_records',
    replacement.id,
    f.store.must<any>('memory_records', replacement.id).revision,
  );
  const missingReplacement = f.control.memoryRead(user, f.project.id, {
    state: 'archived',
  }).records;
  expect(missingReplacement.find((r) => r.id === basis.id)).toHaveProperty(
    'superseded_by',
    replacement.id,
  );
  expect(missingReplacement.find((r) => r.id === basis.id)).not.toHaveProperty(
    'superseded_by_version',
  );
  expect(missingReplacement.find((r) => r.id === nextDependent.id)).toHaveProperty(
    'basis_id',
    replacement.id,
  );
  expect(missingReplacement.find((r) => r.id === nextDependent.id)).not.toHaveProperty(
    'basis_title',
  );
  f.store.remove(
    'memory_records',
    basis.id,
    f.store.must<any>('memory_records', basis.id).revision,
  );
  expect(
    f.control
      .memoryRead(user, f.project.id, { state: 'archived' })
      .records.find((r) => r.id === dependent.id),
  ).not.toHaveProperty('basis_title');
});

it('matches every selected tag and counts tags using all other filters before pagination', () => {
  const f = catalogFixture();
  const first = f.save('first', 'Selected evidence', { tags: ['storage', 'local'] });
  f.save('second', 'Selected evidence', { tags: ['storage'] });
  f.save('third', 'Selected evidence', { tags: ['local'] });
  f.save('excluded', 'Other', { tags: ['excluded'] });
  f.save('decision', 'Selected evidence', { kind: 'decision', tags: ['excluded'] });
  f.save('draft', 'Selected evidence', { tags: ['excluded'] }, false);
  const filters = { kind: 'note', q: 'Selected', tag: ['STORAGE', 'local'], limit: 1 };
  const read = f.directory(filters);
  expect(read.records.map((r: MemorySummary) => r.id)).toEqual([first.id]);
  expect(read.facets.tags).toEqual([
    { tag: 'local', count: 2 },
    { tag: 'storage', count: 2 },
  ]);
  expect(
    f
      .call<any>('memory.search', { project_id: f.project.id, ...filters })
      .items.map((r: MemorySummary) => r.id),
  ).toEqual([first.id]);
  expect(f.directory({ tag: 'storage' }).total).toBe(2);
});

it('filters project records apart from task records in directory, search and graph', () => {
  const f = catalogFixture();
  const lead = f.create();
  f.store.insert('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    tasks: [{ id: 'review', title: 'Review', depends_on: [] }],
  } as any);
  const project = f.save('project', 'Project');
  f.save('task', 'Task', { task: { lead_session_id: lead.id, id: 'review', generation: 1 } });
  expect(f.directory({ project_only: true }).records.map((r: MemorySummary) => r.id)).toEqual([
    project.id,
  ]);
  expect(
    f
      .call<any>('memory.search', { project_id: f.project.id, project_only: true })
      .items.map((r: MemorySummary) => r.id),
  ).toEqual([project.id]);
  expect(
    f.control
      .memoryGraph(user, { project_id: f.project.id, project_only: true })
      .nodes.map((r) => r.id),
  ).toEqual([project.id]);
});
