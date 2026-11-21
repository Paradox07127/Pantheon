import { beforeEach, describe, expect, it } from 'vitest';
import { openSettingsPage } from '@/screens/settings/settings-jump';
import { useSettingsView } from '@/screens/settings/view';
import { useShell } from '@/store';

beforeEach(() => {
  useSettingsView.setState({ open: false, page: 'general', detail: null });
});

describe('openSettings with a project', () => {
  it.each([
    ['a project opens the projects page on it', 'p1', 'projects', 'p1'],
    ['null keeps the page and the detail', null, 'general', null],
  ] as const)('%s', (_name, projectId, page, detail) => {
    useShell.getState().openSettings(projectId);
    const view = useSettingsView.getState();
    expect([view.open, view.page, view.detail]).toEqual([true, page, detail]);
  });

  it.each(['defaults', 'gates'] as const)(
    'keeps the %s page chosen by openSettingsPage',
    (page) => {
      openSettingsPage('p1', page);
      expect(useSettingsView.getState().page).toBe(page);
      expect(useSettingsView.getState().open).toBe(true);
    },
  );
});
