import {
  DomainError,
  type BoardPlan,
  type Project,
  type Session,
  type SessionTurn,
  type WorkflowPolicy,
} from '@pantheon/domain';
import { insert, type ControlContext } from './context.js';
import { queueTurn } from './session-wake.js';
import { nextDepth } from './progress.js';
import { acceptInput, queuedTurn } from './session.js';
import { projectBudgetUse } from './workflow-policy.js';

const WRAP_UP_TEXT =
  'The project has used its input-token budget. Wrap up now: commit the work that is done, say in your report or reply what remains, and end your turn. Pantheon opens no new sessions until the user raises the budget.';

/** Tells each open lead with a plan and each unfinished task session to wrap up, once each time a project goes over its budget. */
export function wrapUpOverBudget(ctx: ControlContext): void {
  for (const project of ctx.store.list<Project>('projects')) {
    const use = projectBudgetUse(ctx, project.id);
    if (use?.reached_at === undefined) continue;
    const policy = ctx.store.must<WorkflowPolicy>('workflow_policies', project.id);
    // A raised budget keeps its since, so the limit and the time it was reached tell one overrun from the next.
    const overrun = {
      since: policy.project_budget!.since,
      input_tokens: use.input_tokens,
      reached_at: use.reached_at,
    };
    if (
      ctx.store.db
        .prepare(
          "SELECT 1 FROM events WHERE project_id=? AND kind='project.budget_wrap_up' AND json_extract(payload,'$.since')=? AND json_extract(payload,'$.input_tokens')=? AND json_extract(payload,'$.reached_at')=? LIMIT 1",
        )
        .get(project.id, overrun.since, overrun.input_tokens, overrun.reached_at)
    )
      continue;
    const leads = ctx.store
      .list<BoardPlan>('board_plans')
      .filter((plan) => plan.project_id === project.id)
      .map((plan) => ctx.store.get<Session>('sessions', plan.id));
    const tasks = ctx.store
      .list<Session>('sessions')
      .filter((session) => session.project_id === project.id && session.task && !session.outcome);
    const told = [...leads, ...tasks]
      .filter((session): session is Session => !!session && session.state !== 'closed')
      .filter((session) => tellWrapUp(ctx, session))
      .map((session) => session.id);
    ctx.store.event('project.budget_wrap_up', policy, project.id, {
      ...overrun,
      session_ids: told,
    });
  }
}

/** Steers the running session or starts a turn on the idle one; false when it takes no input now. */
function tellWrapUp(ctx: ControlContext, session: Session): boolean {
  const running = session.state === 'running';
  try {
    acceptInput(ctx, session, running ? 'steer' : 'send');
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
  const depth = nextDepth(ctx, session.id, session.task);
  if (!running) {
    queueTurn(ctx, session, WRAP_UP_TEXT, 'continuation', '', { causal_depth: depth });
    return true;
  }
  const turn: SessionTurn = {
    ...queuedTurn(session, WRAP_UP_TEXT, 'steer', { causal_depth: depth }),
    origin: 'continuation',
  };
  ctx.store.update(
    'sessions',
    { ...session, turn_count: session.turn_count + 1 },
    session.revision,
  );
  ctx.store.enqueue('session.turn', { turn_id: turn.id });
  insert(ctx, 'session_turns', turn, 'turn.queued', session.project_id, '');
  ctx.store.event('session.turn.delivery', turn, turn.project_id, { delivery: 'pending' }, '');
  return true;
}
