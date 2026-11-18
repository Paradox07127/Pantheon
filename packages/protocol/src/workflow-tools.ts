import { z } from 'zod';
import type { AgentToolGroup } from '@pantheon/domain';

/** The tools a session answers its workflow step with, by tool name. */
export const workflowTools = {
  step_verdict: 'workflow.step.verdict',
} as const satisfies Record<string, string>;

/** What each workflow tool does; a costly one asks the user before every call. */
export const workflowToolEffects = {
  step_verdict: 'write',
} as const satisfies Record<keyof typeof workflowTools, 'read' | 'write' | 'costly'>;

/** The agent profile tool group of each workflow tool. */
export const workflowToolGroups = {
  step_verdict: 'board',
} as const satisfies Record<keyof typeof workflowTools, AgentToolGroup>;

export const workflowInputSchemas = {
  /** Hands in the verdict of the workflow prompt step the calling session's running turn works on, replacing an earlier one of the same turn, and returns it. Command evidence must name a command the turn ran when it ran any. Task and lead sessions only. */
  'workflow.step.verdict': z.strictObject({
    verdict: z
      .enum(['pass', 'fail'])
      .describe('pass when the step did what it asks and your evidence shows it; otherwise fail.'),
    summary: z
      .string()
      .min(1)
      .max(2000)
      .describe('What you checked and what you found, up to 2000 characters.'),
    evidence: z
      .array(
        z.strictObject({
          kind: z
            .enum(['command', 'file'])
            .describe('command for a command you ran in this turn, file for a file you changed.'),
          ref: z
            .string()
            .min(1)
            .max(2000)
            .describe(
              'The command exactly as you ran it, or the file path relative to the worktree.',
            ),
        }),
      )
      .min(1)
      .max(8)
      .describe('1-8 items from this turn that show the verdict.'),
  }),
} as const satisfies Record<string, z.ZodType>;
