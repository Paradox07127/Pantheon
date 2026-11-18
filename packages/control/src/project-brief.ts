import {
  hash,
  type BoardPlan,
  type Entity,
  type Event,
  type Milestone,
  type NeedsYouItem,
  type Principal,
  type Project,
  type Session,
} from '@pantheon/domain';
import {
  inputSchemas,
  type ProjectBrief,
  type ProjectBriefItem,
  type ProjectBriefProse,
  type ProjectBriefRef,
} from '@pantheon/protocol';
import { projectAccess, type ControlContext, type Handlers } from './context.js';
import { boardTaskId } from './board-plan.js';
import { itemTask, needsYou } from './needs-you.js';
import { milestoneView } from './project-facts.js';

/** One user's seen cursor of one project, keyed by JSON of [user id, project id]. */
export interface SeenCursor extends Entity {
  user_id: string;
  project_id: string;
  at: number;
  /** The side model's paragraph about the brief after since whose items hash to items_key. */
  prose?: ProjectBriefProse & {
    since: number;
    items_key: string;
    model?: string;
    usage?: { input_tokens: number; output_tokens: number };
  };
}

export const cursorId = (principal: Principal, projectId: string) =>
  JSON.stringify([principal.id, projectId]);

export const briefItemsKey = (items: ProjectBriefItem[]) => hash(items);

const FAILURES: NeedsYouItem['kind'][] = [
  'session.failed',
  'session.gate_failed',
  'session.merge_blocked',
];
const BRIEF_EVENTS = [
  'session.merged',
  'task.accepted',
  'board.plan_updated',
  'agent_proposal.created',
];

