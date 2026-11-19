import { hash, type BoardPlan, type MemoryRecord, type Milestone } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { writePlanMemory, type PlanMemoryEntry } from './memory.js';

/** More risks than this leaving in one write is a rewrite of the plan, not risks that closed. */
const MAX_CLOSED_RISKS = 3;

const normalized = (text: string) =>
  text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text);

/**
 * Writes project memory for the user's refutes the lead resolved and the risks that left the plan
 * between before and after.
 */
export function recordPlanDecisions(
  ctx: ControlContext,
  before: BoardPlan,
  after: BoardPlan,
  commandId: string,
): void {
  const lead = after.id;
  const milestones = ctx.store
    .list<Milestone>('milestones')
    .filter((row) => row.owner_session_id === lead && row.key);
  const entry = (
    subject: 'assumption' | 'risk',
    subjectId: string,
    outcome: NonNullable<MemoryRecord['origin']>['outcome'],
    milestoneKey: string | undefined,
    content: (milestone: string) => Pick<PlanMemoryEntry, 'title' | 'summary' | 'text'>,
    editId?: string,
  ): PlanMemoryEntry => {
    const milestone = milestoneKey ? milestones.find((row) => row.key === milestoneKey) : undefined;
    const { title, summary, text } = content(milestone ? ` of milestone ${milestone.title}` : '');
    return {
      project_id: after.project_id,
      key: `plan:${lead}:${subject}:${subjectId}`,
      title: clip(title, 160),
      summary: clip(summary, 400),
      tags: ['plan-decision', subject],
      text,
      origin: {
        kind: 'plan',
        lead_session_id: lead,
        ...(milestone && { milestone_id: milestone.id }),
        subject,
        subject_id: subjectId,
        outcome,
        ...(editId && { edit_id: editId }),
        plan_version: after.plan_version,
      },
    };
  };
  const entries: PlanMemoryEntry[] = [];
  for (const edit of after.pending_edits) {
    const was = before.pending_edits.find((old) => old.edit_id === edit.edit_id);
    if (was?.status !== 'pending' || (edit.status !== 'applied' && edit.status !== 'rejected'))
      continue;
    for (const refute of edit.refutes ?? []) {
      // An applied refute of an assumption the plan no longer has changed nothing.
      const assumption = before.assumptions.find((each) => each.id === refute.assumption_id);
      if (!assumption) continue;
      const name = refute.assumption_id;
      entries.push(
        edit.status === 'applied'
          ? entry(
              'assumption',
              name,
              'refuted',
              assumption.milestone,
              (of) => ({
                title: refute.instead,
                summary: `The lead applied the user's correction of plan assumption ${name}${of}, which was: ${refute.text}`,
                text: `Plan assumption ${name}${of}, corrected by the user and applied by the lead.\nWas: ${refute.text}\nNow: ${refute.instead}`,
              }),
              edit.edit_id,
            )
          : entry(
              'assumption',
              name,
              'confirmed',
              assumption.milestone,
              (of) => ({
                title: refute.text,
                summary: `The lead kept plan assumption ${name}${of} after the user said: ${refute.instead}`,
                text: `Plan assumption ${name}${of}, kept by the lead after the user disputed it.\nAssumption: ${refute.text}\nThe user said: ${refute.instead}${edit.reason ? `\nThe lead's reason: ${edit.reason}` : ''}`,
              }),
              edit.edit_id,
            ),
      );
    }
  }
  const gone = before.risks.filter(
    (risk) =>
      !after.risks.some(
        (next) =>
          (risk.id !== undefined && next.id === risk.id) ||
          normalized(next.text) === normalized(risk.text),
      ),
  );
  if (
    gone.length <= MAX_CLOSED_RISKS &&
    !(after.risks.length === 0 && gone.length === MAX_CLOSED_RISKS)
  )
    for (const risk of gone)
      entries.push(
        entry(
          'risk',
          risk.id ?? hash(normalized(risk.text)).slice(0, 12),
          'closed',
          risk.milestone,
          (of) => ({
            title: risk.text,
            summary: `The lead removed this risk${of} from the plan.`,
            text: `Plan risk${risk.id ? ` ${risk.id}` : ''}${of}, closed: the lead removed it from the plan.\nRisk: ${risk.text}`,
          }),
        ),
      );
  for (const each of entries) writePlanMemory(ctx, each, commandId);
}
