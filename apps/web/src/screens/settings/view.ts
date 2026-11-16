import { create } from 'zustand';
import { RUNTIMES, type Runtime } from '../../data/extensions';
import { t } from '../../i18n';

export type SettingsPage =
  | 'general'
  | 'appearance'
  | 'sessionDisplay'
  | 'diff'
  | 'harness'
  | 'devices'
  | 'editor'
  | 'connections'
  | 'notifications'
  | 'shortcuts'
  | 'usage'
  | 'data'
  | 'about'
  | 'gates'
  | 'worktrees'
  | 'permissions'
  | 'external'
  | 'defaults'
  | 'project'
  | 'extensions'
  | 'workflow'
  | 'projects';

/** The navigation's page for a page; a part of one project's page is on the projects page. */
export const navPage = (page: SettingsPage): SettingsPage =>
  SETTINGS_PAGES.find((p) => p.key === page)?.group === 'project' ? 'projects' : page;

/** The settings pages in navigation order: this computer's, then the ones for every project; a project page is a part of one project's page, which the navigation does not list. */
// Labels are getters, so each is read in the language loaded by then.
export const SETTINGS_PAGES: {
  key: SettingsPage;
  label: string;
  group: 'app' | 'global' | 'project';
}[] = [
  {
    key: 'general',
    get label() {
      return t({ id: 'settings.pages.general', defaultMessage: 'General' });
    },
    group: 'app',
  },
  {
    key: 'appearance',
    get label() {
      return t({ id: 'settings.pages.appearance', defaultMessage: 'Appearance' });
    },
    group: 'app',
  },
  {
    key: 'sessionDisplay',
    get label() {
      return t({ id: 'settings.pages.sessionDisplay', defaultMessage: 'Session display' });
    },
    group: 'app',
  },
  {
    key: 'diff',
    get label() {
      return t({ id: 'settings.pages.diff', defaultMessage: 'Diff view' });
    },
    group: 'app',
  },
  {
    key: 'harness',
    get label() {
      return t({ id: 'settings.pages.runtimes', defaultMessage: 'Runtimes' });
    },
    group: 'app',
  },
  {
    key: 'editor',
    get label() {
      return t({ id: 'settings.pages.openWith', defaultMessage: 'Open with' });
    },
    group: 'app',
  },
  {
    key: 'connections',
    get label() {
      return t({ id: 'settings.pages.connections', defaultMessage: 'Connections' });
    },
    group: 'app',
  },
  {
    key: 'devices',
    get label() {
      return t({ id: 'settings.devices.title', defaultMessage: 'Devices' });
    },
    group: 'app',
  },
  {
    key: 'notifications',
    get label() {
      return t({ id: 'settings.pages.notifications', defaultMessage: 'Notifications' });
    },
    group: 'app',
  },
  {
    key: 'shortcuts',
    get label() {
      return t({ id: 'settings.pages.shortcuts', defaultMessage: 'Shortcuts' });
    },
    group: 'app',
  },
  {
    key: 'data',
    get label() {
      return t({ id: 'settings.pages.data', defaultMessage: 'Data' });
    },
    group: 'app',
  },
  {
    key: 'about',
    get label() {
      return t({ id: 'settings.pages.about', defaultMessage: 'About' });
    },
    group: 'app',
  },
  {
    key: 'workflow',
    get label() {
      return t({ id: 'settings.pages.workflow', defaultMessage: 'Workflow' });
    },
    group: 'global',
  },
  {
    key: 'defaults',
    get label() {
      return t({ id: 'settings.pages.defaults', defaultMessage: 'Default model' });
    },
    group: 'global',
  },
  {
    key: 'usage',
    get label() {
      return t({ id: 'settings.pages.usage', defaultMessage: 'Usage' });
    },
    group: 'global',
  },
  {
    key: 'external',
    get label() {
      return t({ id: 'settings.pages.external', defaultMessage: 'External requests' });
    },
    group: 'global',
  },
  {
    key: 'permissions',
    get label() {
      return t({ id: 'settings.pages.permissions', defaultMessage: 'Permissions' });
    },
    group: 'global',
  },
  {
    key: 'projects',
    get label() {
      return t({ id: 'settings.pages.projects', defaultMessage: 'Projects' });
    },
    group: 'global',
  },
  {
    key: 'gates',
    get label() {
      return t({ id: 'settings.pages.gates', defaultMessage: 'Gates' });
    },
    group: 'project',
  },
  {
    key: 'worktrees',
    get label() {
      return t({ id: 'settings.pages.worktrees', defaultMessage: 'Worktrees and merging' });
    },
    group: 'project',
  },
  {
    key: 'extensions',
    get label() {
      return t({ id: 'settings.pages.extensions', defaultMessage: 'Extensions' });
    },
    group: 'project',
  },
  {
    key: 'project',
    get label() {
      return t({ id: 'settings.pages.project', defaultMessage: 'Project' });
    },
    group: 'project',
  },
];

/** State the settings dialog shares with its pages and its header. */
interface SettingsView {
  open: boolean;
  /** The project the projects page shows; null lists them all. */
  detail: string | null;
  setDetail: (detail: string | null) => void;
  close: () => void;
  runtime: Runtime;
  setRuntime: (runtime: Runtime) => void;
  page: SettingsPage;
  setPage: (page: SettingsPage) => void;
  /** The navigation's search text. */
  query: string;
  setQuery: (query: string) => void;
}

export const useSettingsView = create<SettingsView>((set) => ({
  open: false,
  detail: null,
  setDetail: (detail) => set({ detail }),
  close: () => set({ open: false }),
  runtime: RUNTIMES[0]!,
  setRuntime: (runtime) => set({ runtime }),
  page: 'general',
  setPage: (page) => set({ page }),
  query: '',
  setQuery: (query) => set({ query }),
}));
