import {
  requireThat,
  type Event,
  type LandingItem,
  type PlanItem,
  type Principal,
  type ProjectPlan,
  type Review,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import {
  inputSchemas,
  type ChangeRow,
  type PlanItemView,
  type ProjectPlanResult,
  type ProjectPlanView,
  type WorkbenchSession,
} from '@pantheon/protocol';
import { projectChanges } from './changes.js';
import {
  projectAccess,
  revision,
  userOnly,
  type ControlContext,
  type Handler,
  type Preparers,
} from './context.js';
import { planItemEvidence } from './evidence-level.js';
import { gateFailed } from './landing.js';
import { latestEvent, needsYou } from './needs-you.js';
import { landedSince } from './project-brief.js';
import { sessionStall } from './session-stall.js';
import { sessionList } from './workbench-session.js';

const TABLE = 'project_plans';

/** The first id that appears twice. */
const duplicate = (ids: string[]) => ids.find((each, index) => ids.indexOf(each) !== index);

/** An item on a dependency cycle, if any. */
function onCycle(items: { id: string; depends_on?: string[] }[]): string | undefined {
  const dependsOn = new Map(items.map((item) => [item.id, item.depends_on ?? []]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (itemId: string): string | undefined => {
    if (state.get(itemId) === 'done') return;
    if (state.get(itemId) === 'visiting') return itemId;
    state.set(itemId, 'visiting');
    for (const each of dependsOn.get(itemId) ?? []) {
      const found = visit(each);
      if (found) return found;
    }
    state.set(itemId, 'done');
  };
  for (const item of items) {
    const found = visit(item.id);
    if (found) return found;
  }
}

/** Whether a plan item may name the session: the caller, a main agent, or a session a main agent spawned. */
function nameable(ctx: ControlContext, callerId: string, projectId: string, sessionId: string) {
  if (sessionId === callerId) return true;
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (session?.project_id !== projectId) return false;
  if (session.conductor) return true;
  const spawner =
    session.spawned_by && ctx.store.get<Session>('sessions', session.spawned_by.session_id);
  return Boolean(spawner?.conductor);
}

/** conductor.plan_set; the last write wins. */
const setPlan: Handler = (ctx, p, command): ProjectPlanResult => {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  const projectId = p.project_id ?? '';
  projectAccess(ctx, p, projectId, command.type);
  revision(ctx, command);
  const input = inputSchemas['conductor.plan_set'].parse(command.input);
  const milestoneIds = input.milestones.map((each) => each.id);
  const itemIds = input.items.map((each) => each.id);
  const twiceMilestone = duplicate(milestoneIds);
  requireThat(!twiceMilestone, 'invalid_input', `Milestone id ${twiceMilestone} appears twice`);
  const twiceItem = duplicate(itemIds);
  requireThat(!twiceItem, 'invalid_input', `Item id ${twiceItem} appears twice`);
  for (const item of input.items) {
    requireThat(
      item.milestone === undefined || milestoneIds.includes(item.milestone),
      'invalid_input',
      `Item ${item.id} names milestone ${item.milestone}, which the plan does not have`,
    );
    const missing = item.depends_on?.find((each) => !itemIds.includes(each));
    requireThat(
      !missing,
      'invalid_input',
      `Item ${item.id} depends on ${missing}, which the plan does not have`,
    );
    const twiceSession = duplicate(item.session_ids ?? []);
    requireThat(
      !twiceSession,
      'invalid_input',
      `Item ${item.id} names session ${twiceSession} twice`,
    );
    const foreign = item.session_ids?.find(
      (each) => !nameable(ctx, p.session_id!, projectId, each),
    );
    requireThat(
      !foreign,
      'invalid_input',
      `Item ${item.id} names session ${foreign}, which is not you, a main agent or a session a main agent spawned in this project`,
    );
  }
  const cyclic = onCycle(input.items);
  requireThat(!cyclic, 'invalid_input', `Item ${cyclic} depends on itself through depends_on`);
  const before = ctx.store.get<ProjectPlan>(TABLE, projectId);
  const kept = before?.items.find((item) => item.accepted && !itemIds.includes(item.id));
  requireThat(
    !kept,
    'invalid_input',
    `The user accepted item ${kept?.id}; keep it in the plan, marked dropped if you give it up`,
  );
  const now = new Date(ctx.store.now()).toISOString();
  const items = input.items.map((item): PlanItem => {
    const old = before?.items.find((each) => each.id === item.id);
    const named = item.session_ids?.length
      ? {
          named_at: Object.fromEntries(
            item.session_ids.map((each) => [each, old?.named_at?.[each] ?? now]),
          ),
        }
      : {};
    return { ...item, ...named, ...(old?.accepted ? { accepted: old.accepted } : {}) };
  });
  const value: ProjectPlan = {
    id: projectId,
    revision: 1,
    project_id: projectId,
    session_id: p.session_id!,
    milestones: input.milestones,
    items,
    updated_at: now,
  };
  const plan = before
    ? ctx.store.update(TABLE, value, before.revision)
    : ctx.store.insert(TABLE, value);
  ctx.store.event(
    'project.plan_updated',
    plan,
    projectId,
    { session_id: plan.session_id, items: items.length, revision: plan.revision },
    command.command_id,
  );
  return { revision: plan.revision, plan };
};

/** project.plan.accept */
const acceptItem: Handler = (ctx, p, command): ProjectPlanResult => {
  userOnly(p);
  const input = inputSchemas['project.plan.accept'].parse(command.input);
  projectAccess(ctx, p, input.project_id, command.type);
  const before = ctx.store.must<ProjectPlan>(TABLE, input.project_id);
  revision(ctx, command, before);
  requireThat(
    before.items.some((item) => item.id === input.item_id),
    'not_found',
    `The plan has no item ${input.item_id}`,
  );
  const items = before.items.map((item) => {
    if (item.id !== input.item_id) return item;
    const { accepted: _accepted, ...rest } = item;
    return input.accepted
      ? { ...rest, accepted: { at: new Date(ctx.store.now()).toISOString() } }
      : rest;
  });
  const plan = ctx.store.update(TABLE, { ...before, items }, before.revision);
  ctx.store.event(
    'project.plan_accepted',
    plan,
    plan.project_id,
    { item_id: input.item_id, accepted: input.accepted },
    command.command_id,
  );
  return { revision: plan.revision, plan };
};

export const projectPlanPreparers: Preparers = {
  'conductor.plan_set': () => setPlan,
  'project.plan.accept': () => acceptItem,
};

type GateResults = NonNullable<LandingItem['gate_results']>;
type Diff = NonNullable<PlanItemView['diff']>;

/** Where one session of an item stands; rank orders the sessions of an item, lowest first. */
interface SessionPlace {
  session_id: string;
  stage: PlanItemView['stage'];
  status: PlanItemView['status'];
  rank: number;
  change?: ChangeRow;
  listed?: WorkbenchSession;
  merged?: Event;
}

const STAGE_RANK: Partial<Record<PlanItemView['stage'], number>> = {
  landed: 0,
  merge: 2,
  review: 3,
  checks: 4,
  write: 5,
};
const FAILED_RANK = 6;
const ABANDONED_RANK = 7;

interface PlanFacts {
  rows: Map<string, ChangeRow>;
  listed: Map<string, WorkbenchSession>;
  merges: Event[];
  checked: Event[];
  notices: Event[];
}

const iso = (at: number) => new Date(at).toISOString();

function sessionPlace(
  ctx: ControlContext,
  item: PlanItem,
  sessionId: string,
  facts: PlanFacts,
): SessionPlace {
  const namedAt = Date.parse(item.named_at?.[sessionId] ?? '') || 0;
  const merged = facts.merges.findLast(
    (event) => event.aggregate_id === sessionId && event.created_at >= namedAt,
  );
  const change = facts.rows.get(`session:${sessionId}`),
    listed = facts.listed.get(sessionId);
  const known = {
    session_id: sessionId,
    ...(change ? { change } : {}),
    ...(listed ? { listed } : {}),
  };
  if (merged) return { ...known, merged, stage: 'landed', status: 'merged', rank: 0 };
  const session = ctx.store.get<Session>('sessions', sessionId);
  if (!session || session.state === 'closed' || session.outcome === 'discarded')
    return { ...known, stage: 'abandoned', status: 'abandoned', rank: ABANDONED_RANK };
  const status = change?.status ?? (session.state === 'running' ? 'running' : 'not_started');
  // A committed session reads ready before its review or gate passes, so those come first.
  const stage: PlanItemView['stage'] = change?.landing
    ? 'merge'
    : change?.review && (change.review.state === 'running' || change.review.blocking_open > 0)
      ? 'review'
      : change?.gate.state === 'running' || change?.gate.state === 'failed'
        ? 'checks'
        : status === 'ready'
          ? 'merge'
          : 'write';
  const rank = status === 'failed' ? FAILED_RANK : change?.landing ? 1 : STAGE_RANK[stage]!;
  return { ...known, stage, status, rank };
}

const runVerdict = (checked: Event): PlanItemView['gate_runs'][number] => {
  const results = (checked.payload as { results?: GateResults }).results ?? [];
  return results.some(gateFailed)
    ? 'failed'
    : results.every((result) => result.state === 'skipped')
      ? 'skipped'
      : 'passed';
};

/** The first failure that applies, in the order the plan view names them. */
function placeFailure(
  ctx: ControlContext,
  place: SessionPlace,
  facts: PlanFacts,
): PlanItemView['failure'] {
  const { change, listed } = place;
  // A stale gate reads as not run, as in gate_runs.
  const lastCheck =
    listed?.gate?.state === 'stale'
      ? undefined
      : facts.checked.findLast((event) => event.aggregate_id === place.session_id);
  const failedStep = (lastCheck?.payload as { results?: GateResults } | undefined)?.results?.find(
    gateFailed,
  )?.name;
  const wait = listed?.run?.wait;
  const review = change?.review?.blocking_open
    ? ctx.store.get<Review>('reviews', change.review.id)
    : undefined;
  const finding = review?.findings.find(
    (each) =>
      (each.status === 'open' || each.status === 'stale') && each.blocking && !each.resolution,
  );
  const found =
    failedStep && lastCheck
      ? { reason: failedStep, at: lastCheck.created_at }
      : listed?.last_turn?.error
        ? {
            reason: listed.last_turn.error,
            at:
              latestEvent(ctx, listed.last_turn.id, 'turn.failed')?.created_at ??
              Date.parse(listed.last_activity_at),
          }
        : wait && (wait.reason === 'gate_failed' || wait.reason === 'merge_blocked')
          ? { reason: wait.reason, at: wait.since }
          : finding
            ? {
                reason: finding.impact,
                at: review!.ended_at ?? review!.started_at ?? Date.parse(change!.updated_at),
              }
            : undefined;
  if (!found) return;
  const told = facts.notices.some(
    (event) => event.aggregate_id === place.session_id && event.created_at >= found.at,
  );
  return { reason: found.reason, at: iso(found.at), handled_by: told ? 'main_agent' : 'you' };
}

function itemView(ctx: ControlContext, item: PlanItem, facts: PlanFacts): PlanItemView {
  const sessionIds = item.session_ids ?? [];
  if (!sessionIds.length)
    return {
      ...item,
      stage: item.dropped ? 'dropped' : 'plan',
      status: 'not_started',
      gate_runs: [],
    };
  const place = sessionIds
    .map((each) => sessionPlace(ctx, item, each, facts))
    .reduce((best, each) => (each.rank < best.rank ? each : best));
  const { change, listed, merged } = place;
  const diff = merged
    ? (({ files, additions, deletions }) => ({ files, additions, deletions }))(
        merged.payload as Diff,
      )
    : change?.changes;
  const checks = facts.checked.filter((event) => event.aggregate_id === place.session_id);
  // A stale gate reads as not run.
  if (listed?.gate?.state === 'stale') checks.pop();
  const open = place.stage !== 'landed' && place.stage !== 'abandoned';
  const failure = open ? placeFailure(ctx, place, facts) : undefined;
  const session = ctx.store.get<Session>('sessions', place.session_id);
  const stall =
    open && session?.state === 'running' && listed?.last_turn?.state === 'running'
      ? sessionStall(ctx, session, ctx.store.get<SessionTurn>('session_turns', listed.last_turn.id))
      : undefined;
  const review = merged
    ? ctx.store.list<Review>('reviews').findLast((each) => each.session_id === place.session_id)
    : undefined;
  const lastCheck = merged && checks.findLast((event) => event.created_at <= merged.created_at);
  const evidence = planItemEvidence({
    landed: Boolean(merged),
    accepted: Boolean(item.accepted),
    ...(lastCheck ? { gate: runVerdict(lastCheck) } : {}),
    ...(review
      ? {
          review: {
            failed: review.state === 'failed',
            ...(review.range ? { to_sha: review.range.to_sha } : {}),
            verdicts: (review.verdicts ?? []).map(({ runtime, verdict }) => ({ runtime, verdict })),
          },
        }
      : {}),
    ...((merged?.payload as { head_sha?: string } | undefined)?.head_sha
      ? { landed_head: (merged!.payload as { head_sha: string }).head_sha }
      : {}),
    ...(session ? { writer: session.runtime } : {}),
  });
  return {
    ...item,
    stage: item.dropped ? 'dropped' : place.stage,
    status: place.status,
    ...(change ? { change } : {}),
    ...(diff ? { diff } : {}),
    gate_runs: checks.slice(-5).map(runVerdict),
    ...(failure ? { failure } : {}),
    ...(stall !== undefined ? { stuck_since: iso(stall) } : {}),
    ...(evidence ? { evidence } : {}),
  };
}

/** The newer of the newest branch landing and the newest session merge. */
function latestLanding(
  ctx: ControlContext,
  projectId: string,
  merges: Event[],
): ProjectPlanView['latest_landing'] {
  const landing = landedSince(ctx, projectId, 0).reduce<
    ReturnType<typeof landedSince>[number] | undefined
  >((best, each) => (!best || each.finished_at! > best.finished_at! ? each : best), undefined);
  const merge = merges.at(-1);
  if (merge && (!landing || merge.created_at >= landing.finished_at!)) {
    const payload = merge.payload as { to_sha?: string; branch?: string };
    const session = ctx.store.get<Session>('sessions', merge.aggregate_id);
    return {
      sha: payload.to_sha ?? '',
      title: session?.title ?? payload.branch ?? '',
      at: iso(merge.created_at),
    };
  }
  if (landing)
    return {
      sha: landing.to_sha ?? '',
      title: landing.message ?? landing.branch,
      at: iso(landing.finished_at!),
    };
}

/** project.plan: the stored plan, each item's stage and status read from its sessions now. */
export function projectPlanView(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): ProjectPlanView {
  projectAccess(ctx, principal, projectId, 'project.read');
  ctx.store.must('projects', projectId);
  // As read_state, the shared reads run as for the user once access is checked.
  const reader: Principal = { id: principal.id, role: 'user' };
  const changes = projectChanges(ctx, reader, projectId, needsYou(ctx, reader, projectId).items);
  const merges = ctx.store.kindEvents(projectId, ['session.merged']);
  const latest = latestLanding(ctx, projectId, merges);
  const landing = latest ? { latest_landing: latest } : {};
  const plan = ctx.store.get<ProjectPlan>(TABLE, projectId);
  if (!plan) return { plan: null, unplanned: changes, ...landing };
  const facts: PlanFacts = {
    rows: new Map(changes.map((row) => [row.id, row])),
    listed: new Map(sessionList(ctx, reader, projectId, 'cached').map((each) => [each.id, each])),
    merges,
    checked: ctx.store.kindEvents(projectId, ['session.gate_checked']),
    notices: ctx.store.kindEvents(projectId, ['session.spawner_notified']),
  };
  const planned = new Set(plan.items.flatMap((item) => item.session_ids ?? []));
  const conductor = ctx.store.get<Session>('sessions', plan.session_id);
  return {
    plan: {
      session_id: plan.session_id,
      conductor_open:
        !!conductor && conductor.state !== 'closed' && conductor.outcome !== 'discarded',
      revision: plan.revision,
      updated_at: plan.updated_at,
      milestones: plan.milestones,
      items: plan.items.map((item) => itemView(ctx, item, facts)),
    },
    unplanned: changes.filter(
      (row) => row.kind !== 'session' || !planned.has(row.id.slice('session:'.length)),
    ),
    ...landing,
  };
}
