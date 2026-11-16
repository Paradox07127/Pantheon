import { create } from 'zustand';

/** Open-dialog state of the project picker, kept while other screens show. */
interface ProjectsView {
  opening: boolean;
  setOpening: (opening: boolean) => void;
}

export const useProjectsView = create<ProjectsView>((set) => ({
  opening: false,
  setOpening: (opening) => set({ opening }),
}));
