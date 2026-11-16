import { useEffect } from 'react';
import type { BridgeResult, ProjectFactsRead } from '@pantheon/protocol';
import { useBoard } from './board';
import { runCommand } from './commands';
import { useProjectQuery } from './project-read';

export type { ProjectFactsRead };

const isFactsRead = (value: unknown): boolean => {
  const read = value as Partial<ProjectFactsRead> | null;
  return (
    !!read &&
    Array.isArray(read.workstreams) &&
    (read.facts === null || Array.isArray(read.facts?.folders))
  );
};

/** GET /v1/project.facts.read: the newest measured snapshot, read again whenever the board moves. */
export function useFactsRead(project_id: string | null) {
  return useProjectQuery<ProjectFactsRead>('project.facts.read', project_id, isFactsRead);
}

/**
 * Sends one refresh each time the project differs from the one it was last called with; after a
 * failed refresh the next call for that project sends it again.
 */
export function factsRefresher(send: (project_id: string) => Promise<BridgeResult<unknown>>) {
  let last: string | null = null;
  return (project_id: string | null) => {
    if (project_id === last) return;
    last = project_id;
    if (!project_id) return;
    void send(project_id).then((result) => {
      if (result.ok) return;
      console.warn(`project.facts.refresh failed: ${result.error.message}`);
      if (last === project_id) last = null;
    });
  };
}

const refreshOnOpen = factsRefresher((project_id) =>
  runCommand('project.facts.refresh', { project_id }, null),
);

/**
 * Measures the project when it becomes the current one, and again on reconnecting if that failed;
 * the command's event moves the board, so reads follow.
 */
export function useFactsRefreshOnOpen(project_id: string | null) {
  const live = useBoard((s) => s.status.state === 'live');
  useEffect(() => {
    if (live) refreshOnOpen(project_id);
  }, [project_id, live]);
}
