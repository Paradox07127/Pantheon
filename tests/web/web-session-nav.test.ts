import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { SessionsScreen } from '@/screens/sessions/SessionsScreen';

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
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
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});

const listOf = (data: WorkbenchSession[] | null) => ({
  data,
  loading: false,
  error: null,
  reload() {},
});
const needs = { items: [], loading: false, error: null, reload() {} };

beforeEach(() => {
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [] },
    events: [],
    status: { state: 'live' },
    cursor: 0,
    resync: 0,
  };
  mock.shell = {
    sessionId: null,
    sessionGroup: null,
    sessionTab: null,
    sessionOpened: 1,
    openSettings() {},
    openSession() {},
    followFirstSession: vi.fn(),
    follow: vi.fn(),
  };
  vi.stubGlobal('window', {
    pantheon: { query: vi.fn(async () => ({ ok: true, value: [] })) },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('shows the session the store opens again after another was picked in the sidebar', async () => {
  const list = listOf([listed('session-a', { state: 'waiting', waiting: 1 }), listed('session-b')]);
  mock.shell = { ...mock.shell, sessionId: 'session-a' };
  const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  await h.flush();
  const shown = () => named(h.value, 'Thread').props.sessionId;
  expect(shown()).toBe('session-a');
  mock.shell = { ...mock.shell, sessionId: 'session-b', sessionOpened: 2 };
  h.render();
  expect(shown()).toBe('session-b');
  mock.shell = { ...mock.shell, sessionId: 'session-a', sessionOpened: 3 };
  h.render();
  expect(shown()).toBe('session-a');
});

it('follows the first session when the CLI removes the shown one from the refreshed list', async () => {
  mock.shell = { ...mock.shell, sessionId: 'baseline-session' };
  let list = listOf([listed('baseline-session', { state: 'done', workspace_id: null })]);
  const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  await h.flush();
  expect(named(h.value, 'Thread').props.sessionId).toBe('baseline-session');
  expect(mock.shell.followFirstSession).not.toHaveBeenCalled();
  list = listOf([]);
  h.render();
  await h.flush();
  expect(mock.shell.followFirstSession).toHaveBeenCalledTimes(1);
});

it('follows the first session when opened on one the list and board do not have', async () => {
  mock.shell = { ...mock.shell, sessionId: 'deleted-session' };
  const list = listOf([listed('session-a')]);
  const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  await h.flush();
  expect(mock.shell.followFirstSession).toHaveBeenCalledTimes(1);
});

it('stays on a session it just created before the list has it', async () => {
  mock.shell = {
    ...mock.shell,
    sessionId: '',
    openSession(id: string) {
      mock.shell = { ...mock.shell, sessionId: id };
    },
  };
  const list = listOf([listed('session-a')]);
  const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  named(h.value, 'NewSession').props.onCreated('session-new');
  h.render();
  await h.flush();
  expect(named(h.value, 'Thread').props.sessionId).toBe('session-new');
  expect(mock.shell.followFirstSession).not.toHaveBeenCalled();
});

it('shows why the session list failed with a retry instead of loading forever', async () => {
  const reload = vi.fn();
  const list = { data: null, loading: false, error: '读取失败（offline）', reload };
  const h = mount(() => SessionsScreen({ projectId: 'project-a', needs, list }));
  await h.flush();
  const failed = find(h.value, (n) => n.props.role === 'alert');
  expect(text(failed)).toContain('读取失败（offline）');
  expect(nodes(h.value).some((n) => n.props['aria-busy'] === 'true')).toBe(false);
  find(
    failed,
    (n) => n.type === 'button' && text(n) === zh('sessions.screen.retry'),
  ).props.onClick();
  expect(reload).toHaveBeenCalledTimes(1);
});

it('gives each project its own new-session composer', async () => {
  mock.shell = { ...mock.shell, sessionId: '' };
  let projectId = 'project-a';
  const list = listOf([listed('session-a')]);
  const h = mount(() => SessionsScreen({ projectId, needs, list }));
  const first = named(h.value, 'NewSession').key;
  projectId = 'project-b';
  h.render();
  expect(named(h.value, 'NewSession').key).not.toBe(first);
});
