import { z } from 'zod';

/** The lead tools of the always_on profile group, by tool name. */
export const alwaysOnTools = {
  follow_up: 'agent.follow_up',
  tell_user: 'agent.tell_user',
  routine_set: 'agent.routine.set',
  routine_cancel: 'agent.routine.cancel',
} as const satisfies Record<string, string>;

/** What each always_on tool does; a costly one asks the user before every call. */
export const alwaysOnToolEffects = {
  follow_up: 'write',
  tell_user: 'write',
  routine_set: 'write',
  routine_cancel: 'write',
} as const satisfies Record<keyof typeof alwaysOnTools, 'read' | 'write' | 'costly'>;

const projectId = z.string().min(1).max(65536);
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** The fields of one routine, as routine_set and an agent proposal give them. */
export const routineFields = {
  id: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/)
    .optional()
    .describe("Give an existing routine's id to replace it; leave it out to add one."),
  prompt: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      '1-2000 characters that stand alone: what to check each run, and when to end with one short line.',
    ),
  every_minutes: z
    .number()
    .int()
    .min(60)
    .optional()
    .describe('Run every this many minutes, at least 60. Give this or `at`, not both.'),
  at: clockTime.optional().describe('Run daily at this local time, HH:MM.'),
  active_hours: z
    .strictObject({
      from: clockTime.describe('Local start time, HH:MM.'),
      to: clockTime.describe('Local end time, HH:MM.'),
    })
    .optional()
    .describe('`from` and `to` as HH:MM; a run due outside them moves to the next `from`.'),
  enabled: z.boolean().describe('false keeps the routine without running it.'),
};

// The daemon checks the exactly-one rules: MCP tools omit bound fields, which a refined object refuses.
export const alwaysOnInputSchemas = {
  /** Wakes the calling resident with note after_minutes from now or at (Unix epoch ms); exactly one of them. */
  'agent.follow_up': z.strictObject({
    project_id: projectId,
    after_minutes: z
      .number()
      .int()
      .min(1)
      .max(10080)
      .optional()
      .describe('Wake after this many minutes, 1-10080. Give this or `at`, not both.'),
    at: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Wake at this time, Unix epoch milliseconds.'),
    note: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        '1-2000 characters; the only context you get when you wake: what to check, where, and why.',
      ),
  }),
  /** Leaves the user a message from the calling resident and notifies them. */
  'agent.tell_user': z.strictObject({
    project_id: projectId,
    text: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        '1-4000 characters that read on their own: what happened, what you suggest, and what you need from the user, if anything.',
      ),
    urgency: z
      .enum(['normal', 'high'])
      .describe('high only when the user must act soon; otherwise normal.'),
  }),
  /** Adds or, by id, replaces a routine of the calling resident; exactly one of every_minutes or at (local HH:MM). */
  'agent.routine.set': z.strictObject({
    project_id: projectId,
    ...routineFields,
  }),
  /** Removes a routine of the calling resident and its pending run. */
  'agent.routine.cancel': z.strictObject({
    project_id: projectId,
    routine_id: z
      .string()
      .min(1)
      .describe('The id of the routine to remove, as routine_set gave it.'),
  }),
} as const satisfies Record<string, z.ZodType>;
