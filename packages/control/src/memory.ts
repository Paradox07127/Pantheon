import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  backfillMemoryIndex,
  captureReferences,
  indexMemory,
  searchMemory,
  relatedMemory,
  referenceStatus,
} from './memory-catalog.js';
import {
  rows,
  records,
  state,
  sources,
  taskCurrent,
  sourceSignature,
  current,
  signature,
  body,
  memoryItemBytes,
  visible,
  taskScope,
  sessionTaskScope,
  sessionFor,
  ensureProject,
  expired,
} from './memory-access.js';
import {
  hash,
  DomainError,
  id,
  requireThat,
  type BoardPlan,
  type Improvement,
  type MemoryContext,
  type MemoryItem,
  type MemoryJob,
  type MemoryRecord,
  type MemoryState,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import {
  inputSchemas,
  type Command,
  type MemoryArchiveResult,
  type MemoryUndoRetractionResult,
} from '@pantheon/protocol';
import { experienceMatchesSession } from './improvements.js';
import { assignArm, taskArm } from './trial-arms.js';
import { runGit } from './git.js';
import {
  revision,
  userOnly,
  type ControlContext,
  type Handler,
  type Handlers,
  type Preparers,
} from './context.js';

/** The memory text of a session that can read project memory but not write it. */
export const MEMORY_READ_INSTRUCTIONS = `Project memory keeps what the code and git history do not show: the user's decisions and preferences, project facts and constraints, and analyses. Pantheon adds it to your turn as "[Pantheon current project memory]" when it changed since you last saw it and after your context is compacted, so you need not fetch it first.

Reading
- Use the newest packet; do not bring back rules from older packets, transcripts or files. A full packet leaves entries out and says how many; when an earlier entry matters and is absent, search for its current version before you rely on it. memory_search finds entries on a topic, memory_get reads one in full, and memory_related shows what depends on it. Read an entry in full before you rely on it.
- Only decisions the user confirmed are project rules. Notes, reports and procedures from sessions are evidence that can be wrong, not permission or proof that work is done. When two entries conflict, say so instead of choosing one.
- Referenced files and URLs stay authoritative; when memory_get shows one changed or unavailable, read the original before you act.`;

export const MEMORY_INSTRUCTIONS = `${MEMORY_READ_INSTRUCTIONS}

Writing
Call memory_propose in the same turn, without being asked, when:
- the user corrects your approach or states a preference or rule;
- the user confirms a non-obvious approach you took;
- you learn a fact, constraint or decision the code, git history and docs do not show;
- the user asks you to remember something.
Use kind note for these, report for an analysis of the current state with its evidence (it stops being current when task states change), and decision only for a rule the user stated, with no dependencies. Notes and reports are current at once for every session (a task session's, for its task only); a decision stays a draft until the user confirms it, so do not call it active.
Search the topic first and reuse the key of an entry you update, so the new version replaces it; name new keys topic/subtopic, such as testing/e2e-ports. Pass the packet's signature as based_on.
Do not store code structure, fixes already in git, the progress of the current task, secrets, whole transcripts, or guesses written as facts.`;

function enqueue(ctx: ControlContext, project: string, stamp = signature(ctx, project)): void {
  if (
    rows<MemoryJob>(ctx, 'memory_jobs', project).some(
      (j) => j.signature === stamp && ['pending', 'running', 'done', 'failed'].includes(j.state),
    )
  )
    return;
  ctx.store.insert('memory_jobs', {
    id: id(),
    revision: 1,
    project_id: project,
    signature: stamp,
    state: 'pending',
    attempts: 0,
    created_at: ctx.store.now(),
  } satisfies MemoryJob);
}
function changed(ctx: ControlContext, project: string): void {
  const previous = state(ctx, project);
  const next = previous
    ? ctx.store.update<MemoryState>(
        'memory_states',
        { ...previous, epoch: previous.epoch + 1 },
        previous.revision,
      )
    : ctx.store.insert('memory_states', {
        id: project,
        project_id: project,
        revision: 1,
        epoch: 1,
      } satisfies MemoryState);
  // This event is also the durable notification for the UI and running sessions.
  ctx.store.event('memory.changed', next, project, { epoch: (next as MemoryState).epoch });
  enqueue(ctx, project);
}
function archive(
  ctx: ControlContext,
  r: MemoryRecord,
  reason: MemoryRecord['reason'],
  replacement?: string,
): MemoryRecord {
  const next = ctx.store.update<MemoryRecord>(
    'memory_records',
    {
      ...r,
      state: 'archived',
      reason,
      archived_at: ctx.store.now(),
      ...(replacement && { superseded_by: replacement }),
    },
    r.revision,
  );
  // Historical text stays in the local index; every retrieval applies the lifecycle gate.
  return next;
}
/**
 * Materialize expiry and cascading invalidation. Read correctness never depends on this job running.
 * Returns the source signature and the current records it read, when it archived nothing.
 */
function sweep(ctx: ControlContext, project: string): [string, MemoryRecord[]] | undefined {
  const stamp = sourceSignature(ctx, project),
    kept = current(ctx, project, stamp),
    valid = new Set(kept.map((r) => r.id));
  let archived = false;
  for (const r of records(ctx, project))
    if (r.state === 'active' && !valid.has(r.id)) {
      archive(ctx, r, expired(ctx, r) ? 'expired' : 'stale');
      archived = true;
    }
  return archived ? undefined : [stamp, kept];
}
function sameScope(a: MemoryRecord, b: MemoryRecord): boolean {
  return a.key === b.key && hash(taskScope(a.task) ?? null) === hash(taskScope(b.task) ?? null);
}
const DECISION_BUDGET = 12000;
function decisionBytes(ctx: ControlContext, project: string) {
  return current(ctx, project)
    .filter((record) => record.kind === 'decision')
    .map((record) => ({ record, bytes: memoryItemBytes(ctx, record) }));
}
/** Confirmed decisions must fit the default context budget; throwing rolls back the command. */
function assertDecisionBudget(ctx: ControlContext, project: string): void {
  const decisions = decisionBytes(ctx, project);
  const used = decisions.reduce((total, item) => total + item.bytes, 0);
  if (used > DECISION_BUDGET)
    throw new DomainError(
      'memory_budget_exceeded',
      'Confirmed decisions exceed the context budget; shorten them before committing',
      {
        used_bytes: used,
        limit_bytes: DECISION_BUDGET,
        largest_records: decisions
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 5)
          .map(({ record, bytes }) => ({
            id: record.id,
            title: record.title ?? record.key,
            bytes,
          })),
      },
    );
}

