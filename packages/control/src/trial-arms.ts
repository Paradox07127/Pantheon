import type { Improvement } from '@pantheon/domain';
import type { ControlContext } from './context.js';

export type TrialArm = 'old' | 'new';
/** The plan task generation that takes one arm of each experience trial. */
export interface TaskKey {
  lead_session_id: string;
  task_id: string;
  generation: number;
}
interface ArmAssigned extends TaskKey {
  improvement_id: string;
  arm: TrialArm;
}

const assignments = (ctx: ControlContext, projectId: string) =>
  ctx.store
    .kindEvents(projectId, ['improvement.arm_assigned'])
    .map((event) => event.payload as ArmAssigned);
const sameTask = (a: TaskKey, b: TaskKey) =>
  a.lead_session_id === b.lead_session_id &&
  a.task_id === b.task_id &&
  a.generation === b.generation;

/** The arms the task took, by improvement id. */
export function taskArms(
  ctx: ControlContext,
  projectId: string,
  key: TaskKey,
): Record<string, TrialArm> {
  return Object.fromEntries(
    assignments(ctx, projectId)
      .filter((a) => sameTask(a, key))
      .map((a) => [a.improvement_id, a.arm]),
  );
}
export function taskArm(
  ctx: ControlContext,
  improvement: Improvement,
  key: TaskKey,
): TrialArm | undefined {
  return taskArms(ctx, improvement.project_id, key)[improvement.id];
}
/** The task's arm of the trial, assigned once: new after an even count of earlier tasks, else old. */
export function assignArm(ctx: ControlContext, improvement: Improvement, key: TaskKey): TrialArm {
  const earlier = assignments(ctx, improvement.project_id).filter(
    (a) => a.improvement_id === improvement.id,
  );
  const found = earlier.find((a) => sameTask(a, key));
  if (found) return found.arm;
  const arm = earlier.length % 2 ? 'old' : 'new';
  ctx.store.event('improvement.arm_assigned', improvement, improvement.project_id, {
    improvement_id: improvement.id,
    ...key,
    arm,
  } satisfies ArmAssigned);
  return arm;
}
