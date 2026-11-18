import { useEffect, useState } from 'react';
import type { DecisionForUser, DecisionsForUser } from '@pantheon/protocol';
import { t } from '../i18n';
import { listText } from '../lib/list-text';
import { useBoard } from './board';
import { useMidnights } from './needs-you';
import { useProjectQuery } from './project-read';
import type { DaemonEvent } from './sync';
import { readQuery } from './workbench-sessions';

/** The days the list covers, up to now; today starts at local midnight. */
export type DecisionRange = 'today' | 'week' | 'month';

const RANGE_DAYS: Record<DecisionRange, number> = { today: 1, week: 7, month: 30 };

/** The events that add a row. */
const DECISION_KINDS: ReadonlySet<string> = new Set([
  'approval.approved',
  'charter.power_used',
  'lead.question_answered',
  'lead.question_overruled',
  'personal.called',
  'board.plan_proposal_resolved',
  'milestone.accepted',
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

/** The charter power a lead's decision ran under. */
const powerRule = (power: Extract<DecisionForUser, { kind: 'power_used' }>['power']): string => {
  switch (power) {
    case 'plan_change':
      return t({ id: 'trace.approved.rule.planChange', defaultMessage: 'Charter: plan changes' });
    case 'accept_milestone':
      return t({
        id: 'trace.approved.rule.acceptMilestone',
        defaultMessage: 'Charter: accept milestones',
      });
    case 'merge_out_of_scope':
      return t({
        id: 'trace.approved.rule.mergeOutOfScope',
        defaultMessage: 'Charter: merge outside scope',
      });
    case 'create_agent':
      return t({ id: 'trace.approved.rule.createAgent', defaultMessage: 'Charter: create agents' });
  }
};

/** The type the list is filtered by. */
export type DecisionType = 'permission' | 'answer' | 'plan_change';

/** A decision's type; a power other than a plan change, and a milestone a key accepted, have none. */
export function decisionType(item: DecisionForUser): DecisionType | null {
  if (item.kind === 'prompt_approved' || item.kind === 'prompt_by_rule') return 'permission';
  if (item.kind === 'question_answered') return 'answer';
  if (item.kind === 'personal_answer')
    return item.command === 'lead.question.answer'
      ? 'answer'
      : item.command === 'board.plan.proposal.resolve'
        ? 'plan_change'
        : null;
  return item.power === 'plan_change' ? 'plan_change' : null;
}

/** One row of the list, as text. */
export interface DecisionRow {
  key: string;
  kind: DecisionForUser['kind'];
  at: number;
  /** What was decided: a prompt's input or tool, the power used, or the question answered. */
  action: string;
  /** The action is tool input or a tool name. */
  code: boolean;
  /** The id of the plan, milestone or session a power acted on. */
  subject: string | null;
  /** The lead, the stored rule, or the personal agent key. */
  by: string;
  /** Why it was decided: the reason the lead gave for a power, or what its answer cited. */
  reason: string | null;
  /** The stored rule, the charter power the lead decided under, or the kind the user let a key answer. */
  rule: string | null;
  /** The session to open; null once it was deleted. */
  sessionId: string | null;
  /** A question's answer, the user's once they overruled the lead's, and what an overrule names. */
  answer: { text: string; overruled: boolean; leadSessionId: string; questionId: string } | null;
  /** What a personal agent key answered, or how it resolved a plan proposal. */
  decision: string | null;
}

/** The kind of decision the user let a personal agent key answer. */
const personalRule = (
  command: Extract<DecisionForUser, { kind: 'personal_answer' }>['command'],
) => {
  switch (command) {
    case 'lead.question.answer':
      return t({
        id: 'trace.approved.rule.personalQuestion',
        defaultMessage: 'Allowed: questions',
      });
    case 'board.plan.proposal.resolve':
      return t({
        id: 'trace.approved.rule.personalPlanChange',
        defaultMessage: 'Allowed: plan changes',
      });
    case 'milestone.accept':
      return t({
        id: 'trace.approved.rule.personalMilestone',
        defaultMessage: 'Allowed: milestone acceptance',
      });
  }
};

const personalDecision = (item: Extract<DecisionForUser, { kind: 'personal_answer' }>) => {
  if (item.command === 'lead.question.answer') return item.decision ?? null;
  if (item.decision === 'accepted')
    return t({ id: 'trace.approved.decision.accepted', defaultMessage: 'Accepted' });
  if (item.decision === 'rejected')
    return t({ id: 'trace.approved.decision.rejected', defaultMessage: 'Rejected' });
  return null;
};

export function decisionRow(item: DecisionForUser): DecisionRow {
  const lead = t({ id: 'trace.approved.by.lead', defaultMessage: 'Lead' });
  if (item.kind === 'power_used')
    return {
      key: `${item.power}:${item.subject}:${item.at}`,
      kind: item.kind,
      at: item.at,
      action: powerText(item.power),
      code: false,
      subject: item.subject,
      by: lead,
      reason: item.reason ?? null,
      rule: powerRule(item.power),
      sessionId: item.session_id,
      answer: null,
      decision: null,
    };
  if (item.kind === 'question_answered')
    return {
      key: `${item.lead_session_id}:${item.question_id}`,
      kind: item.kind,
      at: item.at,
      action: item.question,
      code: false,
      subject: null,
      by: lead,
      reason: listText(...item.citations.map((citation) => citation.ref)),
      rule: t({
        id: 'trace.approved.rule.answerWorkerQuestions',
        defaultMessage: 'Charter: answer worker questions',
      }),
      sessionId: item.session_id ?? null,
      answer: {
        text: item.overruled?.answer ?? item.answer,
        overruled: item.overruled !== undefined,
        leadSessionId: item.lead_session_id,
        questionId: item.question_id,
      },
      decision: null,
    };
  if (item.kind === 'personal_answer')
    return {
      key: `${item.command}:${item.subject}:${item.at}`,
      kind: item.kind,
      at: item.at,
      action: item.text,
      code: false,
      // A question shows no id, as a lead's answer does.
      subject: item.command === 'lead.question.answer' ? null : item.subject,
      by: t({ id: 'trace.approved.by.personal', defaultMessage: 'Personal agent key' }),
      reason: item.reason ?? null,
      rule: personalRule(item.command),
      sessionId: item.lead_session_id ?? null,
      // An overrule replaces only a lead's answer.
      answer: null,
      decision: personalDecision(item),
    };
  const input = item.input_summary ?? item.tool;
  return {
    key: item.approval_id,
    kind: item.kind,
    at: item.at,
    action: input ?? t({ id: 'trace.approved.prompt', defaultMessage: 'Permission request' }),
    code: input !== undefined,
    subject: null,
    by:
      item.kind === 'prompt_by_rule'
        ? t({ id: 'trace.approved.by.rule', defaultMessage: 'Stored rule' })
        : lead,
    reason: null,
    rule:
      item.kind === 'prompt_by_rule'
        ? (item.rule ?? null)
        : t({
            id: 'trace.approved.rule.approveWorkerPrompts',
            defaultMessage: 'Charter: approve worker prompts',
          }),
    sessionId: item.session_id ?? null,
    answer: null,
    decision: null,
  };
}
