import { useSyncExternalStore } from 'react';

/** Where the repository page is: its tabs, or one commit, session or file opened from them. */
export type RepoView =
  | { kind: 'tabs' }
  | { kind: 'commit'; sha: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'file'; path: string };

const TABS_VIEW: RepoView = { kind: 'tabs' };

// The place on each project's repository page while the app runs.
let views: Readonly<Record<string, RepoView>> = {};
const viewListeners = new Set<() => void>();
const subscribeViews = (listener: () => void) => {
  viewListeners.add(listener);
  return () => void viewListeners.delete(listener);
};

export function openRepoView(projectId: string, view: RepoView) {
  views = { ...views, [projectId]: view };
  viewListeners.forEach((listener) => listener());
}

/** The place the project's repository page shows; its tabs until something else is opened. */
export function useRepoView(projectId: string | null): RepoView {
  const read = () => (projectId ? views[projectId] : undefined) ?? TABS_VIEW;
  return useSyncExternalStore(subscribeViews, read, read);
}
