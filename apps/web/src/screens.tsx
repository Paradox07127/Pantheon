import { t } from './i18n';
import type { Screen } from './store';

// Getters, so each name is read in the language loaded by then; the settings are a dialog.
export const SCREEN_NAMES: Record<Screen | 'settings', string> = {
  get sessions() {
    return t({ id: 'app.screenName.sessions', defaultMessage: 'Sessions' });
  },
  get board() {
    return t({ id: 'app.screenName.board', defaultMessage: 'Project board' });
  },
  get insights() {
    return t({ id: 'app.screenName.insights', defaultMessage: 'Engineering board' });
  },
  get repo() {
    return t({ id: 'app.screenName.repo', defaultMessage: 'Repository' });
  },
  get runtime() {
    return t({ id: 'app.screenName.runtime', defaultMessage: 'Runs' });
  },
  get flow() {
    return t({ id: 'app.screenName.flow', defaultMessage: 'Flow chart' });
  },
  get trace() {
    return t({ id: 'app.screenName.trace', defaultMessage: 'Trace' });
  },
  get memory() {
    return t({ id: 'app.screenName.memory', defaultMessage: 'Memory' });
  },
  get projects() {
    return t({ id: 'app.screenName.projects', defaultMessage: 'All projects' });
  },
  get personal() {
    return t({ id: 'app.screenName.personal', defaultMessage: 'Personal agent' });
  },
  get settings() {
    return t({ id: 'app.screenName.settings', defaultMessage: 'Settings' });
  },
};
