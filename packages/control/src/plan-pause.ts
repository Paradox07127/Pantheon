import { requireThat, type BoardPlan } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { planViews } from './board-plan.js';
import { appendNote } from './lead-inbox.js';
import { wakeLead } from './task-tracking.js';

function userPlan(ctx: ControlContext, projectId: string, leadId: string): BoardPlan {
  const plan = ctx.store.get<BoardPlan>('board_plans', leadId);
  requireThat(plan?.project_id === projectId, 'not_found', `Not found: board plan ${leadId}`);
  return plan;
}

/** Writes the plan, records the event, and tells and wakes the lead. */
function changePause(
  ctx: ControlContext,
  next: BoardPlan,
  revision: number,
  kind: string,
  text: string,
  commandId: string,
) {
  const written = ctx.store.update<BoardPlan>('board_plans', next, revision);
  ctx.store.event(kind, written, written.project_id, {}, commandId);
  const noted = appendNote(
    ctx,
    written,
    { at: ctx.store.now(), session_id: '', task_id: '', kind: 'user_edit', text },
    commandId,
  );
  wakeLead(ctx, noted, commandId);
  return planViews(ctx, written.project_id).find((view) => view.lead_session_id === written.id)!;
}

export const planPauseHandlers: Handlers = {
  'board.plan.pause': (ctx, p, c) => {
    const input = inputSchemas['board.plan.pause'].parse(c.input);
    userOnly(p);
    projectAccess(ctx, p, input.project_id, c.type);
    const plan = userPlan(ctx, input.project_id, input.lead_session_id);
    requireThat(!plan.paused, 'invalid_state', 'This plan is already paused');
    const { reassessment: _, ...rest } = plan;
    return changePause(
      ctx,
      { ...rest, paused: { at: ctx.store.now(), by: 'user' } },
      plan.revision,
      'board.plan_paused',
      'The user paused this plan: write a re-assessment with reassess. Running task sessions go on, and no new task session starts until the user resumes the plan.',
      c.command_id,
    );
  },
  'board.plan.resume': (ctx, p, c) => {
    const input = inputSchemas['board.plan.resume'].parse(c.input);
    userOnly(p);
    projectAccess(ctx, p, input.project_id, c.type);
    const plan = userPlan(ctx, input.project_id, input.lead_session_id);
    requireThat(plan.paused, 'invalid_state', 'This plan is not paused');
    const { paused: _, ...rest } = plan;
    return changePause(
      ctx,
      rest,
      plan.revision,
      'board.plan_resumed',
      'The user resumed this plan; its started tasks open again.',
      c.command_id,
    );
  },
  'board.plan.reassess': (ctx, p, c) => {
    const { project_id, ...fields } = inputSchemas['board.plan.reassess'].parse(c.input);
    projectAccess(ctx, p, project_id, c.type);
    requireThat(p.role === 'lead', 'permission_denied', 'Lead session required');
    const plan = ctx.store.get<BoardPlan>('board_plans', p.session_id!);
    requireThat(
      plan?.paused,
      'invalid_state',
      'Your plan is not paused; write a re-assessment only after the user pauses it',
    );
    const reassessment = { ...fields, at: ctx.store.now() };
    const written = ctx.store.update<BoardPlan>(
      'board_plans',
      { ...plan, reassessment },
      plan.revision,
    );
    ctx.store.event('board.plan_reassessed', written, project_id, {}, c.command_id);
    return { reassessment };
  },
};
