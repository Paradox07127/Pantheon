import { useState, useSyncExternalStore } from 'react';
import { ChartGantt, SquarePen, Target, Workflow, type LucideIcon } from 'lucide-react';
import { t } from '../i18n';

/** The views available on the project board. */
export type BoardPage = 'goals' | 'now' | 'history' | 'canvas';

// Labels are getters, so each is read in the language loaded by then.
export const PAGES: readonly { key: BoardPage; label: string; icon: LucideIcon }[] = [
  {
    key: 'goals',
    get label() {
      return t({ id: 'board.view.goals', defaultMessage: 'Goals' });
    },
    icon: Target,
  },
  {
    key: 'now',
    get label() {
      return t({ id: 'board.history.span.now', defaultMessage: 'Now' });
    },
    icon: Workflow,
  },
  {
    key: 'history',
    get label() {
      return t({ id: 'board.history.span.history', defaultMessage: 'Whole history' });
    },
    icon: ChartGantt,
  },
  {
    key: 'canvas',
    get label() {
      return t({ id: 'board.view.canvas', defaultMessage: 'Canvas' });
    },
    icon: SquarePen,
  },
];

/** The stored board view; anything else opens the now view. */
export function readBoardPage(raw: string | null): BoardPage {
  return PAGES.find((p) => p.key === raw)?.key ?? 'now';
}

const pageKey = (projectId: string) => `pantheon.board-page.${projectId}`;

/** The view stored for the project; null when none is, or it is no view any more. */
function storedPage(projectId: string): BoardPage | null {
  try {
    const raw = localStorage.getItem(pageKey(projectId));
    return PAGES.some((p) => p.key === raw) ? readBoardPage(raw) : null;
  } catch {
    return null;
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

/**
 * The view the project's board shows: the one the user picked, else goals for a project with
 * goals and now for one without. Null while `hasGoals` is unknown; the default it then lands on
 * holds for the project while the board stays mounted.
 */
export function useBoardPage(
  projectId: string | null,
  hasGoals: boolean | null = null,
): BoardPage | null {
  const read = () => (projectId ? picked[projectId] : undefined);
  const chosen = useSyncExternalStore(subscribePicked, read, read);
  const [landed, setLanded] = useState<{ projectId: string; page: BoardPage } | null>(null);
  if (!projectId) return 'now';
  const own = chosen ?? storedPage(projectId);
  if (own) return own;
  if (landed?.projectId === projectId) return landed.page;
  if (hasGoals === null) return null;
  const page = hasGoals ? 'goals' : 'now';
  setLanded({ projectId, page });
  return page;
}
