import { readFileSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  hash,
  requireThat,
  type MemoryDirectory,
  type MemoryFilters,
  type MemoryGraph,
  type MemoryJob,
  type MemoryRecord,
  type MemoryReference,
  type MemorySummary,
  type Principal,
  type Project,
  type Session,
} from '@pantheon/domain';
import {
  memoryDirectorySchema,
  memoryGraphSchema,
  type MemorySessionTurnsResult,
} from '@pantheon/protocol';
import { inside, purposeSessionTools, userOnly, type ControlContext } from './context.js';
import { memoryContents } from './memory.js';
import {
  body,
  memoryItemBytes,
  current,
  ensureProject,
  expired,
  records,
  rows,
  sessionFor,
  signature,
  state,
  visible,
} from './memory-access.js';

const fold = (s: string) => s.normalize('NFKC').toLocaleLowerCase();
export function excerpt(text: string, max = 600): string {
  let out = '',
    bytes = 0;
  for (const char of text.replace(/\s+/gu, ' ').trim()) {
    bytes += Buffer.byteLength(char);
    if (bytes > max) break;
    out += char;
  }
  return out;
}
// A search row carries its record's rowid, so a presence check is a rowid lookup: `id` is UNINDEXED.
export function indexMemory(ctx: ControlContext, r: MemoryRecord, text: string): void {
  const db = ctx.store.db;
  // An older row may sit at this record's rowid.
  if (!alignedIndexes.has(ctx.store)) {
    alignMemoryIndex(ctx);
    alignedIndexes.add(ctx.store);
  }
  const position = db.prepare('SELECT rowid AS position FROM memory_records WHERE id=?').get(r.id)!
    .position as number;
  db.prepare('DELETE FROM memory_search WHERE rowid=?').run(position);
  db.prepare('INSERT INTO memory_search(rowid,id,body) VALUES(?,?,?)').run(position, r.id, text);
  settledIndexes.delete(ctx.store);
}
/** Gives older search rows, written with their own rowids, their record's rowid, keeping the text. */
function alignMemoryIndex(ctx: ControlContext): void {
  const db = ctx.store.db;
  const stray = db
    .prepare(
      `SELECT 1 FROM memory_search f
    WHERE NOT EXISTS (SELECT 1 FROM memory_records r WHERE r.rowid=f.rowid AND r.id=f.id) LIMIT 1`,
    )
    .get();
  if (!stray) return;
  const rows = new Map<string, { position: number; body: string }>();
  // A row already at its record's rowid is the newest text for that id.
  for (const row of db
    .prepare(
      `SELECT r.rowid AS position, f.id, f.body FROM memory_search f JOIN memory_records r ON r.id=f.id
    ORDER BY f.rowid=r.rowid`,
    )
    .all())
    rows.set(String(row.id), { position: Number(row.position), body: String(row.body) });
  db.prepare('DELETE FROM memory_search').run();
  const insert = db.prepare('INSERT INTO memory_search(rowid,id,body) VALUES(?,?,?)');
  for (const [id, row] of rows) insert.run(row.position, id, row.body);
}
const alignedIndexes = new WeakSet<ControlContext['store']>();
// A pass found nothing missing; the next memory write starts a new pass from the first record.
const settledIndexes = new WeakSet<ControlContext['store']>();
const backfillCursors = new WeakMap<ControlContext['store'], number>();
/** Indexes up to limit records that lack a search row; the rest stay visibly pending. */
export function backfillMemoryIndex(ctx: ControlContext, limit = 16): number {
  if (settledIndexes.has(ctx.store)) return 0;
  if (!alignedIndexes.has(ctx.store)) {
    alignMemoryIndex(ctx);
    alignedIndexes.add(ctx.store);
  }
  const missing = ctx.store.db
    .prepare(
      `SELECT r.rowid AS position, r.data FROM memory_records r
    WHERE r.rowid > ? AND NOT EXISTS (SELECT 1 FROM memory_search f WHERE f.rowid=r.rowid AND f.id=r.id)
    ORDER BY r.rowid LIMIT ?`,
    )
    .all(backfillCursors.get(ctx.store) ?? 0, limit);
  // Rotate past corrupt artifacts so they cannot starve later versions. Retry them after a write.
  if (missing.length) backfillCursors.set(ctx.store, Number(missing.at(-1)!.position));
  else {
    backfillCursors.delete(ctx.store);
    settledIndexes.add(ctx.store);
  }
  const projects = new Set<string>();
  let count = 0;
  for (const row of missing) {
    const record = JSON.parse(String(row.data)) as MemoryRecord;
    try {
      indexMemory(ctx, record, body(ctx, record).text);
      count++;
      projects.add(record.project_id);
    } catch {
      /* Detail reports missing/corrupt evidence; never fabricate text. */
    }
  }
  for (const project of projects)
    ctx.store.event('memory.indexed', ctx.store.must<Project>('projects', project), project, {});
  return count;
}
function indexedExcerpt(ctx: ControlContext, id: string): { text: string; indexed: boolean } {
  const row = ctx.store.db
    .prepare('SELECT substr(body,1,400) AS preview FROM memory_search WHERE id=? LIMIT 1')
    .get(id);
  return { text: row ? excerpt(String(row.preview)) : '', indexed: !!row };
}
function versionNumber(ctx: ControlContext, r: MemoryRecord): number | undefined {
  if (r.committed_at === undefined) return;
  const versions = records(ctx, r.project_id)
    .filter(
      (v) =>
        v.committed_at !== undefined &&
        v.key === r.key &&
        v.task?.id === r.task?.id &&
        v.task?.lead_session_id === r.task?.lead_session_id &&
        v.task?.generation === r.task?.generation,
    )
    .sort((a, b) => a.committed_at! - b.committed_at!);
  return versions.findIndex((v) => v.id === r.id) + 1;
}
function summary(ctx: ControlContext, r: MemoryRecord, reasons?: string[]): MemorySummary {
  const index = indexedExcerpt(ctx, r.id);
  const version = versionNumber(ctx, r);
  const active =
    r.reason === 'stale' ? new Set(current(ctx, r.project_id).map((v) => v.id)) : undefined;
  const basis = active && r.dependencies.find((id) => !active.has(id));
  const basisRecord = basis ? ctx.store.get<MemoryRecord>('memory_records', basis) : undefined;
  const replacement = r.superseded_by
    ? ctx.store.get<MemoryRecord>('memory_records', r.superseded_by)
    : undefined;
  const replacementVersion = replacement && versionNumber(ctx, replacement);
  return {
    id: r.id,
    revision: r.revision,
    key: r.key,
    title: r.title ?? r.key,
    summary: r.summary ?? index.text,
    tags: r.tags ?? [],
    kind: r.kind,
    state: r.state,
    authority: r.authority,
    ...(r.author_session_id !== undefined && { author_session_id: r.author_session_id }),
    task: r.task,
    created_at: r.created_at,
    reason: r.reason,
    ...(version !== undefined && { version }),
    ...(r.superseded_by !== undefined && { superseded_by: r.superseded_by }),
    ...(replacementVersion !== undefined && { superseded_by_version: replacementVersion }),
    ...(r.expires_at !== undefined && { expires_at: r.expires_at }),
    ...(r.archived_at !== undefined && { archived_at: r.archived_at }),
    ...(basis && { basis_id: basis }),
    ...(basisRecord && { basis_title: basisRecord.title ?? basisRecord.key }),
    ...(r.origin && { origin: r.origin }),
    indexed: index.indexed,
    bytes: memoryItemBytes(ctx, r),
    ...(reasons && { reasons }),
  };
}
function view(
  ctx: ControlContext,
  p: Principal,
  project: string,
  action: string,
  filters: MemoryFilters,
) {
  ensureProject(ctx, p, project, action);
  if (filters.state && filters.state !== 'active') userOnly(p);
  const active = new Set(current(ctx, project).map((r) => r.id)),
    session = sessionFor(ctx, p);
  const all = records(ctx, project)
    .filter((r) => visible(r, session))
    .map((r) =>
      r.state === 'active' && !active.has(r.id)
        ? {
            ...r,
            state: 'archived' as const,
            reason: (expired(ctx, r) ? 'expired' : 'stale') as MemoryRecord['reason'],
          }
        : r,
    );
  const wanted = [filters.tag ?? []].flat().map(fold);
  const chosen = all.filter(
    (r) =>
      ((filters.state ?? 'active') === 'all' || r.state === (filters.state ?? 'active')) &&
      (!filters.kind || [filters.kind].flat().includes(r.kind)) &&
      wanted.every((tag) => (r.tags ?? []).some((t) => fold(t) === tag)) &&
      (!filters.task_id || r.task?.id === filters.task_id) &&
      (!filters.lead_session_id || r.task?.lead_session_id === filters.lead_session_id) &&
      (!filters.project_only || !r.task) &&
      (!filters.origin || r.origin?.kind === filters.origin) &&
      (!filters.milestone_id || r.origin?.milestone_id === filters.milestone_id),
  );
  return { all, chosen, signature: signature(ctx, project) };
}
/** SQL reads the search index; no artifact body is opened for ranking or directory browsing. */
function matches(ctx: ControlContext, project: string, q: string, candidates: MemoryRecord[]) {
  if (!q.trim()) return candidates.map((record) => ({ record, reasons: [] as string[], score: 0 }));
  const query = fold(q.trim()),
    words = query
      .split(/\s+/u)
      .filter(Boolean)
      .map((w) => '"' + w.replaceAll('"', '""') + '"')
      .join(' AND ');
  const fts = new Set(
    ctx.store.db
      .prepare(
        `SELECT f.id FROM memory_search f JOIN memory_records r ON r.id=f.id
    WHERE memory_search MATCH ? AND json_extract(r.data,'$.project_id')=?`,
      )
      .all(words, project)
      .map((r) => String(r.id)),
  );
  const literal = new Set(
    ctx.store.db
      .prepare(
        `SELECT f.id FROM memory_search f JOIN memory_records r ON r.id=f.id
    WHERE json_extract(r.data,'$.project_id')=? AND instr(lower(f.body),?)>0`,
      )
      .all(project, query)
      .map((r) => String(r.id)),
  );
  return candidates.flatMap((record) => {
    const reasons: string[] = [];
    let score = 0;
    if (fold(record.key) === query) {
      reasons.push('key_exact');
      score += 100;
    }
    if (fold(record.title ?? '') === query) {
      reasons.push('title_exact');
      score += 100;
    }
    for (const tag of record.tags ?? [])
      if (fold(tag) === query) {
        reasons.push('tag_exact:' + tag);
        score += 90;
      }
    if ([record.key, record.title, record.summary].some((v) => v && fold(v).includes(query))) {
      reasons.push('metadata');
      score += 50;
    }
    if (fts.has(record.id)) {
      reasons.push('fts');
      score += 40;
    }
    if (literal.has(record.id)) {
      reasons.push('literal');
      score += 30;
    }
    return reasons.length ? [{ record, reasons, score }] : [];
  });
}
const newest = (a: MemoryRecord, b: MemoryRecord) =>
  b.created_at - a.created_at || b.id.localeCompare(a.id);
