import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemeList, ThemeRead } from '@pantheon/protocol';
import { nodes, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const toasts = vi.hoisted(() => [] as { title: string; kind?: string; action?: { run(): void } }[]);
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: (typeof toasts)[number]) => {
    toasts.push(options);
    return `toast-${toasts.length}`;
  },
  closeNotice: () => {},
}));
import { ThemeBackdrop, useForcedScheme, useUserTheme } from '@/components/UserTheme';
import { useBoard } from '@/data/board';
import { DEFAULT_LOOK, setLook } from '@/data/layout';
import { failureText } from '@/data/needs-you';
import {
  applyUserTheme,
  FIRST_FRAME_KEY,
  forcedScheme,
  getUserThemes,
  loadThemes,
  setBackdropOn,
  setUserThemes,
  windowColours,
  windowDark,
} from '@/data/theme';

const tide: ThemeRead = {
  id: 'tide',
  label: '潮汐',
  css: ':root[data-user-theme="tide"].dark{--bg:rgb(15,28,36);}',
  backdrop: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
  glass: { blur: 12, tint: 'rgb(15,28,36)', opacity: 0.4 },
  modes: ['dark'],
};
const paper: ThemeRead = {
  id: 'paper',
  label: '纸',
  css: ':root[data-user-theme="paper"]:not(.dark){--bg:rgb(239,230,211);}',
  modes: ['light', 'dark'],
};
const list: ThemeList = {
  active_theme_id: 'tide',
  themes: [
    {
      id: 'tide',
      label: '潮汐',
      modes: ['dark'],
      has_backdrop: true,
      built_in: false,
      session_id: 'lead',
      created_at: 2,
      swatches: { surface0: 'rgb(1,1,1)', surface1: 'rgb(2,2,2)', accent: 'rgb(3,3,3)' },
    },
  ],
};

/** A page head and root as much as the theme code touches them. */
function fakeDocument() {
  const head: { id: string; textContent: string; remove(): void }[] = [];
  const root = { dataset: {} as Record<string, string | undefined> };
  const doc = {
    documentElement: root,
    head: { append: (el: (typeof head)[number]) => void head.push(el) },
    getElementById: (id: string) => head.find((el) => el.id === id) ?? null,
    createElement: () => {
      const el = { id: '', textContent: '', remove: () => void head.splice(head.indexOf(el), 1) };
      return el;
    },
    body: { dataset: {} as Record<string, string | undefined> },
  };
  return { doc, head, root };
}

let reduced = false;
const command = vi.fn(async (_c: { type: string; input: unknown }) => ({ ok: true, value: {} }));

beforeEach(() => {
  reduced = false;
  toasts.length = 0;
  command.mockClear();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  vi.stubGlobal('document', fakeDocument().doc);
  vi.stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }),
    pantheon: {
      query: async (method: string) =>
        method === 'theme.list' ? { ok: true, value: list } : { ok: true, value: tide },
      command,
    },
  });
});
afterEach(() => {
  unmountAll();
  setBackdropOn(true);
  setLook(DEFAULT_LOOK);
  setUserThemes({ list: null, active: null });
  useBoard.setState({ events: [], status: { state: 'connecting' } });
  vi.unstubAllGlobals();
});