/** What a needs-you item links to: its approval, proposal, milestone, question or task, else its source's latest event. */
function itemRef(
  ctx: ControlContext,
  item: NeedsYouItem,
  planOf: Map<string, BoardPlan>,
): ProjectBriefRef {
  const { table, id } = item.source;
  if (table === 'approvals') return { kind: 'approval', id };
  if (table === 'agent_proposals') return { kind: 'proposal', id };
  if (table === 'milestones') return { kind: 'milestone', id };
  const asked =
    item.question &&
    (ctx.store.db
      .prepare(
        "SELECT event_id FROM events WHERE aggregate_id=? AND kind='lead.question_asked' AND created_at>=? AND payload ->> '$.id'=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(id, item.question.at, item.question.id) as { event_id: string } | undefined);
  if (asked) return { kind: 'event', id: asked.event_id };
  const bound = itemTask(ctx, item, planOf),
    task = item.task_id ?? (bound && boardTaskId(bound.plan.id, bound.taskId));
  if (task) return { kind: 'task', id: task };
  const latest = ctx.store.db
    .prepare('SELECT event_id FROM events WHERE aggregate_id=? ORDER BY sequence DESC LIMIT 1')
    .get(id) as { event_id: string };
  return { kind: 'event', id: latest.event_id };
}

/** The plan task a completion finished: an acceptance and a direct merge name it on the lead, a merge through its session. */
function completedTask(
  ctx: ControlContext,
  event: Event,
): { lead: string; task: string } | undefined {
  const p = event.payload as { direct?: boolean; task_id?: string };
  if (event.kind === 'task.accepted' || p.direct)
    return { lead: event.aggregate_id, task: p.task_id! };
  const task = ctx.store.get<Session>('sessions', event.aggregate_id)?.task;
  return task && { lead: task.lead_session_id, task: task.id };
}

/** What happened in the project after since, the caller's seen cursor by default, as counts and links. */
export function projectBrief(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  since?: number,
): ProjectBrief {
  projectAccess(ctx, principal, projectId, 'project.brief');
  ctx.store.must<Project>('projects', projectId);
  const cursor = ctx.store.get<SeenCursor>('seen_cursors', cursorId(principal, projectId)),
    after = since ?? cursor?.at ?? 0;
  const planOf = new Map(
    ctx.store
      .list<BoardPlan>('board_plans')
      .filter((plan) => plan.project_id === projectId)
      .map((plan) => [plan.id, plan]),
  );
  const items: ProjectBriefItem[] = [];
  const needs = needsYou(ctx, principal, projectId).items,
    arrived = needs.filter((item) => item.created_at > after);
  if (arrived.length)
    items.push({
      kind: 'decisions',
      ref: itemRef(ctx, needs[0]!, planOf),
      count: needs.length,
      new: arrived.length,
      top: needs[0]!,
    });
  // kindEventsSince reads from its bound on, and the brief starts after the cursor.
  const events = ctx.store.kindEventsSince(projectId, BRIEF_EVENTS, after + 1);
  const completed = events.flatMap((event) =>
    event.kind === 'session.merged' || event.kind === 'task.accepted'
      ? [{ event, task: completedTask(ctx, event) }]
      : [],
  );
  for (const milestone of ctx.store.list<Milestone>('milestones')) {
    if (milestone.project_id !== projectId || milestone.removed_at !== undefined) continue;
    const moved = completed.some(({ event, task }) =>
      milestone.owner_session_id
        ? task?.lead === milestone.owner_session_id && !!milestone.task_ids?.includes(task.task)
        : event.kind === 'session.merged' &&
          milestone.required_sessions.includes(event.aggregate_id),
    );
    if (!moved) continue;
    const view = milestoneView(ctx, milestone);
    items.push({
      kind: 'milestone',
      ref: { kind: 'milestone', id: milestone.id },
      title: milestone.title,
      done: view.tasks?.done ?? view.merged_total,
      total: view.tasks?.total ?? view.required_total,
    });
  }
  for (const event of events)
    if (event.kind === 'session.merged')
      items.push({
        kind: 'merge',
        ref: { kind: 'merge', id: event.aggregate_id },
        at: event.created_at,
      });
  for (const item of arrived)
    if (FAILURES.includes(item.kind))
      items.push({
        kind: 'failure',
        ref: itemRef(ctx, item, planOf),
        at: item.created_at,
        reason: item.reason,
      });
  // Each plan's assumptions as of the cursor, then each one a later version lists first.
  const known = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== 'board.plan_updated') continue;
    let texts = known.get(event.aggregate_id);
    if (!texts) {
      const before = ctx.store.db
        .prepare(
          "SELECT payload ->> '$.assumptions' AS assumptions FROM events WHERE project_id=? AND kind='board.plan_updated' AND aggregate_id=? AND created_at<=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(projectId, event.aggregate_id, after) as { assumptions: string } | undefined;
      texts = new Set(
        before
          ? (JSON.parse(before.assumptions) as BoardPlan['assumptions']).map(({ text }) => text)
          : [],
      );
      known.set(event.aggregate_id, texts);
    }
    for (const { text } of (event.payload as BoardPlan).assumptions)
      if (!texts.has(text)) {
        texts.add(text);
        items.push({
          kind: 'assumption',
          ref: { kind: 'event', id: event.event_id },
          at: event.created_at,
          text,
        });
      }
  }
  for (const event of events)
    if (event.kind === 'agent_proposal.created')
      items.push({
        kind: 'proposal',
        ref: { kind: 'proposal', id: event.aggregate_id },
        at: event.created_at,
      });
  const prose = cursor?.prose;
  return prose && prose.since === after && prose.items_key === briefItemsKey(items)
    ? { since: after, items, prose: { sentences: prose.sentences, at: prose.at } }
    : { since: after, items };
}

export const projectBriefHandlers: Handlers = {
  'project.seen': (ctx, p, c) => {
    const input = inputSchemas['project.seen'].parse(c.input);
    projectAccess(ctx, p, input.project_id, c.type);
    ctx.store.must<Project>('projects', input.project_id);
    const at = input.at ?? ctx.store.now(),
      key = cursorId(p, input.project_id),
      cursor = ctx.store.get<SeenCursor>('seen_cursors', key),
      next: SeenCursor = { id: key, revision: 1, user_id: p.id, project_id: input.project_id, at };
    if (cursor) ctx.store.update('seen_cursors', next, cursor.revision);
    else ctx.store.insert('seen_cursors', next);
    return { project_id: input.project_id, at };
  },
};
