import { isDeepStrictEqual } from 'node:util';
import {
  id,
  requireThat,
  type AgentProfile,
  type AgentRoutine,
  type AgentRoutineInput,
  type BoardPlan,
  type LeadNote,
  type Principal,
  type Project,
  type Session,
  type Timer,
} from '@pantheon/domain';
import { inputSchemas, withinHours } from '@pantheon/protocol';
import { gitFolderAsync, projectAccess, type ControlContext, type Handlers } from './context.js';
import { appendNote } from './lead-inbox.js';
import { openAgent } from './resident.js';
import { wakeLead } from './task-tracking.js';
import { cancelTimer, scheduleTimer, timerHandlers } from './timers.js';
import { tellUser } from './user-delivery.js';
import { runValidationCommand } from './validation-executor.js';
import { afterCommit } from './workbench-session.js';

const FOLLOW_UP = 'agent-follow-up';
export const ROUTINE = 'agent-routine';
const ROUTINE_LIMIT = 10;
const MINUTE_MS = 60_000;
/** Routine timer subjects whose precheck is running. */
const prechecking = new Set<string>();

/** The calling resident session and its agent profile; any other caller is refused. */
export function callingResident(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
  action: string,
) {
  projectAccess(ctx, p, projectId, action);
  const session =
    p.role === 'lead' && p.session_id
      ? ctx.store.get<Session>('sessions', p.session_id)
      : undefined;
  requireThat(session?.resident?.agent_id, 'permission_denied', 'Resident agent session required');
  return {
    session,
    profile: ctx.store.must<AgentProfile>('agents', session.resident!.agent_id!),
  };
}

const exactlyOne = (a: unknown, b: unknown) => (a === undefined) !== (b === undefined);

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/** The first local time of day HH:MM after the moment. */
function nextClock(time: string, after: number): number {
  const minutes = minutesOf(time),
    day = new Date(after);
  day.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (day.getTime() <= after) day.setDate(day.getDate() + 1);
  return day.getTime();
}

/** When the routine runs next after the moment; outside its active hours, at their next start. */
export function nextRun(routine: AgentRoutine, after: number): number {
  const due =
    routine.every_ms !== undefined ? after + routine.every_ms : nextClock(routine.at!, after);
  return !routine.active_hours || withinHours(routine.active_hours, due)
    ? due
    : nextClock(routine.active_hours.from, due);
}

export const routineSubject = (profile: AgentProfile, routineId: string) =>
  `${profile.id}:${routineId}`;

/** Cancels the routine's pending run and schedules its next one while it is enabled. */
export function scheduleRoutine(ctx: ControlContext, profile: AgentProfile, routine: AgentRoutine) {
  const subject = routineSubject(profile, routine.id);
  for (const timer of ctx.store.list<Timer>('timers'))
    if (timer.kind === ROUTINE && timer.subject_id === subject) cancelTimer(ctx, timer.id);
  if (routine.enabled)
    scheduleTimer(ctx, {
      id: id(),
      project_id: profile.project_id,
      kind: ROUTINE,
      subject_id: subject,
      due_at: nextRun(routine, ctx.store.now()),
    });
}

/** The stored routine of one a command gives, with a new id when it has none. */
export const routineOf = (input: AgentRoutineInput): AgentRoutine => ({
  id: input.id ?? id(),
  prompt: input.prompt,
  ...(input.every_minutes !== undefined && { every_ms: input.every_minutes * MINUTE_MS }),
  ...(input.at !== undefined && { at: input.at }),
  ...(input.active_hours && { active_hours: input.active_hours }),
  enabled: input.enabled,
  ...(input.precheck && {
    precheck: {
      argv: input.precheck.argv,
      ...(input.precheck.timeout_seconds !== undefined && {
        timeout_ms: input.precheck.timeout_seconds * 1000,
      }),
    },
  }),
});