describe('applying a saved theme', () => {
  it('puts its stylesheet in one style element and names it on the root, and takes both away for the default', () => {
    const { doc, head, root } = fakeDocument();
    applyUserTheme(paper, doc as never);
    applyUserTheme(tide, doc as never);
    expect(head.map((el) => [el.id, el.textContent])).toEqual([['pt-user-theme', tide.css]]);
    expect(root.dataset.userTheme).toBe('tide');
    applyUserTheme(null, doc as never);
    expect(head).toEqual([]);
    expect('userTheme' in root.dataset).toBe(false);
  });

  it('keeps a copy for the next first frame and takes over the style element the first frame made', () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    });
    applyUserTheme(tide, fakeDocument().doc as never);
    expect(JSON.parse(items.get(FIRST_FRAME_KEY)!)).toEqual({
      id: 'tide',
      css: tide.css,
      forced: 'dark',
    });
    applyUserTheme(null, fakeDocument().doc as never);
    expect(items.has(FIRST_FRAME_KEY)).toBe(false);
    const { doc, head } = fakeDocument();
    const early = doc.createElement();
    early.id = 'pt-user-theme';
    head.push(early);
    applyUserTheme(null, doc as never);
    expect(head).toEqual([]);
  });

  it('holds the window dark while a theme gives only a dark mode, and follows the choice otherwise', () => {
    expect(forcedScheme(tide)).toBe('dark');
    expect(windowDark('light', forcedScheme(tide))).toBe(true);
    expect(forcedScheme(paper)).toBeNull();
    expect(windowDark('light', forcedScheme(paper))).toBe(false);
    expect(windowDark('dark', forcedScheme(null))).toBe(true);
  });

  it("reads the top bar's and the window's colours off the root as #rrggbb in whatever notation the theme wrote", () => {
    const tokens: Record<string, string> = {
      '--sf': ' rgb(15, 28, 36)',
      '--tx': '#EDEDE9',
      '--bg': 'rgb(1,2,3)',
    };
    const root = {};
    vi.stubGlobal('getComputedStyle', (element: unknown) => ({
      getPropertyValue: (name: string) => (element === root ? (tokens[name] ?? '') : ''),
    }));
    // A canvas as far as drawing one pixel and reading it back.
    let pixel = [0, 0, 0];
    const context = {
      fillStyle: '',
      clearRect: () => void (pixel = [0, 0, 0]),
      fillRect() {
        const style = context.fillStyle.trim();
        pixel = style.startsWith('#')
          ? [1, 3, 5].map((at) => parseInt(style.slice(at, at + 2), 16))
          : style.match(/\d+/g)!.map(Number);
      },
      getImageData: () => ({ data: [...pixel, 255] }),
    };
    const doc = {
      documentElement: root,
      createElement: (tag: string) => (tag === 'canvas' ? { getContext: () => context } : null),
    };
    expect(windowColours(doc as never)).toEqual({
      color: '#0f1c24',
      symbolColor: '#edede9',
      background: '#010203',
    });
  });
});

