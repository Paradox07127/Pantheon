import type { BoardSnapshot, BridgeResult, ProjectPermissionRule } from '@pantheon/protocol';
import { runCommand } from './commands';
import { useQuery, type QueryState } from './workbench-sessions';

type Project = BoardSnapshot['projects'][number];

const acceptRules = (value: unknown): ProjectPermissionRule[] | null =>
  Array.isArray(value) ? (value as ProjectPermissionRule[]) : null;

/** The project's always-allowed rules, newest first; read again when the project changes. */
export function usePermissionRules(project: Project): QueryState<ProjectPermissionRule[]> {
  return useQuery(
    'permission.rules',
    project.id,
    (project_id) => ({ project_id }),
    acceptRules,
    project.revision,
  );
}

export const removePermissionRule = (
  projectId: string,
  rule: string,
): Promise<BridgeResult<unknown>> =>
  runCommand('permission.rule.remove', { project_id: projectId, rule }, null);
