import type { AgentProfile, Principal, Retrospective, Session } from '@pantheon/domain';
import type { AgentLedgerWeek } from '@pantheon/protocol';
import { weeklyInputTokensSpent } from './agent-contract.js';
import { wakeOf, wakeSpans } from './agent-wakes.js';
import { projectAccess, userOnly, type ControlContext } from './context.js';
import { latestRetrospectives } from './retrospective.js';
import { turnInputTokens } from './turn-usage.js';

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** The agent's last weeks, each ending seven days after the one before it, newest first. */
export function agentLedger(
  ctx: ControlContext,
  p: Principal,
  agentId: string,
  weeks: number,
): AgentLedgerWeek[] {
  userOnly(p);
  const profile = ctx.store.must<AgentProfile>('agents', agentId);
  projectAccess(ctx, p, profile.project_id, 'agent.ledger');
  const now = ctx.store.now(),
    since = now - weeks * WEEK_MS;
  const sessions = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.resident?.agent_id === profile.id)
    .map((session) => session.id);
  const led = new Set(sessions);
  const wakes = wakeSpans(ctx, profile)
    .filter((span) => span.at > since)
    .map((span) => wakeOf(ctx, span));
  const tasks = [
    ...latestRetrospectives(
      ctx.store.list<Retrospective>('retrospectives'),
      profile.project_id,
    ).values(),
  ].filter((row) => led.has(row.lead_session_id));
  // A task starts when its lead dispatches it or claims it to do directly; both events are the lead's.
  const starts = ctx.store
    .kindEventsSince(profile.project_id, ['task.dispatched', 'task.claimed'], since)
    .filter((event) => led.has(event.aggregate_id));
  // An approval on a task session's behalf names the session of the lead that approved it.
  const approved = sessions.length
    ? (ctx.store.db
        .prepare(
          `SELECT created_at FROM events WHERE project_id=? AND kind='charter.power_used' AND payload ->> '$.power'='approve_worker_prompts' AND created_at>? AND payload ->> '$.session_id' IN (${sessions.map(() => '?').join(',')})`,
        )
        .all(profile.project_id, since, ...sessions) as { created_at: number }[])
    : [];
  return Array.from({ length: weeks }, (_, index) => {
    const to = now - index * WEEK_MS,
      from = to - WEEK_MS;
    const within = (at: number) => at > from && at <= to;
    const week = wakes.filter((wake) => within(wake.at));
    const causes: AgentLedgerWeek['causes'] = {};
    for (const cause of week.flatMap((wake) => wake.causes))
      causes[cause] = (causes[cause] ?? 0) + 1;
    return {
      from,
      to,
      wakes: week.length,
      causes,
      outcomes: {
        nothing: week.filter((wake) => wake.outcome === 'nothing').length,
        acted: week.filter((wake) => wake.outcome === 'acted').length,
        told_user: week.filter((wake) => wake.outcome === 'told_user').length,
        asked: week.filter((wake) => wake.outcome === 'asked').length,
      },
      tasks_started: new Set(
        starts
          .filter((event) => within(event.created_at))
          .map(
            (event) => `${event.aggregate_id}:${(event.payload as { task_id: string }).task_id}`,
          ),
      ).size,
      tasks_merged: tasks.filter(
        (row) =>
          within(row.recorded_at) && (row.outcome === 'merged' || row.outcome === 'accepted'),
      ).length,
      input_tokens: sessions.length
        ? turnInputTokens(ctx, {
            project_id: profile.project_id,
            session_ids: sessions,
            since: from,
            until: to + 1,
          }).reduce((sum, row) => sum + row.input_tokens, 0)
        : 0,
      prompts_auto_approved: approved.filter((row) => within(row.created_at)).length,
      ...(index === 0 && { contract_spent: weeklyInputTokensSpent(ctx, profile, now) }),
    };
  });
}
