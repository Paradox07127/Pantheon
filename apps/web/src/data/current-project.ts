import { create } from 'zustand';
import type { BoardSnapshot } from '@pantheon/protocol';
import { visibleProjects } from './projects';

type Project = BoardSnapshot['projects'][number];

const CURRENT_PROJECT_KEY = 'pantheon.currentProject';

/** The project a project or session window shows; null in the main window and outside the desktop app. */
export function windowProjectId(): string | null {
  const context = globalThis.window?.pantheon?.windowContext?.();
  return context && context.kind !== 'main' ? (context.project_id ?? null) : null;
}

export function readCurrentProjectId(storage?: Pick<Storage, 'getItem'>): string | null {
  try {
    return (storage ?? localStorage).getItem(CURRENT_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function writeCurrentProjectId(project_id: string, storage?: Pick<Storage, 'setItem'>) {
  try {
    (storage ?? localStorage).setItem(CURRENT_PROJECT_KEY, project_id);
  } catch {
    // The choice still applies for this session.
  }
}

interface CurrentProjectState {
  // The viewer's last choice; it may name a project the snapshot no longer has.
  projectId: string | null;
  choose: (project_id: string) => void;
  clear: () => void;
}

// A window of one project keeps it and leaves the stored choice to the main window.
export const useCurrentProject = create<CurrentProjectState>((set) => ({
  projectId: windowProjectId() ?? readCurrentProjectId(),
  choose: (projectId) => {
    if (windowProjectId()) return;
    writeCurrentProjectId(projectId);
    set({ projectId });
  },
  clear: () => {
    if (windowProjectId()) return;
    try {
      localStorage.removeItem(CURRENT_PROJECT_KEY);
    } catch {
      // The choice is still cleared for this session.
    }
    set({ projectId: null });
  },
}));

/** The stored project while the snapshot has it, else the only project; a window of one project has only its own. */
export function currentProject(
  board: BoardSnapshot | null,
  storedId: string | null,
): Project | null {
  if (!board) return null;
  const projects = visibleProjects(board.projects);
  const stored = projects.find((p) => p.id === storedId);
  if (windowProjectId()) return stored ?? null;
  return stored ?? (projects.length === 1 ? projects[0]! : null);
}
