import { requireThat, type Principal, type Project, type Retrospective } from '@pantheon/domain';
import type { ChangeOutcome, ChangeOutcomeWindow } from '@pantheon/protocol';
import { projectAccess, type ControlContext } from './context.js';
import { measure } from './improvements.js';
import { costPerAcceptedTask } from './usage-report.js';

/** The tasks each side of a change is judged on, in tasks. */
const WINDOW_TASKS = 10;
/** How far the cost per accepted task must move to count, as a fraction. */
const COST_SHARE = 0.1;
const LIST_LIMIT = 20;

type Change = Pick<
  ChangeOutcome,
  'event_id' | 'kind' | 'at' | 'param' | 'from' | 'to' | 'agent_id' | 'routine_ids'
>;

/** The user's workflow setting changes, agent creations and routine enables in the project, oldest first. */
function changes(ctx: ControlContext, projectId: string): Change[] {
  const enabled = new Map<string, Set<string>>();
  const found: Change[] = [];
  for (const event of ctx.store.kindEvents(projectId, [
    'workflow.policy_changed',
    'agent_profile.created',
    'agent_profile.updated',
  ])) {
    const base = { event_id: event.event_id, at: event.created_at };
    const payload = event.payload as {
      param?: string;
      by?: unknown;
      routines?: { id: string; enabled: boolean }[];
    };
    if (event.kind === 'workflow.policy_changed') {
      if (payload.by === 'user')
        found.push({
          ...base,
          kind: 'policy_changed',
          param: payload.param!,
          ...('from' in payload && { from: payload.from }),
          ...('to' in payload && { to: payload.to }),
        });
      continue;
    }
    if (event.kind === 'agent_profile.created')
      found.push({ ...base, kind: 'agent_created', agent_id: event.aggregate_id });
    if (!payload.routines) continue;
    const was = enabled.get(event.aggregate_id) ?? new Set<string>();
    const now = payload.routines.filter((routine) => routine.enabled).map((routine) => routine.id);
    enabled.set(event.aggregate_id, new Set(now));
    const turnedOn = now.filter((routineId) => !was.has(routineId));
    if (event.kind === 'agent_profile.updated' && turnedOn.length)
      found.push({
        ...base,
        kind: 'routine_enabled',
        agent_id: event.aggregate_id,
        routine_ids: turnedOn,
      });
  }
  return found;
}

function outcome(rows: Retrospective[], change: Change): ChangeOutcome {
  // A task under way at the change ran partly without it.
  const after = rows
    .filter((row) => (row.started_at ?? row.recorded_at) > change.at)
    .sort((a, b) => a.recorded_at - b.recorded_at)
    .slice(0, WINDOW_TASKS);
  const before = rows
    .filter((row) => row.recorded_at < change.at)
    .sort((a, b) => b.recorded_at - a.recorded_at)
    .slice(0, after.length);
  const window = (sample: Retrospective[]): ChangeOutcomeWindow => {
    const measured = measure(sample, {
      user_interventions: (rows) => rows.filter((row) => row.stopped_by === 'user').length,
    });
    return {
      tasks: measured.tasks!,
      first_pass: measured.first_pass!,
      cost_per_accepted_task: costPerAcceptedTask(sample),
      user_interventions: measured.user_interventions!,
    };
  };
  const was = window(before),
    is = window(after);
  const [cost, costAfter] = [
    was.cost_per_accepted_task.input_tokens,
    is.cost_per_accepted_task.input_tokens,
  ];
  // Both sides hold the same number of tasks, so counts compare as rates.
  const verdict: ChangeOutcome['verdict'] =
    after.length < WINDOW_TASKS ||
    before.length < WINDOW_TASKS ||
    cost === null ||
    costAfter === null
      ? 'not_enough_evidence'
      : costAfter > cost * (1 + COST_SHARE) ||
          is.first_pass < was.first_pass ||
          is.user_interventions > was.user_interventions
        ? 'worse'
        : costAfter < cost * (1 - COST_SHARE)
          ? 'better'
          : 'not_enough_evidence';
  return {
    ...change,
    n: after.length,
    tasks_required: WINDOW_TASKS,
    verdict,
    before: was,
    after: is,
  };
}

const planTasks = (ctx: ControlContext, projectId: string) =>
  ctx.store
    .list<Retrospective>('retrospectives')
    .filter((row) => row.project_id === projectId && row.origin !== 'session');

/** The tasks before and after one of the user's changes in the project, by its event id. */
export function changeOutcome(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
  eventId: string,
): ChangeOutcome {
  projectAccess(ctx, principal, projectId, 'change.outcome');
  ctx.store.must<Project>('projects', projectId);
  const change = changes(ctx, projectId).find((each) => each.event_id === eventId);
  requireThat(change, 'not_found', `events/${eventId}`);
  return outcome(planTasks(ctx, projectId), change);
}

/** The outcome of each of the project's recent changes, newest first. */
export function changeOutcomes(
  ctx: ControlContext,
  principal: Principal,
  projectId: string,
): ChangeOutcome[] {
  projectAccess(ctx, principal, projectId, 'change.outcomes');
  ctx.store.must<Project>('projects', projectId);
  const rows = planTasks(ctx, projectId);
  return changes(ctx, projectId)
    .reverse()
    .slice(0, LIST_LIMIT)
    .map((change) => outcome(rows, change));
}
