import type { ReactNode } from 'react';
import { Ellipsis, X } from 'lucide-react';
import { Menu, MenuItem } from '../../components/Menu';
import { t, type Message } from '../../i18n';
import { SETTINGS_INDEX } from './settings-index';
import { revealSetting } from './settings-jump';
import { allProjects, thisComputer } from './SettingsNav';
import { SETTINGS_PAGES, useSettingsView, type SettingsPage } from './view';

/** The page's groups in order, each with the first setting it holds; a setting outside a section is its own group, one changed on the board is none. */
function pageGroups(page: SettingsPage): { label: Message; id: string }[] {
  const groups = new Map<string, { label: Message; id: string }>();
  for (const record of SETTINGS_INDEX) {
    if (record.page !== page || record.id === `${page}.page` || record.board) continue;
    const label = record.section ?? record.label;
    if (!groups.has(label.id)) groups.set(label.id, { label, id: record.id });
  }
  return [...groups.values()];
}

/** The bar over a settings page: its name and scope (or the search's while one is typed), a jump to each of its groups, its tools and the close. */
export function CategoryHeader({
  page,
  scope,
  tools,
  end,
}: {
  page: SettingsPage;
  /** The scope chip's text instead of the page group's. */
  scope?: string;
  /** A marker after the scope. */
  tools?: ReactNode;
  /** The page's own controls at the header's end, before the close. */
  end?: ReactNode;
}) {
  const { label, group } = SETTINGS_PAGES.find((p) => p.key === page)!;
  const searching = useSettingsView((s) => s.query) !== '';
  const groups = pageGroups(page);
  const jump = t({ id: 'settings.category.jump', defaultMessage: 'Groups on this page' });
  return (
    <header className="ps-hd">
      <h1>{searching ? t({ id: 'settings.category.search', defaultMessage: 'Search' }) : label}</h1>
      {searching && (
        <span className="ps-chip">
          {t({ id: 'settings.category.scopeAll', defaultMessage: 'All settings' })}
        </span>
      )}
      {!searching && (
        <span className="ps-chip">
          {scope ?? (group === 'app' ? thisComputer() : allProjects())}
        </span>
      )}
      {tools}
      <span className="ps-hd-end">
        {groups.length > 1 && (
          <Menu
            label={jump}
            align="end"
            trigger={
              <button type="button" className="ib" aria-label={jump}>
                <Ellipsis aria-hidden="true" />
              </button>
            }
          >
            {groups.map((g) => (
              <MenuItem key={g.id} onClick={() => revealSetting(g.id, 'start')}>
                {t(g.label)}
              </MenuItem>
            ))}
          </Menu>
        )}
        {end}
        <button
          type="button"
          className="ib"
          aria-label={t({ id: 'settings.dialog.close', defaultMessage: 'Close settings' })}
          onClick={() => useSettingsView.getState().close()}
        >
          <X aria-hidden="true" />
        </button>
      </span>
    </header>
  );
}
