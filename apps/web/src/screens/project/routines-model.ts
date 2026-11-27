import type { Routine } from '../../data/project-routines';
import { t } from '../../i18n';
import { durationText } from '../../lib/time-text';

/** What `project.routine.save` takes as its routine. */
export type RoutineInput = Pick<
  Routine,
  'name' | 'prompt' | 'active_hours' | 'enabled' | 'precheck'
> & {
  id?: string;
} & ({ every_minutes: number } | { at: string });

const MINUTE = 60_000;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The form's fields, as typed. */
export interface RoutineDraft {
  name: string;
  prompt: string;
  schedule: 'every' | 'daily';
  every: string;
  at: string;
  hours: boolean;
  from: string;
  to: string;
  precheck: boolean;
  argv: string;
  timeout: string;
}

export type DraftField = 'name' | 'prompt' | 'every' | 'at' | 'from' | 'to' | 'argv' | 'timeout';

/** The draft of a new routine, or of the saved one being edited. */
export function draftOf(routine: Routine | null): RoutineDraft {
  return {
    name: routine?.name ?? '',
    prompt: routine?.prompt ?? '',
    schedule: routine && 'at' in routine ? 'daily' : 'every',
    every: String(routine && 'every_minutes' in routine ? routine.every_minutes : 30),
    at: routine && 'at' in routine ? routine.at : '09:00',
    hours: !!routine?.active_hours,
    from: routine?.active_hours?.from ?? '09:00',
    to: routine?.active_hours?.to ?? '18:00',
    precheck: routine ? !!routine.precheck : true,
    argv: routine?.precheck?.argv.join('\n') ?? '',
    timeout:
      routine?.precheck?.timeout_seconds === undefined
        ? ''
        : String(routine.precheck.timeout_seconds),
  };
}

/** One argument per line, as typed; only the empty line after a final newline is dropped. */
export const argvOf = (text: string): string[] => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

const wholeIn = (text: string, min: number, max: number) =>
  /^\d+$/.test(text) && Number(text) >= min && Number(text) <= max;

/** The fields the daemon would refuse, checked against the same rules it applies. */
export function problemsOf(draft: RoutineDraft): Set<DraftField> {
  const problems = new Set<DraftField>();
  if (!/\S/.test(draft.name)) problems.add('name');
  if (!/\S/.test(draft.prompt)) problems.add('prompt');
  if (draft.schedule === 'every' && !wholeIn(draft.every, 5, Number.MAX_SAFE_INTEGER))
    problems.add('every');
  if (draft.schedule === 'daily' && !CLOCK.test(draft.at)) problems.add('at');
  if (draft.hours) {
    if (!CLOCK.test(draft.from)) problems.add('from');
    if (!CLOCK.test(draft.to) || draft.to === draft.from) problems.add('to');
  }
  if (draft.precheck) {
    // A blank program would only fail when the precheck runs.
    if (!/\S/.test(argvOf(draft.argv)[0] ?? '')) problems.add('argv');
    if (draft.timeout !== '' && !wholeIn(draft.timeout, 1, 3600)) problems.add('timeout');
  }
  return problems;
}

/** The routine a valid draft saves; an edit keeps the routine's id, and its arguments while their box is untouched. */
export function inputOf(
  draft: RoutineDraft,
  id: string | undefined,
  enabled: boolean,
  opened: Routine | null,
) {
  const kept = opened?.precheck?.argv;
  const input: RoutineInput = {
    ...(id !== undefined && { id }),
    name: draft.name,
    prompt: draft.prompt,
    ...(draft.schedule === 'every' ? { every_minutes: Number(draft.every) } : { at: draft.at }),
    ...(draft.hours && { active_hours: { from: draft.from, to: draft.to } }),
    enabled,
    ...(draft.precheck && {
      precheck: {
        argv: kept && draft.argv === kept.join('\n') ? kept : argvOf(draft.argv),
        ...(draft.timeout !== '' && { timeout_seconds: Number(draft.timeout) }),
      },
    }),
  };
  return input;
}

/** The saved routine as `project.routine.save` takes it, without the read's own fields. */
export function savedInput(routine: Routine): RoutineInput {
  const { next_at: _next, state: _state, last_run: _last, ...input } = routine;
  return input;
}

export function scheduleText(routine: Routine): string {
  const when =
    'every_minutes' in routine
      ? t(
          {
            id: 'project.routines.every',
            defaultMessage: '{count, plural, one {Every # minute} other {Every # minutes}}',
          },
          { count: routine.every_minutes },
        )
      : t(
          { id: 'project.routines.daily', defaultMessage: 'Daily at {time}' },
          { time: routine.at },
        );
  if (!routine.active_hours) return when;
  return t(
    { id: 'project.routines.withHours', defaultMessage: '{when}, {from} to {to}' },
    { when, from: routine.active_hours.from, to: routine.active_hours.to },
  );
}

/** Whether and when the routine wakes the resident next. */
export function stateText(routine: Routine, now: number): string | null {
  switch (routine.state) {
    case 'paused':
      return t({ id: 'project.routines.paused', defaultMessage: 'Paused' });
    case 'paused_budget':
      return t({ id: 'project.routines.pausedBudget', defaultMessage: 'Paused: budget' });
    case 'no_resident':
      return t({
        id: 'project.routines.noResident',
        defaultMessage: 'No resident, will not wake',
      });
    case 'active':
      if (routine.next_at === null) return null;
      return t(
        { id: 'project.routines.next', defaultMessage: 'Next in {time}' },
        {
          time: durationText(
            Math.max(MINUTE, Math.round((routine.next_at - now) / MINUTE) * MINUTE),
          ),
        },
      );
  }
}

/** The outcome of the last run; its age is shown beside it. */
export function runText(run: NonNullable<Routine['last_run']>): string {
  if (run.outcome === 'woken') return t({ id: 'project.routines.woken', defaultMessage: 'Woken' });
  switch (run.reason) {
    case 'no_resident':
      return t({
        id: 'project.routines.skippedNoResident',
        defaultMessage: 'Not woken: no resident',
      });
    case 'budget':
      return t({
        id: 'project.routines.skippedBudget',
        defaultMessage: 'Not woken: budget used up',
      });
    case 'precheck':
      return typeof run.exit_code === 'number'
        ? t(
            {
              id: 'project.routines.skippedPrecheckCode',
              defaultMessage: 'Not woken: precheck exited with {code}',
            },
            { code: run.exit_code },
          )
        : t({
            id: 'project.routines.skippedPrecheck',
            defaultMessage: 'Not woken: precheck did not finish',
          });
    case 'not_accepting':
      return t({
        id: 'project.routines.skippedNotAccepting',
        defaultMessage: 'Not woken: session not accepting',
      });
    case 'prechecking':
      return t({
        id: 'project.routines.skippedPrechecking',
        defaultMessage: 'Not woken: the previous precheck is still running',
      });
    case 'changed':
      return t({
        id: 'project.routines.skippedChanged',
        defaultMessage: 'Not woken: the routine changed during its precheck',
      });
    case 'inactive_hours':
      return t({
        id: 'project.routines.skippedInactiveHours',
        defaultMessage: 'Not woken: outside active hours',
      });
    default:
      return t({ id: 'project.routines.skipped', defaultMessage: 'Not woken' });
  }
}
