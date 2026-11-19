import { z } from 'zod';

const str = z.string().min(1).max(65536);

/** What milestone.checks.get and milestone.checks.set return. */
export interface HiddenChecksRead {
  project_id: string;
  /** In the order milestone verification runs them. */
  checks: { name: string; command: string }[];
}

/** The user only; hidden checks are kept outside every worktree and run only by milestone verification. */
export const milestoneCheckInputSchemas = {
  /** The user only; returns HiddenChecksRead, the checks only milestone verification runs, for the project. */
  'milestone.checks.get': z.strictObject({ project_id: str }),
  /** The user only; replaces the project's hidden checks, which milestone verification runs in the clone after the gate and the acceptance; the lead sees only their names, exit codes and last output lines; returns HiddenChecksRead. */
  'milestone.checks.set': z.strictObject({
    project_id: str,
    checks: z
      .array(
        z.strictObject({
          name: z.string().trim().min(1).max(200),
          command: z.string().trim().min(1).max(4096),
        }),
      )
      .max(20)
      .refine((checks) => new Set(checks.map((check) => check.name)).size === checks.length, {
        message: 'Each hidden check has its own name',
      }),
  }),
} as const satisfies Record<string, z.ZodType>;
