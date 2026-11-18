import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { HookHost, find, mount as host, nodes, unmountAll } from './web-hook-host.js';
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

const LIST = [
  session('waiting', 'waiting', { waiting: 1 }),
  session('failed', 'failed'),
  session('running', 'running'),
  session('ready', 'ready'),
];

beforeEach(() => {
  mock.board = { board: null, events: [], status: { state: 'live' } };
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function mount(sessionGroup: string | null = null, needs: object[] = []) {
  mock.shell = { screen: 'board', sessionId: null, sessionGroup, openSession: vi.fn() };
  return host(() =>
    Sidebar({
      layout: {
        collapsed: false,
        width: 264,
        resize: () => {},
        commit: () => {},
        reset: () => {},
        toggle: () => {},
      },
      projects: [{ id: 'alpha', name: 'Alpha' }],
      currentProjectId: 'alpha',
      onChooseProject: () => {},
      list: { data: LIST, loading: false, error: null, reload() {} } as any,
      allNeeds: { items: needs } as any,
    }),
  );
}

const rows = (h: HookHost<any>) =>
  nodes(h.value)
    .filter((n) => typeof n.type === 'function' && n.type.name === 'SessionListRow')
    .map((n) => n.props.session.id);
const chip = (h: HookHost<any>) => find(h.value, (n) => n.props.className === 'sb-wait');

describe('needs-you chip', () => {
  it('shows only the sessions that need you while pressed, and every session again after', () => {
    const h = mount();
    expect(rows(h)).toEqual(['waiting', 'failed', 'running', 'ready']);
    expect(chip(h).props['aria-pressed']).toBe(false);
    chip(h).props.onClick();
    h.render();
    expect(chip(h).props['aria-pressed']).toBe(true);
    expect(rows(h)).toEqual(['waiting', 'failed']);
    chip(h).props.onClick();
    h.render();
    expect(rows(h)).toEqual(['waiting', 'failed', 'running', 'ready']);
  });

  it('opens the session that has waited longest when pressed, and stays put when let go', () => {
    const item = (id: string, created_at: number) => ({
      source: { table: 'sessions', id, revision: 1 },
      project_id: 'alpha',
      created_at,
    });
    const h = mount(null, [item('waiting', 200), item('failed', 100)]);
    chip(h).props.onClick();
    h.render();
    expect(mock.shell.openSession.mock.calls).toEqual([['failed']]);
    chip(h).props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledTimes(1);
  });

  it('opens the first session that needs you in list order without a needs-you item for it', () => {
    const h = mount();
    chip(h).props.onClick();
    expect(mock.shell.openSession.mock.calls).toEqual([['waiting']]);
  });

  it('turns on when the projects page asks for the sessions that need you', () => {
    const h = mount('inbox');
    expect(chip(h).props['aria-pressed']).toBe(true);
    expect(rows(h)).toEqual(['waiting', 'failed']);
    expect(mock.shell.sessionGroup).toBeNull();
  });

  it('turns off when a notice asks for a group the needs-you filter hides', async () => {
    const h = mount();
    chip(h).props.onClick();
    h.render();
    expect(rows(h)).toEqual(['waiting', 'failed']);
    mock.shell.sessionGroup = 'review';
    h.render();
    await h.flush();
    expect(chip(h).props['aria-pressed']).toBe(false);
    expect(rows(h)).toContain('ready');
    expect(mock.shell.sessionGroup).toBeNull();
  });
});