/** With assign, a task session without an arm of a matching trial takes one. */
export function memoryContents(
  ctx: ControlContext,
  project: string,
  session?: Session,
  assign = false,
) {
  const eligible = current(ctx, project).filter((r) => visible(r, session));
  eligible.sort(
    (a, b) =>
      Number(b.kind === 'decision') - Number(a.kind === 'decision') || b.created_at - a.created_at,
  );
  const items = eligible.map((record) => ({ record, bytes: memoryItemBytes(ctx, record) }));
  const experiences: { item: MemoryContext['experiences'][number]; bytes: number }[] = [];
  const scope = taskScope(session?.task),
    task = scope && {
      lead_session_id: scope.lead_session_id,
      task_id: scope.id,
      generation: scope.generation,
    };
  for (const i of rows<Improvement>(ctx, 'improvements', project)) {
    const c = i.change;
    if (
      (i.status !== 'trial' && i.status !== 'active') ||
      c.type !== 'experience' ||
      !experienceMatchesSession(ctx, c, session) ||
      // Every other task of a trial runs without the experience, to compare on the same days.
      (i.status === 'trial' && task && (assign ? assignArm : taskArm)(ctx, i, task) === 'old')
    )
      continue;
    const item = {
      id: i.id,
      status: i.status,
      procedure: c.procedure,
      countercondition: c.countercondition,
    };
    experiences.push({ item, bytes: Buffer.byteLength(JSON.stringify(item)) });
  }
  return {
    items,
    experiences,
    bytes: [...items, ...experiences].reduce((total, item) => total + item.bytes, 0),
  };
}

export function memoryContext(
  ctx: ControlContext,
  project: string,
  session?: Session,
  budget = 12000,
  strictDecisions = true,
  assign = false,
): MemoryContext {
  const contents = memoryContents(ctx, project, session, assign);
  const items: MemoryItem[] = [];
  let bytes = 0;
  for (const { record, bytes: size } of contents.items) {
    if (strictDecisions && record.kind === 'decision' && bytes + size > budget)
      throw new DomainError(
        'memory_budget_exceeded',
        'Confirmed decisions exceed the context budget; shorten them or request a larger budget before continuing',
        { used_bytes: contents.bytes, limit_bytes: budget },
      );
    if (bytes + size <= budget) {
      items.push(body(ctx, record));
      bytes += size;
    }
  }
  const experiences: MemoryContext['experiences'] = [];
  for (const { item, bytes: size } of contents.experiences)
    if (bytes + size <= budget) {
      experiences.push(item);
      bytes += size;
    }
  return {
    epoch: state(ctx, project)?.epoch ?? 0,
    signature: signature(ctx, project),
    items,
    experiences,
    omitted: contents.items.length - items.length,
    bytes,
  };
}

