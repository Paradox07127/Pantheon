import { z } from 'zod';

/** The tool a reviewer ends its review with, by tool name. */
export const reviewerTools = {
  review_verdict: 'review.verdict',
} as const satisfies Record<string, string>;

export const workflowInputSchemas = {
  /** Hands in the calling reviewer's verdict on the running review it belongs to, replacing its earlier one, and returns it. Reviewer sessions only. */
  'review.verdict': z.strictObject({
    verdict: z
      .enum(['pass', 'fail'])
      .describe('pass when nothing you found must be fixed before merge; otherwise fail.'),
    summary: z
      .string()
      .min(1)
      .max(2000)
      .describe('What you checked and what you found, up to 2000 characters.'),
  }),
} as const satisfies Record<string, z.ZodType>;
