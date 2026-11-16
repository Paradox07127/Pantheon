import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { ProjectSummary } from '@pantheon/protocol';
import { find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  shell: {} as any,
  summaries: [] as ProjectSummary[] | null,
}));
const store = vi.hoisted(
  () => (state: () => any) =>
    Object.assign((selector?: any) => (selector ? selector(state()) : state()), {
      getState: state,
      setState: (patch: object) => Object.assign(state(), patch),
    }),
);
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({ useShell: store(() => mock.shell) }));
vi.mock('@/data/projects-summary', async (actual) => ({
  ...(await actual<object>()),
  useProjectsSummary: () => ({
    data: mock.summaries,
    loading: mock.summaries === null,
    error: null,
    reload() {},
  }),
}));
import { Sidebar } from '@/components/Sidebar';
import { getLayout, SIDEBAR } from '@/data/layout';
import { useProjectsView } from '@/screens/projects/view';
import { zh } from './i18n-setup.js';

const summary = (project_id: string, needs_you: number, running: number): ProjectSummary => ({
  project_id,
  name: project_id,
  counts: { running, waiting: 0, ready: 0, failed: 0, queued: 0 },
  merged_today: 0,
  needs_you,
  milestone: null,
  done_daily: [],
  last_activity_at: null,
});

const css = readFileSync(
  new URL('../../apps/web/src/components/sidebar-projects.css', import.meta.url),
  'utf8',
);

const PROJECTS = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
  { id: 'gamma', name: 'Gamma' },
];