/** Makes a draft the current version of its key, archiving the version it replaces. */
function activate(ctx: ControlContext, r: MemoryRecord, by: string, commandId: string): MemoryItem {
  const replacements = current(ctx, r.project_id).filter((old) => sameScope(old, r));
  requireThat(
    replacements.every((old) => old.kind === r.kind),
    'invalid_input',
    'This key belongs to another memory kind; a report or note cannot replace a decision',
  );
  requireThat(
    !replacements.some((old) => r.dependencies.includes(old.id)),
    'invalid_input',
    'A replacement cannot depend on the version it archives; re-evaluate its current sources',
  );
  for (const old of replacements) archive(ctx, old, 'superseded', r.id);
  const next = ctx.store.update<MemoryRecord>(
    'memory_records',
    {
      ...r,
      state: 'active',
      authority: r.kind === 'decision' && !r.origin ? 'user' : r.authority,
      committed_at: ctx.store.now(),
      ...(r.kind === 'report' && { source_signature: sourceSignature(ctx, r.project_id) }),
    },
    r.revision,
  );
  indexMemory(ctx, next, body(ctx, next).text);
  sweep(ctx, r.project_id);
  // A plan entry checked the budget before it chose its kind, and must not fail the plan write.
  if (!r.origin) assertDecisionBudget(ctx, r.project_id);
  changed(ctx, r.project_id);
  ctx.store.event('memory.committed', next, r.project_id, { memory_id: next.id, by }, commandId);
  return body(ctx, next);
}

function propose(ctx: ControlContext, p: Principal, c: Command, verifiedCommit?: string) {
  const i = inputSchemas['memory.propose'].parse(c.input);
  ensureProject(ctx, p, i.project_id, c.type);
  const session = sessionFor(ctx, p);
  const own = sessionTaskScope(session);
  const task = taskScope(i.task) ?? own;
  requireThat(
    !session || !i.task || (!!own && hash(taskScope(i.task)) === hash(own)),
    'permission_denied',
    'A session may propose only in its own task scope',
  );
  requireThat(
    taskCurrent(ctx, { project_id: i.project_id, task }),
    'invalid_state',
    'Task generation is no longer current',
  );
  const stamp = signature(ctx, i.project_id);
  requireThat(
    !session || !!i.based_on,
    'invalid_input',
    'Read memory_context and supply based_on before proposing',
  );
  requireThat(
    !i.based_on || i.based_on === stamp,
    'revision_conflict',
    'Read current memory before proposing',
  );
  const active = current(ctx, i.project_id).filter((r) => visible(r, session));
  requireThat(
    i.dependencies.every((k) => active.some((r) => r.id === k)),
    'invalid_input',
    'Dependencies must be current visible memory versions',
  );
  requireThat(
    !i.expires_at || i.expires_at > ctx.store.now(),
    'invalid_input',
    'Expiry must be in the future',
  );
  requireThat(
    i.kind !== 'decision' || i.dependencies.length === 0,
    'invalid_input',
    'Decisions cannot derive authority from another memory',
  );
  const r: MemoryRecord = {
    id: id(),
    revision: 1,
    project_id: i.project_id,
    key: i.key,
    title: i.title,
    summary: i.summary,
    tags: i.tags && [...new Set(i.tags)],
    references: captureReferences(ctx, i.project_id, i.references),
    kind: i.kind,
    state: 'draft',
    authority: p.role === 'user' && !p.session_id ? 'user' : 'agent_reported',
    author: p.id,
    author_session_id: p.session_id,
    task,
    body_hash: ctx.files.put(Buffer.from(i.text)).hash,
    dependencies: i.dependencies,
    based_on: stamp,
    created_at: ctx.store.now(),
    verified_commit: verifiedCommit,
    expires_at: i.expires_at,
  };
  ctx.store.insert('memory_records', r);
  indexMemory(ctx, r, i.text);
  ctx.store.event(
    'memory.proposed',
    r,
    r.project_id,
    { memory_id: r.id, authority: r.authority, by: p.id },
    c.command_id,
  );
  // An agent's report or note is current at once; only decisions wait for the user.
  if (r.authority === 'agent_reported' && r.kind !== 'decision')
    return activate(ctx, r, p.id, c.command_id);
  return body(ctx, r);
}

