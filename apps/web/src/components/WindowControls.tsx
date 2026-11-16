import type { MouseEvent } from 'react';
import { Menu, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { t } from '../i18n';
import { keyText, shortcutKeys } from '../lib/shortcuts';
import { Tip } from './Tip';

interface WindowControlsProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Opens the command palette. */
  onSearch: () => void;
}

/** Pops the application menu up under the button, as a menu bar's menu would open. */
const popupAppMenu = (e: MouseEvent<HTMLButtonElement>) => {
  const { left, bottom } = e.currentTarget.getBoundingClientRect();
  void window.pantheon?.popupAppMenu(left, bottom);
};

export function WindowControls({ collapsed, onToggle, onSearch }: WindowControlsProps) {
  const label = collapsed
    ? t({ id: 'components.windowControls.expandSidebar', defaultMessage: 'Expand sidebar' })
    : t({ id: 'components.windowControls.collapseSidebar', defaultMessage: 'Collapse sidebar' });
  const Toggle = collapsed ? PanelLeftOpen : PanelLeftClose;
  const search = t({ id: 'components.windowControls.search', defaultMessage: 'Search' });
  const searchKeys = shortcutKeys('palette');
  // Windows and Linux windows have no menu bar; this button opens its menus.
  const menuButton =
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains('overlay-titlebar');
  return (
    <div className="wc">
      {menuButton && (
        <button
          type="button"
          className="ib"
          aria-label={t({ id: 'components.windowControls.appMenu', defaultMessage: 'Menu' })}
          onClick={popupAppMenu}
        >
          <Menu aria-hidden="true" />
        </button>
      )}
      <Tip content={`${label} ${keyText(shortcutKeys('sidebar'))}`}>
        <button
          type="button"
          className="ib"
          aria-label={label}
          aria-keyshortcuts="Meta+B"
          onClick={onToggle}
        >
          <Toggle aria-hidden="true" />
        </button>
      </Tip>
      <Tip content={`${search} ${keyText(searchKeys)}`}>
        <button
          type="button"
          className="ib"
          aria-label={search}
          aria-keyshortcuts={searchKeys || undefined}
          onClick={onSearch}
        >
          <Search aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}
