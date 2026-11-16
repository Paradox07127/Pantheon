import { z } from 'zod';
const str = z.string().min(1).max(16384);
const hunkId = z.string().regex(/^H[1-9]\d*$/);
const side = z.enum(['before', 'after', 'both']);
const anchor = z.strictObject({ file: str, quote: str });
const diagram = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('flow'),
    title: str,
    lanes: z.array(str).min(1).max(12),
    nodes: z
      .array(z.strictObject({ id: str, label: str, lane: str, side, anchor: anchor.optional() }))
      .min(1)
      .max(60),
    edges: z.array(z.strictObject({ from: str, to: str, label: str.optional(), side })).max(120),
  }),
  z.strictObject({
    type: z.literal('decision'),
    title: str,
    rows: z
      .array(
        z.strictObject({
          case: str,
          before: str,
          after: str,
          before_anchor: anchor.optional(),
          after_anchor: anchor.optional(),
        }),
      )
      .min(1)
      .max(40),
  }),
  z.strictObject({
    type: z.literal('type'),
    name: str,
    file: str,
    fields: z
      .array(z.strictObject({ name: str, type: str, side, quote: str }))
      .min(1)
      .max(80),
  }),
  z.strictObject({
    type: z.literal('ui'),
    title: str,
    regions: z
      .array(
        z.strictObject({
          id: str,
          label: str,
          parent: str.optional(),
          side,
          anchor: anchor.optional(),
        }),
      )
      .min(1)
      .max(60),
  }),
]);
export const storySubmission = z.strictObject({
  overall: z.strictObject({ before: z.array(str).max(12), after: z.array(str).max(12) }),
  cards: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(120),
        kind: z.enum(['added', 'behavior', 'fix', 'refactor', 'style', 'test', 'config']),
        surface: z.enum(['ui', 'api', 'cli', 'data', 'internal']),
        acceptance: z.array(z.number().int().min(0)).max(128),
        before: str,
        after: str,
        how: z.array(z.strictObject({ text: str, hunks: z.array(hunkId).min(1) })).max(12),
        hunks: z.array(hunkId).min(1),
        tests: z.array(hunkId),
        diagram: diagram.optional(),
      }),
    )
    .min(1)
    .max(40),
  noise: z.array(hunkId),
});
export const changeStoryInputSchemas = {
  'change_story.start': z.strictObject({ session_id: str }),
  'change_story.submit': storySubmission.extend({ story_id: str }),
  'change_story.revert_patch': z.strictObject({
    story_id: str,
    card: z.number().int().min(0),
  }),
};
export interface DiffHunk {
  /** `H1…Hn` in patch order; the same from_sha..to_sha always gives the same ids. */
  id: string;
  file: string;
  /** The `@@ … @@` line as git printed it. */
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  /** Body lines with their ' ', '+', '-' or '\' prefixes, joined by '\n'. */
  text: string;
  noise?: 'whitespace' | 'moved' | 'generated';
}
export interface LandingDiffFile {
  path: string;
  /** Set for a rename or copy. */
  old_path?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  /** null for a binary file. */
  additions: number | null;
  deletions: number | null;
}
/** The committed change one landing item or one commit range brought into its source. */
export interface LandingDiff {
  source: string;
  from_sha: string;
  to_sha: string;
  files: LandingDiffFile[];
  /** Empty when truncated. */
  hunks: DiffHunk[];
  truncated: boolean;
}