export const memoryHandlers: Handlers = {
  'memory.maintain': (ctx, p, c) => {
    userOnly(p);
    const i = inputSchemas['memory.maintain'].parse(c.input);
    ensureProject(ctx, p, i.project_id, c.type);
    const stamp = signature(ctx, i.project_id);
    for (const job of rows<MemoryJob>(ctx, 'memory_jobs', i.project_id))
      if (
        job.signature === stamp &&
        (job.state === 'failed' ||
          (job.state === 'done' && (!job.body_hash || !ctx.files.valid(job.body_hash))))
      )
        ctx.store.update<MemoryJob>(
          'memory_jobs',
          {
            ...job,
            state: 'pending',
            attempts: 0,
            error: undefined,
            retry_at: undefined,
          },
          job.revision,
        );
    sweep(ctx, i.project_id);
    enqueue(ctx, i.project_id);
    return { queued: true };
  },
  'memory.propose': (ctx, p, c) => propose(ctx, p, c),
  'memory.commit': (ctx, p, c) => {
    userOnly(p);
    const i = inputSchemas['memory.commit'].parse(c.input),
      r = ctx.store.must<MemoryRecord>('memory_records', i.memory_id);
    ensureProject(ctx, p, r.project_id, c.type);
    revision(ctx, c, r);
    requireThat(r.state === 'draft', 'invalid_state', 'Only a draft can be committed');
    requireThat(
      r.based_on === signature(ctx, r.project_id),
      'revision_conflict',
      'Sources changed; review a fresh proposal',
    );
    requireThat(
      taskCurrent(ctx, r) && (!r.expires_at || r.expires_at > ctx.store.now()),
      'invalid_state',
      'Proposal expired',
    );
    requireThat(
      r.dependencies.every((k) => current(ctx, r.project_id).some((a) => a.id === k)),
      'invalid_state',
      'A dependency is no longer current',
    );
    return activate(ctx, r, p.id, c.command_id);
  },
  'memory.archive': (ctx, p, c) => {
    userOnly(p);
    const i = inputSchemas['memory.archive'].parse(c.input),
      r = ctx.store.must<MemoryRecord>('memory_records', i.memory_id);
    ensureProject(ctx, p, r.project_id, c.type);
    revision(ctx, c, r);
    requireThat(r.state !== 'archived', 'invalid_state', 'Already archived');
    const all = records(ctx, r.project_id);
    const validBefore = new Set(current(ctx, r.project_id).map((record) => record.id));
    let next = archive(ctx, r, 'retracted');
    const affected = [{ record: r, archived_revision: next.revision + 1 }];
    if (r.state === 'active') {
      const validAfter = new Set(current(ctx, r.project_id).map((record) => record.id));
      for (const record of all)
        if (record.id !== r.id && validBefore.has(record.id) && !validAfter.has(record.id)) {
          const archived = archive(ctx, record, 'stale');
          affected.push({ record, archived_revision: archived.revision });
        }
    }
    next = ctx.store.update<MemoryRecord>(
      'memory_records',
      {
        ...next,
        retraction: {
          records: affected,
          committed_ids: all
            .filter((record) => record.committed_at !== undefined)
            .map((record) => record.id),
        },
      },
      next.revision,
    );
    if (r.state === 'active') {
      changed(ctx, r.project_id);
    }
    ctx.store.event(
      'memory.archived',
      next,
      r.project_id,
      { memory_id: r.id, archived_ids: affected.map(({ record }) => record.id), by: p.id },
      c.command_id,
    );
    return {
      ...next,
      archived_ids: affected.map(({ record }) => record.id),
    } satisfies MemoryArchiveResult;
  },
  'memory.undo_retraction': (ctx, p, c) => {
    userOnly(p);
    const input = inputSchemas['memory.undo_retraction'].parse(c.input);
    const root = ctx.store.must<MemoryRecord>('memory_records', input.memory_id);
    ensureProject(ctx, p, root.project_id, c.type);
    revision(ctx, c, root);
    const retraction = root.retraction;
    requireThat(
      root.state === 'archived' && root.reason === 'retracted' && retraction,
      'memory_not_retracted',
      'This record was not archived by an undoable retraction',
    );
    const all = records(ctx, root.project_id);
    const replaced = (record: MemoryRecord) =>
      all.some(
        (other) =>
          other.committed_at !== undefined &&
          !retraction.committed_ids.includes(other.id) &&
          sameScope(other, record),
      );
    requireThat(
      !replaced(root),
      'memory_retraction_replaced',
      'A newer version of this key was committed after the retraction',
    );
    const result: MemoryUndoRetractionResult = { restored_ids: [], skipped: [] };
    let restoredRoot = root;
    for (const { record, archived_revision } of retraction.records) {
      const now = ctx.store.must<MemoryRecord>('memory_records', record.id);
      if (now.revision !== archived_revision) {
        result.skipped.push({ memory_id: record.id, reason: 'changed' });
        continue;
      }
      if (replaced(record)) {
        result.skipped.push({ memory_id: record.id, reason: 'replaced' });
        continue;
      }
      const restored = ctx.store.update<MemoryRecord>('memory_records', record, now.revision);
      if (record.id === root.id) restoredRoot = restored;
      result.restored_ids.push(record.id);
    }
    assertDecisionBudget(ctx, root.project_id);
    if (restoredRoot.state === 'active') changed(ctx, root.project_id);
    ctx.store.event(
      'memory.retraction_undone',
      restoredRoot,
      root.project_id,
      { memory_id: root.id, ...result, by: p.id },
      c.command_id,
    );
    return result;
  },
  'memory.restore': (ctx, p, c) => {
    userOnly(p);
    const i = inputSchemas['memory.restore'].parse(c.input),
      r = ctx.store.must<MemoryRecord>('memory_records', i.memory_id);
    ensureProject(ctx, p, r.project_id, c.type);
    revision(ctx, c, r);
    const invalidated =
      r.state === 'active' && !current(ctx, r.project_id).some((active) => active.id === r.id);
    requireThat(
      r.state === 'archived' || invalidated,
      'invalid_state',
      'Only archived versions can be restored',
    );
    if (invalidated) archive(ctx, r, 'stale');
    const restored: MemoryRecord = {
      id: id(),
      revision: 1,
      project_id: r.project_id,
      key: r.key,
      title: r.title,
      summary: r.summary,
      tags: r.tags,
      references: r.references,
      kind: r.kind,
      task: r.task,
      body_hash: r.body_hash,
      dependencies: [...r.dependencies],
      based_on: signature(ctx, r.project_id),
      authority: r.authority,
      author: p.id,
      state: 'draft',
      restored_from: r.id,
      created_at: ctx.store.now(),
    };
    ctx.store.insert('memory_records', restored);
    indexMemory(ctx, restored, body(ctx, restored).text);
    ctx.store.event(
      'memory.restored_as_draft',
      restored,
      r.project_id,
      { restored_from: r.id, by: p.id },
      c.command_id,
    );
    return body(ctx, restored);
  },
  'memory.get': (ctx, p, c) => {
    const i = inputSchemas['memory.get'].parse(c.input),
      r = ctx.store.must<MemoryRecord>('memory_records', i.memory_id);
    ensureProject(ctx, p, r.project_id, c.type);
    requireThat(
      visible(r, sessionFor(ctx, p)) && current(ctx, r.project_id).some((a) => a.id === r.id),
      'not_found',
      'No current memory with this id',
    );
    const now = ctx.store.now(),
      used =
        p.session_id && now - (r.last_used_at ?? -Infinity) >= 24 * 60 * 60 * 1000
          ? ctx.store.update<MemoryRecord>(
              'memory_records',
              { ...r, last_used_at: now },
              r.revision,
            )
          : r;
    return {
      ...body(ctx, used),
      reference_status: referenceStatus(ctx, r.project_id, r.references ?? []),
    };
  },
  'memory.search': (ctx, p, c) =>
    searchMemory(ctx, p, inputSchemas['memory.search'].parse(c.input)),
  'memory.related': (ctx, p, c) =>
    relatedMemory(ctx, p, inputSchemas['memory.related'].parse(c.input)),
  'memory.context': (ctx, p, c) => {
    const i = inputSchemas['memory.context'].parse(c.input);
    ensureProject(ctx, p, i.project_id, c.type);
    const session = sessionFor(ctx, p),
      packet = memoryContext(ctx, i.project_id, session, i.max_bytes);
    if (session)
      ctx.store.update<Session>(
        'sessions',
        { ...session, memory_observed_signature: packet.signature },
        session.revision,
      );
    return packet;
  },
  'memory.history': (ctx, p, c) => {
    userOnly(p);
    const i = inputSchemas['memory.history'].parse(c.input);
    ensureProject(ctx, p, i.project_id, c.type);
    return {
      items: records(ctx, i.project_id)
        .filter((r) => (!i.key || r.key === i.key) && (!i.ids || i.ids.includes(r.id)))
        .reverse()
        .slice(0, i.limit)
        .map((r) => body(ctx, r)),
      historical: true,
    };
  },
};

