import { useEffect } from 'react';
import type { MenuAction } from '@pantheon/protocol';
import { noticeResult } from '../components/Toast';
import { useBoard } from '../data/board';
import { currentProject, useCurrentProject } from '../data/current-project';
import { openPersonalAgent } from '../data/personal-agent';
import { t } from '../i18n';
import { useProjectsView } from '../screens/projects/view';
import { copyDiagnostics } from '../screens/settings/AboutPage';
import { useSettingsView } from '../screens/settings/view';
import { useShell } from '../store';
import { runShortcut, useShortcut, type ShortcutId } from './shortcuts';

/** The menu items that run a shortcut entry and nothing else. */
const SHORTCUT_ITEMS: Partial<Record<MenuAction, ShortcutId>> = {
  search: 'palette',
  'toggle-sidebar': 'sidebar',
  'toggle-details': 'details',
  'toggle-overview': 'overview',
  back: 'back',
  forward: 'forward',
  shortcuts: 'shortcuts',
};

function toggleCurrentSettings(): void {
  if (useSettingsView.getState().open) return useSettingsView.getState().close();
  const project = currentProject(useBoard.getState().board, useCurrentProject.getState().projectId);
  useShell.getState().openSettings(project?.id ?? null);
}

/** Carries out a menu item with the handlers its shortcut keys run. */
export function runMenuAction(action: MenuAction): void {
  const shortcut = SHORTCUT_ITEMS[action];
  if (shortcut) runShortcut(shortcut);
  else if (action === 'new-session') runShortcut('new');
  else if (action === 'settings') runShortcut('settings');
  else if (action === 'copy-diagnostics')
    void copyDiagnostics().then((copied) =>
      noticeResult(
        copied
          ? {
              tone: 'done',
              heading: t({
                id: 'settings.about.diagnosticsCopied',
                defaultMessage: 'Diagnostics copied',
              }),
            }
          : {
              tone: 'failed',
              heading: t({
                id: 'settings.about.diagnosticsCopyFailed',
                defaultMessage: "Couldn't copy the diagnostics",
              }),
            },
      ),
    );
  else if (action === 'personal-agent') void openPersonalAgent();
  else if (action === 'open-project' && !runShortcut('open-project'))
    useProjectsView.getState().setOpening(true);
}

/** Binds the settings shortcut and the desktop app's menu actions. */
export function MenuActions(): null {
  useShortcut('settings', toggleCurrentSettings);
  useEffect(() => window.pantheon?.onMenuAction(runMenuAction), []);
  return null;
}
