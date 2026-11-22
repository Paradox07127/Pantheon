import { z } from 'zod';
import type { MemoryRecord } from '@pantheon/domain';

export interface MemoryArchiveResult extends MemoryRecord {
  archived_ids: string[];
}
export interface MemoryUndoRetractionResult {
  restored_ids: string[];
  skipped: { memory_id: string; reason: 'changed' | 'replaced' }[];
}
export interface MemorySessionTurnsResult {
  turns: { turn_id: string; count: number }[];
}
const id = z.string().min(1).max(200);
const tag = z.string().trim().min(1).max(60);
export const memoryFilterShape = {
  state: z
    .enum(['active', 'draft', 'archived', 'all'])
    .default('active')
    .describe('Leave it at active; other states need the user.'),
  kind: z
    .enum(['decision', 'report', 'note'])
    .optional()
    .describe('Keep only entries of this kind.'),
  tag: z
    .union([tag, z.array(tag)])
    .optional()
    .describe('Keep only entries with this tag, or with any of these tags.'),
  q: z
    .string()
    .max(200)
    .default('')
    .describe('Words or a phrase to search for, at most 200 characters.'),
};
/** Task and plan filters an older client may still send; accepted and not read. */
const retiredQueryFilters = {
  task_id: z.unknown().optional(),
  lead_session_id: z.unknown().optional(),
  project_only: z.unknown().optional(),
  origin: z.unknown().optional(),
  milestone_id: z.unknown().optional(),
};
export const memoryDirectorySchema = z.strictObject({
  project_id: id,
  ...memoryFilterShape,
  ...retiredQueryFilters,
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(1024).optional(),
});
const graphKind = z.enum(['decision', 'report', 'note', 'file', 'url', 'session']);
export const memoryGraphSchema = z
  .strictObject({
    project_id: id,
    memory_id: id.optional(),
    ...memoryFilterShape,
    ...retiredQueryFilters,
    /** The memory and source kinds to draw, applied before the node cap. */
    kind: z.union([graphKind, z.array(graphKind)]).optional(),
    /** A memory that stays in the graph ahead of the cap when it passes the filters. */
    keep: id.optional(),
    depth: z.coerce.number().int().min(1).max(2).default(1),
    max_nodes: z.coerce.number().int().min(1).max(200).optional(),
    include_tags: z
      .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
      .default(false),
  })
  .transform((input) => ({
    ...input,
    max_nodes: input.max_nodes ?? (input.memory_id ? 40 : 80),
  }));
export const memoryInputSchemas = {
  // The session tools omit bound fields from a command schema, which a refinement forbids.
  'memory.related': z.strictObject({
    project_id: id,
    memory_id: id.describe('The id of the current entry to start from.'),
    ...memoryFilterShape,
    relation: z
      .enum(['all', 'dependency', 'dependent', 'version', 'tag'])
      .default('all')
      .describe(
        'dependency: what it rests on; dependent: what rests on it; version: its earlier versions; tag: entries sharing a tag; all (default).',
      ),
    depth: z
      .number()
      .int()
      .min(1)
      .max(2)
      .default(1)
      .describe('1 for direct links, 2 to follow them one step further.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(10)
      .describe('At most this many entries, 1-30; default 10.'),
  }),
  'memory.maintain': z.strictObject({ project_id: id }),
  'memory.propose': z.strictObject({
    project_id: id,
    key: z
      .string()
      .min(1)
      .max(120)
      .describe(
        '1-120 characters, stable, topic/subtopic in lowercase, such as testing/e2e-ports. Reusing the key of a current entry replaces it.',
      ),
    kind: z
      .enum(['decision', 'report', 'note'])
      .describe(
        'note (fact, preference, constraint), report (lasting analysis with evidence), or decision (a rule the user stated; stays a draft until the user confirms).',
      ),
    title: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .optional()
      .describe('Optional, at most 160 characters.'),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(400)
      .optional()
      .describe('Optional, at most 400 characters; what search results show.'),
    tags: z
      .array(z.string().trim().min(1).max(60))
      .max(12)
      .optional()
      .describe('Optional, up to 12 topic words.'),
    references: z
      .array(
        z.strictObject({
          kind: z.enum(['file', 'url']).describe('file or url.'),
          uri: z
            .string()
            .min(1)
            .max(2000)
            .describe('The file path relative to its project root, or the URL.'),
          label: z.string().max(160).optional().describe('Optional name shown for the source.'),
          root: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('For a file: the index of the project root it is in.'),
        }),
      )
      .max(12)
      .optional()
      .describe(
        'Optional, up to 12 sources: `kind` file or url, `uri`, optional `label`, and for a file `root`, the index of the project root it is in.',
      ),
    text: z
      .string()
      .min(1)
      .max(20000)
      .describe('1-20000 characters; the content, with the reason or evidence.'),
    dependencies: z
      .array(id)
      .max(32)
      .default([])
      .describe(
        'Ids of current memory entries this one rests on, at most 32. Must be empty for kind decision.',
      ),
    expires_at: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional Unix epoch milliseconds after which the entry stops being current.'),
    based_on: z
      .string()
      .length(64)
      .optional()
      .describe('The signature of the memory packet or memory_context you read.'),
  }),
  'memory.commit': z.strictObject({ memory_id: id }),
  'memory.archive': z.strictObject({ memory_id: id }),
  'memory.undo_retraction': z.strictObject({ memory_id: id }),
  'memory.restore': z.strictObject({ memory_id: id }),
  'memory.get': z.strictObject({
    memory_id: id.describe('The memory id from the packet or a search result.'),
  }),
  'memory.search': z.strictObject({
    project_id: id,
    ...memoryFilterShape,
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('At most this many results, 1-50; default 10.'),
  }),
  'memory.context': z.strictObject({
    project_id: id,
    max_bytes: z
      .number()
      .int()
      .min(1000)
      .max(24000)
      .default(12000)
      .describe('The entry payload cap in bytes, 1000-24000; default 12000.'),
  }),
  'memory.history': z.strictObject({
    project_id: id,
    key: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    ids: z.array(id).max(200).optional(),
  }),
} as const;