/** A session's proposal with a file reference reads HEAD of the first root before the transaction. */
export const memoryPreparers: Preparers = {
  'memory.propose': (ctx, p, c) => {
    const i = inputSchemas['memory.propose'].parse(c.input);
    const root = ctx.store.get<Project>('projects', i.project_id)?.roots[0];
    if (!p.session_id || !root || !i.references?.some((ref) => ref.kind === 'file'))
      return memoryHandlers['memory.propose']!;
    return runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], undefined, true).then(
      (head): Handler => {
        const commit = head.exit_code === 0 ? head.stdout.toString().trim() : undefined;
        return (ctx, p, c) => propose(ctx, p, c, commit);
      },
    );
  },
};

export function prepareMemoryDelivery(
  ctx: ControlContext,
  session: Session,
  turnId: string,
): MemoryContext | undefined {
  // Purpose-bound trace diagnosis deliberately has no memory authority or tools.
  if (session.runtime_review) return;
  // Skips the task-graph scan on every turn for a project without memory.
  if (
    !session.memory_delivery &&
    !state(ctx, session.project_id)?.epoch &&
    !rows<Improvement>(ctx, 'improvements', session.project_id).some(
      (i) => i.change.type === 'experience' && (i.status === 'trial' || i.status === 'active'),
    )
  )
    return;
  // A task session takes its trial arms once, with its first packet.
  const packet = memoryContext(
    ctx,
    session.project_id,
    session,
    undefined,
    undefined,
    !session.memory_delivery,
  );
  if (
    !session.memory_delivery &&
    !packet.epoch &&
    !packet.items.length &&
    !packet.experiences.length
  )
    return;
  // After a revocation, an empty packet must still replace the earlier experience packet.
  const fresh = ctx.store.must<Session>('sessions', session.id);
  // The native session keeps a delivered packet in its context until it compacts.
  if (
    fresh.memory_delivery?.delivered_signature === packet.signature &&
    ctx.store
      .kindEvents(session.project_id, ['memory.delivered', 'agent.context.compacted'])
      .findLast((event) => event.aggregate_id === session.id)?.kind === 'memory.delivered'
  )
    return;
  ctx.store.update<Session>(
    'sessions',
    {
      ...fresh,
      memory_delivery: {
        ...fresh.memory_delivery,
        prepared_signature: packet.signature,
        prepared_epoch: packet.epoch,
        context_hash: hash(packet),
        turn_id: turnId,
      },
    },
    fresh.revision,
  );
  return packet;
}
export function finishMemoryDelivery(
  ctx: ControlContext,
  sessionId: string,
  turnId: string,
  packet: MemoryContext,
  accepted: boolean,
): void {
  if (!accepted) return;
  ctx.store.transaction(() => {
    const s = ctx.store.must<Session>('sessions', sessionId),
      delivery = s.memory_delivery;
    if (
      !delivery ||
      (delivery.turn_id === turnId && delivery.prepared_signature !== packet.signature)
    )
      return;
    // A later turn's packet was prepared meanwhile; it replaces this one only once acknowledged.
    if (delivery.turn_id === turnId || !acknowledgedAfter(ctx, sessionId, turnId))
      ctx.store.update<Session>(
        'sessions',
        {
          ...s,
          memory_delivery: {
            ...delivery,
            delivered_signature: packet.signature,
            delivered_epoch: packet.epoch,
            delivered_experience_ids: packet.experiences.map((item) => item.id),
          },
        },
        s.revision,
      );
    ctx.store.event('memory.delivered', s, s.project_id, {
      turn_id: turnId,
      signature: packet.signature,
      epoch: packet.epoch,
      memory_ids: packet.items.map((item) => item.id),
    });
  });
}

