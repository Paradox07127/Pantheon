import {
  canonical,
  requireThat,
  type BoardPlan,
  type Event,
  type Milestone,
  type ReplanTrigger,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import type { ControlContext } from './context.js';
import { ownEntry, taskGeneration, taskSessions, taskState } from './board-plan.js';
import { appendNote } from './lead-inbox.js';
import { taskBudgetUse } from './task-budget.js';

/** The payload of a board.replan_triggered event, on the plan of the milestone's lead. */
export interface ReplanFired {
  /** The milestone row id. */
  milestone_id: string;
  trigger: ReplanTrigger;
  task_id: string;
  generation: number;
  /** The hand-backs counted or the budget ratio reached; absent for a stall. */
  value?: number;
}

/** What the task did that met the condition. */
export function triggerText(fired: ReplanFired): string {
  return fired.trigger.type === 'handbacks'
    ? `task ${fired.task_id} was handed back ${fired.value} times`
    : fired.trigger.type === 'budget_ratio'
      ? `task ${fired.task_id} spent ${Math.round(fired.value! * 100)}% of its budget`
      : `task ${fired.task_id} stalled`;
}

/**
 * Fires each re-plan condition of a lead milestone once per task generation that meets it: an event,
 * and a replan note unless one for the same milestone and condition still waits in the inbox.
 */
export function replanTriggers(ctx: ControlContext): void {
  const rows = ctx.store
    .list<Milestone>('milestones')
    .filter(
      (row) => row.owner_session_id && row.replan_if?.length && !row.removed_at && !row.acceptance,
    );
  if (!rows.length) return;
  const sessions = ctx.store.list<Session>('sessions'),
    projectEvents = new Map<string, { fired: Event[]; handedBack: Event[] }>();
  for (const row of rows) {
    let plan = ctx.store.get<BoardPlan>('board_plans', row.owner_session_id!);
    if (!plan) continue;
    const projectId = plan.project_id;
    if (!projectEvents.has(projectId))
      projectEvents.set(projectId, {
        fired: ctx.store.kindEvents(projectId, ['board.replan_triggered']),
        handedBack: ctx.store.kindEvents(projectId, ['task.handed_back']),
      });
    const { fired, handedBack } = projectEvents.get(projectId)!,
      lead = ctx.store.get<Session>('sessions', plan.id);
    const same = (payload: ReplanFired, trigger: ReplanTrigger) =>
      payload.milestone_id === row.id && canonical(payload.trigger) === canonical(trigger);
    for (const taskId of row.task_ids ?? []) {
      if (!plan.tasks.some((task) => task.id === taskId)) continue;
      if (
        taskState(plan, taskId, taskSessions(ctx, plan.id, taskId, sessions, plan), lead) === 'done'
      )
        continue;
      const generation = taskGeneration(plan, taskId),
        bound = sessions.filter(
          (session) =>
            session.task?.lead_session_id === plan!.id &&
            session.task.id === taskId &&
            (session.task.generation ?? 1) === generation,
        );
      for (const trigger of row.replan_if!) {
        let value: number | undefined;
        if (trigger.type === 'handbacks') {
          // Pantheon's hand-backs to the sessions and the hand-backs of the task to the lead.
          value = bound.reduce(
            (sum, session) =>
              sum +
              (ownEntry(plan!.handed_back, session.id)?.length ?? 0) +
              handedBack.filter(
                (event) => (event.payload as { session_id?: string }).session_id === session.id,
              ).length,
            0,
          );
          if (value < trigger.count) continue;
        } else if (trigger.type === 'budget_ratio') {
          value = taskBudgetUse(ctx, plan, taskId, ctx.store.now())?.ratio;
          if (value === undefined || value < trigger.at) continue;
        } else if (trigger.type === 'stall') {
          const stalled = Object.entries(plan.alerted ?? {}).some(
            ([turnId, alerts]) =>
              alerts.includes('stalled') &&
              bound.some(
                (session) =>
                  session.id === ctx.store.get<SessionTurn>('session_turns', turnId)?.session_id,
              ),
          );
          if (!stalled) continue;
        } else continue;
        if (
          fired.some((event) => {
            const payload = event.payload as ReplanFired;
            return (
              same(payload, trigger) &&
              payload.task_id === taskId &&
              payload.generation === generation
            );
          })
        )
          continue;
        const payload: ReplanFired = {
          milestone_id: row.id,
          trigger,
          task_id: taskId,
          generation,
          ...(value === undefined ? {} : { value }),
        };
        const event = ctx.store.event('board.replan_triggered', plan, projectId, payload);
        fired.push(event);
        const waiting = plan.inbox.some((note) => {
          const told = fired.find((each) => each.event_id === note.replan_event);
          return note.kind === 'replan' && !!told && same(told.payload as ReplanFired, trigger);
        });
        if (waiting) continue;
        plan = appendNote(ctx, plan, {
          at: ctx.store.now(),
          session_id: '',
          task_id: taskId,
          kind: 'replan',
          generation,
          replan_event: event.event_id,
          text: `Milestone ${row.key} "${row.title}": ${triggerText(payload)}, which meets the replan_if condition you set (${trigger.type === 'handbacks' ? `handbacks ${trigger.count}` : trigger.type === 'budget_ratio' ? `budget_ratio ${trigger.at}` : 'stall'}).`,
        });
      }
    }
  }
}

/** Refuses a trigger_event that names no re-plan condition fired on the lead's plan. */
export function requireTriggerEvent(
  ctx: ControlContext,
  leadId: string,
  eventId: string | undefined,
): void {
  if (eventId === undefined) return;
  const found = ctx.store
    .statement(
      "SELECT 1 FROM events WHERE event_id=? AND kind='board.replan_triggered' AND aggregate_id=?",
    )
    .get(eventId, leadId);
  requireThat(found, 'not_found', `Not found: re-plan event ${eventId} of your plan`);
}
