import { create } from 'zustand';
import { useCurrentProject } from './current-project';

interface MemoryViewState {
  /** The memory entry the memory page's tabs show; null when none is chosen. */
  selectedId: string | null;
  /** The search words of the entries tab. */
  query: string;
  select: (id: string | null) => void;
  setQuery: (query: string) => void;
}

export const useMemoryView = create<MemoryViewState>((set) => ({
  selectedId: null,
  query: '',
  select: (selectedId) => set({ selectedId }),
  setQuery: (query) => set({ query }),
}));

// An entry and a search belong to one project.
useCurrentProject.subscribe((now, before) => {
  if (now.projectId !== before.projectId) useMemoryView.setState({ selectedId: null, query: '' });
});
