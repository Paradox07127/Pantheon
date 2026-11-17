import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserStyleRead } from '@pantheon/protocol';
import { mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useUserStyleSheet } from '@/components/UserTheme';
import { useBoard } from '@/data/board';
import { applyUserStyle, setUserStyle, USER_STYLE_KEY } from '@/data/user-style';

interface FakeElement {
  tag: string;
  id: string;
  textContent: string;
  innerHTML: string;
  remove(): void;
}

/** A page head as much as the stylesheet code touches it; innerHTML parses the way a page would. */
function fakeDocument() {
  const head: FakeElement[] = [];
  const element = (tag: string): FakeElement => {
    const el: FakeElement = {
      tag,
      id: '',
      textContent: '',
      remove: () => {
        if (head.includes(el)) head.splice(head.indexOf(el), 1);
      },
      set innerHTML(html: string) {
        // The parser ends a style element at its first end tag and makes elements of what follows.
        const end = html.indexOf('</style>');
        el.textContent = end < 0 ? html : html.slice(0, end);
        if (end >= 0) head.push({ ...element('script'), textContent: html.slice(end + 8) });
      },
      get innerHTML() {
        return el.textContent;
      },
    };
    return el;
  };
  const doc = {
    head: {
      append: (el: FakeElement) => {
        el.remove();
        head.push(el);
      },
      get lastElementChild() {
        return head.at(-1) ?? null;
      },
    },
    getElementById: (id: string) => head.find((el) => el.id === id) ?? null,
    createElement: element,
  };
  return { doc, head, element };
}

const shown = (head: FakeElement[]) => head.map((el) => [el.tag, el.id, el.textContent]);

let read: UserStyleRead;
let observed: (() => void)[];

beforeEach(() => {
  read = { css: '.sb{opacity:0.9}', enabled: true, rules: 1, revision: 1 };
  observed = [];
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', {
    pantheon: { query: vi.fn(async () => ({ ok: true, value: read })) },
  });
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(private callback: () => void) {}
      observe() {
        observed.push(this.callback);
      }
      disconnect() {
        observed = observed.filter((callback) => callback !== this.callback);
      }
    },
  );
});
afterEach(() => {
  unmountAll();
  setUserStyle(null);
  useBoard.setState({ events: [], status: { state: 'connecting' } });
  vi.unstubAllGlobals();
});

describe('the user stylesheet on the page', () => {
  it.each([
    { name: 'plain rules', css: '.sb{opacity:0.9}' },
    { name: 'an end tag and a script', css: '.sb{}</style><script>alert(1)</script>' },
  ])('puts $name in one style element last in the head, as its text', ({ css }) => {
    const { doc, head, element } = fakeDocument();
    head.push({ ...element('link'), id: 'app-css' });
    applyUserStyle(css, doc as never);
    applyUserStyle(css, doc as never);
    expect(shown(head)).toEqual([
      ['link', 'app-css', ''],
      ['style', 'pt-user-style', css],
    ]);
  });

  it('takes the style element away for empty CSS', () => {
    const { doc, head } = fakeDocument();
    applyUserStyle('.sb{}', doc as never);
    applyUserStyle('', doc as never);
    expect(head).toEqual([]);
  });

  it('keeps a copy for the next first frame, and drops it with the stylesheet', () => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    });
    applyUserStyle('.sb{}', fakeDocument().doc as never);
    expect(items.get(USER_STYLE_KEY)).toBe('.sb{}');
    applyUserStyle('', fakeDocument().doc as never);
    expect(items.has(USER_STYLE_KEY)).toBe(false);
  });
});

describe('the window following the user stylesheet', () => {
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const changed = (sequence: number) =>
    useBoard.setState((s) => ({
      events: [
        ...s.events,
        {
          sequence,
          event_id: `e${sequence}`,
          kind: 'style.changed',
          aggregate_id: 'app.style',
          aggregate_revision: read.revision,
          project_id: '',
          causation_id: 'c',
          created_at: sequence,
          payload: { revision: read.revision, enabled: read.enabled, rules: read.rules },
        },
      ],
    }));
  const started = async () => {
    const page = fakeDocument();
    vi.stubGlobal('document', page.doc);
    const h = mount(() => useUserStyleSheet());
    await settle();
    h.render();
    return { ...page, h };
  };

  it('reads the stylesheet at start and again on each style.changed event', async () => {
    const { head, h } = await started();
    expect(shown(head)).toEqual([['style', 'pt-user-style', '.sb{opacity:0.9}']]);
    read = { css: '.sb{opacity:0.5}', enabled: true, rules: 1, revision: 2 };
    changed(1);
    await settle();
    h.render();
    expect(window.pantheon!.query).toHaveBeenCalledTimes(2);
    expect(shown(head)).toEqual([['style', 'pt-user-style', '.sb{opacity:0.5}']]);
  });

  it.each([
    { name: 'turned off', next: { css: '.sb{}', enabled: false, rules: 1, revision: 2 } },
    { name: 'cleared', next: { css: '', enabled: true, rules: 0, revision: 2 } },
  ])('takes the style element away once the stylesheet is $name', async ({ next }) => {
    const { head, h } = await started();
    read = next;
    changed(1);
    await settle();
    h.render();
    expect(head).toEqual([]);
  });

  it('moves the style element last again when a stylesheet is added after it', async () => {
    const { doc, head, element, h } = await started();
    doc.head.append({ ...element('link'), id: 'lazy-css' });
    observed.forEach((callback) => callback());
    expect(shown(head).map(([, id]) => id)).toEqual(['lazy-css', 'pt-user-style']);
    h.unmount();
    expect(observed).toEqual([]);
  });
});

describe('the first frame', () => {
  const html = readFileSync(path.resolve(import.meta.dirname, '../../apps/web/index.html'), 'utf8');
  const body = html.slice(html.indexOf('<body'));
  const script = /<script>([\s\S]*?)<\/script>/.exec(body)![1]!;

  it('paints the cached stylesheet after every stylesheet in the head', () => {
    const { doc, head, element } = fakeDocument();
    head.push({ ...element('link'), id: 'app-css' });
    runInNewContext(script, {
      localStorage: { getItem: (key: string) => (key === USER_STYLE_KEY ? '.sb{}' : null) },
      document: doc,
    });
    expect(shown(head)).toEqual([
      ['link', 'app-css', ''],
      ['style', 'pt-user-style', '.sb{}'],
    ]);
  });

  it('adds nothing without a cached stylesheet or with storage off', () => {
    const { doc, head } = fakeDocument();
    for (const getItem of [
      () => null,
      () => {
        throw new Error('storage is off');
      },
    ])
      runInNewContext(script, { localStorage: { getItem }, document: doc });
    expect(head).toEqual([]);
  });
});
