import { t } from './i18n';
import type { Screen } from './store';

// Getters, so each name is read in the language loaded by then; the settings are a dialog.
export const SCREEN_NAMES: Record<Screen | 'settings', string> = {
  get sessions() {
    return t({ id: 'app.screenName.sessions', defaultMessage: 'Sessions' });
  },
  get changes() {
    return t({ id: 'app.screenName.changes', defaultMessage: 'Changes' });
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
  get settings() {
    return t({ id: 'app.screenName.settings', defaultMessage: 'Settings' });
  },
};
