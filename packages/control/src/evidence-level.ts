import type { MilestoneView, Review } from '@pantheon/domain';
import {
  USER_PRINCIPAL_ID,
  type BoardMilestoneExtras,
  type BoardModel,
  type BoardTaskExtras,
} from '@pantheon/protocol';
import { runtimeIndependence } from './runtime-vendor.js';

type TaskLevel = NonNullable<BoardTaskExtras['evidence_level']>;

const TASK_LEVELS: TaskLevel[] = ['report', 'gate', 'reviewed'];

/** What backs a merged plan task, from the facts its board row shows. */
export function taskEvidenceLevel(facts: {
  merged: boolean;
  gate_steps?: BoardModel['tasks'][number]['gate_steps'];
  /** The newest review of the task's current session. */
  review?: {
    failed: boolean;
    verdicts: Pick<NonNullable<Review['verdicts']>[number], 'runtime' | 'verdict'>[];
  };
  /** The runtimes of the sessions that wrote the task's current generation. */
  writers: string[];
}): Pick<BoardTaskExtras, 'evidence_level' | 'evidence_reviewer'> {
  if (!facts.merged) return {};
  // With no known writer runtime no reviewer can be shown to run on another one.
  const independent =
    facts.review && !facts.review.failed && facts.writers.length
      ? facts.review.verdicts
          .filter((given) => given.verdict === 'pass')
          .map((given) => runtimeIndependence(facts.writers, given.runtime))
          .filter((independence) => independence !== 'same_runtime')
      : [];
  if (independent.length)
    return {
      evidence_level: 'reviewed',
      evidence_reviewer: independent.includes('other_vendor') ? 'other_vendor' : 'other_runtime',
    };
  // A skipped step never counts as passed.
  const steps = facts.gate_steps ?? [];
  return steps.some((step) => step.state === 'passed') &&
    steps.every((step) => step.state === 'passed' || step.state === 'skipped')
    ? { evidence_level: 'gate' }
    : { evidence_level: 'report' };
}

/** What backs a ready or completed milestone; absent while nothing does. */
export function milestoneEvidenceLevel(facts: {
  status: MilestoneView['status'];
  /** Who accepted it; only an acceptance that holds, on a completed milestone, counts. */
  acceptance_actor?: string;
  verification_state?: NonNullable<MilestoneView['verification']>['state'];
  /** The levels of its merged plan tasks whose rows the board shows. */
  tasks: TaskLevel[];
  /** How many of its plan tasks are done; absent on milestones that name sessions. */
  done_tasks?: number;
}): BoardMilestoneExtras['evidence_level'] {
  if (facts.status !== 'ready_for_acceptance' && facts.status !== 'completed') return undefined;
  // A lead accepting under its charter is not the user's acceptance.
  if (
    facts.status === 'completed' &&
    (facts.acceptance_actor === USER_PRINCIPAL_ID ||
      facts.acceptance_actor?.startsWith('personal:'))
  )
    return 'accepted';
  if (facts.verification_state === 'passed') return 'verified';
  // A done task without a row has an unknown level, so the weakest one is unknown too.
  return facts.tasks.length && facts.tasks.length >= (facts.done_tasks ?? 0)
    ? TASK_LEVELS[Math.min(...facts.tasks.map((level) => TASK_LEVELS.indexOf(level)))]
    : undefined;
}
