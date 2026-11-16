import type { RangeStory } from '@pantheon/protocol';
import { sendProjectCommand, useProjectQuery } from './project-read';

export type { RangeStory };

/** GET /v1/range_story.list; the project's range interpretations, newest first. */
export const useRangeStories = (projectId: string | null) =>
  useProjectQuery<RangeStory[]>('range_story.list', projectId, Array.isArray, undefined, {
    events: true,
  });

export type StartRangeStoryResult = { ok: true; story: RangeStory } | { ok: false; error: string };

/** Asks an agent to interpret the range; only ever on the user's request. */
export async function startRangeStory(
  project_id: string,
  from: number,
  to: number,
): Promise<StartRangeStoryResult> {
  const result = await sendProjectCommand('range_story.start', { project_id, from, to }, null);
  if (!result.ok) return result;
  return { ok: true, story: result.value as RangeStory };
}