/** The resident's plan; an empty one while it has written none. */
export function residentPlan(ctx: ControlContext, resident: Session): BoardPlan {
  return (
    ctx.store.get<BoardPlan>('board_plans', resident.id) ??
    ctx.store.insert<BoardPlan>('board_plans', {
      id: resident.id,
      revision: 1,
      project_id: resident.project_id,
      headline: '',
      lanes: [],
      tasks: [],
      plan_version: 0,
      pending_edits: [],
      risks: [],
      assumptions: [],
      inbox: [],
      notified: {},
      updated_at: ctx.store.now(),
    })
  );
}

/** Leaves the agent's open resident, opened when it has none, the note and wakes it. */
export function wakeAgent(
  ctx: ControlContext,
  profile: AgentProfile,
  kind: LeadNote['kind'],
  text: string,
  cause: string,
  fields: Partial<LeadNote> = {},
): void {
  const resident = openAgent(ctx, profile, cause);
  const plan = appendNote(
    ctx,
    residentPlan(ctx, resident),
    { at: ctx.store.now(), session_id: '', task_id: '', kind, text, ...fields },
    cause,
  );
  wakeLead(ctx, plan, cause);
}

timerHandlers.set(FOLLOW_UP, (ctx, timer) => {
  const session = ctx.store.get<Session>('sessions', timer.subject_id);
  const profile =
    session?.resident?.agent_id && ctx.store.get<AgentProfile>('agents', session.resident.agent_id);
  if (!profile || profile.archived_at) return;
  wakeAgent(ctx, profile, 'follow_up', timer.note ?? '', `timer:${timer.id}`);
});

/** The routine note of the agent's last run of the routine; undefined when it never ran. */
export function lastRoutineRun(
  ctx: ControlContext,
  profile: AgentProfile,
  routineId: string,
): LeadNote | undefined {
  // Routine ids are unique within the profile, whose residents' plans hold its notes.
  return ctx.store
    .kindEvents(profile.project_id, ['lead.note_added'])
    .filter(
      (event) =>
        ctx.store.get<Session>('sessions', event.aggregate_id)?.resident?.agent_id === profile.id,
    )
    .map((event) => event.payload as LeadNote)
    .filter((note) => note.kind === 'routine' && note.routine_id === routineId)
    .at(-1);
}

