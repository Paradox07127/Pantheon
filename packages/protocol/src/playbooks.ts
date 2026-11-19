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

/** What playbook.get, playbook.set and playbook.remove return. */
export interface PlaybookRead {
  project_id: string;
  runtime?: string;
  /** The current version of the asked playbook, 0 while none is stored; playbook.set takes it as base_version. */
  version: number;
  /** The stored version numbers of the asked playbook, ascending; empty while none is stored. */
  versions: number[];
  /** The text a lead of runtime gets: from its own playbook, the project default, or the code. */
  source: 'runtime' | 'default' | 'code';
  /** The current text, or the stored text of the version asked for. */
  sections: PlaybookSections;
  /** The sections as written in code, used when no playbook is stored. */
  built_in: PlaybookSections;
}

/** What playbook.export returns. */
export interface PlaybookExport {
  /** The absolute path of the written file. */
  path: string;
}

/** The user only; a playbook replaces the lead instruction sections Before you plan, Routing and Replies. */
export const playbookInputSchemas = {
  /** The user only; returns PlaybookRead for the project's playbook for runtime, or its default playbook without runtime; with version, its sections are that stored version's, not_found when it is not stored. */
  'playbook.get': z.strictObject({
    project_id: str,
    runtime: str.optional(),
    version: z.number().int().min(1).optional(),
  }),
  /** The user only; stores sections as the next version of the project's playbook for runtime, or of its default playbook without runtime, and makes it current for leads that start afterwards; returns PlaybookRead. */
  'playbook.set': z.strictObject({
    project_id: str,
    runtime: str.optional(),
    base_version: z.number().int().min(0),
    sections: z.strictObject({ before_you_plan: body, routing: body, replies: body }),
  }),
  /** The user only; deletes the project's stored playbook for runtime, or its default playbook without runtime, so its leads fall back to the project default or the code; returns PlaybookRead. */
  'playbook.remove': z.strictObject({
    project_id: str,
    runtime: str.optional(),
    base_version: z.number().int().min(0),
  }),
  /** The user only; writes the stored version of the project's playbook for runtime, or of its default playbook without runtime, as {version, sections} to a JSON file under the data folder, which the eval condition playbook=file:<path> reads; returns PlaybookExport, not_found when the version is not stored. */
  'playbook.export': z.strictObject({
    project_id: str,
    runtime: str.optional(),
    version: z.number().int().min(1),
  }),
} as const satisfies Record<string, z.ZodType>;