export function searchMemory(
  ctx: ControlContext,
  p: Principal,
  input: MemoryFilters & { project_id: string; limit: number },
) {
  const selected = view(ctx, p, input.project_id, 'memory.search', input);
  const ranked = matches(ctx, input.project_id, input.q ?? '', selected.chosen).sort(
    (a, b) => b.score - a.score || newest(a.record, b.record),
  );
  const items: MemorySummary[] = [];
  let bytes = 0;
  for (const hit of ranked.slice(0, input.limit)) {
    const item = summary(ctx, hit.record, hit.reasons),
      size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > 16000) break;
    items.push(item);
    bytes += size;
  }
  return {
    items,
    signature: selected.signature,
    omitted: ranked.length - items.length,
    index_pending: selected.chosen.filter((r) => !indexedExcerpt(ctx, r.id).indexed).length,
    instructions:
      'Results contain summaries and match reasons, not full evidence. Use memory_get before relying on the content. Pending index entries can match metadata only.',
  };
}
export function memoryRead(
  ctx: ControlContext,
  p: Principal,
  project: string,
  options: Record<string, unknown> = {},
): MemoryDirectory {
  userOnly(p);
  const input = memoryDirectorySchema.parse({ ...options, project_id: project });
  const selected = view(ctx, p, project, 'memory.read', input);
  const matched = matches(ctx, project, input.q, selected.chosen).sort(
    (a, b) => b.score - a.score || newest(a.record, b.record),
  );
  const stamp = hash({
    filters: { ...input, cursor: undefined },
    rows: matched.map((h) => [h.record.id, h.record.revision, h.record.state]),
    signature: selected.signature,
  });
  let offset = 0;
  if (input.cursor) {
    let cursor: { stamp?: string; offset?: number } = {};
    try {
      cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
    } catch {
      /* Checked below. */
    }
    requireThat(
      cursor.stamp === stamp,
      'revision_conflict',
      'Memory directory changed; restart from the first page',
    );
    requireThat(
      Number.isInteger(cursor.offset) && cursor.offset! >= 0 && cursor.offset! <= matched.length,
      'invalid_input',
      'Invalid directory cursor',
    );
    offset = cursor.offset!;
  }
  const page = matched.slice(offset, offset + input.limit),
    jobs = rows<MemoryJob>(ctx, 'memory_jobs', project);
  const tagRecords = matches(
    ctx,
    project,
    input.q,
    view(ctx, p, project, 'memory.read', { ...input, tag: undefined }).chosen,
  );
  const tags = new Map<string, { tag: string; count: number }>();
  for (const { record } of tagRecords)
    for (const tag of new Set((record.tags ?? []).map(fold))) {
      const facet = tags.get(tag);
      if (facet) facet.count++;
      else tags.set(tag, { tag: record.tags!.find((t) => fold(t) === tag)!, count: 1 });
    }
  return {
    epoch: state(ctx, project)?.epoch ?? 0,
    records: page.map((h) => summary(ctx, h.record, h.reasons)),
    signature: selected.signature,
    total: matched.length,
    budget: { used_bytes: memoryContents(ctx, project).bytes, limit_bytes: 12000 },
    ...(offset + page.length < matched.length && {
      next_cursor: Buffer.from(JSON.stringify({ stamp, offset: offset + page.length })).toString(
        'base64url',
      ),
    }),
    index_pending: selected.all.filter((r) => !indexedExcerpt(ctx, r.id).indexed).length,
    counts: Object.fromEntries(
      ['active', 'draft', 'archived'].map((s) => [
        s,
        selected.all.filter((r) => r.state === s).length,
      ]),
    ) as MemoryDirectory['counts'],
    facets: {
      tags: [...tags.values()].sort((a, b) => a.tag.localeCompare(b.tag)).slice(0, 100),
      tasks: [
        ...new Map(
          selected.all
            .filter((r) => r.task)
            .map((r) => {
              const task = r.task!;
              return [
                task.lead_session_id + ':' + task.id,
                { id: task.id, lead_session_id: task.lead_session_id },
              ] as const;
            }),
        ).values(),
      ].slice(0, 100),
      milestones: [
        ...matches(
          ctx,
          project,
          input.q,
          view(ctx, p, project, 'memory.read', { ...input, milestone_id: undefined }).chosen,
        )
          .reduce((facets, { record: r }) => {
            const milestoneId = r.origin?.milestone_id;
            if (!milestoneId) return facets;
            const facet = facets.get(milestoneId);
            if (facet) facet.count++;
            else facets.set(milestoneId, { id: milestoneId, count: 1 });
            return facets;
          }, new Map<string, { id: string; title?: string; count: number }>())
          .values(),
      ].slice(0, 100),
    },
    jobs: jobs.slice(-10).reverse(),
    document_ready: jobs.some(
      (j) => j.signature === selected.signature && j.state === 'done' && j.body_hash,
    ),
    sessions: ctx.store
      .list<Session>('sessions')
      .filter((s) => s.project_id === project && s.state !== 'closed')
      .map((s) => ({
        id: s.id,
        title: s.title,
        delivered: s.memory_delivery?.delivered_signature === selected.signature,
        prepared: s.memory_delivery?.prepared_signature === selected.signature,
        memory_tool: purposeSessionTools(s)?.includes('memory.context') ?? true,
        stale:
          !!s.memory_delivery?.delivered_signature &&
          s.memory_delivery.delivered_signature !== selected.signature,
      })),
  };
}
export function memoryItem(ctx: ControlContext, p: Principal, project: string, memoryId: string) {
  userOnly(p);
  const selected = view(ctx, p, project, 'memory.item', { state: 'all' });
  const r = selected.all.find((r) => r.id === memoryId);
  requireThat(r, 'not_found', 'Memory version not found in this project');
  const version = versionNumber(ctx, r);
  return {
    ...body(ctx, r),
    ...(version !== undefined && { version }),
    reference_status: referenceStatus(ctx, project, r.references ?? []),
    source_sessions: sourceSessions(ctx, project)
      .filter((s) => s.runtime_review?.memory_id === r.id)
      .map((s) => ({ id: s.id, title: s.title })),
  };
}
export function memoryDocument(ctx: ControlContext, p: Principal, project: string) {
  userOnly(p);
  ensureProject(ctx, p, project, 'memory.document');
  const stamp = signature(ctx, project),
    job = rows<MemoryJob>(ctx, 'memory_jobs', project).findLast(
      (j) => j.signature === stamp && j.state === 'done' && j.body_hash,
    );
  return {
    signature: stamp,
    text:
      job?.body_hash && ctx.files.valid(job.body_hash)
        ? readFileSync(path.join(ctx.files.directory, job.body_hash), 'utf8')
        : null,
  };
}

