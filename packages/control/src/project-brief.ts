import {
  hash,
  type Entity,
  type Landing,
  type NeedsYouItem,
  type Principal,
  type Project,
} from '@pantheon/domain';
import {
  inputSchemas,
  type ProjectBrief,
  type ProjectBriefItem,
  type ProjectBriefProse,
  type ProjectBriefRef,
} from '@pantheon/protocol';
import { projectAccess, type ControlContext, type Handlers } from './context.js';
import { decisionsForUser } from './decisions-for-user.js';
import { personalCalled } from './personal-scope.js';
import { needsYou } from './needs-you.js';

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

/** The items the paragraph is about: the decided count moves with every approval a lead gives, so it is left out. */
export const proseItems = (items: ProjectBriefItem[]) =>
  items.filter(
    (item): item is Exclude<ProjectBriefItem, { kind: 'decided' }> => item.kind !== 'decided',
  );
export const briefItemsKey = (items: ProjectBriefItem[]) => hash(proseItems(items));

const FAILURES: NeedsYouItem['kind'][] = [
  'session.failed',
  'session.gate_failed',
  'session.merge_blocked',
];
const BRIEF_EVENTS = ['session.merged'];

/** The project's branches that `pantheon land` landed at or after from. */
export const landedSince = (ctx: ControlContext, projectId: string, from: number) =>
  ctx.store
    .list<Landing>('landings')
    .filter(
      (l) => l.project_id === projectId && l.state === 'landed' && (l.finished_at ?? 0) >= from,
    );

/** What a needs-you item links to: its approval, else its source's latest event. */
function itemRef(ctx: ControlContext, item: NeedsYouItem): ProjectBriefRef {
  const { table, id } = item.source;
  if (table === 'approvals') return { kind: 'approval', id };
  const latest = ctx.store.db
    .prepare('SELECT event_id FROM events WHERE aggregate_id=? ORDER BY sequence DESC LIMIT 1')
    .get(id) as { event_id: string };
  return { kind: 'event', id: latest.event_id };
}

/**
 * What happened in the project after since, the caller's seen cursor by default, as counts and
 * links; given is the project's needs-you list when the caller has it already.
 */
export function projectBrief(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  since?: number,
  given?: NeedsYouItem[],
): ProjectBrief {
  projectAccess(ctx, principal, projectId, 'project.brief');
  ctx.store.must<Project>('projects', projectId);
  const cursor = ctx.store.get<SeenCursor>('seen_cursors', cursorId(principal, projectId)),
    after = since ?? cursor?.at ?? 0;
  const items: ProjectBriefItem[] = [];
  const needs = given ?? needsYou(ctx, principal, projectId).items,
    arrived = needs.filter((item) => item.created_at > after);
  if (arrived.length)
    items.push({
      kind: 'decisions',
      ref: itemRef(ctx, needs[0]!),
      count: needs.length,
      new: arrived.length,
      top: needs[0]!,
    });
  // kindEventsSince reads from its bound on, and the brief starts after the cursor.
  const events = ctx.store.kindEventsSince(projectId, BRIEF_EVENTS, after + 1);
  for (const event of events)
    if (event.kind === 'session.merged')
      items.push({
        kind: 'merge',
        ref: { kind: 'merge', id: event.aggregate_id },
        at: event.created_at,
      });
  for (const landing of landedSince(ctx, projectId, after + 1))
    items.push({
      kind: 'merge',
      ref: { kind: 'landing', id: landing.id },
      at: landing.finished_at!,
    });
  for (const item of arrived)
    if (FAILURES.includes(item.kind))
      items.push({
        kind: 'failure',
        ref: itemRef(ctx, item),
        at: item.created_at,
        reason: item.reason,
      });
  const decided = decisionsForUser(ctx, principal, projectId, after + 1).items;
  if (decided.length)
    items.push({
      kind: 'decided',
      ref: { kind: 'decided', id: projectId },
      count: decided.length,
      types: { permission: decided.length },
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
    personalCalled(ctx, p, c, input.project_id);
    const at = input.at ?? ctx.store.now(),
      key = cursorId(p, input.project_id),
      cursor = ctx.store.get<SeenCursor>('seen_cursors', key),
      next: SeenCursor = { id: key, revision: 1, user_id: p.id, project_id: input.project_id, at };
    if (cursor) ctx.store.update('seen_cursors', next, cursor.revision);
    else ctx.store.insert('seen_cursors', next);
    return { project_id: input.project_id, at };
  },
};
