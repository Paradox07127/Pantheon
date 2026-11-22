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
  | 'data'
  | 'about'
  | 'gates'
  | 'worktrees'
  | 'permissions'
  | 'defaults'
  | 'project'
  | 'extensions'
  | 'projects';

/** The navigation's page for a page; a part of one project's page is on the projects page. */
export const navPage = (page: SettingsPage): SettingsPage =>
  SETTINGS_PAGES.find((p) => p.key === page)?.group === 'project' ? 'projects' : page;

export type SettingsSection = 'general' | 'models' | 'project' | 'connections' | 'data';

/** The navigation's groups in order, each with its name. */
export const SETTINGS_SECTIONS: { key: SettingsSection; label: string }[] = [
  {
    key: 'general',
    get label() {
      return t({ id: 'settings.nav.general', defaultMessage: 'General' });
    },
  },
  {
    key: 'models',
    get label() {
      return t({ id: 'settings.nav.models', defaultMessage: 'Models and permissions' });
    },
  },
  {
    key: 'project',
    get label() {
      return t({ id: 'settings.nav.project', defaultMessage: 'Project' });
    },
  },
  {
    key: 'connections',
    get label() {
      return t({ id: 'settings.nav.connections', defaultMessage: 'Connections and devices' });
    },
  },
  {
    key: 'data',
    get label() {
      return t({ id: 'settings.nav.data', defaultMessage: 'Data and about' });
    },
  },
];

/** The settings pages in navigation order, each in its navigation group and with its scope: this computer, every project, or a part of one project's page, which the navigation does not list. */
// Labels are getters, so each is read in the language loaded by then.
export const SETTINGS_PAGES: {
  key: SettingsPage;
  label: string;
  group: 'app' | 'global' | 'project';
  section: SettingsSection;
}[] = [
  {
    key: 'general',
    get label() {
      return t({ id: 'settings.pages.general', defaultMessage: 'General' });
    },
    group: 'app',
    section: 'general',
  },
  {
    key: 'appearance',
    get label() {
      return t({ id: 'settings.pages.appearance', defaultMessage: 'Appearance' });
    },
    group: 'app',
    section: 'general',
  },
  {
    key: 'sessionDisplay',
    get label() {
      return t({ id: 'settings.pages.sessionDisplay', defaultMessage: 'Session display' });
    },
    group: 'app',
    section: 'general',
  },
  {
    key: 'diff',
    get label() {
      return t({ id: 'settings.pages.diff', defaultMessage: 'Diff view' });
    },
    group: 'app',
    section: 'general',
  },
  {
    key: 'editor',
    get label() {
      return t({ id: 'settings.pages.openWith', defaultMessage: 'Open with' });
    },
    group: 'app',
    section: 'general',
  },
  {
    key: 'shortcuts',
    get label() {
      return t({ id: 'settings.pages.shortcuts', defaultMessage: 'Shortcuts' });
    },
    group: 'app',
    section: 'general',
  },
  {
    key: 'notifications',
    get label() {
      return t({ id: 'settings.pages.notifications', defaultMessage: 'Notifications' });
    },
    group: 'app',
    section: 'general',
  },
  {
    key: 'harness',
    get label() {
      return t({ id: 'settings.pages.runtimes', defaultMessage: 'Runtimes' });
    },
    group: 'app',
    section: 'models',
  },
  {
    key: 'defaults',
    get label() {
      return t({ id: 'settings.pages.defaults', defaultMessage: 'Default model' });
    },
    group: 'global',
    section: 'models',
  },
  {
    key: 'permissions',
    get label() {
      return t({ id: 'settings.pages.permissions', defaultMessage: 'Permissions' });
    },
    group: 'global',
    section: 'models',
  },
  {
    key: 'projects',
    get label() {
      return t({ id: 'settings.pages.projects', defaultMessage: 'Projects' });
    },
    group: 'global',
    section: 'project',
  },
  {
    key: 'connections',
    get label() {
      return t({ id: 'settings.pages.connections', defaultMessage: 'Connections' });
    },
    group: 'app',
    section: 'connections',
  },
  {
    key: 'devices',
    get label() {
      return t({ id: 'settings.devices.title', defaultMessage: 'Devices' });
    },
    group: 'app',
    section: 'connections',
  },
  {
    key: 'data',
    get label() {
      return t({ id: 'settings.pages.data', defaultMessage: 'Data' });
    },
    group: 'app',
    section: 'data',
  },
  {
    key: 'about',
    get label() {
      return t({ id: 'settings.pages.about', defaultMessage: 'About' });
    },
    group: 'app',
    section: 'data',
  },
  {
    key: 'gates',
    get label() {
      return t({ id: 'settings.pages.gates', defaultMessage: 'Gates' });
    },
    group: 'project',
    section: 'project',
  },
  {
    key: 'worktrees',
    get label() {
      return t({ id: 'settings.pages.worktrees', defaultMessage: 'Worktrees and merging' });
    },
    group: 'project',
    section: 'project',
  },
  {
    key: 'extensions',
    get label() {
      return t({ id: 'settings.pages.extensions', defaultMessage: 'Extensions' });
    },
    group: 'project',
    section: 'project',
  },
  {
    key: 'project',
    get label() {
      return t({ id: 'settings.pages.project', defaultMessage: 'Project' });
    },
    group: 'project',
    section: 'project',
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
  // Choosing the projects page lists them all; a part of one project is opened by setting detail after.
  setPage: (page) => set(page === 'projects' ? { page, detail: null } : { page }),
  query: '',
  setQuery: (query) => set({ query }),
}));
