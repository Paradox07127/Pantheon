import type { BoardSnapshot } from '@pantheon/protocol';
import { runCommand } from './commands';

type Project = BoardSnapshot['projects'][number];

/** project.autoMerge.set at the project's revision. */
export const autoMergeRequest = (project: Pick<Project, 'id' | 'revision'>, enabled: boolean) => ({
  type: 'project.autoMerge.set' as const,
  input: { project_id: project.id, enabled },
  expected_revision: project.revision,
});

/** Turns the project's auto merge on or off at its revision. */
export function setAutoMerge(project: Pick<Project, 'id' | 'revision'>, enabled: boolean) {
  const request = autoMergeRequest(project, enabled);
  return runCommand(request.type, request.input, request.expected_revision);
}