function acknowledgedAfter(ctx: ControlContext, sessionId: string, turnId: string): boolean {
  const turns = ctx.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === sessionId),
    later = new Set(
      turns.slice(turns.findIndex((turn) => turn.id === turnId) + 1).map((t) => t.id),
    );
  return ctx.store
    .kindEvents(ctx.store.must<Session>('sessions', sessionId).project_id, ['memory.delivered'])
    .some(
      (event) =>
        event.aggregate_id === sessionId &&
        later.has((event.payload as { turn_id?: string }).turn_id ?? ''),
    );
}

/** A project's local instruction files and Claude's native memory files for its folders. */
function memoryFiles(ctx: ControlContext, project: Project) {
  const home = ctx.protectionPaths?.home ?? os.homedir();
  // Claude Code names a folder's native memory directory after its path with every other character a dash.
  const slug = (folder: string) => folder.replace(/[^a-zA-Z0-9]/g, '-');
  const markdown = (folder: string) =>
    existsSync(folder)
      ? readdirSync(folder)
          .filter((name) => name.endsWith('.md') && name !== 'MEMORY.md')
          .map((name) => path.join(folder, name))
      : [];
  const files: { key: string; file: string; authority: MemoryRecord['authority']; tag: string }[] =
    [];
  project.roots.forEach((root, index) => {
    for (const name of ['CLAUDE.md', 'AGENTS.md'])
      if (existsSync(path.join(root, name)))
        files.push({
          key: `import:root${index}/${name}`,
          file: path.join(root, name),
          authority: 'user',
          tag: 'instructions',
        });
    for (const file of markdown(path.join(home, '.claude/projects', slug(root), 'memory')))
      files.push({
        key: `import:root${index}/claude-memory/${path.basename(file)}`,
        file,
        authority: 'agent_reported',
        tag: 'native-memory',
      });
  });
  // Sessions outside the user's folder keep Claude's native memory in Pantheon's own native state.
  const managed = path.resolve(
    path.dirname(ctx.files.directory),
    'native-sessions',
    project.id,
    'claude',
    'projects',
  );
  for (const folder of existsSync(managed) ? readdirSync(managed) : [])
    for (const file of markdown(path.join(managed, folder, 'memory')))
      files.push({
        key: `import:sessions/${hash(folder).slice(0, 8)}/${path.basename(file)}`,
        file,
        authority: 'agent_reported',
        tag: 'native-memory',
      });
  return files;
}

