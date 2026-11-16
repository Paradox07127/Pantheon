import { create } from 'zustand';
import type { GraphKind } from '../screens/memory/graph-layout';
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
