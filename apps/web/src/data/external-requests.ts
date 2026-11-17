import type { ExternalRead } from '@pantheon/domain';
import type { BoardSnapshot, BridgeResult } from '@pantheon/protocol';
import { runCommand } from './commands';
import { useQuery, type QueryState } from './workbench-sessions';

type Project = BoardSnapshot['projects'][number];

/** How a project takes requests; `off` is a project without the setting. */
export type ExternalMode = 'off' | NonNullable<ExternalRead['mode']>;

const acceptRead = (value: unknown): ExternalRead | null => {
  const read = value as Partial<ExternalRead> | null;
  return read &&
    Array.isArray(read.sources) &&
    Array.isArray(read.events) &&
    Array.isArray(read.held)
    ? (read as ExternalRead)
    : null;
};

/** GET /v1/external.read for the project; read again when tick changes. */
export function useExternalRead(project: Project, tick: number): QueryState<ExternalRead> {
  return useQuery('external.read', project.id, (project_id) => ({ project_id }), acceptRead, tick);
}

export const setExternalMode = (
  project: Project,
  mode: ExternalMode,
): Promise<BridgeResult<unknown>> =>
  runCommand('project.externalEvents.set', { project_id: project.id, mode }, project.revision);

export const approveExternal = (
  project: Project,
  subjectKey: string,
): Promise<BridgeResult<unknown>> =>
  runCommand('external.approve', { project_id: project.id, subject_key: subjectKey }, null);
