import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchSession } from '@pantheon/protocol';
import { matchProjects, Sidebar } from '@/components/Sidebar';
import { WindowControls } from '@/components/WindowControls';
import type { useBoard } from '@/data/board';
import type { NeedsYouItem, NeedsYouState } from '@/data/needs-you';
import { zh } from './i18n-setup.js';

const screen = (key: string) => zh(`app.screenName.${key}`);
const side = (key: string) => zh(`components.sidebar.${key}`);

// Server rendering reads a store's initial state, so the connection state comes from here.
const connection = vi.hoisted(() => ({
  status: { state: 'connecting' } as ReturnType<(typeof useBoard)['getState']>['status'],
}));
vi.mock('@/data/board', async (actual) => {
  const real = await actual<typeof import('@/data/board')>();
  return {
    ...real,
    useBoard: Object.assign(
      (selector: (state: unknown) => unknown) =>
        selector({ ...real.useBoard.getState(), status: connection.status }),
      real.useBoard,
    ),
  };
});
// With no stored project the shell starts on all projects; these render a project page.
vi.mock('@/store', async (actual) => {
  const real = await actual<typeof import('@/store')>();
  return {
    ...real,
    useShell: Object.assign(
      (selector: (state: unknown) => unknown) =>
        selector({ ...real.useShell.getState(), screen: 'board' }),
      real.useShell,
    ),
  };
});

const session = (id: string, state: WorkbenchSession['state']): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting: state === 'waiting' ? 1 : 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
});

const item = (project_id: string, id: string): NeedsYouItem => ({
  source: { table: 'sessions', id, revision: 1 },
  kind: 'session.failed',
  project_id,
  status: 'failed',
  created_at: 1,
  reason: 'session_failed',
  actions: [],
});

const needsOf = (items: NeedsYouItem[]): NeedsYouState => ({
  items,
  loading: false,
  error: null,
  reload() {},
});

beforeAll(() => vi.stubGlobal('navigator', { userAgent: 'Macintosh' }));
afterAll(() => vi.unstubAllGlobals());

const PROJECTS = [
  { id: 'project-a', name: 'Alpha' },
  { id: 'project-b', name: 'Beta' },
];

const render = (
  options: {
    current?: string | null;
    sessions?: WorkbenchSession[];
    collapsed?: boolean;
    all?: NeedsYouItem[];
  } = {},
) =>
  renderToStaticMarkup(
    createElement(Sidebar, {
      layout: {
        collapsed: options.collapsed ?? false,
        width: 280,
        resize() {},
        commit() {},
        reset() {},
        toggle() {},
      },
      projects: PROJECTS,
      currentProjectId: options.current === undefined ? 'project-a' : options.current,
      onChooseProject() {},
      list: {
        data: options.sessions ?? [],
        loading: false,
        error: null,
        reload() {},
      },
      allNeeds: needsOf(options.all ?? []),
    }),
  );

/** The markup inside the section labelled `label`, nested sections included. */
function section(html: string, label: string): string {
  const open = new RegExp(`<section[^>]*aria-label="${label}"[^>]*>`).exec(html);
  if (!open) throw new Error(`no section labelled ${label}`);
  const start = open.index + open[0].length;
  const tags = /<section\b|<\/section>/g;
  tags.lastIndex = start;
  let depth = 1;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0] === '</section>' ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.index);
  }
  throw new Error(`section ${label} is not closed`);
}