export function memoryTurn(ctx: ControlContext, p: Principal, sessionId: string, turnId: string) {
  userOnly(p);
  const session = ctx.store.must<Session>('sessions', sessionId);
  ensureProject(ctx, p, session.project_id, 'memory.turn');
  const event = ctx.store.db
    .prepare(
      "SELECT payload FROM events WHERE kind='memory.delivered' AND aggregate_id=? AND json_extract(payload,'$.turn_id')=? ORDER BY sequence DESC LIMIT 1",
    )
    .get(sessionId, turnId);
  const payload = event
    ? (JSON.parse(String(event.payload)) as { memory_ids?: string[] })
    : undefined;
  return {
    items: (payload?.memory_ids ?? []).map((id) => {
      const r = ctx.store.must<MemoryRecord>('memory_records', id);
      const version = versionNumber(ctx, r);
      return {
        id: r.id,
        key: r.key,
        title: r.title ?? r.key,
        kind: r.kind,
        state: r.state,
        ...(version !== undefined && { version }),
      };
    }),
  };
}

export function memorySessionTurns(
  ctx: ControlContext,
  p: Principal,
  sessionId: string,
): MemorySessionTurnsResult {
  userOnly(p);
  const session = ctx.store.must<Session>('sessions', sessionId);
  ensureProject(ctx, p, session.project_id, 'memory.session_turns');
  const events = ctx.store.db
    .prepare(
      "SELECT payload FROM events WHERE kind='memory.delivered' AND aggregate_id=? ORDER BY sequence",
    )
    .all(sessionId);
  const turns = new Map<string, number>();
  for (const event of events) {
    const payload = JSON.parse(String(event.payload)) as {
      turn_id: string;
      memory_ids?: string[];
    };
    turns.set(payload.turn_id, payload.memory_ids?.length ?? 0);
  }
  return {
    turns: [...turns]
      .filter(([, count]) => count > 0)
      .map(([turn_id, count]) => ({ turn_id, count })),
  };
}

