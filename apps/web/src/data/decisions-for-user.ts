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

/** The events that add or remove a row. */
const DECISION_KINDS: ReadonlySet<string> = new Set([
  'approval.approved',
  'approval.rejected',
  'approval.refused',
  'approval.resolved',
  'session.deleted',
]);

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

/** The sequence of the newest event that can change the decisions, 0 without one. */
export function newestDecision(events: readonly DaemonEvent[]): number {
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
  /**
   * The main agent that decided, each question with its answer, and what it decided with its
   * reason; null for a stored rule.
   */
  mainAgent: { sessionId: string; answers: string[]; decided: string | null } | null;
}

/** What the main agent decided, with its reason; null without one. */
function decidedText(item: Extract<DecisionForUser, { kind: 'answered_by_main_agent' }>) {
  const reason = item.reason;
  if (reason === undefined) return null;
  return item.decision === 'reject'
    ? t({ id: 'trace.approved.refused', defaultMessage: 'Refused: {reason}' }, { reason })
    : t({ id: 'trace.approved.answered', defaultMessage: 'Answered: {reason}' }, { reason });
}

export function decisionRow(item: DecisionForUser): DecisionRow {
  const question = item.kind === 'answered_by_main_agent' ? item.question : undefined;
  const input = item.input_summary ?? item.tool;
  return {
    key: item.approval_id,
    at: item.at,
    action:
      question ?? input ?? t({ id: 'trace.approved.prompt', defaultMessage: 'Permission request' }),
    code: question === undefined && input !== undefined,
    by: t({ id: 'trace.approved.by.rule', defaultMessage: 'Stored rule' }),
    rule: item.kind === 'prompt_by_rule' ? (item.rule ?? null) : null,
    sessionId: item.session_id ?? null,
    mainAgent:
      item.kind === 'answered_by_main_agent'
        ? {
            sessionId: item.main_agent_session_id,
            answers: Object.entries(item.answers ?? {}).map(([question, answer]) =>
              t(
                { id: 'trace.approved.answer', defaultMessage: '{question} → {answer}' },
                { question, answer },
              ),
            ),
            decided: decidedText(item),
          }
        : null,
  };
}

/** The first line of a message to the main agent about its answer. */
export const tellDecisionDraft = (row: DecisionRow) =>
  t(
    { id: 'trace.approved.tellDraft', defaultMessage: 'About your answer to “{action}”:\n' },
    { action: row.action },
  );
