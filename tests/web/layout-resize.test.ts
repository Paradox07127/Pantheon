import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BoardModel, WorkbenchSession } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import { type HookHost, mount, named, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any, projects: {} as any }));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      subscribe: () => () => {},
    }),
);
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({ useBoard: store(() => mock.board) }));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
vi.mock('@/screens/projects/view', () => ({ useProjectsView: store(() => mock.projects) }));
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: (selector: any) => selector({ items: {} }),
}));
import { Sidebar, useSidebarLayout } from '@/components/Sidebar';
import { Splitter, type SplitterProps } from '@/components/Splitter';
import {
  APPEARANCE_KEY,
  getLayout,
  LAYOUT_KEY,
  readAppearance,
  readLayout,
  resetLayout,
  saveLayout,
  setAppearance,
  setLayout,
} from '@/data/layout';
import { SessionsScreen } from '@/screens/sessions/SessionsScreen';

type Listener = (e: any) => void;
let stored: Map<string, string>;
let writes: string[];
let windowListeners: Map<string, Set<Listener>>;

function stubWindow(innerWidth: number) {
  vi.stubGlobal('window', {
    innerWidth,
    matchMedia: () => ({ matches: false }),
    pantheon: { query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener: (type: string, fn: Listener) =>
      windowListeners.set(type, (windowListeners.get(type) ?? new Set()).add(fn)),
    removeEventListener: (type: string, fn: Listener) => windowListeners.get(type)?.delete(fn),
  });
}
const fire = (type: string, event: object) =>
  [...(windowListeners.get(type) ?? [])].forEach((fn) => fn(event));

beforeEach(() => {
  stored = new Map();
  writes = [];
  windowListeners = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      stored.set(key, value);
    },
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.stubGlobal('document', {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('HTMLElement', class {});
  stubWindow(1400);
  resetLayout();
  setAppearance({ inspector: 'auto', density: 'standard' });
  writes = [];
  stored.clear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, preventDefault: vi.fn() });

function splitter(over: Partial<SplitterProps> = {}) {
  const props: SplitterProps = {
    label: '调整侧栏宽度',
    value: 280,
    min: 200,
    max: 420,
    edge: 'right',
    onSize: vi.fn(),
    onCommit: vi.fn(),
    onToggle: vi.fn(),
    onReset: vi.fn(),
    ...over,
  };
  const h = mount(() => Splitter(props));
  return { props, el: () => h.value as any, h };
}

describe('splitter', () => {
  it('is a focusable separator that names its pane and its range', () => {
    const { el } = splitter();
    expect(el().props).toMatchObject({
      role: 'separator',
      tabIndex: 0,
      'aria-label': '调整侧栏宽度',
      'aria-valuenow': 280,
      'aria-valuemin': 200,
      'aria-valuemax': 420,
    });
  });

  it('moves 8px per arrow and 32px with shift, stored at once', () => {
    const { el, props } = splitter();
    el().props.onKeyDown(key('ArrowRight'));
    el().props.onKeyDown(key('ArrowRight', true));
    el().props.onKeyDown(key('ArrowLeft'));
    el().props.onKeyDown(key('ArrowLeft', true));
    expect(vi.mocked(props.onSize).mock.calls.map(([w]) => w)).toEqual([288, 312, 272, 248]);
    expect(props.onCommit).toHaveBeenCalledTimes(4);
  });

  it('widens a pane on its left edge with the left arrow', () => {
    const { el, props } = splitter({ edge: 'left', value: 400, min: 320, max: 640 });
    el().props.onKeyDown(key('ArrowLeft'));
    el().props.onKeyDown(key('ArrowRight', true));
    expect(vi.mocked(props.onSize).mock.calls.map(([w]) => w)).toEqual([408, 368]);
  });

  it('keeps keyboard moves inside the range', () => {
    const wide = splitter({ value: 416 });
    wide.el().props.onKeyDown(key('ArrowRight', true));
    expect(wide.props.onSize).toHaveBeenCalledWith(420);
    const narrow = splitter({ value: 204 });
    narrow.el().props.onKeyDown(key('ArrowLeft'));
    expect(narrow.props.onSize).toHaveBeenCalledWith(200);
  });

  it('folds with Enter and resets on a double click', () => {
    const { el, props } = splitter();
    el().props.onKeyDown(key('Enter'));
    expect(props.onToggle).toHaveBeenCalledOnce();
    expect(props.onSize).not.toHaveBeenCalled();
    el().props.onDoubleClick();
    expect(props.onReset).toHaveBeenCalledOnce();
  });

  it('follows the pointer and stores only on release', () => {
    const { el, props, h } = splitter();
    el().props.onPointerDown({
      button: 0,
      clientX: 100,
      preventDefault() {},
      currentTarget: { focus() {} },
    });
    h.render();
    expect(el().props['data-dragging']).toBe(true);
    fire('pointermove', { clientX: 150 });
    fire('pointermove', { clientX: 60 });
    expect(vi.mocked(props.onSize).mock.calls.map(([w]) => w)).toEqual([330, 240]);
    expect(props.onCommit).not.toHaveBeenCalled();
    fire('pointerup', {});
    expect(props.onCommit).toHaveBeenCalledOnce();
    fire('pointermove', { clientX: 300 });
    expect(props.onSize).toHaveBeenCalledTimes(2);
  });

  it('takes the focus when pressed, so the arrow keys move it next', () => {
    const { el } = splitter();
    const focus = vi.fn();
    el().props.onPointerDown({
      button: 0,
      clientX: 100,
      preventDefault() {},
      currentTarget: { focus },
    });
    expect(focus).toHaveBeenCalledOnce();
  });
});

describe('stored layout', () => {
  it('reads the defaults for nothing stored and keeps widths in range', () => {
    expect(readLayout(null)).toEqual({
      sidebar: { collapsed: false, width: 248 },
      inspector: 400,
      drawer: 440,
      collapse_sidebar_at_start: false,
    });
    expect(readLayout('{not json').inspector).toBe(400);
    expect(
      readLayout(JSON.stringify({ sidebar: { width: 900 }, inspector: 100, drawer: 10 })),
    ).toEqual({
      sidebar: { collapsed: false, width: 420 },
      inspector: 320,
      drawer: 360,
      collapse_sidebar_at_start: false,
    });
  });

  it('keeps folding the sidebar at start through Reset layout, which puts the widths back', () => {
    setLayout({ collapse_sidebar_at_start: true, inspector: 500, drawer: 600 });
    saveLayout();
    resetLayout();
    expect(getLayout()).toMatchObject({
      inspector: 400,
      drawer: 440,
      collapse_sidebar_at_start: true,
    });
    expect(readLayout(stored.get(LAYOUT_KEY) ?? null).collapse_sidebar_at_start).toBe(true);
    setLayout({ collapse_sidebar_at_start: false });
  });
});

describe('sidebar width', () => {
  it('keeps the drag between 200 and 420 and stores it only on release', () => {
    const h = mount(() => useSidebarLayout());
    h.value.resize(220);
    h.value.resize(900);
    expect(getLayout().sidebar).toEqual({ collapsed: false, width: 420 });
    h.value.resize(150);
    expect(getLayout().sidebar).toEqual({ collapsed: false, width: 200 });
    expect(writes).toEqual([]);
    h.value.commit();
    expect(JSON.parse(stored.get(LAYOUT_KEY)!).sidebar).toEqual({ collapsed: false, width: 200 });
  });

  it('becomes the rail below 140 and comes back at its last width', () => {
    const h = mount(() => useSidebarLayout());
    h.value.resize(320);
    h.value.resize(139);
    expect(getLayout().sidebar).toEqual({ collapsed: true, width: 320 });
    h.render();
    h.value.toggle();
    expect(getLayout().sidebar).toEqual({ collapsed: false, width: 320 });
    h.value.reset();
    expect(getLayout().sidebar).toEqual({ collapsed: false, width: 248 });
  });

  // The sidebar drawn with this layout over an empty board.
  const sidebar = (layout: ReturnType<typeof useSidebarLayout>) => {
    mock.board = {
      board: { cursor: 0, projects: [], sessions: [], session_turns: [], workspaces: [] },
      events: [],
      status: { state: 'live' },
    };
    mock.shell = { screen: 'board', sessionId: null, theme: 'system', sessionGroup: null };
    mock.projects = { query: '', opening: false, setQuery() {}, setOpening() {} };
    return mount(() =>
      Sidebar({
        layout,
        projects: [],
        currentProjectId: null,
        onChooseProject() {},
        list: { data: [] } as any,
        allNeeds: { items: [] } as any,
      }),
    ).value;
  };

  it('puts a splitter on the sidebar and on the rail', () => {
    const fixed = (collapsed: boolean) =>
      sidebar({ collapsed, width: 300, resize() {}, commit() {}, reset() {}, toggle() {} });
    expect(named(fixed(false), 'Splitter').props).toMatchObject({
      label: zh('components.sidebar.resize'),
      value: 300,
      min: 200,
      max: 420,
      edge: 'right',
    });
    expect(named(fixed(true), 'Splitter').props).toMatchObject({
      label: zh('components.sidebar.resize'),
      value: 48,
      edge: 'right',
    });
  });

  it('brings the rail back at its last width when an arrow key widens it', () => {
    const layout = mount(() => useSidebarLayout());
    layout.value.resize(320);
    layout.value.resize(100);
    layout.render();
    expect(getLayout().sidebar).toEqual({ collapsed: true, width: 320 });
    const rail = named(sidebar(layout.value), 'Splitter');
    mount(() => Splitter(rail.props)).value.props.onKeyDown(key('ArrowRight'));
    expect(getLayout().sidebar).toEqual({ collapsed: false, width: 320 });
  });

  it('keeps the rail while a drag stays below 140 and opens it once the drag passes', () => {
    const layout = mount(() => useSidebarLayout());
    layout.value.resize(320);
    layout.value.resize(100);
    layout.render();
    const aside = sidebar(layout.value);
    const split = mount(() => Splitter(named(aside, 'Splitter').props)).value;
    const press = {
      button: 0,
      clientX: 100,
      target: { classList: { contains: (name: string) => name === 'split' } },
      preventDefault() {},
      currentTarget: { focus() {} },
    };
    aside.props.onPointerDownCapture?.(press);
    split.props.onPointerDown(press);
    fire('pointermove', { clientX: 120 });
    fire('pointermove', { clientX: 180 });
    expect(getLayout().sidebar).toEqual({ collapsed: true, width: 320 });
    fire('pointermove', { clientX: 200 });
    expect(getLayout().sidebar).toEqual({ collapsed: false, width: 320 });
    fire('pointerup', {});
  });
});

const listed = (id: string): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T08:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'fixture',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T08:00:00.000Z',
  changes: null,
  merge: null,
});

