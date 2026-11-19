import { useSyncExternalStore } from 'react';
import { LayoutDashboard, Workflow, type LucideIcon } from 'lucide-react';
import { t } from '../i18n';

/** The views available on the project board. */
export type BoardPage = 'overview' | 'tasks';
/** How the tasks view draws the tasks. */
export type TaskView = 'flow' | 'list' | 'timeline';
/** Which tasks the tasks view shows: those of the current milestone, or all. */
export type TaskScope = 'milestone' | 'all';

// Labels are getters, so each is read in the language loaded by then.
export const PAGES: readonly { key: BoardPage; label: string; icon: LucideIcon }[] = [
  {
    key: 'overview',
    get label() {
      return t({ id: 'board.view.overview', defaultMessage: 'Overview' });
    },
    icon: LayoutDashboard,
  },
  {
    key: 'tasks',
    get label() {
      return t({ id: 'board.view.tasks', defaultMessage: 'Tasks' });
    },
    icon: Workflow,
  },
];

// The views stored before the board had two, each read as the one that took its place.
const STORED_PAGES = new Map<string, BoardPage>([
  ['overview', 'overview'],
  ['tasks', 'tasks'],
  ['goals', 'overview'],
  ['now', 'overview'],
  ['canvas', 'overview'],
  ['history', 'tasks'],
]);

/** The stored board view; anything else opens the overview. */
export function readBoardPage(raw: string | null): BoardPage {
  return (raw !== null && STORED_PAGES.get(raw)) || 'overview';
}

const pageKey = (projectId: string) => `pantheon.board-page.${projectId}`;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** A choice kept for each project while the app runs and in local storage across runs. */
function projectChoice<T extends string>(
  key: (projectId: string) => string,
  read: (raw: string | null, projectId: string) => T,
) {
  let picked: Readonly<Record<string, T>> = {};
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const pick = (projectId: string, value: T) => {
    picked = { ...picked, [projectId]: value };
    listeners.forEach((listener) => listener());
    try {
      localStorage.setItem(key(projectId), value);
    } catch {
      // The choice still holds until the app closes.
    }
  };
  const use = (projectId: string | null): T => {
    const chosen = () => (projectId ? picked[projectId] : undefined);
    const value = useSyncExternalStore(subscribe, chosen, chosen);
    if (!projectId) return read(null, '');
    return value ?? read(stored(key(projectId)), projectId);
  };
  return { pick, use };
}

const page = projectChoice(pageKey, readBoardPage);

export const pickBoardPage = page.pick;
/** The view the project's board shows: the one the user picked, else the overview. */
export const useBoardPage = page.use;

let asked: { projectId: string; milestoneId: string } | null = null;
const askedListeners = new Set<() => void>();
const subscribeAsked = (listener: () => void) => {
  askedListeners.add(listener);
  return () => void askedListeners.delete(listener);
};

/** Asks the overview to unfold the project's milestone; the goals take the ask once, and null clears it. */
export function askMilestone(projectId: string | null, milestoneId?: string): void {
  asked = projectId && milestoneId ? { projectId, milestoneId } : null;
  askedListeners.forEach((listener) => listener());
}

/** The milestone another screen asked the project's overview to unfold, if any. */
export function useAskedMilestone(projectId: string): string | null {
  const read = () => (asked?.projectId === projectId ? asked.milestoneId : null);
  return useSyncExternalStore(subscribeAsked, read, read);
}

const TASK_VIEWS: readonly TaskView[] = ['flow', 'list', 'timeline'];
const TASK_SCOPES: readonly TaskScope[] = ['milestone', 'all'];

const view = projectChoice(
  (projectId) => `pantheon.board-task-view.${projectId}`,
  (raw, projectId): TaskView =>
    TASK_VIEWS.find((v) => v === raw) ??
    (projectId && stored(pageKey(projectId)) === 'history' ? 'timeline' : 'flow'),
);

export const pickTaskView = view.pick;
/** The tasks view's drawing the user picked for the project, else the flow chart. */
export const useTaskView = view.use;

const scope = projectChoice(
  (projectId) => `pantheon.board-task-scope.${projectId}`,
  (raw): TaskScope => TASK_SCOPES.find((s) => s === raw) ?? 'milestone',
);

export const pickTaskScope = scope.pick;
/** The tasks view's scope the user picked for the project, else the current milestone. */
export const useTaskScope = scope.use;
