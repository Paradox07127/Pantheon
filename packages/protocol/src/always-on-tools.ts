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

// The daemon checks the exactly-one rules: MCP tools omit bound fields, which a refined object refuses.
export const alwaysOnInputSchemas = {
  /** Wakes the calling resident with note after_minutes from now or at (Unix epoch ms); exactly one of them. */
  'agent.follow_up': z.strictObject({
    project_id: projectId,
    after_minutes: z.number().int().min(1).max(10080).optional(),
    at: z.number().int().positive().optional(),
    note: z.string().min(1).max(2000),
  }),
  /** Leaves the user a message from the calling resident and notifies them. */
  'agent.tell_user': z.strictObject({
    project_id: projectId,
    text: z.string().min(1).max(4000),
    urgency: z.enum(['normal', 'high']),
  }),
  /** Adds or, by id, replaces a routine of the calling resident; exactly one of every_minutes or at (local HH:MM). */
  'agent.routine.set': z.strictObject({
    project_id: projectId,
    id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/)
      .optional(),
    prompt: z.string().min(1).max(2000),
    every_minutes: z.number().int().min(60).optional(),
    at: clockTime.optional(),
    active_hours: z.strictObject({ from: clockTime, to: clockTime }).optional(),
    enabled: z.boolean(),
  }),
  /** Removes a routine of the calling resident and its pending run. */
  'agent.routine.cancel': z.strictObject({ project_id: projectId, routine_id: z.string().min(1) }),
} as const satisfies Record<string, z.ZodType>;
