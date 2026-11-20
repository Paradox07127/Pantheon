import type { z } from 'zod';
import type { agentInputSchemas } from './agent-tools.js';

type UserRoutine = NonNullable<
  z.input<(typeof agentInputSchemas)['agent.update']>['routines']
>[number];

/** A starting point for a routine; without `id` and `title`, plus `enabled`, it is an agent.update routine. */
export type RoutineTemplate = { id: string; title: string } & Omit<
  UserRoutine,
  'id' | 'enabled'
> & {
    /** False for a routine the user turns on after adding it; absent adds it turned on. */
    enabled?: false;
  };

const WEEK_MINUTES = 7 * 24 * 60;

export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    id: 'bug-hunt',
    title: 'Bug hunt',
    prompt:
      'Look for likely bugs in code changed since your last run. File each one you can show as a signal or a finding with the file and line; say none when you find none.',
    at: '09:00',
    precheck: {
      // ROUTINE_LAST_RUN_AT is unset before the first run, which then goes ahead.
      argv: [
        'sh',
        '-c',
        'test -z "$ROUTINE_LAST_RUN_AT" || test -n "$(git log --since="$ROUTINE_LAST_RUN_AT" --oneline -1)"',
      ],
    },
  },
  {
    id: 'security-scan',
    title: 'Security scan',
    prompt:
      'Check the dependencies and the code changed this week for known security problems. Report each with its source; do not change code.',
    every_minutes: WEEK_MINUTES,
  },
  {
    id: 'test-coverage',
    title: 'Test coverage',
    prompt:
      'Find changed modules without tests. Propose one task per module with the tests it needs.',
    every_minutes: WEEK_MINUTES,
  },
  {
    id: 'weekly-self-review',
    title: 'Weekly self-review',
    prompt:
      "Read lead.retrospectives and the improvement signals in project_read, and what you did yourself this week. Name at most 3 points of friction from this week, each with its evidence, and state each one's sample size n; when the evidence is weak, say so. When you found none, say so.",
    every_minutes: WEEK_MINUTES,
    enabled: false,
  },
];
