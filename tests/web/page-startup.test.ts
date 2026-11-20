import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { HookHost, nodes } from './web-hook-host.js';

const mock = vi.hoisted(() => ({ rendered: [] as unknown[] }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: (tree: unknown) => mock.rendered.push(tree) }),
}));
vi.mock('@/i18n', async (actual) => ({
  ...(await actual<object>()),
  startLocale: async () => {},
}));
vi.mock('@/App', () => ({ App: () => null }));
vi.mock('@/lib/menu-actions', () => ({ MenuActions: () => null }));
vi.mock('@/shell/CrashNotice', () => ({ CrashNotice: () => null }));
vi.mock('@/shell/QuitDialog', () => ({ QuitDialog: () => null }));
vi.mock('@/shell/TrayPopover', () => ({ TrayPopover: () => null }));
vi.mock('@/shell/RecoverScreen', () => ({
  RecoverBoundary: ({ children }: { children: unknown }) => children,
  ConnectionGate: ({ children }: { children: unknown }) => children,
}));

const themes: string[] = [];
let readies = 0;
const bridge = {
  windowContext: () => ({ kind: 'main' }),
  setThemeSource: (theme: string) => themes.push(theme),
  ready: () => readies++,
  systemAccent: async () => null,
  onSystemAccent: () => () => {},
};
const fontLoads: string[] = [];
let fontsAsked!: () => void;
const asked = new Promise<void>((done) => (fontsAsked = done));
const frames: (() => void)[] = [];
let loading: Promise<unknown>;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('window', {
    pantheon: bridge,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('document', {
    documentElement: { classList: { add() {}, toggle() {} } },
    body: { dataset: {} },
    getElementById: () => ({}),
    // The fonts never load here, so the page waits as long as it ever does.
    fonts: {
      load: (font: string) => {
        fontLoads.push(font);
        if (fontLoads.length === 2) fontsAsked();
        return new Promise(() => {});
      },
    },
  });
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => frames.push(run));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  loading = import('@/main');
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the page start', () => {
  it('waits up to 300ms for the interface and code fonts before the first render', async () => {
    await Promise.race([asked, loading]);
    expect(fontLoads).toEqual(['13px "Geist Variable"', '13px "Geist Mono Variable"']);
    await vi.advanceTimersByTimeAsync(299);
    expect(mock.rendered).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await loading;
    expect(mock.rendered).toHaveLength(1);
  });

  it('tells the desktop shell its first content is on screen once a frame of it is painted', async () => {
    const tree = mock.rendered[0] as ReactElement;
    const shown = nodes(tree).filter(
      (n) => typeof n.type === 'function' && n.type.name === 'FirstContent',
    );
    expect(shown).toHaveLength(1);
    new HookHost(() => (shown[0]!.type as (props: object) => unknown)(shown[0]!.props)).render();
    expect(readies).toBe(0);
    frames.splice(0).forEach((run) => run());
    expect(readies).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(readies).toBe(1);
  });

  it('defines no component in the entry, so a hot update reloads the page instead of mounting a second root', () => {
    // React Refresh makes a file that defines a component accept hot updates, and running this one again calls createRoot again.
    const entry = readFileSync(new URL('../../apps/web/src/main.tsx', import.meta.url), 'utf8');
    expect(entry).not.toMatch(/^(?:export )?(?:function|const|let|class) [A-Z]/m);
  });

  it('hands the desktop shell the theme at start and each time it changes', async () => {
    const { useShell } = await import('@/store');
    expect(themes).toEqual(['system']);
    useShell.getState().setTheme('dark');
    useShell.getState().setTheme('dark');
    useShell.getState().setTheme('light');
    expect(themes).toEqual(['system', 'dark', 'light']);
  });
});
