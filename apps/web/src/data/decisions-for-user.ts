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
const DECISION_KINDS: ReadonlySet<string> = new Set(['approval.approved', 'charter.power_used']);

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

/** What a lead or a stored rule decided without the user in the project over the range, newest first. */
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
        const count = (result.value as DecisionsForUser).items.length;
        setCounts((all) => ({ ...all, [project_id]: count }));
      });
    return () => {
      current = false;
    };
  }, [key, changed, resync, midnights]);
  return counts;
}

const powerText = (power: Extract<DecisionForUser, { kind: 'power_used' }>['power']): string => {
  switch (power) {
    case 'plan_change':
      return t({ id: 'trace.approved.power.planChange', defaultMessage: 'Changed the plan' });
    case 'accept_milestone':
      return t({
        id: 'trace.approved.power.acceptMilestone',
        defaultMessage: 'Accepted a milestone',
      });
    case 'merge_out_of_scope':
      return t({
        id: 'trace.approved.power.mergeOutOfScope',
        defaultMessage: 'Merged outside its scope',
      });
    case 'create_agent':
      return t({ id: 'trace.approved.power.createAgent', defaultMessage: 'Added an agent' });
  }
};

/** One row of the list, as text. */
export interface DecisionRow {
  key: string;
  at: number;
  /** What was decided: a prompt's input or tool, or the power used. */
  action: string;
  /** The action is tool input or a tool name. */
  code: boolean;
  /** The id of the plan, milestone or session a power acted on. */
  subject: string | null;
  /** The lead, or the stored rule. */
  by: string;
  rule: string | null;
  /** The session to open; null once it was deleted. */
  sessionId: string | null;
}

export function decisionRow(item: DecisionForUser): DecisionRow {
  const lead = t({ id: 'trace.approved.by.lead', defaultMessage: 'Lead' });
  if (item.kind === 'power_used')
    return {
      key: `${item.power}:${item.subject}:${item.at}`,
      at: item.at,
      action: powerText(item.power),
      code: false,
      subject: item.subject,
      by: lead,
      rule: null,
      sessionId: item.session_id,
    };
  const input = item.input_summary ?? item.tool;
  return {
    key: item.approval_id,
    at: item.at,
    action: input ?? t({ id: 'trace.approved.prompt', defaultMessage: 'Permission request' }),
    code: input !== undefined,
    subject: null,
    by:
      item.kind === 'prompt_by_rule'
        ? t({ id: 'trace.approved.by.rule', defaultMessage: 'Stored rule' })
        : lead,
    rule: item.kind === 'prompt_by_rule' ? item.rule : null,
    sessionId: item.session_id ?? null,
  };
}