describe('inspector width', () => {
  const list = { data: [listed('session-a')], loading: false, error: null, reload() {} };
  const needs = { items: [], loading: false, error: null, reload() {} };
  beforeEach(() => {
    mock.board = {
      board: { sessions: [], session_turns: [], projects: [], workspaces: [] },
      events: [],
      status: { state: 'live' },
      cursor: 0,
      resync: 0,
    };
    mock.shell = {
      sessionId: 'session-a',
      sessionGroup: null,
      sessionTab: null,
      sessionOpened: 1,
      openSettings() {},
      openSession() {},
      followFirstSession() {},
      follow() {},
    };
  });
  const screen = () => mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  const opened = (panels = ['changes']) =>
    stored.set('pantheon.inspector.session-a', JSON.stringify({ panels }));
  // The dock also holds the session overview; only a dock showing the inspector is a panel column.
  const column = (h: HookHost<any>) =>
    nodes(h.value).find(
      (n) =>
        n.type === 'aside' &&
        nodes(n.props.children).some(
          (c) => typeof c.type === 'function' && c.type.name === 'SessionInspector',
        ),
    );
  const sheet = (h: HookHost<any>) =>
    nodes(h.value).find((n) => typeof n.props.onOpenChange === 'function');
  const grip = (h: HookHost<any>, tab: string) =>
    named(column(h), 'SessionInspector').props.grip(tab);

  it('has a splitter on each column, at least 280 and at most what leaves the thread 360', () => {
    const h = screen();
    expect(grip(h, 'changes').props).toMatchObject({
      label: '调整改动宽度',
      value: 340,
      min: 280,
      max: 1040,
      edge: 'left',
    });
    expect(h.value.props.style['--ss-pw']).toBe('340px');
    opened(['changes', 'plan']);
    const two = screen();
    expect(two.value.props.style['--ss-pw']).toBe('680px');
    expect(grip(two, 'plan').props.max).toBe(700);
    stubWindow(1100);
    opened();
    expect(grip(screen(), 'changes').props.max).toBe(740);
  });

  it('changes the width while dragging and stores the width of each panel kind on release', () => {
    const h = screen();
    grip(h, 'changes').props.onSize(1200);
    h.render();
    expect(grip(h, 'changes').props.value).toBe(1040);
    expect(writes).toEqual([]);
    grip(h, 'changes').props.onCommit();
    h.render();
    expect(JSON.parse(stored.get('pantheon.panel-widths')!)).toMatchObject({
      changes: 1040,
      plan: 340,
    });
    grip(h, 'changes').props.onSize(100);
    h.render();
    expect(grip(h, 'changes').props.value).toBe(280);
  });

  it('narrows a panel stored wider than the room beside the thread and keeps its stored width', () => {
    stubWindow(1000);
    stored.set('pantheon.panel-widths', JSON.stringify({ changes: 700 }));
    opened([]);
    const h = screen();
    expect(column(h)).toBeUndefined();
    named(h.value, 'Thread').props.onPanel('changes');
    h.render();
    expect(named(h.value, 'Thread').props.panels).toEqual(['changes']);
    expect(named(column(h), 'SessionInspector').props.widths.changes).toBe(640);
    expect(h.value.props.style['--ss-pw']).toBe('640px');
    expect(grip(h, 'changes').props).toMatchObject({ value: 640, max: 640 });
    expect(JSON.parse(stored.get('pantheon.panel-widths')!).changes).toBe(700);
  });

  it('puts the panel widths and the terminal height back on Reset layout', () => {
    vi.stubGlobal('window', { ...window, innerHeight: 900 });
    const h = screen();
    grip(h, 'changes').props.onSize(500);
    grip(h, 'changes').props.onCommit();
    named(h.value, 'Thread').props.terminal.onToggle();
    h.render();
    const terminalGrip = () =>
      nodes(h.value).find((n) => typeof n.type === 'function' && n.type.name === 'TerminalPanel')!
        .props.grip;
    terminalGrip().props.onSize(400);
    terminalGrip().props.onCommit();
    h.render();
    expect(grip(h, 'changes').props.value).toBe(500);
    expect(h.value.props.style['--ss-th']).toBe('400px');
    resetLayout();
    h.render();
    expect(grip(h, 'changes').props.value).toBe(340);
    expect(h.value.props.style['--ss-th']).toBe('240px');
    expect(stored.has('pantheon.panel-widths')).toBe(false);
    expect(stored.has('pantheon.terminal-height')).toBe(false);
  });

  it('follows the panel widths and the terminal height another window stores', async () => {
    vi.resetModules();
    const fresh = await import('@/data/layout');
    const before = fresh.useSizeChanges();
    fire('storage', { key: 'pantheon.panel-widths', newValue: JSON.stringify({ changes: 500 }) });
    const widths = fresh.useSizeChanges();
    expect(widths).not.toBe(before);
    fire('storage', { key: 'pantheon.terminal-height', newValue: '400' });
    expect(fresh.useSizeChanges()).not.toBe(widths);
  });

  it('folds the sidebar at start only, and follows the sidebar another window stores', async () => {
    const saved = (drawer: number) =>
      JSON.stringify({
        collapse_sidebar_at_start: true,
        sidebar: { collapsed: false, width: 280 },
        drawer,
      });
    stored.set(LAYOUT_KEY, saved(500));
    vi.resetModules();
    const fresh = await import('@/data/layout');
    expect(fresh.getLayout().sidebar.collapsed).toBe(true);
    fire('storage', { key: LAYOUT_KEY, newValue: saved(600) });
    expect(fresh.getLayout().drawer).toBe(600);
    expect(fresh.getLayout().sidebar.collapsed).toBe(false);
  });

  it('closes its column with Enter, as its close button does', () => {
    const h = screen();
    grip(h, 'changes').props.onToggle();
    h.render();
    expect(column(h)).toBeUndefined();
    expect(JSON.parse(stored.get('pantheon.inspector.session-a')!).panels).toEqual([]);
  });

  it('closes the earliest opened column that no longer fits, and becomes a sheet only when a default-width column leaves the thread less than 360', () => {
    stubWindow(1300);
    opened(['changes', 'checks', 'plan']);
    const h = screen();
    expect(named(column(h), 'SessionInspector').props.panels).toEqual(['checks', 'plan']);
    expect(sheet(h)).toBeUndefined();
    stubWindow(759);
    expect(sheet(screen())).toBeTruthy();
    expect(named(sheet(screen())!, 'SessionInspector').props.panels).toEqual(['plan']);
    stubWindow(760);
    expect(column(screen())).toBeTruthy();
  });

  it('keeps two default columns open beside a conversation of at least 360', () => {
    stubWindow(1100);
    opened(['changes', 'plan']);
    expect(named(column(screen()), 'SessionInspector').props.panels).toEqual(['changes', 'plan']);
    const css = readFileSync(
      fileURLToPath(new URL('../../apps/web/src/screens/sessions/panel.css', import.meta.url)),
      'utf8',
    );
    expect(css).toMatch(/\.ss:not\(\.ss-np\) > \.ss-convo \{\s*min-width: 360px;/);
  });

  it('opens by itself as the appearance setting says', () => {
    stubWindow(1200);
    expect(column(screen())).toBeUndefined();
    setAppearance({ inspector: 'always' });
    expect(column(screen())).toBeTruthy();
    stubWindow(1400);
    setAppearance({ inspector: 'never' });
    expect(column(screen())).toBeUndefined();
  });
});

describe('density', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../apps/web/src/index.css', import.meta.url)),
    'utf8',
  );

  it('stores the density with the other appearance choices', () => {
    setAppearance({ density: 'compact' });
    expect(readAppearance(stored.get(APPEARANCE_KEY)!)).toEqual({
      density: 'compact',
      inspector: 'auto',
      chat_font: 13,
      line_height: 'standard',
      reading_width: 760,
    });
    expect(readAppearance('{bad')).toEqual({
      density: 'standard',
      inspector: 'never',
      chat_font: 13,
      line_height: 'standard',
      reading_width: 760,
    });
  });

  it.each([
    [
      'lowers the control height and drops the panel margins in the compact density',
      [
        /^\.pt\[data-density=compact\]\{[^}]*--h-ctl:28px/m,
        /^\.pt\[data-density=compact\] \.sb-pz\{margin:0\}/m,
      ],
    ],
    [
      'keeps the pane border as the line and turns it the ink colour after 300ms',
      [
        /^\.split\{[^}]*width:6px/m,
        /^\.split::before\{[^}]*width:1px[^}]*background:transparent/m,
        /^\.split:hover::before\{background:var\(--ink\);transition-delay:var\(--dur-4\)\}/m,
        /^\.split\[data-dragging\]::before\{background:var\(--ink\)/m,
      ],
    ],
  ])('%s', (_name, rules) => {
    for (const rule of rules) expect(css).toMatch(rule);
  });
});

describe('text size and reading width', () => {
  const read = (value: object) => readAppearance(JSON.stringify(value));

  it('defaults to the 13px text size and a 760px reading width', () => {
    expect(read({})).toMatchObject({ chat_font: 13, reading_width: 760 });
    expect(readAppearance(null)).toMatchObject({ chat_font: 13, reading_width: 760 });
  });

  it.each([680, 760, 960, 'none'] as const)('keeps the %s reading width', (reading_width) => {
    expect(read({ reading_width }).reading_width).toBe(reading_width);
  });

  it('falls back to the defaults for unknown values', () => {
    for (const value of [
      { chat_font: 'huge', reading_width: 800 },
      { chat_font: 1, reading_width: '760' },
      { chat_font: null, reading_width: null },
    ])
      expect(read(value), JSON.stringify(value)).toMatchObject({
        chat_font: 13,
        reading_width: 760,
      });
  });

  it('stores both with the other appearance choices', () => {
    setAppearance({ chat_font: 16, reading_width: 'none' });
    expect(readAppearance(stored.get(APPEARANCE_KEY)!)).toMatchObject({
      chat_font: 16,
      reading_width: 'none',
    });
  });
});
