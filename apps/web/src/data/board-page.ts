import { useSyncExternalStore } from 'react';

/** The views available on the project board. */
export type BoardPage = 'now' | 'history' | 'canvas';

const PAGES: readonly BoardPage[] = ['now', 'history', 'canvas'];

/** The stored board view; anything else opens the now view. */
export function readBoardPage(raw: string | null): BoardPage {
  return PAGES.find((p) => p === raw) ?? 'now';
}

const pageKey = (projectId: string) => `pantheon.board-page.${projectId}`;

function storedPage(projectId: string): BoardPage {
  try {
    return readBoardPage(localStorage.getItem(pageKey(projectId)));
  } catch {
    return 'now';
  }
}

// The view picked on each project's board while the app runs; the title bar names it too.
let picked: Readonly<Record<string, BoardPage>> = {};
const pickListeners = new Set<() => void>();
const subscribePicked = (listener: () => void) => {
  pickListeners.add(listener);
  return () => void pickListeners.delete(listener);
};

export function pickBoardPage(projectId: string, page: BoardPage) {
  picked = { ...picked, [projectId]: page };
  pickListeners.forEach((listener) => listener());
  try {
    localStorage.setItem(pageKey(projectId), page);
  } catch {
    // The choice still holds until the app closes.
  }
}

/** The view the project's board shows. */
export function useBoardPage(projectId: string | null): BoardPage {
  const read = () => (projectId ? picked[projectId] : undefined);
  const chosen = useSyncExternalStore(subscribePicked, read, read);
  return projectId ? (chosen ?? storedPage(projectId)) : 'now';
}
