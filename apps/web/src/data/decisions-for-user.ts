import { useEffect, useState } from 'react';
import type { DecisionForUser, DecisionsForUser } from '@pantheon/protocol';
import { t } from '../i18n';
import { useBoard } from './board';
import { useMidnights } from './needs-you';
import { useProjectQuery } from './project-read';
import type { DaemonEvent } from './sync';
import { readQuery } from './workbench-sessions';

/** The days the list covers, up to now; today starts at local midnight. */
export type DecisionRange = 'today' | 'week' | 'month';

const RANGE_DAYS: Record<DecisionRange, number> = { today: 1, week: 7, month: 30 };

/** The events that add a row. */
const DECISION_KINDS: ReadonlySet<string> = new Set(['approval.approved']);

/** Local midnight of the range's first day, in Unix milliseconds. */
export function rangeSince(range: DecisionRange, now: number): number {
  const day = new Date(now);
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() - RANGE_DAYS[range] + 1,
  ).getTime();
}

const isDecisions = (value: unknown): boolean =>
  Array.isArray((value as Partial<DecisionsForUser> | null)?.items);

/** What a stored rule decided without the user in the project over the range, newest first. */
export function useDecisionsForUser(projectId: string | null, range: DecisionRange) {
  // A new day moves the range's start.
  useMidnights();
  return useProjectQuery<DecisionsForUser>(
    'project.decisions',
    projectId,
    isDecisions,
    { since: String(rangeSince(range, Date.now())) },
    { kinds: DECISION_KINDS },
  );
}

/** What was decided for the user in the project after the time, as project.brief counts it, newest first. */
export const useDecisionsAfter = (projectId: string | null, after: number) =>
  useProjectQuery<DecisionsForUser>(
    'project.decisions',
    projectId,
    isDecisions,
    { since: String(after + 1) },
    { kinds: DECISION_KINDS },
  );

function newestDecision(events: readonly DaemonEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--)
    if (DECISION_KINDS.has(events[i]!.kind)) return events[i]!.sequence;
  return 0;
}

/** How many decisions each of the projects had today, read again after each new one and at midnight. */
export function useDecisionsToday(projectIds: readonly string[]): Readonly<Record<string, number>> {
  const changed = useBoard((s) => newestDecision(s.events));
  const resync = useBoard((s) => s.resync);
  const midnights = useMidnights();
  const [counts, setCounts] = useState<Readonly<Record<string, number>>>({});
  const key = projectIds.join('\n');
  useEffect(() => {
    let current = true;
    const since = String(rangeSince('today', Date.now()));
    for (const project_id of projectIds)
      void readQuery('project.decisions', { project_id, since }).then((result) => {
        if (!current || !result.ok || !isDecisions(result.value)) return;
        const count = byRule((result.value as DecisionsForUser).items).length;
        setCounts((all) => ({ ...all, [project_id]: count }));
      });
    return () => {
      current = false;
    };
  }, [key, changed, resync, midnights]);
  return counts;
}

type RuleDecision = Extract<DecisionForUser, { kind: 'prompt_by_rule' }>;

/** The prompts a stored permission rule answered; the list shows no other decision. */
export const byRule = (items: readonly DecisionForUser[]): RuleDecision[] =>
  items.filter((item): item is RuleDecision => item.kind === 'prompt_by_rule');

/** One row of the list, as text. */
export interface DecisionRow {
  key: string;
  at: number;
  /** What was decided: a prompt's input or tool. */
  action: string;
  /** The action is tool input or a tool name. */
  code: boolean;
  by: string;
  /** The stored rule. */
  rule: string | null;
  /** The session to open; null once it was deleted. */
  sessionId: string | null;
}

export function decisionRow(item: RuleDecision): DecisionRow {
  const input = item.input_summary ?? item.tool;
  return {
    key: item.approval_id,
    at: item.at,
    action: input ?? t({ id: 'trace.approved.prompt', defaultMessage: 'Permission request' }),
    code: input !== undefined,
    by: t({ id: 'trace.approved.by.rule', defaultMessage: 'Stored rule' }),
    rule: item.rule ?? null,
    sessionId: item.session_id ?? null,
  };
}