export function memoryRecent(ctx: ControlContext, p: Principal, project: string, limit: number) {
  userOnly(p);
  ensureProject(ctx, p, project, 'memory.recent');
  const events = ctx.store.db
    .prepare(
      `SELECT e.created_at, e.kind, e.aggregate_id, e.payload, r.data FROM events e
       JOIN memory_records r ON r.id=e.aggregate_id
       WHERE e.project_id=? AND e.kind IN ('memory.proposed','memory.committed','memory.archived','memory.restored_as_draft','memory.retraction_undone')
       ORDER BY e.created_at DESC, e.sequence DESC LIMIT ?`,
    )
    .all(project, limit);
  return {
    items: events.map((event) => {
      const r = JSON.parse(String(event.data)) as MemoryRecord;
      const payload = JSON.parse(String(event.payload)) as { by?: string };
      return {
        at: Number(event.created_at),
        kind:
          event.kind === 'memory.restored_as_draft'
            ? 'restored'
            : String(event.kind).slice('memory.'.length),
        memory_id: r.id,
        memory_kind: r.kind,
        ...(r.state === 'archived' && r.reason !== undefined && { reason: r.reason }),
        key: r.key,
        title: r.title ?? r.key,
        actor: payload.by ?? r.author,
      };
    }),
  };
}

