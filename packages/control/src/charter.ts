import type { CharterMode, CharterPower, Entity, Principal, Project } from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { externalEvents } from './user-config.js';
import { DEFAULT_WORKFLOW_POLICY, workflowPolicy } from './workflow-policy.js';

type Power = Exclude<CharterPower, 'plan_change'>;

export const CHARTER_POWERS = [
  'approve_worker_prompts',
  'answer_worker_questions',
  'create_agent',
  'merge_out_of_scope',
  'start_external',
] as const satisfies readonly Power[];

const EXTERNAL_START: Record<ReturnType<typeof externalEvents>, CharterMode> = {
  off: 'off',
  approve: 'ask',
  auto: 'on',
};

/** What a lead of the project may do without asking, for every power. */
export function charterModes(ctx: ControlContext, projectId: string): Record<Power, CharterMode> {
  const policy = workflowPolicy(ctx, projectId);
  const project = ctx.store.must<Project>('projects', projectId);
  return {
    ...DEFAULT_WORKFLOW_POLICY.charter,
    ...policy.charter,
    start_external: EXTERNAL_START[externalEvents(ctx, project)],
  };
}

/** Whether a lead of the project uses the power on its own, asks the user first, or may not use it. */
export function charterMode(ctx: ControlContext, projectId: string, power: Power): CharterMode {
  return charterModes(ctx, projectId)[power];
}

/** The mode the principal uses the power on the subject in; a non-user's use is recorded. */
export function chartered(
  ctx: ControlContext,
  p: Principal,
  power: Power,
  subject: Entity,
  reason?: string,
): CharterMode {
  if (p.role === 'user') return 'on';
  const mode = charterMode(ctx, p.project_id!, power);
  ctx.store.event('charter.power_used', subject, p.project_id!, {
    power,
    mode,
    subject: subject.id,
    session_id: p.session_id,
    ...(reason ? { reason } : {}),
  });
  return mode;
}
