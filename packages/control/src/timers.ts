import type { Timer } from '@pantheon/domain';
import type { ControlContext } from './context.js';

export type TimerHandler = (ctx: ControlContext, timer: Timer) => void;
export const timerHandlers = new Map<string, TimerHandler>();

export function scheduleTimer(
  ctx: ControlContext,
  input: Omit<Timer, 'revision' | 'state' | 'fired_at'>,
): Timer {
  return (
    ctx.store.get<Timer>('timers', input.id) ??
    ctx.store.insert<Timer>('timers', { ...input, revision: 1, state: 'pending' })
  );
}

export function cancelTimer(ctx: ControlContext, id: string): void {
  const timer = ctx.store.get<Timer>('timers', id);
  if (timer?.state === 'pending')
    ctx.store.update<Timer>('timers', { ...timer, state: 'cancelled' }, timer.revision);
}

// One failing handler must not keep later timers or the rest of the tick from running.
export function fireDueTimers(ctx: ControlContext): void {
  const errors: unknown[] = [];
  for (const timer of ctx.store.list<Timer>('timers')) {
    if (timer.state !== 'pending' || timer.due_at > ctx.store.now()) continue;
    try {
      ctx.store.transaction(() => {
        const current = ctx.store.must<Timer>('timers', timer.id);
        if (current.state !== 'pending' || current.due_at > ctx.store.now()) return;
        const handler = timerHandlers.get(current.kind);
        if (!handler) return;
        handler(ctx, current);
        const next = ctx.store.update<Timer>(
          'timers',
          { ...current, state: 'fired', fired_at: ctx.store.now() },
          current.revision,
        );
        ctx.store.event('timer.fired', next, next.project_id, next);
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors);
}
