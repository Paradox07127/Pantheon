import { DomainError, requireThat, type Principal } from '@pantheon/domain';
import type { Command } from '@pantheon/protocol';
import type { ControlContext, Handler, Preparers } from './context.js';

/** The only instructions Pantheon adds to a conductor session. */
export const CONDUCTOR_INSTRUCTIONS =
  "Pantheon gives this session four tools. request_review: another vendor reviews your committed changes; the result comes back to you as a message. report_ready: your committed changes go through the project's gate and land. spawn_session: another vendor's session starts in a new worktree from your current commit; you hear when its turn ends. read_state: this project's changes, checks, landing queue and items waiting for the user. Plan, split work and run subagents with your own tools.";

/** conductor.review */
function prepareConductorReview(ctx: ControlContext, p: Principal, command: Command): Handler {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  throw new DomainError('not_implemented', 'conductor.review is not implemented');
}

/** conductor.ready */
function prepareConductorReady(ctx: ControlContext, p: Principal, command: Command): Handler {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  throw new DomainError('not_implemented', 'conductor.ready is not implemented');
}

/** conductor.spawn */
function prepareConductorSpawn(ctx: ControlContext, p: Principal, command: Command): Handler {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  throw new DomainError('not_implemented', 'conductor.spawn is not implemented');
}

/** conductor.state */
function prepareConductorState(ctx: ControlContext, p: Principal, command: Command): Handler {
  requireThat(p.role === 'conductor', 'permission_denied', 'A conductor session only');
  throw new DomainError('not_implemented', 'conductor.state is not implemented');
}

export const conductorPreparers: Preparers = {
  'conductor.review': prepareConductorReview,
  'conductor.ready': prepareConductorReady,
  'conductor.spawn': prepareConductorSpawn,
  'conductor.state': prepareConductorState,
};
