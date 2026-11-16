import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  hash,
  requireThat,
  type BoardPlan,
  type Improvement,
  type MemoryItem,
  type MemoryRecord,
  type MemoryState,
  type Principal,
  type Project,
  type Session,
} from '@pantheon/domain';
import { projectAccess, type ControlContext } from './context.js';
import { taskGeneration, taskSessions, taskState } from './board-plan.js';

export function rows<T>(
  ctx: ControlContext,
  table: 'memory_records' | 'memory_jobs' | 'board_plans' | 'improvements',
  project: string,
): T[] {
  return ctx.store.db
    .prepare(`SELECT data FROM ${table} WHERE json_extract(data,'$.project_id')=? ORDER BY rowid`)
    .all(project)
    .map((r) => JSON.parse(String(r.data)) as T);
}
export const records = (ctx: ControlContext, project: string) =>
  rows<MemoryRecord>(ctx, 'memory_records', project);
export const state = (ctx: ControlContext, project: string) =>
  ctx.store.get<MemoryState>('memory_states', project);

/** Only authoritative source fields. Delivery acknowledgements, page writes and inbox consumption are excluded. */
export function sources(ctx: ControlContext, project: string) {
  const plans = rows<BoardPlan>(ctx, 'board_plans', project);
  return {
    brief: ctx.store.get('project_briefs', project) ?? null,
    tasks: plans.flatMap((plan) =>
      plan.tasks.map((task) => ({
        lead_session_id: plan.id,
        task_id: task.id,
        generation: taskGeneration(plan, task.id),
        title: task.title,
        goal: task.goal,
        scope: task.scope,
        acceptance: task.acceptance,
        state: taskState(
          plan,
          task.id,
          taskSessions(ctx, plan.id, task.id),
          ctx.store.get<Session>('sessions', plan.id),
        ),
        completion: plan.accepted?.[task.id] ?? plan.direct_merged?.[task.id] ?? null,
        done_when: task.done_when ?? 'merged',
      })),
    ),
    experiences: rows<Improvement>(ctx, 'improvements', project)
      .filter((i) => i.change.type === 'experience')
      .map((i) => ({ id: i.id, revision: i.revision, status: i.status, change: i.change })),
  };
}
export function taskCurrent(
  ctx: ControlContext,
  r: Pick<MemoryRecord, 'project_id' | 'task'>,
): boolean {
  if (!r.task) return true;
  const plan = ctx.store.get<BoardPlan>('board_plans', r.task.lead_session_id);
  return (
    !!plan &&
    plan.project_id === r.project_id &&
    plan.tasks.some((t) => t.id === r.task!.id) &&
    taskGeneration(plan, r.task.id) === (r.task.generation ?? 1) &&
    taskState(
      plan,
      r.task.id,
      taskSessions(ctx, plan.id, r.task.id),
      ctx.store.get<Session>('sessions', plan.id),
    ) !== 'done'
  );
}
export function alive(ctx: ControlContext, r: MemoryRecord): boolean {
  return (
    r.state === 'active' && (!r.expires_at || r.expires_at > ctx.store.now()) && taskCurrent(ctx, r)
  );
}
export function sourceSignature(
  ctx: ControlContext,
  project: string,
  all = records(ctx, project),
): string {
  return hash({
    sources: sources(ctx, project),
    decisions: all.filter((r) => r.kind === 'decision' && alive(ctx, r)).map((r) => r.id),
  });
}
/** The one lifecycle gate every memory read goes through. */
export function current(ctx: ControlContext, project: string): MemoryRecord[] {
  const all = records(ctx, project),
    byId = new Map(all.map((r) => [r.id, r]));
  const stamp = sourceSignature(ctx, project, all),
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
export function signature(ctx: ControlContext, project: string): string {
  return hash({
    epoch: state(ctx, project)?.epoch ?? 0,
    sources: sourceSignature(ctx, project),
    current: current(ctx, project).map((r) => r.id),
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
/** The board task a session works on, or the direct task its lead claimed. */
export function sessionTaskScope(session?: Session) {
  return taskScope(
    session?.task ??
      (session?.direct_task && { ...session.direct_task, lead_session_id: session.id }),
  );
}
export function visible(r: MemoryRecord, session?: Session): boolean {
  const own = sessionTaskScope(session);
  return !r.task || !session || (!!own && hash(taskScope(r.task)) === hash(own));
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
