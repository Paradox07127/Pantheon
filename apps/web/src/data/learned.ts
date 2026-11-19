import type { CommandType, LearnedItem } from '@pantheon/protocol';
import { failureText } from './needs-you';
import { sendProjectCommand, useProjectQuery, type MutationResult } from './project-read';
import { readQuery } from './workbench-sessions';

export type { LearnedItem };
export type LearnedAction = LearnedItem['actions'][number];

/** The project's events after which learned.list can answer otherwise. */
const LEARNED_KINDS: ReadonlySet<string> = new Set([
  'improvement.proposed',
  'improvement.status_changed',
  'retrospective.recorded',
  'agent_proposal.created',
  'agent_proposal.resolved',
  'workflow.definition_changed',
  'workflow.step_changed',
  'workflow.definition_trial_completed',
  'workflow.definition_trial_decided',
  'memory.proposed',
  'memory.committed',
  'memory.archived',
  'memory.restored_as_draft',
  'memory.retraction_undone',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object';

const isLearned = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (i) =>
      isObject(i) &&
      typeof i.id === 'string' &&
      typeof i.group === 'string' &&
      isObject(i.diff) &&
      Array.isArray(i.evidence) &&
      Array.isArray(i.actions),
  );

/** GET /v1/learned.list: every learned change of the project, newest first. */
export const useLearned = (project_id: string | null) =>
  useProjectQuery<LearnedItem[]>('learned.list', project_id, isLearned, undefined, {
    kinds: LEARNED_KINDS,
  });

/** Sends one of the item's actions with the input its command takes. */
export async function runLearnedAction(
  projectId: string,
  item: LearnedItem,
  action: LearnedAction,
  rejectReason?: 'duplicate' | 'not_useful',
): Promise<MutationResult> {
  if (action.command === 'improvement.decide')
    return sendProjectCommand(
      'improvement.decide',
      {
        project_id: projectId,
        improvement_id: item.id,
        decision: action.decision,
        ...(rejectReason && { reject_reason: rejectReason }),
      },
      null,
    );
  if (action.command === 'agent.proposal.resolve')
    return sendProjectCommand(
      'agent.proposal.resolve',
      { proposal_id: item.id, decision: action.decision },
      null,
    );
  if (action.command === 'workflow.definition.trial.decide')
    return sendProjectCommand(
      'workflow.definition.trial.decide',
      { project_id: projectId, id: item.id, decision: action.decision },
      null,
    );
  // memory.commit and memory.archive expect the record's revision, which learned.list leaves out.
  const read = await readQuery('memory.item', { project_id: projectId, memory_id: item.id });
  if (!read.ok) return { ok: false, error: failureText(read.error) };
  return sendProjectCommand(
    action.command as CommandType,
    { memory_id: item.id },
    (read.value as { revision: number }).revision,
  );
}
