import type { ProjectBrief } from '@pantheon/protocol';
import { sendProjectCommand, useProjectQuery, type MutationResult } from './project-read';

export type { ProjectBrief };

const isBrief = (value: unknown): boolean =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as ProjectBrief).since === 'number' &&
  Array.isArray((value as ProjectBrief).items);

/** GET /v1/project.brief: what happened in the project after the user's seen cursor. */
export const useProjectBrief = (projectId: string | null) =>
  useProjectQuery<ProjectBrief>('project.brief', projectId, isBrief, undefined, { events: true });

/** Moves the user's seen cursor of the project to now, so the brief starts over. */
export const markProjectSeen = (projectId: string): Promise<MutationResult> =>
  sendProjectCommand('project.seen', { project_id: projectId }, null);

/** Asks the daemon to write the paragraph of the project's brief; true once it started, the paragraph landing with a later read. */
export const writeBriefProse = async (projectId: string): Promise<boolean> => {
  const result = await sendProjectCommand(
    'project.brief.prose.write',
    { project_id: projectId },
    null,
  );
  return result.ok && (result.value as { started?: boolean } | null)?.started === true;
};
