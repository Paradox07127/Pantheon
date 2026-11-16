import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WindowControls } from '@/components/WindowControls';
import { zh } from './i18n-setup.js';
import { nodes } from './web-hook-host.js';

afterEach(() => vi.unstubAllGlobals());

/** The class main.tsx puts on the root element of a Windows or Linux desktop window. */
const titlebar = (name: string) =>
  vi.stubGlobal('document', {
    documentElement: { classList: { contains: (token: string) => token === name } },
  });
const buttons = (collapsed: boolean, onSearch = () => {}) =>
  nodes(WindowControls({ collapsed, onToggle() {}, onSearch })).filter((n) => n.type === 'button');

const render = (collapsed = false) =>
  renderToStaticMarkup(createElement(WindowControls, { collapsed, onToggle() {}, onSearch() {} }));

describe('window controls', () => {
  it('names the sidebar toggle after what it does next', () => {
    expect(render(true)).toContain(`aria-label="${zh('components.windowControls.expandSidebar')}"`);
    expect(render(false)).toContain(
      `aria-label="${zh('components.windowControls.collapseSidebar')}"`,
    );
    expect(render()).toContain('aria-keyshortcuts="Meta+B"');
  });

  it('holds the sidebar toggle, then a search button with the palette keys that opens the palette', () => {
    for (const collapsed of [false, true]) {
      const onSearch = vi.fn();
      const shown = buttons(collapsed, onSearch);
      expect(shown.map((n) => n.props['aria-label'])).toEqual([
        zh(`components.windowControls.${collapsed ? 'expandSidebar' : 'collapseSidebar'}`),
        zh('components.windowControls.search'),
      ]);
      expect(shown[1]!.props['aria-keyshortcuts']).toBe('Meta+K');
      shown[1]!.props.onClick();
      expect(onSearch).toHaveBeenCalledOnce();
      expect(render(collapsed)).not.toContain('全部项目');
    }
  });

  it.each(['mac-titlebar', undefined])('has no menu button under %s', (name) => {
    if (name) titlebar(name);
    for (const collapsed of [false, true])
      expect(buttons(collapsed).map((n) => n.props['aria-label'])).not.toContain(
        zh('components.windowControls.appMenu'),
      );
  });

  it('opens the application menu at the bottom left corner of the menu button on Windows and Linux', () => {
    titlebar('overlay-titlebar');
    const popupAppMenu = vi.fn(async () => ({ ok: true, value: null }));
    vi.stubGlobal('window', { pantheon: { popupAppMenu } });
    for (const collapsed of [false, true]) {
      const shown = buttons(collapsed);
      expect(shown.map((n) => n.props['aria-label'])).toEqual([
        zh('components.windowControls.appMenu'),
        zh(`components.windowControls.${collapsed ? 'expandSidebar' : 'collapseSidebar'}`),
        zh('components.windowControls.search'),
      ]);
      popupAppMenu.mockClear();
      shown[0]!.props.onClick({
        currentTarget: {
          getBoundingClientRect: () => ({ left: 8, top: 8, right: 36, bottom: 36 }),
        },
      });
      expect(popupAppMenu.mock.calls).toEqual([[8, 36]]);
    }
  });
});
