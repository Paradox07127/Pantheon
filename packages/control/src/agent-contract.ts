import type { AgentContract, AgentProfile, Session, SignalIssue } from '@pantheon/domain';
import { withinHours } from '@pantheon/protocol';
import type { ControlContext } from './context.js';
import { turnInputTokens } from './turn-usage.js';
import { readUserConfig } from './user-config.js';
import { workflowPolicy } from './workflow-policy.js';

/** Local Monday 00:00 of the week of `now`, when a weekly token cap starts again. */
export function contractWeekStart(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

/**
 * The local HH:MM hours in which the agent is not woken; absent: none. The personal agent without
 * its own follows the app's quiet hours.
 */
export function contractQuietHours(
  ctx: ControlContext,
  profile: AgentProfile,
): AgentContract['quiet_hours'] {
  return (
    profile.contract?.quiet_hours ??
    (profile.template === 'personal' ? readUserConfig(ctx.userConfigDir).quiet_hours : undefined)
  );
}

/** The input tokens the agent's own resident sessions spent in turns that ended this week. */
export function weeklyInputTokensSpent(
  ctx: ControlContext,
  profile: AgentProfile,
  now: number,
): number {
  const sessionIds = ctx.store
    .list<Session>('sessions')
    .filter((session) => session.resident?.agent_id === profile.id)
    .map((session) => session.id);
  return turnInputTokens(ctx, {
    project_id: profile.project_id,
    session_ids: sessionIds,
    since: contractWeekStart(now),
  }).reduce((sum, row) => sum + row.input_tokens, 0);
}

/** Why the agent's contract holds its wakes at `now`; undefined when it may be woken. */
export function wakeHold(
  ctx: ControlContext,
  profile: AgentProfile,
  now: number,
): 'quiet_hours' | 'weekly_budget' | undefined {
  const quiet = contractQuietHours(ctx, profile);
  if (quiet && withinHours(quiet, now)) return 'quiet_hours';
  const cap = profile.contract?.weekly_input_tokens;
  if (cap !== undefined && weeklyInputTokensSpent(ctx, profile, now) >= cap) return 'weekly_budget';
  return undefined;
}

/** How loudly the agent's message reaches the user at `now`; loudest feed wins over urgency. */
export function messageDelivery(
  ctx: ControlContext,
  profile: AgentProfile,
  now: number,
  urgent: boolean,
): 'feed' | 'notify' {
  if (profile.contract?.loudest === 'feed') return 'feed';
  const quiet = contractQuietHours(ctx, profile);
  return quiet && withinHours(quiet, now) && !urgent ? 'feed' : 'notify';
}

/** True when the issue is the project's and of a class the project's urgent list names. */
export function urgentIssue(
  ctx: ControlContext,
  projectId: string,
  issue: SignalIssue | undefined,
): boolean {
  return (
    issue?.project_id === projectId &&
    issue.scope === 'default_branch' &&
    (workflowPolicy(ctx, projectId).urgent_direct ?? []).includes('main_gate_failed')
  );
}
