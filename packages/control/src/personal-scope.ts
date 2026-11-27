import { requireThat, type Principal } from '@pantheon/domain';
import type { Command, CommandType, QueryMethod } from '@pantheon/protocol';
import type { ControlContext } from './context.js';

/** The queries a personal principal may make, for every project. */
export const PERSONAL_QUERIES = [
  'projects.summary',
  'needs_you.list',
  'project.brief',
  'project.decisions',
  'session.thread',
] as const satisfies readonly QueryMethod[];

/** The commands a personal principal may send. */
export const PERSONAL_COMMANDS = ['project.seen'] as const satisfies readonly CommandType[];

export const OUTSIDE_PERSONAL_SCOPE = "Outside the personal agent's scope";

/** The id of the personal key the principal holds. */
export const personalKeyId = (p: Principal) => p.id.slice('personal:'.length);

/** Refuses a personal principal a query not on its list. */
export function personalQuery(p: Principal, method: string): void {
  requireThat(
    p.role !== 'personal' || (PERSONAL_QUERIES as readonly string[]).includes(method),
    'permission_denied',
    OUTSIDE_PERSONAL_SCOPE,
  );
}

/** Refuses a personal principal a command not on its list. */
export function personalCommand(p: Principal, command: Command): void {
  requireThat(
    p.role !== 'personal' || (PERSONAL_COMMANDS as readonly string[]).includes(command.type),
    'permission_denied',
    OUTSIDE_PERSONAL_SCOPE,
  );
}

/** Records a write a personal principal made; the caller owns the transaction. */
export function personalCalled(
  ctx: ControlContext,
  p: Principal,
  command: Command,
  projectId: string,
): void {
  if (p.role !== 'personal') return;
  const keyId = personalKeyId(p);
  ctx.store.event(
    'personal.called',
    { id: keyId, revision: 1 },
    projectId,
    { key_id: keyId, type: command.type, project_id: projectId },
    command.command_id,
  );
}
