import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deferred, find, named, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, openSession: (_id: string) => {} }));
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
  useShell: Object.assign(
    (selector: any) =>
      selector({
        openSession: mock.openSession,
        openSessionGroup() {},
        openTaskSession() {},
      }),
    { setState() {} },
  ),
}));
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import { BoardScreen, BoardView } from '@/screens/board/BoardScreen';
import { zh } from './i18n-setup.js';

let commands: { type: string; input: unknown }[];
let reply: unknown;
const noop = () => {};
// The board screen's view under its top bar.
const boardView = (props: Parameters<typeof BoardScreen>[0]) =>
  find(BoardScreen(props), (n) => n.type === BoardView);
const view = (sync: Parameters<typeof BoardView>[0]['sync']) =>
  mount(() =>
    BoardView({
      model: null,
      loading: false,
      error: null,
      onRetry: noop,
      range: 7,
      onRange: noop,
      page: 'now',
      onPage: noop,
      onOpenSession: noop,
      onOpenSessions: noop,
      onOpenStory: noop,
      onOpenTrace: noop,
      sync,
    }),
  );
const syncItem = (tree: unknown) =>
  find(tree as any, (n) => n.type === Menu.Item && text(n) === zh('board.headline.sync'));

beforeEach(() => {
  commands = [];
  reply = { ok: true, value: { session_ids: ['lead-a', 'lead-b'] } };
  mock.board = {
    board: { cursor: 1 },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.openSession = vi.fn();
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async () => ({ ok: true, value: { tasks: [] } })),
      command: vi.fn(async (command: any) => {
        commands.push(command);
        return reply;
      }),
    },
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

it('puts an update item in the more menu that is busy while it syncs, the menu button marked', () => {
  const onSync = vi.fn();
  const idle = syncItem(view({ busy: false, error: null, onSync }).value);
  idle.props.onClick();
  expect(onSync).toHaveBeenCalledOnce();

  const tree = view({ busy: true, error: null, onSync }).value;
  const busy = syncItem(tree);
  expect(busy.props['aria-busy']).toBe(true);
  expect(busy.props.disabled).toBe(true);
  expect(find(tree, (n) => n.props['aria-label'] === zh('board.bar.more')).props['aria-busy']).toBe(
    true,
  );
});

it("keeps the more menu and the range picker at the bar's end, the lead's sentence giving way", () => {
  const tree = view({ busy: false, error: null, onSync: noop }).value;
  const actions = find(tree, (n) => n.props.className === 'tb-end');
  expect(() => syncItem(actions)).not.toThrow();
  expect(() =>
    find(actions, (n) => n.props['aria-label'] === zh('board.headline.range')),
  ).not.toThrow();
  const css = readFileSync(
    new URL('../../apps/web/src/screens/board/overview.css', import.meta.url),
    'utf8',
  );
  const rule = (name: string) => new RegExp(`\\n${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  expect(rule('\\.bgl')).toContain('min-width: 0');
  expect(rule('\\.bgl-t')).toContain('text-overflow: ellipsis');
});

it('shows a failed sync as one line under the bar', () => {
  const onSync = vi.fn();
  const tree = view({ busy: false, error: 'resource_busy：Wait', onSync }).value;
  const line = named(tree, 'Failure');
  expect(line.props.error).toBe('resource_busy：Wait');
  line.props.onRetry();
  expect(onSync).toHaveBeenCalledOnce();
});

it('sends board.sync and stays on the board, busy until the sync turns of its leads end', async () => {
  const turn = (id: string, session_id: string, state: string, origin?: string) => ({
    id,
    session_id,
    state,
    ...(origin && { origin }),
  });
  // An earlier sync turn of lead-a ended before this one.
  mock.board.board = { cursor: 1, session_turns: [turn('old', 'lead-a', 'completed', 'sync')] };
  const h = mount(() =>
    boardView({ projectId: 'project-a', onOpenSession: noop, onOpenSessions: noop }),
  );
  await h.flush();
  h.value.props.sync.onSync();
  h.render();
  expect(h.value.props.sync.busy).toBe(true);
  await h.flush();
  expect(commands).toMatchObject([{ type: 'board.sync', input: { project_id: 'project-a' } }]);
  expect(mock.openSession).not.toHaveBeenCalled();
  expect(h.value.props.sync).toMatchObject({ busy: true, error: null });
  const ended = turn('old', 'lead-a', 'completed', 'sync');
  mock.board.board = {
    cursor: 2,
    session_turns: [
      ended,
      turn('a', 'lead-a', 'completed', 'sync'),
      turn('b', 'lead-b', 'running', 'sync'),
      turn('user', 'lead-b', 'completed'),
    ],
  };
  h.render();
  expect(h.value.props.sync.busy).toBe(true);
  mock.board.board = {
    cursor: 3,
    session_turns: [
      ended,
      turn('a', 'lead-a', 'completed', 'sync'),
      turn('b', 'lead-b', 'completed', 'sync'),
      turn('user', 'lead-b', 'running'),
    ],
  };
  h.render();
  expect(h.value.props.sync).toMatchObject({ busy: false, error: null });
  expect(mock.openSession).not.toHaveBeenCalled();
});

it('drops a sync failure and an unfinished sync when the board moves to another project', async () => {
  reply = {
    ok: false,
    error: { code: 'permission_denied', message: 'Authenticated user required' },
  };
  let projectId = 'project-a';
  const h = mount(() => boardView({ projectId, onOpenSession: noop, onOpenSessions: noop }));
  await h.flush();
  h.value.props.sync.onSync();
  await h.flush();
  expect(h.value.props.sync.error).toContain('Authenticated user required');

  projectId = 'project-b';
  h.render();
  expect(h.value.props.sync).toMatchObject({ busy: false, error: null });

  const late = deferred<unknown>();
  (window as any).pantheon.command = vi.fn(() => late.promise);
  h.value.props.sync.onSync();
  h.render();
  expect(h.value.props.sync.busy).toBe(true);
  projectId = 'project-c';
  h.render();
  expect(h.value.props.sync.busy).toBe(false);
  late.resolve(reply);
  await h.flush();
  expect(h.value.props.sync).toMatchObject({ busy: false, error: null });
});

it('is not busy on the next project when the board shows the sync turn in the same render as the switch', async () => {
  let projectId = 'project-a';
  const h = mount(() => boardView({ projectId, onOpenSession: noop, onOpenSessions: noop }));
  await h.flush();
  h.value.props.sync.onSync();
  await h.flush();
  expect(h.value.props.sync.busy).toBe(true);
  mock.board.board = {
    cursor: 2,
    session_turns: [{ id: 'a', session_id: 'lead-a', state: 'running', origin: 'sync' }],
  };
  projectId = 'project-b';
  h.render();
  expect(h.value.props.sync).toMatchObject({ busy: false, error: null });
});

it('stops being busy when the board lists the sync leads discarded before it showed their turns', async () => {
  const h = mount(() =>
    boardView({ projectId: 'project-a', onOpenSession: noop, onOpenSessions: noop }),
  );
  await h.flush();
  h.value.props.sync.onSync();
  await h.flush();
  expect(h.value.props.sync.busy).toBe(true);
  mock.board.board = {
    cursor: 3,
    sessions: [
      { id: 'lead-a', state: 'closed', outcome: 'discarded' },
      { id: 'lead-b', state: 'closed', outcome: 'discarded' },
    ],
    session_turns: [],
  };
  h.render();
  expect(h.value.props.sync).toMatchObject({ busy: false, error: null });
});

it('keeps the failure of a refused sync for the headline bar', async () => {
  reply = {
    ok: false,
    error: { code: 'permission_denied', message: 'Authenticated user required' },
  };
  const h = mount(() =>
    boardView({ projectId: 'project-a', onOpenSession: noop, onOpenSessions: noop }),
  );
  await h.flush();
  h.value.props.sync.onSync();
  await h.flush();
  expect(h.value.props.sync.error).toContain('Authenticated user required');
  expect(mock.openSession).not.toHaveBeenCalled();
});
