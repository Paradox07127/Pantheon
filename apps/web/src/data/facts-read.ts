import { useEffect } from 'react';
import type { BridgeResult, ProjectFactsRead } from '@pantheon/protocol';
import { useBoard } from './board';
import { runCommand } from './commands';
import { REPOSITORY_KINDS, useProjectQuery } from './project-read';

export type { ProjectFactsRead };

const isFactsRead = (value: unknown): boolean => {
  const read = value as Partial<ProjectFactsRead> | null;
  return !!read && (read.facts === null || Array.isArray(read.facts?.folders));
};

/** Events that change the snapshot, or whether a root has commits. */
const FACTS_KINDS: ReadonlySet<string> = new Set(['project.facts_collected', ...REPOSITORY_KINDS]);

/** GET /v1/project.facts.read: the newest measured snapshot, read again after the events that change it. */
export function useFactsRead(project_id: string | null) {
  return useProjectQuery<ProjectFactsRead>(
    'project.facts.read',
    project_id,
    isFactsRead,
    undefined,
    { kinds: FACTS_KINDS },
  );
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

/** Measures the project now; the result comes back once the new snapshot is stored. */
export const measureFacts = (project_id: string) =>
  runCommand('project.facts.refresh', { project_id }, null);

const refreshOnOpen = factsRefresher(measureFacts);

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
