import { isDeepStrictEqual } from 'node:util';
import { nativeEnvironment } from '@pantheon/adapters';
import {
  id,
  requireThat,
  type Principal,
  type Project,
  type Routine,
  type RoutineSchedule,
  type Session,
  type Timer,
} from '@pantheon/domain';
import {
  withinHours,
  type inputSchemas,
  type ProjectRoutines,
  type RoutineRun,
} from '@pantheon/protocol';
import { projectAccess, userOnly, type ControlContext, type Handlers } from './context.js';
import { inheritedEnvAllowlist } from './native-session.js';
import { notifySession } from './session-wake.js';
import { cancelTimer, scheduleTimer, timerHandlers } from './timers.js';
import { runValidationCommand } from './validation-executor.js';
import { afterCommit } from './workbench-session.js';
import { projectOverBudget } from './workflow-policy.js';

const MINUTE = 60_000;
const ROUTINE = 'routine';
const prechecking = new Set<string>();
type RunResult = Omit<RoutineRun, 'at'> & { turn_id?: string };

function nextClock(time: string, after: number): number {
  const from = new Date(after);
  // Built per day, so a time skipped by a clock change on one day is not carried into the next.
  const on = (days: number) =>
    new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + days,
      Number(time.slice(0, 2)),
      Number(time.slice(3)),
    ).getTime();
  return on(0) > after ? on(0) : on(1);
}

export function nextRun(routine: RoutineSchedule, after: number): number {
  const due =
    routine.every_ms === undefined ? nextClock(routine.at, after) : after + routine.every_ms;
  return routine.active_hours && !withinHours(routine.active_hours, due)
    ? nextClock(routine.active_hours.from, due)
    : due;
}

function pendingTimers(ctx: ControlContext, projectId: string) {
  return ctx.store
    .list<Timer>('timers')
    .filter(
      (timer) =>
        timer.kind === ROUTINE && timer.project_id === projectId && timer.state === 'pending',
    );
}

function cancelPending(ctx: ControlContext, projectId: string, routineId: string) {
  for (const timer of pendingTimers(ctx, projectId))
    if (timer.subject_id === routineId) cancelTimer(ctx, timer.id);
}

function openResident(ctx: ControlContext, project: Project) {
  const session =
    project.resident && ctx.store.get<Session>('sessions', project.resident.session_id);
  return session?.state === 'closed' ? undefined : session;
}

function runRoutine(ctx: ControlContext, project: Project, routine: Routine, scheduled: boolean) {
  const cause = `routine:${routine.id}`;
  const record = (current: Project, result: RunResult) =>
    ctx.store.event(
      'routine.ran',
      current,
      current.id,
      { routine_id: routine.id, ...result },
      cause,
    );

  function wake(current: Project, resident: Session | undefined, stdout?: string) {
    const checked = stdout === undefined ? {} : { exit_code: 0 };
    if (!resident) {
      record(current, { outcome: 'skipped', reason: 'no_resident', ...checked });
      return;
    }
    const text = stdout ? `${routine.prompt}\n\n${stdout}` : routine.prompt;
    const turn = notifySession(ctx, resident.id, text, cause);
    record(
      current,
      turn
        ? { outcome: 'woken', turn_id: turn.id, ...checked }
        : {
            outcome: 'skipped',
            reason: projectOverBudget(ctx, current.id) ? 'budget' : 'not_accepting',
            ...checked,
          },
    );
  }

  const resident = openResident(ctx, project);
  const precheck = routine.precheck;
  if (!resident || !precheck || projectOverBudget(ctx, project.id)) {
    wake(project, resident);
    return;
  }
  const key = `${project.id}:${routine.id}`;
  if (prechecking.has(key)) {
    record(project, { outcome: 'skipped', reason: 'prechecking' });
    return;
  }
  prechecking.add(key);
  const committed = afterCommit(ctx);
  ctx.rollback?.push(() => prechecking.delete(key));
  const work = Promise.resolve()
    .then(async () => {
      if (!committed()) return;
      const result = await runValidationCommand({
        ctx,
        key: `check-process:routine:${key}`,
        argv: precheck.argv,
        cwd: project.roots[0]!,
        // The environment a session the user opened gets, as gate commands have it.
        env: { ...project.env, ...nativeEnvironment(inheritedEnvAllowlist(project)) },
        timeoutMs: precheck.timeout_ms ?? MINUTE,
        cancelled: () => ctx.closing,
      }).catch((error: unknown) => {
        // spawn can reject an unusable argv before there is a child to report an exit.
        ctx.diagnostic(error);
        return { exit_code: null, timedOut: false, stdout: Buffer.alloc(0) };
      });
      ctx.store.transaction(() => {
        const current = ctx.store.must<Project>('projects', project.id);
        if (current.removed_at !== undefined) return;
        const saved = current.routines?.find((r) => r.id === routine.id);
        const exit_code = result.exit_code;
        if (!isDeepStrictEqual(saved, routine))
          record(current, { outcome: 'skipped', reason: 'changed', exit_code });
        else if (ctx.closing || exit_code !== 0 || result.timedOut)
          record(current, { outcome: 'skipped', reason: 'precheck', exit_code });
        else if (
          scheduled &&
          routine.active_hours &&
          !withinHours(routine.active_hours, ctx.store.now())
        )
          record(current, { outcome: 'skipped', reason: 'inactive_hours', exit_code });
        else
          wake(current, openResident(ctx, current), result.stdout.toString('utf8').slice(0, 4000));
      });
    })
    .catch((error: unknown) => ctx.diagnostic(error))
    .finally(() => {
      if (committed()) prechecking.delete(key);
      ctx.completions.delete(work);
      if (!ctx.closing) ctx.changed();
    });
  ctx.completions.add(work);
}