const screen = (id: string) => zh(`app.screenName.${id}`);
beforeEach(() => {
  mock.board = { board: null, status: { state: 'live' } };
  mock.shell = { screen: 'projects', sessionId: null, sessionGroup: null };
  mock.summaries = [summary('alpha', 0, 2), summary('beta', 3, 1), summary('gamma', 0, 0)];
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function mount(
  options: { collapsed?: boolean; choose?: (id: string) => void; current?: string } = {},
) {
  return host(() =>
    Sidebar({
      layout: {
        collapsed: options.collapsed ?? false,
        width: 248,
        resize: () => {},
        commit: () => {},
        reset: () => {},
        toggle: () => {},
      },
      projects: PROJECTS,
      currentProjectId: options.current ?? 'alpha',
      onChooseProject: options.choose ?? (() => {}),
      list: { data: [], loading: false, error: null, reload() {} } as any,
      allNeeds: { items: [], error: null } as any,
    }),
  );
}

const isFn = (n: ReactElement<any>, name: string) =>
  typeof n.type === 'function' && n.type.name === name;

/** Renders a function component found in the tree, one level down. */
function expand(node: ReactElement<any>) {
  return host(() => (node.type as (props: object) => any)(node.props)).value;
}

/** The open sidebar with its project list rendered in place. */
function openSidebar(choose?: (id: string) => void, current?: string) {
  const tree = mount({ choose, current }).value;
  const list = nodes(tree).find((n) => isFn(n, 'ProjectList'));
  return { tree, list: list ? expand(list) : null };
}

const projectRows = (list: ReactNode) =>
  nodes(list).filter((n) => n.type === 'button' && /\bsb-pr\b/.test(n.props.className ?? ''));

const PAGES = ['board', 'insights', 'trace', 'memory'].map(screen);

describe('sidebar on the all projects screen', () => {
  it('heads the sidebar with all projects as the current page and lists the projects', () => {
    const { tree, list } = openSidebar();
    const top = find(tree, (n) => isFn(n, 'ProjectMenu'));
    expect(top.props.current).toBe('page');
    expect(text(top.props.children)).toBe(screen('projects'));
    expect(
      nodes(list).some(
        (n) => n.props.className === 'sb-sh' && text(n) === zh('components.sidebar.projects'),
      ),
    ).toBe(true);
    expect(
      projectRows(list).map((row) => text(nodes(row).find((n) => n.props.className === 'sb-pn'))),
    ).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('shows no page navigation and no session list', () => {
    const { tree } = openSidebar();
    const labels = nodes(tree)
      .filter((n) => n.type === 'button')
      .map((n) => text(n.props.children));
    for (const page of PAGES) expect(labels).not.toContain(page);
    expect(nodes(tree).some((n) => n.props.className === 'ss-list')).toBe(false);
    expect(nodes(tree).some((n) => n.props.className === 'sb-sh')).toBe(false);
    expect(labels).toContain(screen('settings'));
  });

  it('counts what needs you first, else what runs, and nothing for a quiet project', () => {
    const { list } = openSidebar();
    const counts = Object.fromEntries(
      projectRows(list).map((row) => {
        const count = nodes(row).find((n) => n.props.className === 'sb-pc');
        return [
          text(nodes(row).find((n) => n.props.className === 'sb-pn')),
          count ? [count.props['aria-label'], text(count.props.children)] : null,
        ];
      }),
    );
    expect(counts).toEqual({
      Beta: ['3 件事等你', '3'],
      Alpha: ['2 个会话在跑', '2'],
      Gamma: null,
    });
  });

  it('marks an idle project in name and in words, but not a busy or the current one', () => {
    const idle = (current: string) =>
      Object.fromEntries(
        projectRows(openSidebar(undefined, current).list).map((row) => [
          text(nodes(row).find((n) => n.props.className === 'sb-pn')),
          [
            row.props['data-idle'] ?? false,
            nodes(row)
              .filter((n) => n.props.className === 'ss-vh')
              .map((n) => text(n.props.children)),
          ],
        ]),
      );
    // Alpha runs two sessions, Beta needs you, Gamma has nothing.
    expect(idle('beta')).toEqual({
      Beta: [false, []],
      Alpha: [false, []],
      Gamma: [true, [zh('components.sidebar.projectIdle')]],
    });
    expect(idle('gamma')).toMatchObject({ Gamma: [false, []] });
    mock.summaries = [
      {
        ...summary('alpha', 0, 0),
        counts: { running: 0, waiting: 1, ready: 0, failed: 0, queued: 0 },
      },
      {
        ...summary('beta', 0, 0),
        counts: { running: 0, waiting: 0, ready: 1, failed: 0, queued: 0 },
      },
      summary('gamma', 0, 0),
    ];
    expect(idle('beta')).toMatchObject({
      Alpha: [false, []],
      Gamma: [true, [zh('components.sidebar.projectIdle')]],
    });
    expect(css).toMatch(/\.sb-pr\[data-idle\] \.sb-pn \{\s*color: var\(--mu\);/);
  });

  it('holds one row per project, none named in a place the summary moves, until the summary lands', () => {
    mock.summaries = null;
    const { list } = openSidebar();
    const nav = find(list, (n) => n.type === 'nav');
    expect(nodes(nav).filter((n) => n.type === 'button')).toEqual([]);
    expect(nav.props.children.flat().filter(Boolean)).toHaveLength(PROJECTS.length);
    mock.summaries = [summary('alpha', 0, 2), summary('beta', 3, 1), summary('gamma', 0, 0)];
    const landed = find(openSidebar().list, (n) => n.type === 'nav');
    expect(nodes(landed).filter((n) => n.type === 'button')).toHaveLength(PROJECTS.length);
  });

  it('opens the project of a clicked row', () => {
    const chosen: string[] = [];
    const { list } = openSidebar((id) => chosen.push(id));
    projectRows(list)
      .find((row) => text(row.props.children).startsWith('Gamma'))!
      .props.onClick();
    expect(chosen).toEqual(['gamma']);
  });

  it('opens the open-project dialog from a named icon button', () => {
    const { list } = openSidebar();
    const button = find(
      list,
      (n) => n.type === 'button' && n.props['aria-label'] === zh('components.sidebar.openProject'),
    );
    useProjectsView.getState().setOpening(false);
    button.props.onClick();
    expect(useProjectsView.getState().opening).toBe(true);
    useProjectsView.getState().setOpening(false);
  });

  it('keeps only all projects and settings on the folded rail', () => {
    const labels = nodes(mount({ collapsed: true }).value)
      .filter((n) => n.type === 'button' && n.props.className === 'ib')
      .map((n) => n.props['aria-label']);
    expect(labels).toEqual([screen('projects'), screen('settings')]);
  });

  it('keeps the page navigation and drops the project list on a project page', () => {
    mock.shell.screen = 'board';
    const { tree, list } = openSidebar();
    expect(list).toBeNull();
    const labels = nodes(tree)
      .filter((n) => n.type === 'button')
      .map((n) => text(n.props.children));
    for (const page of PAGES) expect(labels).toContain(page);
    expect(find(tree, (n) => isFn(n, 'ProjectMenu')).props.current).toBeUndefined();
  });
});

describe('sidebar width', () => {
  it('starts 248 pixels wide', () => {
    expect(SIDEBAR.initial).toBe(248);
    expect(getLayout().sidebar.width).toBe(248);
  });
});