describe('sidebar zones', () => {
  it('keeps the project entries and the session list inside the current project', () => {
    const html = render({ sessions: [session('a', 'running')] });
    const project = section(html, side('currentProject'));
    for (const entry of ['board', 'trace', 'memory'].map(screen)) expect(project).toContain(entry);
    expect(project).toContain(`<nav class="ss-list" aria-label="${screen('sessions')}"`);
    expect(project).toContain('title of a');
    expect(project).not.toContain(screen('settings'));
    expect(html).toContain(screen('settings'));
  });

  it('puts the engineering board right after the project board, open and folded', () => {
    const project = section(render(), side('currentProject'));
    expect(project).toMatch(
      /项目看板<\/button><button type="button" class="sb-it"><svg[^>]*lucide-chart-line[^>]*>.*?<\/svg>工程看板<\/button>/,
    );
    const rail = render({ collapsed: true });
    const at = (label: string) => rail.indexOf(`aria-label="${label}"`);
    expect(at(screen('board'))).toBeLessThan(at(screen('insights')));
    expect(at(screen('insights'))).toBeLessThan(at(screen('trace')));
  });

  it('leaves the theme and all projects out of the open sidebar', () => {
    const html = render({ all: [item('project-a', 's1')] });
    expect(html).not.toContain('aria-label="主题"');
    expect(html).not.toContain(screen('projects'));
  });

  it('draws the project row as its mark, name and chevron, with no state counts under it', () => {
    const html = render({
      sessions: [session('a', 'running'), session('c', 'waiting'), session('d', 'ready')],
    });
    const project = section(html, side('currentProject'));
    expect(project).toMatch(
      /^<button[^>]*aria-label="切换项目" class="sb-pj"><span class="pmono"[^>]*>A<\/span><span class="clip-1 sb-pj-nm"[^>]*>Alpha<\/span><svg[^>]*lucide-chevron-down[^>]*>/,
    );
    for (const label of ['运行 1', '待处理 1', '待合并 1', '失败 0'])
      expect(project).not.toContain(`aria-label="${label}"`);
    const css = readFileSync(new URL('../../apps/web/src/index.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.sb-cnts?\b/);
  });

  it('leaves archived sessions out of the needs-you count', () => {
    const html = render({
      sessions: [
        session('a', 'failed'),
        { ...session('b', 'failed'), archived_at: '2026-01-02T00:00:00.000Z' },
        { ...session('c', 'waiting'), archived_at: '2026-01-02T00:00:00.000Z' },
      ],
    });
    expect(html).toContain('aria-label="只看等你的 1 个会话">1</button>');
  });

  it('leaves out the project entries without a current project', () => {
    const html = render({ current: null });
    const project = section(html, side('currentProject'));
    expect(project).toContain(side('chooseProject'));
    for (const entry of ['board', 'flow', 'trace'].map(screen))
      expect(project).not.toContain(entry);
    expect(html).toContain(screen('settings'));
  });

  it('shows a labelled icon rail when folded', () => {
    const html = render({ collapsed: true });
    expect(html).toContain(`<aside class="sb sb-rail" aria-label="${side('navigation')}"`);
    for (const label of [
      screen('board'),
      screen('trace'),
      screen('memory'),
      side('newSession'),
      screen('projects'),
      screen('settings'),
      side('connectionConnecting'),
    ])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain(side('switchProject'));
  });
});

describe('sidebar bottom and title row', () => {
  afterEach(() => {
    connection.status = { state: 'connecting' };
  });

  it('ends the open sidebar with a settings row and leaves search to the title bar', () => {
    const html = render();
    expect(html).toMatch(
      /<div class="sb-gz"><button type="button" class="sb-it"><svg[^>]*lucide-settings[^>]*>.*?<\/svg>设置<\/button>/,
    );
    expect(html).not.toContain('aria-keyshortcuts="Meta+K"');
  });

  it('keeps one settings gear and no search at the bottom of the rail', () => {
    const html = render({ collapsed: true });
    expect(html.split(`aria-label="${screen('settings')}"`)).toHaveLength(2);
    expect(html).not.toContain('aria-keyshortcuts="Meta+K"');
    expect(html.replace(/<[^>]*>/g, '')).not.toContain(screen('settings'));
    expect(html).toMatch(/<div class="sb-rail-end">.*aria-label="设置"/);
  });

  it('shows the connection only while it is not live', () => {
    for (const collapsed of [false, true]) {
      connection.status = { state: 'live' };
      expect(render({ collapsed })).not.toContain('sb-conn');
      connection.status = { state: 'offline', reason: 'gone' };
      expect(render({ collapsed })).toContain('class="sb-conn"');
    }
  });

  it('puts all projects above settings at the bottom of the rail', () => {
    expect(render({ collapsed: true })).toMatch(
      /<div class="sb-rail-end">.*aria-label="全部项目".*aria-label="设置"/,
    );
  });

  it('leaves page navigation out of the title row', () => {
    const html = renderToStaticMarkup(
      createElement(WindowControls, { collapsed: true, onToggle() {}, onSearch() {} }),
    );
    expect(html).not.toContain(screen('projects'));
  });

  it('draws no peek panel until a rail icon is hovered', () => {
    expect(render({ collapsed: true })).not.toContain('sb-peek');
  });
});

describe('session list title row', () => {
  const waiting = [
    session('a', 'waiting'),
    session('b', 'failed'),
    session('c', 'running'),
    { ...session('d', 'waiting'), archived_at: '2026-01-02T00:00:00.000Z' },
  ];

  it('counts the sessions that need you in a chip before the group, sort and filter menu, and puts new session on the sessions title', () => {
    const html = render({ sessions: waiting });
    expect(html).toMatch(
      /<div class="sb-sh"><span>智能体<\/span><button type="button" class="sb-wait" aria-pressed="false" aria-label="只看等你的 2 个会话">2<\/button><button[^>]*aria-label="分组、排序与筛选"[^>]*>.*?<\/button><\/div>/,
    );
    expect(html).toMatch(
      /<div class="ss-zh"><span>会话<\/span><button[^>]*aria-label="新会话"[^>]*><svg[^>]*>.*?<\/svg><span class="kbd hk" aria-hidden="true">⌘N<\/span><\/button><\/div>/,
    );
  });

  it('shows no chip while nothing needs you', () => {
    expect(render({ sessions: [session('c', 'running')] })).not.toContain('sb-wait');
  });

  it('has no inbox: no inbox group, kind filter or rail button', () => {
    for (const collapsed of [false, true]) {
      const html = render({ sessions: waiting, collapsed });
      for (const gone of ['收件箱', '类型', '审批', '验收']) expect(html).not.toContain(gone);
    }
  });
});

describe('project menu search', () => {
  it('keeps the projects whose name holds the query, ignoring case and spaces around it', () => {
    expect(matchProjects(PROJECTS, '').map((p) => p.id)).toEqual(['project-a', 'project-b']);
    expect(matchProjects(PROJECTS, ' be ').map((p) => p.id)).toEqual(['project-b']);
    expect(matchProjects(PROJECTS, 'ALP').map((p) => p.id)).toEqual(['project-a']);
    expect(matchProjects(PROJECTS, 'zeta')).toEqual([]);
  });
});
