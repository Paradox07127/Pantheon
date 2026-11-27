import { requireThat, type Principal, type Project, type Session } from '@pantheon/domain';
import { sessionRole, type inputSchemas, type ProjectResident } from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handler } from './context.js';
import { projectBudgetUse } from './workflow-policy.js';

export function assignResident(
  ctx: ControlContext,
  project: Project,
  session_id: string | null,
  cause: string,
) {
  // The newest assignment is the mark the turn counts start from.
  if ((project.resident?.session_id ?? null) === session_id) return project;
  const resident = session_id === null ? undefined : { session_id, since: ctx.store.now() };
  const next = ctx.store.update('projects', { ...project, resident }, project.revision);
  ctx.store.event('project.resident_set', next, project.id, { session_id }, cause);
  return next;
}

function currentResident(ctx: ControlContext, project: Project) {
  const resident = project.resident;
  const session = resident && ctx.store.get<Session>('sessions', resident.session_id);
  return session && session.state !== 'closed' ? resident : undefined;
}

export function setResidentInstructions(
  ctx: ControlContext,
  project: Project,
  instructions: string,
  cause: string,
) {
  const resident = currentResident(ctx, project);
  requireThat(resident, 'invalid_state', 'This project has no resident main agent');
  const next = ctx.store.update(
    'projects',
    {
      ...project,
      resident: { ...resident, instructions: instructions.trim() ? instructions : undefined },
    },
    project.revision,
  );
  ctx.store.event(
    'project.resident_instructions_set',
    next,
    project.id,
    { session_id: resident.session_id },
    cause,
  );
}

export function residentInstructionBlock(project: Project, session: Session): string[] {
  const { resident } = project;
  return resident?.session_id === session.id && resident.instructions
    ? [
        `The user's standing instructions for you as this project's resident main agent, in their own words:\n\n${resident.instructions}`,
      ]
    : [];
}

export const setProjectResident: Handler = (ctx, p, c) => {
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
  assignResident(ctx, project, session_id, c.command_id);
  return {};
};

export const setProjectResidentInstructions: Handler = (ctx, p, c) => {
  userOnly(p);
  const { project_id, instructions } = c.input as ReturnType<
    (typeof inputSchemas)['project.resident.instructions.set']['parse']
  >;
  projectAccess(ctx, p, project_id, c.type);
  setResidentInstructions(
    ctx,
    ctx.store.must<Project>('projects', project_id),
    instructions,
    c.command_id,
  );
  return {};
};

export function projectResident(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): ProjectResident {
  projectAccess(ctx, p, projectId, 'project.read');
  const resident = currentResident(ctx, ctx.store.must<Project>('projects', projectId));
  const budget = projectBudgetUse(ctx, projectId) ?? null;
  if (!resident)
    return {
      session_id: null,
      since: null,
      instructions: null,
      turns: { pantheon: 0, user: 0 },
      budget,
      wakes: [],
    };

  const turns = ctx.store
    .statement(
      `SELECT count(*) FILTER (WHERE data->>'$.origin' IS NULL) AS user,
              count(*) FILTER (WHERE data->>'$.origin' <> 'compaction') AS pantheon
       FROM session_turns t WHERE data->>'$.session_id'=? AND
         (SELECT min(sequence) FROM events WHERE aggregate_id=t.id AND kind='turn.running') >
         (SELECT max(sequence) FROM events WHERE project_id=? AND kind='project.resident_set')`,
    )
    .get(resident.session_id, projectId) as ProjectResident['turns'];
  const events = ctx.store
    .statement(
      `SELECT e.created_at AS at, e.payload->>'$.cause' AS cause, e.payload->>'$.reason' AS reason,
              e.payload->>'$.turn_id' AS turn_id, substr(t.data->>'$.input', 1, 200) AS preview
       FROM events e LEFT JOIN session_turns t ON t.id=e.payload->>'$.turn_id'
       WHERE e.project_id=? AND e.kind IN ('resident.woken', 'resident.wake_skipped')
         AND e.payload->>'$.session_id'=?
       ORDER BY e.sequence DESC LIMIT 20`,
    )
    .all(projectId, resident.session_id) as ({
    at: number;
    cause: string;
  } & (
    | { reason: null; turn_id: string; preview: string | null }
    | { reason: 'budget' | 'not_accepting'; turn_id: null; preview: null }
  ))[];
  return {
    ...resident,
    instructions: resident.instructions ?? null,
    turns,
    budget,
    wakes: events.map(({ at, cause, reason, turn_id, preview }) =>
      reason === null
        ? { at, cause, kind: 'woken', turn_id, ...(preview !== null && { preview }) }
        : { at, cause, kind: 'skipped', reason },
    ),
  };
}