/** Imports changed instruction and native memory files as current notes; a removed file's note is archived. */
export function syncMemoryFiles(ctx: ControlContext, project: Project): void {
  const all = records(ctx, project.id);
  const files = memoryFiles(ctx, project);
  for (const source of files) {
    const text = readFileSync(source.file, 'utf8');
    const latest = all
      .filter((r) => r.key === source.key && !r.task)
      .sort((a, b) => a.created_at - b.created_at)
      .at(-1);
    // An unchanged file is skipped, also when the user archived its note.
    if (latest?.body_hash === createHash('sha256').update(text).digest('hex')) continue;
    const meta = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(meta)?.[1]?.trim();
    const r: MemoryRecord = {
      id: id(),
      revision: 1,
      project_id: project.id,
      key: source.key,
      title: (field('name') ?? path.basename(source.file)).slice(0, 160),
      summary: field('description')?.slice(0, 400),
      tags: ['imported', source.tag],
      kind: 'note',
      state: 'draft',
      authority: source.authority,
      author: 'pantheon:import',
      body_hash: ctx.files.put(Buffer.from(text)).hash,
      dependencies: [],
      based_on: signature(ctx, project.id),
      created_at: ctx.store.now(),
    };
    ctx.store.insert('memory_records', r);
    activate(ctx, r, r.author, '');
  }
  const keys = new Set(files.map((source) => source.key));
  const gone = current(ctx, project.id).filter(
    (r) => r.tags?.includes('imported') && !keys.has(r.key),
  );
  for (const r of gone) archive(ctx, r, 'retracted');
  if (gone.length) changed(ctx, project.id);
}

/** A decision Pantheon takes from a lead's plan, current at once and never confirmed by the user. */
export interface PlanMemoryEntry {
  project_id: string;
  key: string;
  title: string;
  summary: string;
  tags: string[];
  text: string;
  origin: NonNullable<MemoryRecord['origin']>;
}

/**
 * Writes the entry as the current version of its key, unless that version has the same text; one
 * that does not fit the decision budget is kept as a note. It never throws, so the plan write stands.
 */
export function writePlanMemory(
  ctx: ControlContext,
  entry: PlanMemoryEntry,
  commandId: string,
): void {
  const project = entry.project_id;
  const same = current(ctx, project).filter((r) => r.key === entry.key && !r.task);
  if (same.some((r) => r.body_hash === createHash('sha256').update(entry.text).digest('hex')))
    return;
  const r: MemoryRecord = {
    id: id(),
    revision: 1,
    project_id: project,
    key: entry.key,
    title: entry.title,
    summary: entry.summary,
    tags: entry.tags,
    kind: 'decision',
    state: 'draft',
    authority: 'agent_reported',
    author: 'pantheon:plan',
    body_hash: ctx.files.put(Buffer.from(entry.text)).hash,
    dependencies: [],
    based_on: signature(ctx, project),
    created_at: ctx.store.now(),
    origin: entry.origin,
  };
  const used = decisionBytes(ctx, project)
    .filter(({ record }) => !same.some((old) => old.id === record.id))
    .reduce((total, item) => total + item.bytes, 0);
  const size = memoryItemBytes(ctx, { ...r, state: 'active', committed_at: ctx.store.now() });
  if (used + size > DECISION_BUDGET) r.kind = 'note';
  ctx.store.insert('memory_records', r);
  // activate replaces only a version of the same kind.
  for (const old of same) if (old.kind !== r.kind) archive(ctx, old, 'superseded', r.id);
  activate(ctx, r, r.author, commandId);
}

const FILE_SYNC_MS = 60_000;
const fileSyncs = new WeakMap<ControlContext, Map<string, number>>();