timerHandlers.set(ROUTINE, (ctx, timer) => {
  const split = timer.subject_id.indexOf(':'),
    profile = ctx.store.get<AgentProfile>('agents', timer.subject_id.slice(0, split)),
    routine = profile?.routines.find((each) => each.id === timer.subject_id.slice(split + 1));
  if (!profile || profile.archived_at || !routine?.enabled) return;
  const last = lastRoutineRun(ctx, profile, routine.id);
  const cause = `timer:${timer.id}`,
    fields = { routine_id: routine.id, ...(last ? { last_run_at: last.at } : {}) };
  const precheck = routine.precheck;
  if (!precheck) wakeAgent(ctx, profile, 'routine', routine.prompt, cause, fields);
  else if (!prechecking.has(timer.subject_id)) {
    // The command runs after this transaction commits; its end re-reads the routine.
    prechecking.add(timer.subject_id);
    const settle = (exitCode: number | null, output: string) =>
      ctx.store.transaction(() => {
        const current = ctx.store.get<AgentProfile>('agents', profile.id),
          now = current?.routines.find((each) => each.id === routine.id);
        if (!current || current.archived_at || !now?.enabled) return;
        if (!isDeepStrictEqual(now.precheck, precheck)) return;
        if (exitCode === 0) return wakeAgent(ctx, current, 'routine', now.prompt, cause, fields);
        ctx.store.event(
          'agent.routine_skipped',
          current,
          current.project_id,
          {
            agent_id: current.id,
            routine_id: routine.id,
            exit_code: exitCode,
            output_tail: output.slice(-600),
          },
          cause,
        );
      });
    const committed = afterCommit(ctx);
    const work: Promise<void> = Promise.resolve()
      .then(async () => {
        if (!committed() || ctx.closing) return;
        const project = ctx.store.must<Project>('projects', profile.project_id);
        const git = await Promise.all(project.roots.map(gitFolderAsync));
        const root = project.roots.find((_, index) => git[index]);
        requireThat(root, 'invalid_state', 'The project has no git folder to run the precheck in');
        const result = await runValidationCommand({
          ctx,
          key: `routine-precheck:${timer.subject_id}`,
          argv: precheck.argv,
          cwd: root,
          root,
          env: {
            ...project.env,
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            LANG: 'en_US.UTF-8',
            pnpm_config_verify_deps_before_run: 'false',
            ...(last && { ROUTINE_LAST_RUN_AT: new Date(last.at).toISOString() }),
          },
          timeoutMs: precheck.timeout_ms ?? MINUTE_MS,
          cancelled: () => ctx.closing,
        });
        if (!ctx.closing) settle(result.exit_code, result.error ?? result.tail);
      })
      .catch((error: unknown) => {
        if (!ctx.closing) settle(null, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        prechecking.delete(timer.subject_id);
        ctx.completions.delete(work);
        if (!ctx.closing) ctx.changed();
      });
    ctx.completions.add(work);
  }
  return nextRun(routine, ctx.store.now());
});

export const agentAlwaysOnHandlers: Handlers = {
  'agent.follow_up': (ctx, p, c) => {
    const input = inputSchemas['agent.follow_up'].parse(c.input);
    requireThat(
      exactlyOne(input.after_minutes, input.at),
      'invalid_input',
      'Give exactly one of after_minutes or at',
    );
    const { session } = callingResident(ctx, p, input.project_id, c.type);
    return scheduleTimer(ctx, {
      id: id(),
      project_id: session.project_id,
      kind: FOLLOW_UP,
      subject_id: session.id,
      due_at: input.at ?? ctx.store.now() + input.after_minutes! * MINUTE_MS,
      note: input.note,
    });
  },
  'agent.tell_user': (ctx, p, c) => {
    const input = inputSchemas['agent.tell_user'].parse(c.input);
    return tellUser(ctx, callingResident(ctx, p, input.project_id, c.type), input, c.command_id);
  },
  'agent.routine.set': (ctx, p, c) => {
    const input = inputSchemas['agent.routine.set'].parse(c.input);
    requireThat(
      exactlyOne(input.every_minutes, input.at),
      'invalid_input',
      'Give exactly one of every_minutes or at',
    );
    const { profile } = callingResident(ctx, p, input.project_id, c.type);
    const { project_id: _project, ...fields } = input;
    const previous = profile.routines.find((each) => each.id === fields.id);
    // A resident cannot set a precheck, so replacing a routine keeps the user's.
    const routine = {
      ...routineOf(fields),
      ...(previous?.precheck && { precheck: previous.precheck }),
    };
    const replaced = previous !== undefined;
    requireThat(
      replaced || profile.routines.length < ROUTINE_LIMIT,
      'invalid_input',
      `An agent has at most ${ROUTINE_LIMIT} routines`,
    );
    const next = ctx.store.update<AgentProfile>(
      'agents',
      {
        ...profile,
        routines: replaced
          ? profile.routines.map((each) => (each.id === routine.id ? routine : each))
          : [...profile.routines, routine],
      },
      profile.revision,
    );
    ctx.store.event(
      'agent_profile.updated',
      next,
      next.project_id,
      { routines: next.routines },
      c.command_id,
    );
    scheduleRoutine(ctx, next, routine);
    return routine;
  },
  'agent.routine.cancel': (ctx, p, c) => {
    const input = inputSchemas['agent.routine.cancel'].parse(c.input);
    const { profile } = callingResident(ctx, p, input.project_id, c.type);
    const routine = profile.routines.find((each) => each.id === input.routine_id);
    requireThat(routine, 'not_found', `Not found: routine ${input.routine_id}`);
    const next = ctx.store.update<AgentProfile>(
      'agents',
      { ...profile, routines: profile.routines.filter((each) => each !== routine) },
      profile.revision,
    );
    ctx.store.event(
      'agent_profile.updated',
      next,
      next.project_id,
      { routines: next.routines },
      c.command_id,
    );
    scheduleRoutine(ctx, next, { ...routine, enabled: false });
    return next;
  },
};
