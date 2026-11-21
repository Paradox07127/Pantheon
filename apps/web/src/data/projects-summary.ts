import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@pantheon/protocol';
import { useBoard } from './board';
import { touchesNeedsYou } from './needs-you';
import type { DaemonEvent } from './sync';
import { useQuery, useRefetchTick } from './workbench-sessions';

// Session states and merges, approvals and the projects themselves; the needs-you count follows
// the needs-you list.
const SUMMARY_PREFIXES = ['session.', 'turn.', 'workspace.', 'approval.', 'project.'];

/** Whether an event of this kind can change a project's summary. */
export const changesSummary = (kind: string): boolean =>
  SUMMARY_PREFIXES.some((prefix) => kind.startsWith(prefix)) || touchesNeedsYou(kind);

function newest(events: readonly DaemonEvent[]): DaemonEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--)
    if (changesSummary(events[i]!.kind)) return events[i];
  return undefined;
}

const noParams = () => ({});
const acceptSummary = (value: unknown): ProjectSummary[] | null => {
  const projects = (value as { projects?: unknown } | null)?.projects;
  return Array.isArray(projects) ? (projects as ProjectSummary[]) : null;
};

/** Counts the local midnights passed while mounted. */
function useDays(): number {
  const [days, setDays] = useState(0);
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const id = setTimeout(() => setDays((n) => n + 1), midnight.getTime() - now.getTime());
    return () => clearTimeout(id);
  }, [days]);
  return days;
}

/**
 * Every project's counts and progress; read again after an event of any project changes them,
 * and at local midnight, when the daily window moves.
 */
export function useProjectsSummary(): ReturnType<typeof useQuery<ProjectSummary[]>> {
  const sequence = useBoard((s) => newest(s.events)?.sequence ?? 0);
  const tick = useRefetchTick(sequence, false);
  const days = useDays();
  return useQuery('projects.summary', 'all', noParams, acceptSummary, tick + days);
}

/** Whether a project has a summary, no session running, waiting, ready or failed, and none needing you. */
export const projectIdle = (summary: ProjectSummary | undefined): boolean =>
  !!summary &&
  !summary.needs_you &&
  !summary.counts.running &&
  !summary.counts.waiting &&
  !summary.counts.ready &&
  !summary.counts.failed;

const activityAt = (summary: ProjectSummary | undefined): number =>
  summary?.last_activity_at ? Date.parse(summary.last_activity_at) : -Infinity;

/**
 * Projects that need you first, then the newest activity; projects without activity or summary
 * come last, by name.
 */
export function sortProjects<T extends { id: string; name: string }>(
  projects: readonly T[],
  summaries: readonly ProjectSummary[],
): T[] {
  const byId = new Map(summaries.map((s) => [s.project_id, s]));
  return [...projects].sort((a, b) => {
    const as = byId.get(a.id),
      bs = byId.get(b.id);
    const needs = Number((bs?.needs_you ?? 0) > 0) - Number((as?.needs_you ?? 0) > 0);
    if (needs) return needs;
    const at = activityAt(as),
      bt = activityAt(bs);
    if (at !== bt) return bt > at ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}
