import type { RoleUsage } from '@pantheon/domain';
import type { ProjectUsageDaily } from '@pantheon/protocol';
import { useProjectQuery } from './project-read';

/** Events after which a role's sessions, turns, tool calls or tokens may differ. */
const USAGE_KINDS: ReadonlySet<string> = new Set([
  'session.opened',
  'session.deleted',
  'turn.queued',
  'turn.running',
  'agent.tool.started',
  'agent.usage.updated',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'session.turn.delivery',
]);

const isRows = (value: unknown): boolean => Array.isArray(value);
const isDaily = (value: unknown): boolean =>
  !!value && Array.isArray((value as ProjectUsageDaily).days);

/** The project's use by session role over all time. */
export const useRoleUsage = (projectId: string | null) =>
  useProjectQuery<RoleUsage[]>('project.usage.read', projectId, isRows, undefined, {
    kinds: USAGE_KINDS,
  });

/** The project's use by role for each of the last `days` days in the browser's time zone, oldest first. */
export const useDailyUsage = (projectId: string | null, days: number) =>
  useProjectQuery<ProjectUsageDaily>(
    'project.usage.daily',
    projectId,
    isDaily,
    { days: String(days), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    { kinds: USAGE_KINDS },
  );
