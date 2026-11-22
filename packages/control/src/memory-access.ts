import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  hash,
  requireThat,
  type MemoryItem,
  type MemoryRecord,
  type MemoryState,
  type Principal,
  type Project,
  type Session,
} from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';

export function rows<T>(
  ctx: ControlContext,
  table: 'memory_records' | 'memory_jobs',
  project: string,
): T[] {
  return ctx.store
    .statement(`SELECT data FROM ${table} WHERE json_extract(data,'$.project_id')=? ORDER BY rowid`)
    .all(project)
    .map((r) => JSON.parse(String(r.data)) as T);
}
export const records = (ctx: ControlContext, project: string) =>
  rows<MemoryRecord>(ctx, 'memory_records', project);
export const state = (ctx: ControlContext, project: string) =>
  ctx.store.get<MemoryState>('memory_states', project);

/** Only authoritative source fields. Delivery acknowledgements, page writes and inbox consumption are excluded. */
export function sources(ctx: ControlContext, project: string) {
  return {
    brief: ctx.store.get('project_briefs', project) ?? null,
    // Kept so the source signatures of stored reports stay valid.
    tasks: [],
    experiences: [],
  };
}
/** A record scoped to a board task is never current. */
export function taskCurrent(r: Pick<MemoryRecord, 'task'>): boolean {
  return !r.task;
}
export const NOTE_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** Past its expires_at, or an agent's own note no session read for NOTE_IDLE_MS. */
export function expired(ctx: ControlContext, r: MemoryRecord): boolean {
  const now = ctx.store.now();
  return (
    (!!r.expires_at && r.expires_at <= now) ||
    (r.authority === 'agent_reported' &&
      r.kind === 'note' &&
      // Handoff notes and notes imported from files stay while their source does.
      !r.tags?.some((t) => t === 'handoff' || t === 'imported') &&
      // A plan decision kept as a note for lack of budget stays a decision of the plan.
      !r.origin &&
      now - (r.last_used_at ?? r.created_at) > NOTE_IDLE_MS)
  );
}
export function alive(ctx: ControlContext, r: MemoryRecord): boolean {
  return r.state === 'active' && !expired(ctx, r) && taskCurrent(r);
}
export function sourceSignature(
  ctx: ControlContext,
  project: string,
  all = records(ctx, project),
): string {
  return hash({
    sources: sources(ctx, project),
    // A decision Pantheon wrote from a plan does not make the project's reports stale.
    decisions: all
      .filter((r) => r.kind === 'decision' && !r.origin && alive(ctx, r))
      .map((r) => r.id),
  });
}
/** The one lifecycle gate every memory read goes through. */
export function current(
  ctx: ControlContext,
  project: string,
  // The project's sourceSignature, when the caller computed it since the last write.
  known?: string,
): MemoryRecord[] {
  const all = records(ctx, project),
    byId = new Map(all.map((r) => [r.id, r]));
  const stamp = known ?? sourceSignature(ctx, project, all),
    accepted = new Map<string, boolean>();
  const valid = (r: MemoryRecord, visiting = new Set<string>()): boolean => {
    if (accepted.has(r.id)) return accepted.get(r.id)!;
    if (visiting.has(r.id)) return false;
    const next = new Set(visiting).add(r.id);
    const ok =
      alive(ctx, r) &&
      (!r.source_signature || r.source_signature === stamp) &&
      r.dependencies.every((k) => {
        const source = byId.get(k);
        return !!source && valid(source, next);
      });
    accepted.set(r.id, ok);
    return ok;
  };
  return all.filter((r) => valid(r));
}
export function signature(
  ctx: ControlContext,
  project: string,
  stamp = sourceSignature(ctx, project),
  valid = current(ctx, project, stamp),
): string {
  return hash({
    epoch: state(ctx, project)?.epoch ?? 0,
    sources: stamp,
    current: valid.map((r) => r.id),
  });
}
/** Serialized item bytes, including JSON escaping, without opening indexed artifact bodies. */
export function memoryItemBytes(ctx: ControlContext, r: MemoryRecord): number {
  const row = ctx.store.db
    .prepare(
      'SELECT length(CAST(json_quote(body) AS BLOB))-2 AS bytes FROM memory_search WHERE id=?',
    )
    .get(r.id);
  let textBytes: number;
  if (row) textBytes = Number(row.bytes);
  else {
    const file = path.join(ctx.files.directory, r.body_hash);
    if (!statSync(file, { throwIfNoEntry: false })) return 0;
    textBytes = Buffer.byteLength(JSON.stringify(readFileSync(file, 'utf8'))) - 2;
  }
  return Buffer.byteLength(JSON.stringify({ ...r, text: '' })) + textBytes;
}
export function body(ctx: ControlContext, r: MemoryRecord): MemoryItem {
  requireThat(ctx.files.valid(r.body_hash), 'invalid_state', 'Memory body is missing or corrupt');
  return { ...r, text: readFileSync(path.join(ctx.files.directory, r.body_hash), 'utf8') };
}
/** The identity of a task scope; other session task fields do not narrow it. */
export function taskScope(task?: { lead_session_id: string; id: string; generation?: number }) {
  return (
    task && { lead_session_id: task.lead_session_id, id: task.id, generation: task.generation ?? 1 }
  );
}
export function visible(r: MemoryRecord, session?: Session): boolean {
  return !r.task || !session;
}
export function sessionFor(ctx: ControlContext, p: Principal): Session | undefined {
  return p.session_id ? ctx.store.must<Session>('sessions', p.session_id) : undefined;
}
export function ensureProject(
  ctx: ControlContext,
  p: Principal,
  project: string,
  action: string,
): void {
  projectAccess(ctx, p, project, action);
  ctx.store.must<Project>('projects', project);
}
