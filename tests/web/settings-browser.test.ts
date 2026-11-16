import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { deferred, find, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { EditorPage } from '@/screens/settings/EditorPage';

async function mount(body: () => ReactNode) {
  const h = host(body);
  await h.flush();
  return h;
}
const titles = (tree: ReactNode) => nodes(tree).map((n) => n.props.title);
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('lists the installed browsers after the system default and saves the choice', async () => {
  const chooseBrowser = vi.fn(async () => ({ ok: true, value: null }));
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      listBrowsers: vi.fn(async () => ({
        ok: true,
        value: [
          { id: 'com.google.Chrome', name: 'Chrome', path: '/Applications/Google Chrome.app' },
          { id: 'company.thebrowser.Browser', name: 'Arc', path: '/Applications/Arc.app' },
        ],
      })),
      chooseBrowser,
    },
  });
  const page = await mount(() => EditorPage());
  expect(titles(page.value)).toContain(zh('settings.editor.browser'));
  const picker = named(page.value, 'BrowserPicker');
  const h = await mount(() => (picker.type as (props: unknown) => ReactNode)(picker.props));
  const select = () => named(h.value, 'Select');
  expect(select().props['aria-label']).toBe(zh('settings.editor.externalBrowser'));
  expect(select().props.options.map((o: { label: string }) => o.label)).toEqual([
    zh('settings.editor.systemBrowser'),
    'Chrome',
    'Arc',
  ]);
  select().props.onChange('company.thebrowser.Browser');
  await h.flush();
  expect(chooseBrowser).toHaveBeenLastCalledWith('company.thebrowser.Browser');
  expect(select().props.value).toBe('company.thebrowser.Browser');
  select().props.onChange(select().props.options[0].value);
  await h.flush();
  expect(chooseBrowser).toHaveBeenLastCalledWith(null);
});

it('shows the saved browser when the page opens', async () => {
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      listBrowsers: async () => ({ ok: true, value: [{ id: 'arc', name: 'Arc', path: '/A' }] }),
      chosenBrowser: vi.fn(async () => ({ ok: true, value: 'arc' })),
      chooseBrowser: vi.fn(),
    },
  });
  const page = await mount(() => EditorPage());
  const picker = named(page.value, 'BrowserPicker');
  const h = await mount(() => (picker.type as (props: unknown) => ReactNode)(picker.props));
  expect(named(h.value, 'Select').props.value).toBe('arc');
});

it('keeps a browser chosen before the saved one was read', async () => {
  const saved = deferred<{ ok: true; value: string | null }>();
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      listBrowsers: async () => ({
        ok: true,
        value: [
          { id: 'arc', name: 'Arc', path: '/A' },
          { id: 'chrome', name: 'Chrome', path: '/C' },
        ],
      }),
      chosenBrowser: () => saved.promise,
      chooseBrowser: vi.fn(async () => ({ ok: true, value: null })),
    },
  });
  const page = await mount(() => EditorPage());
  const picker = named(page.value, 'BrowserPicker');
  const h = await mount(() => (picker.type as (props: unknown) => ReactNode)(picker.props));
  named(h.value, 'Select').props.onChange('chrome');
  await h.flush();
  saved.resolve({ ok: true, value: 'arc' });
  await h.flush();
  expect(named(h.value, 'Select').props.value).toBe('chrome');
});

it('shows a failed choice under the select', async () => {
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    pantheon: {
      listBrowsers: async () => ({ ok: true, value: [{ id: 'arc', name: 'Arc', path: '/A' }] }),
      chooseBrowser: async () => ({
        ok: false,
        error: { code: 'browser_unavailable', message: 'not installed' },
      }),
    },
  });
  const page = await mount(() => EditorPage());
  const picker = named(page.value, 'BrowserPicker');
  const h = await mount(() => (picker.type as (props: unknown) => ReactNode)(picker.props));
  named(h.value, 'Select').props.onChange('arc');
  await h.flush();
  expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain('not installed');
});

it('draws no browser row outside the desktop app', async () => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  const page = await mount(() => EditorPage());
  expect(nodes(page.value).some((n) => (n.type as any)?.name === 'BrowserPicker')).toBe(false);
  expect(titles(page.value)).not.toContain(zh('settings.editor.browser'));
});
