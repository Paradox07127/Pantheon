import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { HookHost, find, nodes, text } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
const shell = vi.hoisted(() => ({ openSession: vi.fn() }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/store', () => ({
  useShell: Object.assign((select: any) => select({}), { getState: () => shell }),
}));
import { ArtifactCard, ToolImages } from '@/screens/sessions/items';
import { BrowserPanel } from '@/screens/sessions/BrowserPanel';

const hosts: HookHost<any>[] = [];
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
  shell.openSession.mockClear();
});
const render = <T>(body: () => T, commit?: (value: T) => void) => {
  const h = new HookHost(body, commit);
  hosts.push(h);
  h.render();
  return h;
};
const button = (tree: ReactElement, label: string) =>
  find(tree, (n) => n.type === 'button' && text(n) === label);
const buttons = (tree: ReactElement) =>
  nodes(tree)
    .filter((n) => n.type === 'button')
    .map((n) => text(n));

const page = {
  url: 'https://claude.ai/artifact/page-a',
  path: '/work/tree/design/landing.html',
  title: 'Landing design',
  version: '3',
};
const card = (artifact: Parameters<typeof ArtifactCard>[0]['artifact'] = page) =>
  render(() => ArtifactCard({ artifact, folders: ['/work/tree'], sessionId: 'session-a' }));

/** A desktop bridge with the browser panel's page calls. */
function desktop(extra: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('document', { body: { children: [] } });
  const bridge = {
    browserOpen: vi.fn(async () => ({ ok: true, value: { id: 'view-a' } })),
    browserNavigate: vi.fn(async () => ({ ok: true, value: null })),
    browserSetBounds: vi.fn(async () => ({ ok: true, value: null })),
    browserClose: vi.fn(async () => ({ ok: true, value: null })),
    onBrowserState: vi.fn(() => () => {}),
    ...extra,
  };
  vi.stubGlobal('window', { pantheon: bridge, addEventListener() {}, removeEventListener() {} });
  return bridge;
}
const bounds = { x: 600, y: 80, width: 380, height: 500 };
const browser = (sessionId: string) =>
  render(
    () => BrowserPanel({ sessionId }),
    (tree) => {
      find(tree, (n) => n.props.ref !== undefined).props.ref.current = {
        getBoundingClientRect: () => ({ left: 600, top: 80, width: 380, height: 500 }),
      };
    },
  );

describe('artifact card', () => {
  it('names the published page by its title, version and host', () => {
    desktop();
    const h = card();
    const group = find(h.value, (n) => n.props.role === 'group');
    expect(group.props['aria-label']).toBe('Landing design');
    expect(text(group)).toContain(zhf('sessions.parts.artifactVersion', { version: '3' }));
    expect(text(group)).toContain('claude.ai');
    expect(text(group)).not.toContain('page-a');
  });

  it('opens the page in the browser panel, and takes the open panel to the next page', async () => {
    const bridge = desktop();
    button(card().value, zh('sessions.parts.artifactOpen')).props.onClick();
    expect(shell.openSession).toHaveBeenCalledWith('session-a', 'browser');
    const panel = browser('session-a');
    await panel.flush();
    expect(bridge.browserOpen).toHaveBeenCalledWith({ url: page.url, bounds });
    const next = { ...page, url: 'https://claude.ai/artifact/page-b' };
    button(card(next).value, zh('sessions.parts.artifactOpen')).props.onClick();
    panel.render();
    await panel.flush();
    expect(bridge.browserNavigate).toHaveBeenCalledWith({ id: 'view-a', url: next.url });
    expect(bridge.browserOpen).toHaveBeenCalledTimes(1);
  });

  it("leaves another session's browser panel where it is", async () => {
    const bridge = desktop();
    button(card().value, zh('sessions.parts.artifactOpen')).props.onClick();
    await browser('session-b').flush();
    expect(bridge.browserOpen).not.toHaveBeenCalled();
  });

  it('opens the local file in the editor while it is in the worktree', () => {
    const openFile = vi.fn(async () => ({ ok: true, value: null }));
    desktop({ openFile });
    button(card().value, zh('sessions.parts.artifactOpenInEditor')).props.onClick();
    expect(openFile).toHaveBeenCalledWith({ path: 'design/landing.html', base: '/work/tree' });
    expect(shell.openSession).not.toHaveBeenCalled();
    expect(buttons(card({ ...page, path: '/elsewhere/landing.html' }).value)).toEqual([
      zh('sessions.parts.artifactOpen'),
    ]);
  });

  it('offers no Open outside the desktop app, which has no browser panel', () => {
    vi.stubGlobal('window', {});
    expect(buttons(card().value)).toEqual([zh('sessions.parts.artifactOpenInEditor')]);
  });
});

describe('images a call returned', () => {
  it('reads a stored image by its hash for the session that returned it', async () => {
    const hash = 'ab'.repeat(32);
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const query = vi.fn(async () => ({ ok: true, value: { mime: 'image/png', data, size: 4 } }));
    vi.stubGlobal('window', { pantheon: { query } });
    const h = render(() =>
      ToolImages({
        images: [{ mime: 'image/png', hash, size: 4 }],
        files: [],
        base: '/work/tree',
        sessionId: 'session-a',
      }),
    );
    await h.flush();
    expect(query).toHaveBeenCalledWith('session.tool_image', { session_id: 'session-a', hash });
    const open = find(h.value, (n) => n.props['aria-label'] === zh('sessions.parts.openImage'));
    expect(find(open, (n) => n.type === 'img').props.src).toBe(`data:image/png;base64,${data}`);
  });
});