timerHandlers.set(ROUTINE, (ctx, timer) => {
  const project = ctx.store.must<Project>('projects', timer.project_id);
  const routine = project.routines?.find((r) => r.id === timer.subject_id);
  if (!routine?.enabled) return;
  const now = ctx.store.now();
  // A removed project keeps its routines for a reopening, but runs none of them.
  if (project.removed_at !== undefined) return nextRun(routine, now);
  if (routine.active_hours && !withinHours(routine.active_hours, now))
    return nextClock(routine.active_hours.from, now);
  runRoutine(ctx, project, routine, true);
  return nextRun(routine, now);
});

function editableProject(ctx: ControlContext, p: Principal, projectId: string, action: string) {
  userOnly(p);
  projectAccess(ctx, p, projectId, action);
  return ctx.store.must<Project>('projects', projectId);
}

type RoutineRef = ReturnType<(typeof inputSchemas)['project.routine.run']['parse']>;
export const routineHandlers: Handlers = {
  'project.routine.save': (ctx, p, c) => {
    const { project_id, routine: input } = c.input as ReturnType<
      (typeof inputSchemas)['project.routine.save']['parse']
    >;
    const project = editableProject(ctx, p, project_id, c.type);
    const { precheck } = input;
    const routine: Routine = {
      id: input.id ?? id(),
      name: input.name,
      prompt: input.prompt,
      enabled: input.enabled,
      ...(input.active_hours && { active_hours: input.active_hours }),
      ...('every_minutes' in input ? { every_ms: input.every_minutes * MINUTE } : { at: input.at }),
      ...(precheck && {
        precheck: {
          argv: precheck.argv,
          ...(precheck.timeout_seconds !== undefined && {
            timeout_ms: precheck.timeout_seconds * 1000,
          }),
        },
      }),
    };
    const routines = [...(project.routines ?? [])];
    const index = routines.findIndex((r) => r.id === routine.id);
    if (index === -1) routines.push(routine);
    else routines[index] = routine;
    const next = ctx.store.update('projects', { ...project, routines }, project.revision);
    ctx.store.event('routine.saved', next, project_id, { routine_id: routine.id }, c.command_id);
    cancelPending(ctx, project_id, routine.id);
    if (routine.enabled)
      scheduleTimer(ctx, {
        id: id(),
        kind: ROUTINE,
        project_id,
        subject_id: routine.id,
        due_at: nextRun(routine, ctx.store.now()),
      });
    return { routine_id: routine.id };
  },
  'project.routine.remove': (ctx, p, c) => {
    const { project_id, routine_id } = c.input as RoutineRef;
    const project = editableProject(ctx, p, project_id, c.type);
    const routines = project.routines?.filter((r) => r.id !== routine_id);
    requireThat(routines?.length !== project.routines?.length, 'not_found', 'Routine not found');
    const next = ctx.store.update('projects', { ...project, routines }, project.revision);
    ctx.store.event('routine.removed', next, project_id, { routine_id }, c.command_id);
    cancelPending(ctx, project_id, routine_id);
    return {};
  },
  'project.routine.run': (ctx, p, c) => {
    const { project_id, routine_id } = c.input as RoutineRef;
    const project = editableProject(ctx, p, project_id, c.type);
    const routine = project.routines?.find((r) => r.id === routine_id);
    requireThat(routine, 'not_found', 'Routine not found');
    runRoutine(ctx, project, routine, false);
    return {};
  },
};

export function projectRoutines(
  ctx: ControlContext,
  p: Principal,
  projectId: string,
): ProjectRoutines {
  projectAccess(ctx, p, projectId, 'project.read');
  const project = ctx.store.must<Project>('projects', projectId);
  const state = projectOverBudget(ctx, projectId)
    ? 'paused_budget'
    : openResident(ctx, project)
      ? 'active'
      : 'no_resident';
  const pending = new Map(pendingTimers(ctx, projectId).map((t) => [t.subject_id, t.due_at]));
  // SQLite takes the bare columns from the row with max(sequence) in each group.
  const rows = ctx.store
    .statement(
      `SELECT created_at, payload, max(sequence) FROM events WHERE project_id=? AND kind='routine.ran'
     GROUP BY payload->>'$.routine_id'`,
    )
    .all(projectId) as { created_at: number; payload: string }[];
  const latest = new Map(
    rows.map((row) => {
      const { routine_id, turn_id, ...result } = JSON.parse(row.payload) as RunResult & {
        routine_id: string;
      };
      return [routine_id, { ...result, at: row.created_at }];
    }),
  );
  return {
    routines: (project.routines ?? []).map(({ every_ms, at, precheck, ...fields }) => ({
      ...fields,
      ...(every_ms === undefined ? { at } : { every_minutes: every_ms / MINUTE }),
      ...(precheck && {
        precheck: {
          argv: precheck.argv,
          ...(precheck.timeout_ms !== undefined && { timeout_seconds: precheck.timeout_ms / 1000 }),
        },
      }),
      next_at: pending.get(fields.id) ?? null,
      state: fields.enabled ? state : 'paused',
      last_run: latest.get(fields.id) ?? null,
    })),
  };
}
