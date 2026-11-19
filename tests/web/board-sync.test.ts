import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deferred, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
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
import { RunningFor } from '@/components/RunningFor';
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
      page: 'overview',
      onPage: noop,
      onOpenSession: noop,
      onOpenStory: noop,
      onOpenTrace: noop,
      sync,
    }),
  );
const syncItem = (tree: unknown) =>
  find(tree as any, (n) => n.type === 'button' && n.props['aria-label'] === zh('board.bar.sync'));

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
    addEventListener() {},
    removeEventListener() {},
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

it("puts the lead's sync in the bar, off while it syncs with how long it has run beside it", () => {
  const onSync = vi.fn();
  const idle = syncItem(view({ busy: false, error: null, onSync, since: null }).value);
  expect(text(idle)).toBe(zh('board.bar.sync'));
  idle.props.onClick();
  expect(onSync).toHaveBeenCalledOnce();

  const tree = view({ busy: true, error: null, onSync, since: 1_000 }).value;
  const busy = syncItem(tree);
  expect(busy.props['aria-busy']).toBe(true);
  expect(busy.props.disabled).toBe(true);
  expect(find(tree, (n) => n.type === RunningFor).props).toEqual({
    label: zh('components.running.writing'),
    since: 1_000,
  });
  expect(
    find(tree, (n) => n.props['aria-label'] === zh('board.bar.more')).props['aria-busy'],
  ).toBeUndefined();
});

it("keeps the more menu at the bar's end, the lead's sentence giving way", () => {
  const tree = view({ busy: false, error: null, onSync: noop, since: null }).value;
  const actions = find(tree, (n) => n.props.className === 'tb-end');
  expect(() => syncItem(actions)).not.toThrow();
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
  const tree = view({ busy: false, error: 'resource_busy：Wait', onSync, since: null }).value;
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
  const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
  await h.flush();
  const sent = Date.now();
  h.value.props.sync.onSync();
  h.render();
  expect(h.value.props.sync.busy).toBe(true);
  expect(h.value.props.sync.since).toBeGreaterThanOrEqual(sent);
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
  expect(h.value.props.sync).toMatchObject({ busy: false, error: null, since: null });
  expect(mock.openSession).not.toHaveBeenCalled();
});

it('drops a sync failure and an unfinished sync when the board moves to another project', async () => {
  reply = {
    ok: false,
    error: { code: 'permission_denied', message: 'Authenticated user required' },
  };
  let projectId = 'project-a';
  const h = mount(() => boardView({ projectId, onOpenSession: noop }));
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
  const h = mount(() => boardView({ projectId, onOpenSession: noop }));
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
  const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
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
  const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
  await h.flush();
  h.value.props.sync.onSync();
  await h.flush();
  expect(h.value.props.sync.error).toContain('Authenticated user required');
  expect(mock.openSession).not.toHaveBeenCalled();
});

it.each([
  ['running', true],
  ['submitted', true],
  ['confirmed', false],
  ['failed', false],
] as const)(
  "turns the lead's sync off, saying why, while the newest baseline is %s: %s",
  async (state, off) => {
    (window as any).pantheon.query = vi.fn(async (method: string) => ({
      ok: true,
      value:
        method === 'project.baseline.read'
          ? {
              id: 'baseline-a',
              revision: 1,
              project_id: 'project-a',
              state,
              session_id: 'baseline-session',
              facts_id: 'facts-a',
              dropped: 0,
              created_at: 1,
            }
          : { tasks: [] },
    }));
    const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
    await h.flush();
    const tree = view(h.value.props.sync).value;
    const update = syncItem(tree);
    expect(!!update.props['aria-disabled']).toBe(off);
    const described = update.props['aria-describedby'];
    if (!off) return expect(described).toBeUndefined();
    expect(text(find(tree, (n) => n.props.id === described && n.type === 'span'))).toBe(
      zh('board.headline.syncBaseline'),
    );
    const tip = find(
      tree,
      (n) =>
        typeof n.type === 'function' &&
        n.type.name === 'Tip' &&
        nodes(n.props.children).includes(update),
    );
    expect(tip.props.content).toBe(zh('board.headline.syncBaseline'));
  },
);
