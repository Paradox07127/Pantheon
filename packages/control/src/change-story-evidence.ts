import {
  hash,
  type BoardPlan,
  type Session,
  type StoryContext,
  type Workspace,
  type Project,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { currentBinding, sessionPlanTask, taskGeneration } from './board-plan.js';
import { gateCommands } from './landing.js';
import { sessionGoal } from './landing-diff.js';

/**
 * The exact generation this session worked on, including a contract since removed or replaced, with
 * the session's parallel part over it.
 */
function taskContract(ctx: ControlContext, session: Session) {
  const bound = session.task;
  if (!bound) return;
  const plan = ctx.store.get<BoardPlan>('board_plans', bound.lead_session_id);
  if (currentBinding(plan, bound)) {
    const task = plan && sessionPlanTask(plan, session);
    if (task) return task;
  }
  const leads = new Set([bound.lead_session_id]);
  const transfers = ctx.store.kindEvents(session.project_id, ['board.plan_transferred']);
  for (const lead of leads)
    for (const event of transfers)
      if (event.aggregate_id === lead) {
        const from = (event.payload as { from?: string }).from;
        if (from) leads.add(from);
      }
  const historical = ctx.store
    .kindEvents(session.project_id, ['board.plan_updated'])
    .findLast((event) => {
      const saved = event.payload as BoardPlan;
      return (
        leads.has(event.aggregate_id) &&
        taskGeneration(saved, bound.id) === (bound.generation ?? 1) &&
        saved.tasks.some((task) => task.id === bound.id)
      );
    })?.payload as BoardPlan | undefined;
  return historical && sessionPlanTask(historical, session);
}

/** Only a recorded run of this commit and this command configuration can support a story. */
export function storyContext(ctx: ControlContext, session: Session, commit: string): StoryContext {
  const task = taskContract(ctx, session);
  const acceptance = [...(task?.acceptance ?? [])];
  const project = ctx.store.must<Project>('projects', session.project_id);
  const workspace = ctx.store.must<Workspace>('workspaces', session.workspace_id!);
  const projectCommands =
    gateCommands(ctx, project, workspace, { ...session, task: undefined }) ?? [];
  const commands = [
    ...projectCommands,
    ...acceptance.map((command) => ({ name: command, argv: ['/bin/sh', '-c', command] })),
  ];
  const spec_hash = hash(commands.length ? commands : undefined);
  const event = ctx.store
    .kindEvents(session.project_id, ['session.gate_checked'])
    .findLast((event) => event.aggregate_id === session.id);
  const run = event?.payload as
    | { commit?: string; check_spec_hash?: string; results?: StoryContext['checks']['results'] }
    | undefined;
  return {
    goal: task?.goal ?? sessionGoal(ctx, session),
    acceptance,
    contract_available: !session.task || task !== undefined,
    ...(session.task ? { task: { ...session.task } } : {}),
    checks: {
      state: !run
        ? 'none'
        : run.commit === commit && run.check_spec_hash === spec_hash
          ? 'recorded'
          : 'stale',
      spec_hash,
      commands,
      ...(event && run
        ? {
            run_id: event.event_id,
            commit: run.commit,
            recorded_spec_hash: run.check_spec_hash,
            checked_at: event.created_at,
          }
        : {}),
      results: run?.results ?? [],
    },
  };
}
