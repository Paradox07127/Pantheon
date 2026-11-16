import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, mount as host, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
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
import { Sidebar } from '@/components/Sidebar';
import { WindowControls } from '@/components/WindowControls';
import { SessionRowButton } from '@/screens/sessions/SessionRow';
import { zh } from './i18n-setup.js';

const session = (
  id: string,
  state: WorkbenchSession['state'],
  extra: Partial<WorkbenchSession> = {},
): WorkbenchSession => ({
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
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

const screen = (id: string) => zh(`app.screenName.${id}`);
const allLabel = screen('projects');
beforeEach(() => {
  mock.board = { board: null, status: { state: 'live' } };
  mock.shell = { screen: 'board', sessionId: null, sessionGroup: null, openSession: vi.fn() };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function mount(list: WorkbenchSession[], collapsed = false, attention: number | null = 0) {
  return host(() =>
    Sidebar({
      layout: {
        collapsed,
        width: 264,
        resize: () => {},
        commit: () => {},
        reset: () => {},
        toggle: () => {},
      },
      projects: [{ id: 'alpha', name: 'Alpha' }],
      currentProjectId: 'alpha',
      onChooseProject: () => {},
      list: { data: list, loading: false, error: null, reload() {} } as any,
      allNeeds: (attention === null
        ? { items: null, error: 'read failed' }
        : { items: Array.from({ length: attention }, () => ({})), error: null }) as any,
    }),
  );
}

/** Renders a function component found in the tree, one level down. */
function expand(node: ReactElement<any>) {
  return host(() => (node.type as (props: object) => any)(node.props)).value;
}

const isFn = (n: ReactElement<any>, name: string) =>
  typeof n.type === 'function' && n.type.name === name;

/** The sidebar's parts, top to bottom. */
function parts(h: HookHost<any>): string[] {
  const out: string[] = [];
  for (const n of nodes(h.value)) {
    const name = n.props.className;
    if (isFn(n, 'ProjectMenu')) out.push('project');
    else if (n.type === 'button' && name === 'sb-it')
      out.push(text(n.props.children) === screen('settings') ? 'settings' : 'nav');
    else if (name === 'sb-sh') out.push('sessions');
    else if (n.type === 'nav' && name === 'ss-list') out.push('list');
  }
  return out.filter((part, i) => part !== out[i - 1]);
}

const LIST = [
  session('waiting', 'waiting', { waiting: 1 }),
  session('running', 'running'),
  session('ready', 'ready'),
];

const rows = (h: HookHost<any>) =>
  nodes(h.value)
    .filter((n) => isFn(n, 'SessionListRow'))
    .map((n) => n.props.session.id);
const waitButton = (h: HookHost<any>) =>
  nodes(h.value).find((n) => n.type === 'button' && n.props.className === 'sb-wait');

describe('sidebar layout', () => {
  it('runs project row, page rows, sessions title, session list, then settings', () => {
    expect(parts(mount(LIST))).toEqual(['project', 'nav', 'sessions', 'list', 'settings']);
  });

  it('keeps every page row', () => {
    const pages = nodes(mount(LIST).value)
      .filter((n) => n.type === 'button' && n.props.className === 'sb-it')
      .map((n) => text(n.props.children));
    expect(pages).toEqual(['board', 'insights', 'repo', 'trace', 'memory', 'settings'].map(screen));
  });

  it('draws the project row as the mark, the name and a chevron, with no counts under it', () => {
    const h = mount(LIST);
    const project = find(h.value, (n) => isFn(n, 'ProjectMenu'));
    expect(project.props.className).toBe('sb-pj');
    expect(text(project.props.children)).toBe('Alpha');
    expect(nodes(h.value).some((n) => /\bsb-cnts?\b/.test(n.props.className ?? ''))).toBe(false);
  });

  it('ends the project menu with all projects', () => {
    const menu = expand(find(mount(LIST).value, (n) => isFn(n, 'ProjectMenu')));
    const items = nodes(menu)
      // Menu items: clickable, not the radio items that pick a project.
      .filter((n) => typeof n.type !== 'string' && n.props.onClick && n.props.value === undefined)
      .map((n) => text(n.props.children));
    expect(items.at(-1)).toBe(allLabel);
    expect(items.filter((item) => item === allLabel)).toHaveLength(1);
  });

  it('draws no needs-you count at zero', () => {
    expect(waitButton(mount([session('running', 'running')]))).toBeUndefined();
  });

  it('presses the needs-you count to list only the sessions that need you', () => {
    const h = mount(LIST);
    const button = waitButton(h)!;
    expect(button.props['aria-pressed']).toBe(false);
    expect(button.props['aria-label']).toBe('只看等你的 1 个会话');
    expect(text(button.props.children)).toBe('1');
    expect(rows(h)).toEqual(['waiting', 'running', 'ready']);
    button.props.onClick();
    h.render();
    expect(waitButton(h)!.props['aria-pressed']).toBe(true);
    expect(rows(h)).toEqual(['waiting']);
    expect(mock.shell.openSession).toHaveBeenCalledWith('waiting');
  });

  it('keeps only page icons, new session, all projects and settings on the folded rail', () => {
    const h = mount(LIST, true);
    expect(nodes(h.value).some((n) => isFn(n, 'ProjectMenu'))).toBe(false);
    const labels = nodes(h.value)
      .filter((n) => n.type === 'button' && n.props.className === 'ib')
      .map((n) => n.props['aria-label']);
    expect(labels).toEqual([
      ...['board', 'insights', 'repo', 'trace', 'memory'].map(screen),
      zh('components.sidebar.newSession'),
      allLabel,
      screen('settings'),
    ]);
  });

  it('keeps only the sidebar toggle and search in the window controls', () => {
    for (const collapsed of [false, true]) {
      const buttons = nodes(WindowControls({ collapsed, onToggle() {}, onSearch() {} })).filter(
        (n) => n.type === 'button',
      );
      expect(buttons.map((n) => n.props['aria-label'])).toEqual([
        zh(`components.windowControls.${collapsed ? 'expandSidebar' : 'collapseSidebar'}`),
        zh('components.windowControls.search'),
      ]);
    }
  });

  it('counts what other projects need on the all projects item, or shows — when the read failed', () => {
    const allProjects = (attention: number | null) =>
      nodes(expand(find(mount(LIST, false, attention).value, (n) => isFn(n, 'ProjectMenu')))).find(
        (n) => typeof n.type !== 'string' && text(n.props.children) === allLabel,
      )!.props['data-keys'];
    expect(allProjects(3)).toBe(3);
    expect(allProjects(null)).toBe('—');
    expect(allProjects(0)).toBeUndefined();
  });

  it('dots the project row while other projects need you or their read failed', () => {
    const dot = (attention: number | null) =>
      nodes(mount(LIST, false, attention).value).find((n) => n.props.className === 'sb-dot');
    expect(dot(2)!.props).toMatchObject({
      role: 'img',
      'aria-label': zh('components.sidebar.attention'),
    });
    expect(dot(null)!.props).toMatchObject({
      role: 'img',
      'aria-label': zh('components.sidebar.attentionFailed'),
    });
    expect(dot(0)).toBeUndefined();
  });

  it('dots all projects on the folded rail as the window controls once did', () => {
    const badge = (attention: number | null) => {
      const button = nodes(mount(LIST, true, attention).value).find(
        (n) => n.type === 'button' && n.props['aria-label'] === allLabel,
      )!;
      return nodes(button).find((n) => n.type === 'b');
    };
    expect(badge(2)!.props.children).toBeFalsy();
    expect(badge(null)!.props.children).toBe('—');
    expect(badge(0)).toBeUndefined();
  });
});

describe('session row', () => {
  const button = (s: WorkbenchSession, lead = false) =>
    SessionRowButton({
      session: s,
      on: false,
      now: Date.parse(s.last_activity_at),
      lead,
      onSelect() {},
    });

  it('runs avatar, title, crown and time', () => {
    const order = (button(session('l', 'running'), true).props.children as any[])
      .flat()
      .filter((n) => n && typeof n === 'object')
      .map((n: ReactElement<any>) =>
        typeof n.type === 'function' ? n.type.name : n.props.className,
      );
    expect(order).toEqual(['Avatar', 'ss-ttl', 'LeadCrown', 'ss-time']);
  });

  it('marks the avatar with a named status badge', () => {
    const avatar = find(button(session('w', 'waiting', { waiting: 1 })), (n) => isFn(n, 'Avatar'));
    const badge = find(expand(avatar), (n) => n.props['data-badge'] !== undefined);
    expect(badge.props['aria-label']).toBe(zh('sessions.row.badge.waiting'));
    expect(badge.props['data-badge']).toBe('waiting');
  });
});
