import { create } from 'zustand';
import type { EntriesFilters } from '../screens/memory/EntriesBar';
import { useShell } from '../store';
import { askMilestone, pickBoardPage } from './board-page';
import { useCurrentProject } from './current-project';

interface MemoryViewState {
  /** The memory entry the memory page's tabs show; null when none is chosen. */
  selectedId: string | null;
  /** The search words of the entries tab. */
  query: string;
  /** Filters another screen asked the entries tab to show; the tab takes them and clears this. */
  askedFilters: Partial<EntriesFilters> | null;
  select: (id: string | null) => void;
  setQuery: (query: string) => void;
}

export const useMemoryView = create<MemoryViewState>((set) => ({
  selectedId: null,
  query: '',
  askedFilters: null,
  select: (selectedId) => set({ selectedId }),
  setQuery: (query) => set({ query }),
}));

// An entry and a search belong to one project.
useCurrentProject.subscribe((now, before) => {
  if (now.projectId !== before.projectId) useMemoryView.setState({ selectedId: null, query: '' });
});

/** Opens the project's memory entries listing only the entries the plan decided. */
export function openPlanMemory(projectId: string): void {
  useMemoryView.setState({ selectedId: null, askedFilters: { origin: 'plan' } });
  useShell.getState().openProjectMemory(projectId, 'entries');
}

/** Opens the project board's overview with the plan's milestone unfolded. */
export function openPlanMilestone(projectId: string, milestoneId: string): void {
  askMilestone(projectId, milestoneId);
  pickBoardPage(projectId, 'overview');
  useShell.getState().openProjectBoard(projectId);
}
