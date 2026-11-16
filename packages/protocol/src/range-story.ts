import { z } from 'zod';
export type { RangeStory } from '@pantheon/domain';

const str = z.string().min(1).max(16384);
const RANGE_LIMIT_MS = 400 * 24 * 60 * 60 * 1000;
export const rangeStoryInputSchemas = {
  'range_story.start': z
    .strictObject({ project_id: str, from: z.number().int().min(0), to: z.number().int().min(0) })
    .refine((range) => range.to > range.from, { message: 'to must be after from', path: ['to'] })
    .refine((range) => range.to - range.from <= RANGE_LIMIT_MS, {
      message: 'The range spans at most 400 days',
      path: ['to'],
    }),
  'range_story.submit': z.strictObject({
    story_id: str,
    lines: z.array(z.string().min(1).max(280)).min(1).max(6),
  }),
};
