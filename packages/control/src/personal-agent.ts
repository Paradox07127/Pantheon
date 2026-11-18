import {
  id,
  requireThat,
  type AgentProfile,
  type BoardPlan,
  type NeedsYouItem,
  type PersonalKey,
  type Project,
} from '@pantheon/domain';
import { wakeHold } from './agent-contract.js';
import { scheduleRoutine, wakeAgent } from './agent-always-on.js';
import { AGENT_TEMPLATES } from './agent-templates.js';
import type { ControlContext } from './context.js';
import { needsYou } from './needs-you.js';
import { openOf } from './resident.js';
import { releaseIdleConversation } from './session.js';
import { afterCommit } from './workbench-session.js';

/** Issues and records a new built-in key; the caller owns the transaction. */
function builtInKey(ctx: ControlContext, cause: string): string {
  requireThat(ctx.issuePersonalKey, 'daemon_unavailable', 'Personal keys are issued by the daemon');
  const keyId = id(),
    issued = ctx.issuePersonalKey(keyId);
  // The token file and its principal live outside the transaction.
  ctx.rollback?.push(() => ctx.discardPersonalKey?.(keyId));
  const key = ctx.store.insert<PersonalKey>('personal_keys', {
    id: keyId,
    revision: 1,
    label: 'Built-in personal agent',
    digest: issued.digest,
    created_at: ctx.store.now(),
  });
  ctx.store.event('personal_key.created', key, '', { label: key.label }, cause);
  return keyId;
}

/**
 * The personal agent's home project and profile, created with its own personal key on first use.
 * Called when the user opens the agent, it replaces a revoked built-in key with a new one.
 * The caller owns the transaction.
 */
export function personalHome(
  ctx: ControlContext,
  cause: string,
): { project: Project; profile: AgentProfile } {
  let project = ctx.store.list<Project>('projects').find((each) => each.kind === 'personal');
  if (!project) {
    project = ctx.store.insert<Project>('projects', {
      id: id(),
      revision: 1,
      name: 'Personal',
      roots: [],
      kind: 'personal',
    });
    ctx.store.event('project.opened', project, project.id, project, cause);
  }
  const homeId = project.id;
  const found = ctx.store
    .list<AgentProfile>('agents')
    .find((agent) => agent.project_id === homeId && agent.template === 'personal');
  if (found && !ctx.store.get<PersonalKey>('personal_keys', found.personal_key_id!)?.revoked_at)
    return { project, profile: found };
  const keyId = builtInKey(ctx, cause);
  if (found) {
    const next = ctx.store.update<AgentProfile>(
      'agents',
      { ...found, personal_key_id: keyId },
      found.revision,
    );
    ctx.store.event('agent_profile.updated', next, homeId, { personal_key_id: keyId }, cause);
    const open = openOf(ctx, next);
    if (open) {
      // An idle process holds the revoked key's file; the next input resumes it on the new one.
      const committed = afterCommit(ctx);
      const completion = Promise.resolve()
        .then(() => {
          if (committed()) releaseIdleConversation(ctx, open);
        })
        .finally(() => ctx.completions.delete(completion));
      ctx.completions.add(completion);
    }
    return { project, profile: next };
  }
  const defaults = AGENT_TEMPLATES.personal;
  const profile = ctx.store.insert<AgentProfile>('agents', {
    id: id(),
    revision: 1,
    project_id: homeId,
    template: 'personal',
    name: defaults.name,
    role: defaults.role,
    routines: defaults.routines ?? [],
    personal_key_id: keyId,
    created_by: { kind: 'user' },
    created_at: ctx.store.now(),
  });
  ctx.store.event('agent_profile.created', profile, homeId, profile, cause);
  for (const routine of profile.routines) scheduleRoutine(ctx, profile, routine);
  return { project, profile };
}

/** New waiting items wake the personal agent at most once in this long. */
const PERSONAL_ATTENTION_MS = 30 * 60_000;

/** The waiting items are read again at most once in this long, however many events arrive. */
const PERSONAL_READ_MS = 60_000;

/** The event cursor and time of the last tick that read the waiting items, by context. */
const attentionReads = new WeakMap<ControlContext, { cursor: number; at: number }>();

/** A waiting item's identity; an item whose revision changes keeps it. */
export const attentionKey = (item: NeedsYouItem) =>
  `${item.kind}:${item.source.table}:${item.source.id}:${item.reason}:${item.request_id ?? ''}`;

/**
 * Wakes the personal agent with one note when items it has not seen wait for the user in other
 * projects. The cheap checks come first, since reading the items of every project is not.
 */
export function tickPersonalAttention(ctx: ControlContext): void {
  const project = ctx.store.list<Project>('projects').find((each) => each.kind === 'personal');
  if (!project) return;
  const read = attentionReads.get(ctx);
  if (read && (read.cursor === ctx.store.cursor() || ctx.store.now() - read.at < PERSONAL_READ_MS))
    return;
  const profile = ctx.store
    .list<AgentProfile>('agents')
    .find((agent) => agent.project_id === project.id && agent.template === 'personal');
  if (!profile || profile.archived_at) return;
  const now = ctx.store.now();
  const { at } = ctx.store.db
    .prepare(
      "SELECT max(created_at) AS at FROM events WHERE project_id=? AND kind='lead.note_added' AND json_extract(payload,'$.kind')='personal_attention'",
    )
    .get(project.id) as { at: number | null };
  if (at !== null && now - at < PERSONAL_ATTENTION_MS) return;
  // Held, the items stay unseen, so the first tick after the hold names them all.
  if (wakeHold(ctx, profile, now)) return;
  // A woken agent whose key is revoked could read nothing.
  if (ctx.store.get<PersonalKey>('personal_keys', profile.personal_key_id!)?.revoked_at) return;
  const items = needsYou(ctx, {
    id: `personal:${profile.personal_key_id}`,
    role: 'personal',
  }).items.filter((item) => item.project_id !== project.id);
  const keys = items.map(attentionKey);
  const resident = openOf(ctx, profile);
  const seen = resident && ctx.store.get<BoardPlan>('board_plans', resident.id)?.personal_seen;
  const known = new Set(seen?.keys);
  const fresh = items.filter((_item, index) => !known.has(keys[index]!));
  if (fresh.length) {
    const counts = new Map<string, Map<string, number>>();
    for (const item of fresh) {
      const kinds = counts.get(item.project_id) ?? new Map<string, number>();
      counts.set(item.project_id, kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1));
    }
    const projects = [...counts].map(
      ([projectId, kinds]) =>
        `In "${ctx.store.must<Project>('projects', projectId).name}": ${[...kinds]
          .map(([kind, count]) => `${kind} (${count})`)
          .join(', ')}.`,
    );
    wakeAgent(
      ctx,
      profile,
      'personal_attention',
      [
        fresh.length === 1
          ? '1 new item waits for the user.'
          : `${fresh.length} new items wait for the user.`,
        ...projects,
      ].join(' '),
      'personal-attention',
    );
  }
  // A key that leaves the set counts as new when it comes back.
  if (fresh.length || (seen && keys.join('\n') !== seen.keys.join('\n'))) {
    const plan = ctx.store.must<BoardPlan>('board_plans', openOf(ctx, profile)!.id);
    ctx.store.update<BoardPlan>(
      'board_plans',
      { ...plan, personal_seen: { keys, at: now } },
      plan.revision,
    );
  }
  attentionReads.set(ctx, { cursor: ctx.store.cursor(), at: now });
}
