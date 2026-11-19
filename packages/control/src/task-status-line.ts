import { requireThat, type BoardPlan, type Session } from '@pantheon/domain';
import { inputSchemas } from '@pantheon/protocol';
import { projectAccess, sessionPrincipal, type Handlers } from './context.js';
import { causeTurn } from './progress.js';

/** How long a status line stands before the same turn may set another. */
const STATUS_LINE_MS = 15_000;

export const taskStatusLineHandlers: Handlers = {
  'task.status_line': (ctx, p, c) => {
    const session = sessionPrincipal(ctx, p);
    projectAccess(ctx, p, session.project_id, c.type);
    const input = inputSchemas['task.status_line'].parse(c.input);
    requireThat(
      session.task || ctx.store.get<BoardPlan>('board_plans', session.id),
      'invalid_state',
      'Only a plan task session or a lead session sets a status line',
    );
    const turn = causeTurn(ctx, session.id);
    requireThat(turn?.state === 'running', 'invalid_state', 'This session has no running turn');
    const stored = session.status_line?.turn_id === turn.id ? session.status_line : undefined;
    if (stored?.text === input.text) return stored;
    const now = ctx.store.now();
    if (stored)
      requireThat(
        now - stored.at >= STATUS_LINE_MS,
        'invalid_state',
        `The status line was set less than 15 s ago; set a new one after ${new Date(stored.at + STATUS_LINE_MS).toISOString()}`,
      );
    const latest = ctx.store.must<Session>('sessions', session.id);
    const status_line = { text: input.text, at: now, turn_id: turn.id };
    const next = ctx.store.update('sessions', { ...latest, status_line }, latest.revision);
    ctx.store.event(
      'session.status_line_set',
      next,
      next.project_id,
      { text: input.text, turn_id: turn.id },
      c.command_id,
    );
    return status_line;
  },
};
