import { requireThat, type Principal, type Project, type Session } from '@pantheon/domain';
import { sessionRole, type inputSchemas, type ProjectResident } from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { projectBudgetUse } from './workflow-policy.js';

export const residentHandlers: Handlers = {
  'project.resident.set': (ctx, p, c) => {
    userOnly(p);
    const { project_id, session_id } = c.input as ReturnType<
      (typeof inputSchemas)['project.resident.set']['parse']
    >;
    projectAccess(ctx, p, project_id, c.type);
    const project = ctx.store.must<Project>('projects', project_id);
    if (session_id !== null) {
      const session = ctx.store.get<Session>('sessions', session_id);
      requireThat(
        session && session.project_id === project_id && sessionRole(session) === 'conductor',
        'invalid_input',
        'Choose an existing main agent session in this project',
      );
      requireThat(
        session.state !== 'closed' && session.outcome !== 'discarded',
        'invalid_input',
        'A closed or discarded session cannot be the resident main agent',
      );
    }
    // Only a change records the event, so the newest one is the mark the turn counts start from.
    if ((project.resident?.session_id ?? null) === session_id) return {};
    const resident = session_id === null ? undefined : { session_id, since: ctx.store.now() };
    const next = ctx.store.update('projects', { ...project, resident }, project.revision);
    ctx.store.event('project.resident_set', next, project_id, { session_id }, c.command_id);
    return {};
  },
};

export function projectResident(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): ProjectResident {
  projectAccess(ctx, p, projectId, 'project.read');
  const { resident } = ctx.store.must<Project>('projects', projectId);
  const budget = projectBudgetUse(ctx, projectId) ?? null;
  const session = resident && ctx.store.get<Session>('sessions', resident.session_id);
  if (!resident || !session || session.state === 'closed')
    return { session_id: null, since: null, turns: { pantheon: 0, user: 0 }, budget, wakes: [] };

  const turns = ctx.store
    .statement(
      `SELECT count(*) FILTER (WHERE data->>'$.origin' IS NULL) AS user,
              count(*) FILTER (WHERE data->>'$.origin' <> 'compaction') AS pantheon
       FROM session_turns t WHERE data->>'$.session_id'=? AND
         (SELECT min(sequence) FROM events WHERE aggregate_id=t.id AND kind='turn.running') >
         (SELECT max(sequence) FROM events WHERE project_id=? AND kind='project.resident_set')`,
    )
    .get(session.id, projectId) as ProjectResident['turns'];
  const events = ctx.store
    .statement(
      `SELECT e.created_at AS at, e.payload->>'$.cause' AS cause, e.payload->>'$.reason' AS reason,
              e.payload->>'$.turn_id' AS turn_id, substr(t.data->>'$.input', 1, 200) AS preview
       FROM events e LEFT JOIN session_turns t ON t.id=e.payload->>'$.turn_id'
       WHERE e.project_id=? AND e.kind IN ('resident.woken', 'resident.wake_skipped')
         AND e.payload->>'$.session_id'=?
       ORDER BY e.sequence DESC LIMIT 20`,
    )
    .all(projectId, session.id) as ({
    at: number;
    cause: string;
  } & (
    | { reason: null; turn_id: string; preview: string | null }
    | { reason: 'budget' | 'not_accepting'; turn_id: null; preview: null }
  ))[];
  return {
    ...resident,
    turns,
    budget,
    wakes: events.map(({ at, cause, reason, turn_id, preview }) =>
      reason === null
        ? { at, cause, kind: 'woken', turn_id, ...(preview !== null && { preview }) }
        : { at, cause, kind: 'skipped', reason },
    ),
  };
}
