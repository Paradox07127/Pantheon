import type { ProjectBrief } from '@pantheon/protocol';
import { sendProjectCommand } from './project-read';

export type { ProjectBrief };

/** Asks the daemon to write the paragraph of the project's brief; true once it started, the paragraph landing with a later read. */
export const writeBriefProse = async (projectId: string): Promise<boolean> => {
  const result = await sendProjectCommand(
    'project.brief.prose.write',
    { project_id: projectId },
    null,
  );
  return result.ok && (result.value as { started?: boolean } | null)?.started === true;
};