/** Durable, bounded local maintenance. No model runs, network, or external memory dependency. */
export function tickMemory(ctx: ControlContext): void {
  ctx.store.transaction(() => backfillMemoryIndex(ctx));
  let synced = fileSyncs.get(ctx);
  if (!synced) fileSyncs.set(ctx, (synced = new Map()));
  for (const project of ctx.store.list<Project>('projects'))
    ctx.store.transaction(() => {
      if (ctx.store.now() - (synced.get(project.id) ?? -Infinity) >= FILE_SYNC_MS) {
        synced.set(project.id, ctx.store.now());
        syncMemoryFiles(ctx, project);
      }
      if (
        !records(ctx, project.id).length &&
        !rows<BoardPlan>(ctx, 'board_plans', project.id).length &&
        !rows<Improvement>(ctx, 'improvements', project.id).length
      )
        return;
      // An archive in sweep changes the signature, so enqueue then computes it again.
      const kept = sweep(ctx, project.id);
      enqueue(ctx, project.id, kept && signature(ctx, project.id, ...kept));
    });
  const now = ctx.store.now();
  // A single job per tick, with a reclaimable lease after a crash.
  const job = ctx.store
    .list<MemoryJob>('memory_jobs')
    .find(
      (j) =>
        (j.state === 'pending' && (!j.retry_at || j.retry_at <= now)) ||
        (j.state === 'running' && (j.lease_until ?? 0) <= now),
    );
  if (!job) return;
  let running = ctx.store.transaction(() =>
    ctx.store.update<MemoryJob>(
      'memory_jobs',
      { ...job, state: 'running', attempts: job.attempts + 1, lease_until: now + 30000 },
      job.revision,
    ),
  );
  try {
    ctx.failpoint('memory_before_projection');
    const packet = memoryContext(ctx, job.project_id, undefined, 24000, false),
      snapshot = sources(ctx, job.project_id);
    const text = [
      '# Current project memory',
      `Source signature: ${packet.signature}`,
      '',
      '## Confirmed decisions and reviewed evidence',
      JSON.stringify(packet.items, null, 2),
      '## Task state (accepted reports are not independent test verification)',
      JSON.stringify(snapshot.tasks, null, 2),
      '## Applicable project-wide improvement procedures (trial is provisional)',
      JSON.stringify(packet.experiences, null, 2),
      `Omitted memory entries: ${packet.omitted}. Use memory_search for targeted reading.`,
    ].join('\n');
    const artifact = ctx.files.put(Buffer.from(text));
    ctx.failpoint('memory_before_publish');
    ctx.store.transaction(() => {
      const fresh = ctx.store.must<MemoryJob>('memory_jobs', running.id);
      requireThat(
        fresh.revision === running.revision && fresh.state === 'running',
        'revision_conflict',
        'Memory job lease changed',
      );
      const valid =
        signature(ctx, job.project_id) === job.signature && packet.signature === job.signature;
      ctx.store.update<MemoryJob>(
        'memory_jobs',
        {
          ...fresh,
          state: valid ? 'done' : 'obsolete',
          completed_at: ctx.store.now(),
          lease_until: undefined,
          ...(valid && { body_hash: artifact.hash }),
        },
        fresh.revision,
      );
      ctx.store.event('memory.maintained', fresh, fresh.project_id, {
        state: valid ? 'done' : 'obsolete',
      });
    });
  } catch (error) {
    const fresh = ctx.store.must<MemoryJob>('memory_jobs', running.id);
    if (fresh.revision !== running.revision) return;
    ctx.store.update<MemoryJob>(
      'memory_jobs',
      {
        ...fresh,
        state: fresh.attempts >= 3 ? 'failed' : 'pending',
        error: String(error).slice(0, 500),
        lease_until: undefined,
        retry_at: now + 1000 * 2 ** fresh.attempts,
      },
      fresh.revision,
    );
  }
}

/** Gate control-plane completion against current memory; a user may still explicitly decide. */
export function assertMemoryFresh(ctx: ControlContext, p: Principal, action: string): void {
  if (!p.session_id || !['task.accept', 'milestone.accept', 'session.merge'].includes(action))
    return;
  const s = ctx.store.must<Session>('sessions', p.session_id);
  if (!records(ctx, s.project_id).some((r) => r.committed_at !== undefined)) return;
  const currentSignature = signature(ctx, s.project_id);
  requireThat(
    s.memory_delivery?.delivered_signature === currentSignature ||
      s.memory_observed_signature === currentSignature,
    'memory_refresh_required',
    'Project memory changed. Read memory_context and recheck the decision before accepting or merging work',
  );
}
