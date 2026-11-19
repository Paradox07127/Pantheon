import { create } from 'zustand';
import type { EntriesFilters } from '../screens/memory/EntriesBar';
import type { GraphKind } from '../screens/memory/graph-layout';
import { useShell } from '../store';
import { askMilestone, pickBoardPage } from './board-page';
import { useCurrentProject } from './current-project';

interface MemoryViewState {
  /** The memory entry the memory page's tabs show; null when none is chosen. */
  selectedId: string | null;
  /** The source or tag node the graph tab focuses; null while it follows selectedId. */
  graphNode: string | null;
  /** The search words of the entries tab, also marked in the graph. */
  query: string;
  /** The kinds the graph tab leaves out. */
  hiddenKinds: readonly GraphKind[];
  /** Whether the graph tab draws tag nodes. */
  showTags: boolean;
  /** How many links around the selected node the graph tab keeps in focus. */
  depth: 1 | 2;
  /** Filters another screen asked the entries tab to show; the tab takes them and clears this. */
  askedFilters: Partial<EntriesFilters> | null;
  select: (id: string | null) => void;
  focusGraphNode: (id: string) => void;
  setQuery: (query: string) => void;
  showKind: (kind: GraphKind, shown: boolean) => void;
  setShowTags: (showTags: boolean) => void;
  setDepth: (depth: 1 | 2) => void;
}

export const useMemoryView = create<MemoryViewState>((set) => ({
  selectedId: null,
  graphNode: null,
  query: '',
  hiddenKinds: [],
  showTags: false,
  depth: 1,
  askedFilters: null,
  select: (selectedId) => set({ selectedId, graphNode: null }),
  focusGraphNode: (graphNode) => set({ graphNode }),
  setQuery: (query) => set({ query }),
  showKind: (kind, shown) =>
    set((s) => ({
      hiddenKinds: [...s.hiddenKinds.filter((k) => k !== kind), ...(shown ? [] : [kind])],
    })),
  setShowTags: (showTags) => set({ showTags }),
  setDepth: (depth) => set({ depth }),
}));

// An entry and a search belong to one project.
useCurrentProject.subscribe((now, before) => {
  if (now.projectId !== before.projectId)
    useMemoryView.setState({ selectedId: null, graphNode: null, query: '' });
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
