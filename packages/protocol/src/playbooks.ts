import { z } from 'zod';
import type { PlaybookSections } from '@pantheon/domain';

const str = z.string().min(1).max(65536);
// The lead prompt starts each section at a line that begins with "## ".
const body = z
  .string()
  .trim()
  .min(1)
  .max(20000)
  .refine((text) => !/^## /m.test(text), {
    message: 'A playbook section has no line that starts with "## "',
  });

/** What playbook.get and playbook.set return. */
export interface PlaybookRead {
  project_id: string;
  runtime?: string;
  /** The current version of the asked playbook, 0 while none is stored; playbook.set takes it as base_version. */
  version: number;
  /** The text a lead of runtime gets: from its own playbook, the project default, or the code. */
  source: 'runtime' | 'default' | 'code';
  sections: PlaybookSections;
}

/** The user only; a playbook replaces the lead instruction sections Before you plan, Routing and Replies. */
export const playbookInputSchemas = {
  /** The user only; returns PlaybookRead for the project's playbook for runtime, or its default playbook without runtime. */
  'playbook.get': z.strictObject({ project_id: str, runtime: str.optional() }),
  /** The user only; stores sections as the next version of the project's playbook for runtime, or of its default playbook without runtime, and makes it current for leads that start afterwards; returns PlaybookRead. */
  'playbook.set': z.strictObject({
    project_id: str,
    runtime: str.optional(),
    base_version: z.number().int().min(0),
    sections: z.strictObject({ before_you_plan: body, routing: body, replies: body }),
  }),
} as const satisfies Record<string, z.ZodType>;
