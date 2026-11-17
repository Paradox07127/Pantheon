import { create } from 'zustand';
import { useCurrentProject } from '../../data/current-project';
import { reducedMotion } from '../../lib/motion';
import { useShell } from '../../store';
import { openRetro } from '../board/RetroPanel';
import { pickInsightsSection, type InsightsSection } from '../insights/InsightsScreen';
import { searchSettings, type SettingHit } from './settings-search';
import { navPage, useSettingsView, type SettingsPage } from './view';

/** The result the arrow keys have reached in the search field. */
export const useSearchCursor = create<{ active: number; setActive: (active: number) => void }>(
  (set) => ({ active: 0, setActive: (active) => set({ active }) }),
);

/** The hits of the query by page, the page of the best hit first; read in this order by the arrow keys. */
export function hitGroups(query: string): { page: SettingsPage; hits: SettingHit[] }[] {
  const groups = new Map<SettingsPage, SettingHit[]>();
  for (const hit of searchSettings(query))
    groups.set(hit.page, [...(groups.get(hit.page) ?? []), hit]);
  return [...groups].map(([page, hits]) => ({ page, hits }));
}

/** Scrolls to the setting's anchor, or to its whole section for block 'start'. */
export function revealSetting(id: string, block: 'center' | 'start'): HTMLElement | null {
  const anchor = document.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
  const target = block === 'start' ? (anchor?.closest<HTMLElement>('.ps-sec') ?? anchor) : anchor;
  target?.scrollIntoView({ block, behavior: reducedMotion() ? 'auto' : 'smooth' });
  return anchor;
}

/** Closes the settings and opens the project's engineering board on the tab, and on the retrospective when given. */
export function openBoardTab(section: InsightsSection, retrospectiveId?: string) {
  const view = useSettingsView.getState();
  const projectId = view.detail ?? useCurrentProject.getState().projectId;
  view.close();
  if (!projectId) return;
  pickInsightsSection(projectId, section);
  if (retrospectiveId) openRetro(retrospectiveId);
  // The project is chosen before the one navigation, which would drop a navigation still owed.
  useCurrentProject.getState().choose(projectId);
  useShell.getState().setScreen('insights');
}

/** Opens the settings on the page; a part of one project's page opens on that project. */
export function openSettingsPage(projectId: string, page: SettingsPage) {
  const view = useSettingsView.getState();
  view.setPage(page);
  if (navPage(page) === 'projects') view.setDetail(projectId);
  useShell.getState().openSettings(projectId);
}

/** Opens the hit's page, then scrolls to the setting and flashes it once. */
export function jumpTo(hit: SettingHit) {
  const view = useSettingsView.getState();
  view.setPage(hit.page);
  view.setQuery('');
  useSearchCursor.getState().setActive(0);
  if (hit.board) return openBoardTab(hit.board);
  if (hit.pageOnly) return;
  // The page renders once the query is cleared; a row that waits on the page's settings read renders
  // frames later, so the anchor is looked for each frame for about a second (60 frames).
  const reveal = (framesLeft: number) =>
    requestAnimationFrame(() => {
      const anchor = revealSetting(hit.id, 'center');
      if (!anchor) {
        if (framesLeft > 0) reveal(framesLeft - 1);
        return;
      }
      anchor.dataset.flash = 'on';
      setTimeout(() => {
        // 'off' keeps the fade-back transition until it ends.
        anchor.dataset.flash = 'off';
        anchor.addEventListener('transitionend', () => delete anchor.dataset.flash, { once: true });
      }, 1200);
    });
  reveal(60);
}
