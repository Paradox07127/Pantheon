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
  state: z.enum(['active', 'draft', 'archived', 'all']).default('active'),
  kind: z.enum(['decision', 'report', 'note']).optional(),
  tag: z.union([tag, z.array(tag)]).optional(),
  task_id: id.optional(),
  lead_session_id: id.optional(),
  project_only: z.boolean().optional(),
  q: z.string().max(200).default(''),
};
// A GET query carries a boolean as text. The session tools publish the command shape as JSON Schema, which has no transform.
const queryFilterShape = {
  ...memoryFilterShape,
  project_only: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .optional(),
};
const projectOnlyFilter = (input: {
  project_only?: boolean;
  task_id?: string;
  lead_session_id?: string;
}) => !input.project_only || (!input.task_id && !input.lead_session_id);
const projectOnlyMessage = 'Project-only memory cannot be combined with a task filter';
export const memoryDirectorySchema = z
  .strictObject({
    project_id: id,
    ...queryFilterShape,
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(1024).optional(),
  })
  .refine(projectOnlyFilter, projectOnlyMessage);
const graphKind = z.enum(['decision', 'report', 'note', 'file', 'url', 'session']);
export const memoryGraphSchema = z
  .strictObject({
    project_id: id,
    memory_id: id.optional(),
    ...queryFilterShape,
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
  .refine(projectOnlyFilter, projectOnlyMessage)
  .transform((input) => ({
    ...input,
    max_nodes: input.max_nodes ?? (input.memory_id ? 40 : 80),
  }));
export const memoryInputSchemas = {
  // The session tools omit bound fields from a command schema, which a refinement forbids.
  'memory.related': z.strictObject({
    project_id: id,
    memory_id: id,
    ...memoryFilterShape,
    relation: z.enum(['all', 'dependency', 'dependent', 'version', 'tag']).default('all'),
    depth: z.number().int().min(1).max(2).default(1),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  'memory.maintain': z.strictObject({ project_id: id }),
  'memory.propose': z.strictObject({
    project_id: id,
    key: z.string().min(1).max(120),
    kind: z.enum(['decision', 'report', 'note']),
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().min(1).max(400).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(12).optional(),
    references: z
      .array(
        z.strictObject({
          kind: z.enum(['file', 'url']),
          uri: z.string().min(1).max(2000),
          label: z.string().max(160).optional(),
          root: z.number().int().nonnegative().optional(),
        }),
      )
      .max(12)
      .optional(),
    text: z.string().min(1).max(20000),
    dependencies: z.array(id).max(32).default([]),
    task: z
      .strictObject({ lead_session_id: id, id, generation: z.number().int().positive() })
      .optional(),
    expires_at: z.number().int().positive().optional(),
    based_on: z.string().length(64).optional(),
  }),
  'memory.commit': z.strictObject({ memory_id: id }),
  'memory.archive': z.strictObject({ memory_id: id }),
  'memory.undo_retraction': z.strictObject({ memory_id: id }),
  'memory.restore': z.strictObject({ memory_id: id }),
  'memory.get': z.strictObject({ memory_id: id }),
  'memory.search': z.strictObject({
    project_id: id,
    ...memoryFilterShape,
    limit: z.number().int().min(1).max(50).default(10),
  }),
  'memory.context': z.strictObject({
    project_id: id,
    max_bytes: z.number().int().min(1000).max(24000).default(12000),
  }),
  'memory.history': z.strictObject({
    project_id: id,
    key: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
} as const;
