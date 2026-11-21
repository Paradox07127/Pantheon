import type { ProjectSetupRead, SetupState } from '@/data/project-setup';

/** A project's setup read in one state, starting nothing unless `start` is given. */
export const setupRead = (
  state: SetupState | null,
  extra: Partial<ProjectSetupRead> = {},
): ProjectSetupRead => ({
  projectId: 'project-a',
  name: 'LiveWallpaper',
  state,
  baseline: null,
  roots: ['/work/LiveWallpaper'],
  intro: false,
  charts: 0,
  plan: null,
  planSince: null,
  busy: false,
  error: null,
  start: () => {},
  ...extra,
});