describe('the backdrop', () => {
  const drawn = () => {
    setUserThemes({ list, active: tide });
    return nodes(mount(() => ThemeBackdrop()).value).filter((n) => typeof n.type === 'string');
  };

  it('draws the SVG as an image under the window, with the glass over it', () => {
    const [img, glass] = drawn();
    expect(img!.type).toBe('img');
    expect(img!.props.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(img!.props.alt).toBe('');
    expect(img!.props['aria-hidden']).toBe('true');
    expect(glass!.props.style.backdropFilter).toBe('blur(12px)');
    expect(document.body.dataset.backdrop).toBe('');
  });

  it('draws nothing once turned off, or while motion is reduced', () => {
    setBackdropOn(false);
    expect(drawn()).toEqual([]);
    expect(document.body.dataset.backdrop).toBeUndefined();
    setBackdropOn(true);
    reduced = true;
    expect(drawn()).toEqual([]);
    reduced = false;
    setLook({ motion: 'reduced' });
    expect(drawn()).toEqual([]);
  });

  it('draws while motion is off, though the system reduces it', () => {
    reduced = true;
    expect(drawn()).toEqual([]);
    setLook({ motion: 'full' });
    expect(drawn()).not.toEqual([]);
  });
});

describe('a theme a session applied', () => {
  const applied = (payload: object, sequence: number) =>
    useBoard.setState((s) => ({
      events: [
        ...s.events,
        {
          sequence,
          event_id: `e${sequence}`,
          kind: 'theme.applied',
          aggregate_id: 'app.theme',
          aggregate_revision: 1,
          project_id: '',
          causation_id: 'c',
          created_at: sequence,
          payload,
        },
      ],
    }));
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('offers to undo it, back to the theme before', async () => {
    mount(() => useUserTheme());
    applied({ theme_id: 'tide', previous_theme_id: 'paper', by_session_id: 'lead' }, 1);
    await settle();
    expect(toasts.map((t) => t.title)).toEqual(['已应用主题「潮汐」']);
    toasts[0]!.action!.run();
    await settle();
    expect(command.mock.calls.map(([c]) => [c.type, c.input])).toEqual([
      ['theme.apply', { theme_id: 'paper' }],
    ]);
  });

  it('says why undoing it failed', async () => {
    const error = { code: 'theme_not_found', message: 'No theme paper' };
    command.mockImplementationOnce(async () => ({ ok: false, error }) as never);
    mount(() => useUserTheme());
    applied({ theme_id: 'tide', previous_theme_id: 'paper', by_session_id: 'lead' }, 1);
    await settle();
    toasts[0]!.action!.run();
    await settle();
    expect(toasts.slice(1).map((t) => [t.title, t.kind])).toEqual([
      [failureText(error), 'failure'],
    ]);
  });

  it('says nothing when the user applied it', async () => {
    mount(() => useUserTheme());
    applied({ theme_id: 'tide', previous_theme_id: 'paper' }, 1);
    await settle();
    expect(getUserThemes().active?.id).toBe('tide');
    expect(toasts).toEqual([]);
  });
});

describe('reading the saved themes', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const refused = { ok: false, error: { code: 'command_timeout', message: 'theme.get timed out' } };
  // The style element and copy index.html made for the first frame, before the daemon answers.
  const firstFrame = () => {
    applyUserTheme(null, fakeDocument().doc as never);
    const { doc, head } = fakeDocument();
    const early = doc.createElement();
    early.id = 'pt-user-theme';
    head.push(early);
    vi.stubGlobal('document', doc);
    const removeItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem });
    return { head, removeItem };
  };
  const answer = (query: (method: string) => Promise<unknown>) =>
    ((window as unknown as { pantheon: { query: unknown } }).pantheon.query = query);

  it('keeps the first-frame theme until the first read lands', async () => {
    const { head, removeItem } = firstFrame();
    answer(() => new Promise(() => {}));
    mount(() => useUserTheme());
    await settle();
    expect(head.map((el) => el.id)).toEqual(['pt-user-theme']);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('keeps the first-frame theme when the applied one cannot be read', async () => {
    const { head, removeItem } = firstFrame();
    answer(async (method) => (method === 'theme.list' ? { ok: true, value: list } : refused));
    mount(() => useUserTheme());
    await settle();
    expect(head.map((el) => el.id)).toEqual(['pt-user-theme']);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('holds the window in the scheme of the first-frame theme until the first read lands', async () => {
    firstFrame();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) =>
        key === FIRST_FRAME_KEY
          ? JSON.stringify({ id: tide.id, css: tide.css, forced: 'dark' })
          : null,
      setItem() {},
      removeItem() {},
    });
    answer(() => new Promise(() => {}));
    const h = mount(() => useForcedScheme());
    await settle();
    expect(h.value).toBe('dark');
    setUserThemes({ list: { ...list, active_theme_id: null }, active: null });
    h.render();
    expect(h.value).toBeNull();
  });

  it('keeps the applied theme when reading it again fails', async () => {
    setUserThemes({ list, active: tide });
    answer(async (method) => (method === 'theme.list' ? { ok: true, value: list } : refused));
    await loadThemes();
    expect(getUserThemes().active).toEqual(tide);
  });

  it('reads them again once the connection is live again after a failed read', async () => {
    let lists = 0;
    answer(async (method) =>
      method !== 'theme.list'
        ? { ok: true, value: tide }
        : ++lists === 1
          ? refused
          : { ok: true, value: list },
    );
    useBoard.setState({ status: { state: 'offline', reason: 'daemon restarting' } });
    mount(() => useUserTheme());
    await settle();
    expect(getUserThemes().list).toBeNull();
    useBoard.setState({ status: { state: 'connecting' } });
    useBoard.setState({ status: { state: 'live' } });
    await settle();
    expect(getUserThemes()).toEqual({ list, active: tide });
  });
});
