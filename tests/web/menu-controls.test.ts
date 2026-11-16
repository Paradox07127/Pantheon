import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Menu as BaseMenu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import { Select as BaseSelect } from '../../apps/web/node_modules/@base-ui/react/select/index.mjs';
import { MenuCheckboxItem, MenuItem, MenuRadioGroup, MenuRadioItem } from '@/components/Menu';
import { Select } from '@/components/Select';

const inMenu = (...children: ReactNode[]) =>
  renderToStaticMarkup(createElement(BaseMenu.Root, { defaultOpen: true }, ...children));

const languages = [
  { value: 'system', label: 'Match system' },
  { value: 'zh-CN', label: 'Chinese' },
];

afterEach(() => vi.unstubAllGlobals());

describe('menu entries', () => {
  it('puts the icon in the leading slot and the keys in a key cap at the end', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    const html = inMenu(
      createElement(MenuItem, { icon: createElement('svg'), keys: 'Meta+\\' }, 'Open beside'),
    );
    expect(html).toMatch(
      /role="menuitem"[^>]*aria-keyshortcuts="Meta\+\\"[^>]*class="mn-row"><span class="mn-ic" aria-hidden="true"><svg[^>]*>.*<\/svg><\/span><span class="mn-tx">Open beside<\/span><span class="mn-ct" aria-hidden="true"><kbd class="kbd">⌘\\<\/kbd><\/span><\/div>$/,
    );
  });

  it('keeps the slot of an entry without an icon so the labels line up', () => {
    const html = inMenu(createElement(MenuItem, null, 'Pause'));
    expect(html).toMatch(
      /class="mn-row"><span class="mn-ic" aria-hidden="true"><\/span><span class="mn-tx">Pause<\/span><\/div>$/,
    );
    expect(html).not.toContain('aria-keyshortcuts');
  });

  it('writes the keys the way this platform writes them', () => {
    vi.stubGlobal('navigator', { userAgent: 'X11; Linux x86_64' });
    expect(inMenu(createElement(MenuItem, { keys: 'Meta+K' }, 'Open'))).toContain(
      '<kbd class="kbd">Ctrl+K</kbd>',
    );
  });

  it('draws a destructive entry in its own class', () => {
    expect(inMenu(createElement(MenuItem, { danger: true }, 'Discard'))).toContain(
      'class="mn-row mn-bad"',
    );
  });

  it('marks the chosen radio entry checked and the others not', () => {
    const html = inMenu(
      createElement(MenuRadioGroup, {
        value: 'zh-CN',
        onChange: () => {},
        children: languages.map((l) =>
          createElement(MenuRadioItem, { key: l.value, value: l.value, children: l.label }),
        ),
      }),
    );
    const checked = [
      ...html.matchAll(/role="menuitemradio"[^>]*aria-checked="(\w+)"[^>]*>.*?mn-tx">([^<]*)/g),
    ].map((m) => [m[2], m[1]]);
    expect(checked).toEqual([
      ['Match system', 'false'],
      ['Chinese', 'true'],
    ]);
  });

  it('marks a checkbox entry by whether it is on', () => {
    const html = inMenu(
      createElement(MenuCheckboxItem, {
        checked: true,
        onChange: () => {},
        children: 'Wrap lines',
      }),
    );
    expect(html).toMatch(/role="menuitemcheckbox"[^>]*aria-checked="true"/);
  });
});

describe('select', () => {
  const root = (onChange: (v: string) => void) =>
    Select({
      value: 'system',
      onChange,
      options: languages,
      'aria-label': 'Language',
    }) as ReactElement<{
      onValueChange: (v: string | null) => void;
    }>;

  it('hands the newly chosen value to its callback, and nothing for the current one', () => {
    const onChange = vi.fn();
    const select = root(onChange);
    expect(select.type).toBe(BaseSelect.Root);
    select.props.onValueChange('zh-CN');
    select.props.onValueChange('system');
    select.props.onValueChange(null);
    expect(onChange.mock.calls).toEqual([['zh-CN']]);
  });

  it('opens from a focusable 28px control that says it holds a list', () => {
    const html = renderToStaticMarkup(
      createElement(Select, {
        value: 'zh-CN',
        onChange: () => {},
        options: languages,
        'aria-label': 'Language',
      }),
    );
    const trigger = html.match(/<button[^>]*>/)![0];
    expect(trigger).toContain('role="combobox"');
    expect(trigger).toContain('aria-haspopup="listbox"');
    expect(trigger).toContain('aria-expanded="false"');
    expect(trigger).toContain('aria-label="Language"');
    expect(trigger).toContain('class="mn-sel"');
    expect(trigger).not.toContain('tabindex="-1"');
    expect(html).toContain('Chinese');
  });
});