export function captureReferences(
  ctx: ControlContext,
  projectId: string,
  refs: MemoryReference[] = [],
): MemoryReference[] {
  const project = ctx.store.must<Project>('projects', projectId);
  return refs.map((ref) => {
    if (ref.kind === 'url') {
      let url: URL | undefined;
      try {
        url = new URL(ref.uri);
      } catch {
        /* Checked below. */
      }
      requireThat(
        url && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password,
        'invalid_input',
        'Reference URL must be HTTP(S) without credentials',
      );
      return { kind: ref.kind, uri: url.href, label: ref.label };
    }
    const root = project.roots[ref.root ?? 0];
    requireThat(
      root && !path.isAbsolute(ref.uri),
      'invalid_input',
      'File references need a project-relative path and valid root',
    );
    let file: string | undefined;
    try {
      file = realpathSync(path.resolve(root, ref.uri));
    } catch {
      /* Checked below. */
    }
    requireThat(file, 'invalid_input', 'Referenced project file is unavailable');
    requireThat(
      inside(realpathSync(root), file),
      'scope_violation',
      'Reference is outside project roots',
    );
    const stat = statSync(file);
    requireThat(stat.isFile(), 'invalid_input', 'Reference must be a file');
    return {
      kind: ref.kind,
      label: ref.label,
      uri: path.relative(root, file),
      root: ref.root ?? 0,
      ...(stat.size <= 2_000_000 && {
        content_hash: createHash('sha256').update(readFileSync(file)).digest('hex'),
      }),
    };
  });
}
export function referenceStatus(ctx: ControlContext, project: string, refs: MemoryReference[]) {
  return refs.map((ref) => {
    if (ref.kind === 'url') return { ...ref, status: 'unverified' };
    try {
      const captured = captureReferences(ctx, project, [ref])[0]!;
      return {
        ...ref,
        status: !ref.content_hash
          ? 'unversioned'
          : captured.content_hash === ref.content_hash
            ? 'unchanged'
            : 'changed',
      };
    } catch {
      return { ...ref, status: 'unavailable' };
    }
  });
}
function sourceSessions(ctx: ControlContext, project: string) {
  return ctx.store
    .list<Session>('sessions')
    .filter((s) => s.project_id === project && s.runtime_review?.memory_id);
}

