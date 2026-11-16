import type { ChangeStory } from '@pantheon/domain';
import type { LandingDiff } from '@pantheon/protocol';
import { useProjectQuery, sendProjectCommand } from './project-read';
import { useQuery } from './workbench-sessions';

/** GET /v1/change_story.list: every interpretation in the project, read again whenever the board moves. */
export function useChangeStories(project_id: string | null) {
  return useProjectQuery<ChangeStory[]>('change_story.list', project_id, Array.isArray);
}

/** The frozen committed range, never the session's later worktree patch. */
export function useChangeStoryDiff(
  story: ChangeStory | null,
): ReturnType<typeof useQuery<LandingDiff>> {
  return useQuery<LandingDiff>(
    'change_story.diff',
    story?.id ?? null,
    (story_id) => ({ story_id }),
    (value) => {
      const diff = value as Partial<LandingDiff> | null;
      return diff &&
        diff.from_sha === story?.from_sha &&
        diff.to_sha === story?.to_sha &&
        Array.isArray(diff.files) &&
        Array.isArray(diff.hunks) &&
        typeof diff.truncated === 'boolean'
        ? (diff as LandingDiff)
        : null;
    },
    0,
  );
}

export type RevertPatchResult =
  { ok: true; path: string; commands: string[] } | { ok: false; error: string };

/** Writes the card's hunks as a patch and returns the commands that reverse it in the source. */
export async function revertPatch(story_id: string, card: number): Promise<RevertPatchResult> {
  const result = await sendProjectCommand('change_story.revert_patch', { story_id, card }, null);
  if (!result.ok) return result;
  const value = result.value as { path?: unknown; commands?: unknown } | null;
  if (
    typeof value?.path !== 'string' ||
    !Array.isArray(value.commands) ||
    !value.commands.every((c) => typeof c === 'string')
  )
    return { ok: false, error: 'change_story.revert_patch result is incomplete' };
  return { ok: true, path: value.path, commands: value.commands as string[] };
}
