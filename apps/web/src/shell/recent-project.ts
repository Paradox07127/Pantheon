import { useEffect } from 'react';
import { useBoard } from '../data/board';
import { currentProject, useCurrentProject } from '../data/current-project';

/** Adds the first root of each project the main window opens to the system's recent items. */
export function useRecentProject(kind: 'main' | 'project') {
  const stored = useCurrentProject((state) => state.projectId);
  const root = useBoard((state) => currentProject(state.board, stored)?.roots[0]);
  useEffect(() => {
    if (kind === 'main' && root) void window.pantheon?.addRecentProject(root);
  }, [kind, root]);
}
