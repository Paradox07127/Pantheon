import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBoard } from '@/data/board';
import { t } from '@/i18n';
import { readDiffPrefs } from '@/data/diff-prefs';
import { EditorPage } from '@/screens/settings/EditorPage';
import { editorPickerAvailability } from '@/screens/settings/editors';
import { ProjectSettingsScreen } from '@/screens/settings/ProjectSettingsScreen';
import { useSettingsView } from '@/screens/settings/view';
import { zh } from './i18n-setup.js';

const editor = (id: string) => zh(`settings.editor.${id}`);

describe('editor picker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useBoard.setState({ board: null });
    useSettingsView.setState({ page: 'general' });
  });

  it('disables the editor picker without a bridge or installed editors', () => {
    const ready = {
      status: 'ready' as const,
      items: [{ id: 'zed', name: 'Zed' }],
      selected: 'zed',
    };
    const label = '编辑器';
    expect(editorPickerAvailability(ready, true, label).enabled).toBe(true);
    expect(editorPickerAvailability(ready, false, label).reason).toBe(
      zh('settings.common.bridgeUnavailable'),
    );
    expect(
      editorPickerAvailability({ status: 'ready', items: [], selected: null }, true, label).reason,
    ).toBe(t({ id: 'settings.editor.none', defaultMessage: '' }, { label }));
    expect(editorPickerAvailability({ status: 'loading' }, true, label).enabled).toBe(false);
    expect(editorPickerAvailability({ status: 'error', message: 'boom' }, true, label).reason).toBe(
      t({ id: 'settings.editor.readFailed', defaultMessage: '' }, { label, message: 'boom' }),
    );
  });

  it('opens from the app settings without any project', () => {
    vi.stubGlobal('window', {});
    useBoard.setState({ board: { cursor: 0, projects: [], sessions: [] } as never });
    useSettingsView.setState({ page: 'editor' });
    const html = renderToStaticMarkup(createElement(ProjectSettingsScreen));
    const app = new RegExp(
      `<div role="group" aria-label="${zh('settings.nav.general')}"(?:(?!</div>).)*</div>`,
    ).exec(html)?.[0];
    expect(app).toMatch(
      new RegExp(
        `<button type="button" class="ps-page" aria-current="page"><span class="ps-ico"><svg[^>]*>.*?</svg></span>${zh('settings.pages.openWith')}`,
      ),
    );
    expect(html).toContain(`<section class="ps-sec" aria-label="${editor('files')}">`);
    expect(html).toContain('class="tk-editor"');
    expect(html).toContain(`aria-label="${editor('externalTerminal')}"`);
  });

  it('groups the page into files, terminal and changes, one setting a row', () => {
    vi.stubGlobal('window', {});
    const html = renderToStaticMarkup(createElement(EditorPage));
    expect(
      [...html.matchAll(/<section class="ps-sec" aria-label="([^"]+)">/g)].map((m) => m[1]),
    ).toEqual([editor('files'), editor('terminal'), editor('changes')]);
    expect([...html.matchAll(/<span class="ps-row-nm">([^<]+)/g)].map((m) => m[1])).toEqual([
      editor('openWith'),
      editor('externalTerminal'),
      editor('viewWith'),
    ]);
    expect(html).toContain(`aria-label="${editor('openFilesWith')}"`);
    expect(html).toContain(`aria-label="${editor('changesViewer')}"`);
    expect(html).toContain(editor('inAppDiff'));
    expect(html).toContain(editor('editor'));
  });

  it('keeps the choice of how changes open', () => {
    expect(readDiffPrefs(null).changes_viewer).toBe('app');
    expect(readDiffPrefs('{"changes_viewer":"editor"}').changes_viewer).toBe('editor');
  });
});
