import type { ProjectSummary, WorkbenchSession } from '@pantheon/protocol';
import { t } from '../../i18n';
import { spawnedOf } from '../sessions/RunMap';

// A listed session in one of these states no longer takes messages.
const CLOSED: readonly WorkbenchSession['state'][] = ['failed', 'merged', 'discarded', 'done'];

/** The project's main agent: of its open, unarchived main agents, the one active last; null when none. */
export function mainAgent(sessions: readonly WorkbenchSession[] | null): WorkbenchSession | null {
  let best: WorkbenchSession | null = null;
  for (const s of sessions ?? []) {
    if (!s.conductor || s.archived_at || CLOSED.includes(s.state)) continue;
    if (!best || Date.parse(s.last_activity_at) > Date.parse(best.last_activity_at)) best = s;
  }
  return best;
}

/** The agent list: the main agent, then the sessions it spawned. */
export const agentRows = (
  main: WorkbenchSession,
  sessions: readonly WorkbenchSession[] | null,
): readonly WorkbenchSession[] => [main, ...spawnedOf(main, sessions)];

// A steer turn is not last_turn; a session in these states holds a queued or running turn.
const TAKING: readonly WorkbenchSession['state'][] = ['starting', 'running', 'waiting'];

/** How many of the sessions hold a queued or running turn, as the spawned-session limit counts them. */
export const takingTurns = (sessions: readonly WorkbenchSession[]): number =>
  sessions.filter(
    (s) =>
      TAKING.includes(s.state) ||
      s.last_turn?.state === 'queued' ||
      s.last_turn?.state === 'running',
  ).length;

export interface StatusCount {
  key: 'running' | 'waiting' | 'ready' | 'failed' | 'today';
  label: string;
  /** null until the summary is read. */
  count: number | null;
  /** How long the oldest item has waited, in ms; only on waiting, while something waits. */
  longest?: number;
}

/** The status head's counts, in order, from the project's summary. */
export function statusCounts(summary: ProjectSummary | undefined): StatusCount[] {
  const counts = summary?.counts;
  return [
    {
      key: 'running',
      label: t({ id: 'project.status.running', defaultMessage: 'Running' }),
      count: counts?.running ?? null,
    },
    {
      key: 'waiting',
      label: t({ id: 'project.status.waiting', defaultMessage: 'Waiting for you' }),
      count: summary ? summary.needs_you : null,
      ...(summary?.waiting ? { longest: summary.waiting.longest_wait_ms } : {}),
    },
    {
      key: 'ready',
      label: t({ id: 'project.status.ready', defaultMessage: 'Can land' }),
      count: counts?.ready ?? null,
    },
    {
      key: 'failed',
      label: t({ id: 'project.status.failed', defaultMessage: 'Failed' }),
      count: counts?.failed ?? null,
    },
    {
      key: 'today',
      label: t({ id: 'project.status.landedToday', defaultMessage: 'Landed today' }),
      count: summary ? summary.merged_today : null,
    },
  ];
}

/** A commit's short form. */
export const shortSha = (sha: string): string => sha.slice(0, 7);
