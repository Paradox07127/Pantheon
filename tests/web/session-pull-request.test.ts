import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import {
  HookHost,
  deferred,
  find,
  named,
  nodes,
  text,
  mount,
  unmountAll,
} from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any, toasts: [] as any[] }));
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
vi.mock('@/data/feedback', async (actual) => ({
  ...(await actual<object>()),
  useFeedback: (selector: any) => selector({ items: {} }),
}));
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: unknown) => {
    mock.toasts.push(options);
    return 'toast';
  },
}));
import { SessionHeader } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

let command: ReturnType<typeof vi.fn>;
let openLink: ReturnType<typeof vi.fn>;

const listed: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Refund filter',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
};

beforeEach(() => {
  mock.toasts = [];
  mock.board = {
    board: {
      sessions: [{ id: 'session-a', revision: 6, project_id: 'project-a' }],
      session_turns: [],
      projects: [],
      workspaces: [
        {
          id: 'workspace-a',
          kind: 'linked_worktree',
          path: '/work/a',
          source: '/src/a',
          source_branch: 'main',
        },
      ],
      cursor: 1,
    },
    events: [],
    status: { state: 'live' },
    cursor: 1,
    resync: 0,
    refresh() {},
  };
  mock.shell = { sessionId: 'session-a', openSettings() {}, openSession: vi.fn() };
  command = vi.fn(async () => ({
    ok: true,
    value: { number: 41, url: 'https://github.com/acme/app/pull/41' },
  }));
  openLink = vi.fn(async () => ({ ok: true, value: null }));
  vi.stubGlobal('window', {
    innerWidth: 1400,
    pantheon: { command, openLink, query: vi.fn(async () => ({ ok: true, value: null })) },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh', clipboard: { writeText: vi.fn() } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

function menu(row: WorkbenchSession = listed) {
  const header = mount(() =>
    SessionHeader({
      session: {
        id: 'session-a',
        revision: 6,
        project_id: 'project-a',
        runtime: 'claude',
        state: 'open',
        turn_count: 1,
        workspace_id: 'workspace-a',
      } as never,
      listed: row,
      title: row.title,
      panels: [],
      onPanel: vi.fn(),
      overview: true,
    }),
  );
  const element = named(header.value, 'MoreMenu');
  return mount(() => (element.type as (props: unknown) => ReactNode)(element.props));
}
const item = (tree: unknown, label: string) =>
  nodes(tree as never).find(
    (n: ReactElement<any>) =>
      typeof n.type !== 'string' && typeof n.props.onClick === 'function' && text(n) === label,
  );

it('creates a pull request from the more menu and offers to open it', async () => {
  const h = menu();
  item(h.value, zh('sessions.header.createPull'))!.props.onClick();
  await h.flush();
  expect(command.mock.calls[0]![0]).toMatchObject({
    type: 'github.pr.create',
    input: { session_id: 'session-a' },
  });
  expect(mock.toasts).toHaveLength(1);
  expect(mock.toasts[0].title).toBe('PR #41 已建好');
  expect(mock.toasts[0].action.label).toBe(zh('sessions.header.openPull'));
  mock.toasts[0].action.run();
  expect(openLink).toHaveBeenCalledWith('https://github.com/acme/app/pull/41');
});

it('shows why creating the pull request failed', async () => {
  command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'invalid_state', message: 'commit or discard the changes first' },
  });
  const h = menu();
  item(h.value, zh('sessions.header.createPull'))!.props.onClick();
  await h.flush();
  expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain(
    'commit or discard the changes first',
  );
  expect(mock.toasts).toEqual([]);
});

it('keeps create pull request off while its request is out', async () => {
  const pending = deferred<unknown>();
  command.mockReturnValueOnce(pending.promise);
  const h = menu();
  item(h.value, zh('sessions.header.createPull'))!.props.onClick();
  await h.flush();
  expect(item(h.value, zh('sessions.header.createPull'))!.props.disabled).toBe(true);
  pending.resolve({ ok: true, value: { number: 41, url: 'https://github.com/acme/app/pull/41' } });
  await h.flush();
  expect(item(h.value, zh('sessions.header.createPull'))!.props.disabled).toBe(false);
  expect(command).toHaveBeenCalledTimes(1);
});

it('shows the pull request failure in place of an earlier menu failure', async () => {
  command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'invalid_state', message: 'archive refused' },
  });
  const h = menu();
  item(h.value, zh('sessions.model.menu.archive'))!.props.onClick();
  await h.flush();
  expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain('archive refused');
  command.mockResolvedValueOnce({
    ok: false,
    error: { code: 'invalid_state', message: 'gh is not signed in' },
  });
  item(h.value, zh('sessions.header.createPull'))!.props.onClick();
  await h.flush();
  expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain('gh is not signed in');
});

it('opens the pull request the session already created', () => {
  mock.board.events = [
    {
      sequence: 3,
      kind: 'session.pr_created',
      aggregate_id: 'session-a',
      project_id: 'project-a',
      payload: { number: 41, url: 'https://github.com/acme/app/pull/41' },
    },
  ];
  const h = menu();
  expect(item(h.value, zh('sessions.header.createPull'))).toBeUndefined();
  item(h.value, '打开 PR #41')!.props.onClick();
  expect(openLink).toHaveBeenCalledWith('https://github.com/acme/app/pull/41');
  expect(command).not.toHaveBeenCalled();
});

it('opens the pull request the session list keeps once its event has left the window', () => {
  const kept = {
    ...listed,
    pull_request: { number: 41, url: 'https://github.com/acme/app/pull/41' },
  };
  const h = menu(kept);
  expect(item(h.value, zh('sessions.header.createPull'))).toBeUndefined();
  item(h.value, '打开 PR #41')!.props.onClick();
  expect(openLink).toHaveBeenCalledWith('https://github.com/acme/app/pull/41');
  mock.board.events = [
    {
      sequence: 3,
      kind: 'session.pr_created',
      aggregate_id: 'session-a',
      project_id: 'project-a',
      payload: { number: 42, url: 'https://github.com/acme/app/pull/42' },
    },
  ];
  expect(item(menu(kept).value, '打开 PR #42')).toBeDefined();
});

it('says why a pull request cannot come from a session without a worktree on a source branch', () => {
  const reasonOf = (h: HookHost<any>) => {
    const entry = nodes(h.value as never).find(
      (n: ReactElement<any>) =>
        typeof n.type !== 'string' &&
        n.props.disabled !== undefined &&
        text(n) === zh('sessions.header.createPull'),
    )!;
    expect(entry.props.disabled).toBe(true);
    return text(find(h.value, (n) => n.props.id === entry.props['aria-describedby']));
  };
  expect(reasonOf(menu({ ...listed, workspace_id: null }))).toBe(
    zh('sessions.model.worktree.none'),
  );
  expect(reasonOf(menu({ ...listed, workspace_kind: 'in_place' }))).toBe(
    zh('sessions.model.worktree.none'),
  );
  delete mock.board.board.workspaces[0].source_branch;
  expect(reasonOf(menu())).toBe(zh('sessions.model.mergeBlock.detachedHead'));
  expect(command).not.toHaveBeenCalled();
});
