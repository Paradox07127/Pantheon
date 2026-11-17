import { requireThat, type Principal } from '@pantheon/domain';
import type { Command, CommandType, QueryMethod } from '@pantheon/protocol';

/** The queries a personal principal may make, for every project. */
export const PERSONAL_QUERIES = [
  'projects.summary',
  'needs_you.list',
  'project.brief',
  'project.decisions',
] as const satisfies readonly QueryMethod[];

/** The commands a personal principal may send. */
export const PERSONAL_COMMANDS = ['project.seen'] as const satisfies readonly CommandType[];

export const OUTSIDE_PERSONAL_SCOPE = "Outside the personal agent's scope";

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
