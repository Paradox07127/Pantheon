import { z } from 'zod';
import type { AgentToolGroup } from '@pantheon/domain';

const str = z.string().min(1).max(65536);
const line = (what: string) => z.string().trim().min(1).max(2000).describe(what);

/** The tool a lead answers the user's pause of its plan with, by tool name. */
export const planPauseTools = {
  reassess: 'board.plan.reassess',
} as const satisfies Record<string, string>;

/** What each plan pause tool does; a costly one asks the user before every call. */
export const planPauseToolEffects = {
  reassess: 'write',
} as const satisfies Record<keyof typeof planPauseTools, 'read' | 'write' | 'costly'>;

/** The agent profile tool group of each plan pause tool. */
export const planPauseToolGroups = {
  reassess: 'board',
} as const satisfies Record<keyof typeof planPauseTools, AgentToolGroup>;

export const planPauseInputSchemas = {
  /** Holds the new task sessions of a lead's plan while its running sessions go on, and wakes the lead to write a re-assessment; the user only. */
  'board.plan.pause': z.strictObject({ project_id: str, lead_session_id: str }),
  /** Lets the held tasks of a paused plan start again and tells the lead; the user only. */
  'board.plan.resume': z.strictObject({ project_id: str, lead_session_id: str }),
  /** Stores the calling lead's re-assessment of its paused plan, replacing an earlier one, for the user to read before resuming it; the lead only. */
  'board.plan.reassess': z.strictObject({
    project_id: str,
    done: line('What the plan has finished so far, up to 2000 characters.'),
    blocked: line('What is stuck and why, or "nothing", up to 2000 characters.'),
    change: line(
      'What you would change in the plan before it goes on, or "nothing", up to 2000 characters.',
    ),
  }),
} as const satisfies Record<string, z.ZodType>;