type Link = MemoryGraph['edges'][number];
function relationshipIndex(all: MemoryRecord[]) {
  const ids = new Set(all.map((r) => r.id)),
    edges: Link[] = [],
    adjacency = new Map<string, Link[]>();
  const add = (from: string, to: string, kind: Link['kind']) => {
    if (!ids.has(from) || !ids.has(to)) return;
    const edge = { id: hash({ from, to, kind }), from, to, kind };
    edges.push(edge);
    for (const id of [from, to]) {
      const list = adjacency.get(id) ?? [];
      list.push(edge);
      adjacency.set(id, list);
    }
  };
  for (const r of all) {
    for (const dep of r.dependencies) add(r.id, dep, 'depends_on');
    if (r.superseded_by) add(r.superseded_by, r.id, 'supersedes');
    if (r.restored_from) add(r.id, r.restored_from, 'restored_from');
  }
  return { edges, adjacency };
}
function graphSelection(
  ctx: ControlContext,
  p: Principal,
  input: MemoryFilters & { project_id: string; memory_id?: string },
  action: string,
) {
  const selected = view(ctx, p, input.project_id, action, input);
  const matched = matches(ctx, input.project_id, input.q ?? '', selected.chosen).map(
    (h) => h.record,
  );
  const root = matched.find((r) => r.id === input.memory_id);
  requireThat(
    !input.memory_id || root,
    'not_found',
    'Selected memory is no longer visible under these filters',
  );
  return { ...selected, matched, root, ...relationshipIndex(matched) };
}
export function relatedMemory(
  ctx: ControlContext,
  p: Principal,
  input: MemoryFilters & {
    project_id: string;
    memory_id: string;
    relation: 'all' | 'dependency' | 'dependent' | 'version' | 'tag';
    depth: number;
    limit: number;
  },
) {
  const selected = graphSelection(ctx, p, input, 'memory.related'),
    found = new Map<string, Set<string>>();
  let frontier = [input.memory_id];
  const visited = new Set(frontier);
  for (let depth = 0; depth < input.depth; depth++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const edge of selected.adjacency.get(id) ?? []) {
        const reason =
          edge.kind === 'depends_on' ? (edge.from === id ? 'dependency' : 'dependent') : 'version';
        if (input.relation !== 'all' && input.relation !== reason) continue;
        const other = edge.from === id ? edge.to : edge.from;
        if (other === input.memory_id) continue;
        if (found.size >= 80 && !found.has(other)) continue;
        const reasons = found.get(other) ?? new Set();
        reasons.add(reason + ':' + edge.kind);
        found.set(other, reasons);
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
        if (found.size >= 80) break;
      }
    frontier = next.slice(0, 80);
    if (found.size >= 80) break;
  }
  if (input.relation === 'tag' || input.relation === 'all') {
    const tags = new Set((selected.root!.tags ?? []).map(fold));
    for (const r of selected.matched) {
      if (r.id === input.memory_id || found.size >= 80) continue;
      for (const tag of r.tags ?? [])
        if (tags.has(fold(tag))) {
          const reasons = found.get(r.id) ?? new Set();
          reasons.add('shared_tag:' + tag);
          found.set(r.id, reasons);
        }
    }
  }
  const byId = new Map(selected.matched.map((r) => [r.id, r]));
  let bytes = 0;
  const items: MemorySummary[] = [];
  for (const [id, reasons] of [...found].slice(0, input.limit)) {
    const item = summary(ctx, byId.get(id)!, [...reasons]),
      size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > 16000) break;
    items.push(item);
    bytes += size;
  }
  return {
    items,
    signature: selected.signature,
    truncated: items.length < found.size || found.size >= 80,
  };
}
export function memoryGraph(ctx: ControlContext, p: Principal, raw: unknown): MemoryGraph {
  userOnly(p);
  const input = memoryGraphSchema.parse(raw),
    kinds = input.kind === undefined ? undefined : [input.kind].flat(),
    memoryKinds = kinds?.filter(
      (k): k is MemoryRecord['kind'] => k === 'decision' || k === 'report' || k === 'note',
    ),
    // Sources hang off memories, so a source-only filter walks every memory without drawing it.
    sourceOnly = memoryKinds?.length === 0,
    selected = graphSelection(
      ctx,
      p,
      { ...input, kind: sourceOnly ? undefined : memoryKinds },
      'memory.graph',
    );
  const byId = new Map(selected.matched.map((r) => [r.id, r])),
    kept = input.keep && byId.has(input.keep) ? [input.keep] : [],
    reachable = new Set(
      input.memory_id
        ? [input.memory_id, ...kept]
        : [...kept, ...selected.matched.map((r) => r.id)],
    ),
    ids = new Set(sourceOnly ? [] : [...reachable].slice(0, input.max_nodes));
  const treeEdges: Link[] = [];
  let frontier = input.memory_id ? [input.memory_id] : [];
  for (let depth = 0; depth < input.depth; depth++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const edge of selected.adjacency.get(id) ?? []) {
        const other = edge.from === id ? edge.to : edge.from;
        if (reachable.has(other)) continue;
        reachable.add(other);
        next.push(other);
        if (!sourceOnly && ids.size < input.max_nodes) {
          ids.add(other);
          treeEdges.push(edge);
        }
      }
    frontier = next;
  }
  let truncated = !sourceOnly && ids.size < reachable.size;
  const allNodes = new Set(sourceOnly ? [] : reachable);
  const nodes: MemoryGraph['nodes'] = [...ids].map((id) => {
    const r = byId.get(id)!;
    const version = versionNumber(ctx, r);
    return {
      id,
      label: r.title ?? r.key,
      kind: r.kind,
      state: r.state,
      ...(version !== undefined && { version }),
      memory_id: id,
      summary: (r.summary ?? indexedExcerpt(ctx, id).text).split(/\r?\n/u)[0]!.slice(0, 120),
      ...(r.task && {
        task: {
          id: r.task.id,
          lead_session_id: r.task.lead_session_id,
          generation: r.task.generation ?? 1,
          title: r.task.id,
        },
      }),
    };
  });
  const edges = [
    ...new Map(
      [...treeEdges, ...selected.edges.filter((e) => ids.has(e.from) && ids.has(e.to))].map((e) => [
        e.id,
        e,
      ]),
    ).values(),
  ].slice(0, 160);
  if (selected.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).length > edges.length)
    truncated = true;
  const append = (memory: string, node: MemoryGraph['nodes'][number], kind: Link['kind']) => {
    if (kinds && node.source_kind && !kinds.includes(node.source_kind)) return;
    allNodes.add(node.id);
    if (!(sourceOnly ? reachable : ids).has(memory)) return;
    if (edges.length >= 160) {
      truncated = true;
      return;
    }
    if (!nodes.some((n) => n.id === node.id)) {
      if (nodes.length >= input.max_nodes) {
        truncated = true;
        return;
      }
      nodes.push(node);
    }
    if (!sourceOnly)
      edges.push({ id: hash({ memory, node: node.id, kind }), from: memory, to: node.id, kind });
  };
  for (const id of reachable) {
    const r = byId.get(id)!;
    for (const ref of r.references ?? [])
      append(
        id,
        {
          id: 'source:' + hash(ref),
          label: excerpt(ref.label ?? ref.uri, 240),
          kind: 'source',
          source_kind: ref.kind,
          uri: ref.uri,
        },
        'source',
      );
    // Tags hang off the memories drawn, and a source-only filter draws none.
    if (input.include_tags && !sourceOnly)
      for (const tag of r.tags ?? [])
        append(id, { id: 'tag:' + hash(fold(tag)), label: tag, kind: 'tag' }, 'tagged');
  }
  for (const s of sourceSessions(ctx, input.project_id))
    if (reachable.has(s.runtime_review!.memory_id!))
      append(
        s.runtime_review!.memory_id!,
        {
          id: 'session:' + s.id,
          label: s.title ?? s.id,
          kind: 'source',
          source_kind: 'session',
          uri: 'session:' + s.id,
        },
        'source',
      );
  const result = {
    nodes,
    edges,
    signature: selected.signature,
    total: allNodes.size,
    truncated: truncated || nodes.length < allNodes.size,
    depth: input.depth,
  };
  while (Buffer.byteLength(JSON.stringify(result)) > 48000 && result.nodes.length > 1) {
    const removed = result.nodes.pop()!;
    result.edges = result.edges.filter((e) => e.from !== removed.id && e.to !== removed.id);
    result.truncated = true;
  }
  return result;
}
