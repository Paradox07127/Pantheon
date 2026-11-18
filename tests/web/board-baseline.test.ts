import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ProjectBaseline } from '@pantheon/domain';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
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
import { Popover } from '../../apps/web/node_modules/@base-ui/react/popover/index.mjs';
import { BoardScreen, BoardView, Failure, boardBaseline } from '@/screens/board/BoardScreen';
import { failureText } from '@/data/needs-you';
import { BaselineLaunch, BaselinePopover } from '@/screens/projects/BaselineBlocks';

let commands: { type: string; input: unknown }[];
let reply: unknown;
const noop = () => {};
// The board screen's view under its top bar.
const boardView = (props: Parameters<typeof BoardScreen>[0]) =>
  find(BoardScreen(props), (n) => n.type === BoardView);
const created_at = new Date(2026, 10, 2, 9, 8).getTime();
const baseline = (state: ProjectBaseline['state'], session_id?: string): ProjectBaseline => ({
  id: 'baseline-a',
  revision: 1,
  project_id: 'project-a',
  state,
  ...(session_id && { session_id }),
  facts_id: 'facts-a',
  dropped: 0,
  created_at,
});
const view = (
  props: Pick<Parameters<typeof BoardView>[0], 'baseline' | 'projectId'> & {
    onOpenSession?: (id: string) => void;
  },
) =>
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
      onOpenSession: props.onOpenSession ?? noop,
      onOpenStory: noop,
      onOpenTrace: noop,
      baseline: props.baseline,
      ...(props.projectId && { projectId: props.projectId }),
    }),
  );
const item = (tree: unknown, label: string) =>
  find(tree as any, (n) => n.type === Menu.Item && text(n) === label);

beforeEach(() => {
  commands = [];
  reply = { ok: true, value: { ...baseline('running', 'baseline-session'), id: 'baseline-b' } };
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

const d = new Date(created_at);
const two = (n: number) => String(n).padStart(2, '0');
const restart = { link: null, start: zh('board.baseline.restart') };
const linked = (label: string | undefined, start: string | null | undefined = null) => ({
  link: { label, session_id: 'baseline-session' },
  start,
});
it.each([
  [
    'offers a first baseline when the project has none',
    [[null, { link: null, start: zh('board.baseline.start') }]],
  ],
  [
    'links a running or handed-back baseline to its session without a start button',
    [
      [baseline('running', 'baseline-session'), linked(zh('board.baseline.running'))],
      [baseline('submitted', 'baseline-session'), linked(zh('board.baseline.submitted'))],
    ],
  ],
  [
    'names a confirmed baseline by its local start time and offers another',
    [
      [
        baseline('confirmed', 'baseline-session'),
        linked(
          `摸底 ${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`,
          zh('board.baseline.restart'),
        ),
      ],
    ],
  ],
  [
    'offers another baseline without a link after a failed or empty one',
    [
      [baseline('failed', 'baseline-session'), restart],
      [baseline('empty'), restart],
      [baseline('confirmed'), restart],
    ],
  ],
  [
    'offers another baseline after its submitted session was discarded',
    [[baseline('submitted'), restart]],
  ],
] as [string, [ProjectBaseline | null, unknown][]][])('%s', (_name, cases) => {
  for (const [input, expected] of cases) expect(boardBaseline(input)).toEqual(expected);
});

it('opens the baseline session from the more menu', () => {
  const onOpenSession = vi.fn();
  const tree = view({
    onOpenSession,
    baseline: {
      link: { label: '摸底中', session_id: 'baseline-session' },
      start: null,
      busy: false,
      error: null,
      onStart: noop,
    },
  }).value;
  const link = item(tree, '摸底中');
  link.props.onClick();
  expect(onOpenSession).toHaveBeenCalledWith('baseline-session');
  expect(nodes(tree).filter((n) => n.type === Menu.Item && text(n).includes('摸底'))).toEqual([
    link,
  ]);
});

it('puts a start item in the more menu that is busy while it starts, the menu button marked', () => {
  const onStart = vi.fn();
  const props = { link: null, start: '重新摸底', error: null, onStart };
  const tree = view({ baseline: { ...props, busy: true } }).value;
  const busy = item(tree, '重新摸底');
  expect(busy.props['aria-busy']).toBe(true);
  expect(busy.props.disabled).toBe(true);
  expect(find(tree, (n) => n.props['aria-label'] === zh('board.bar.more')).props['aria-busy']).toBe(
    true,
  );
});

// The model popover the more menu's start item opens, drawn out.
const popoverOf = (tree: unknown) =>
  BaselinePopover(find(tree as any, (n) => n.type === BaselinePopover).props);
const hasPopover = (tree: unknown) => nodes(tree as any).some((n) => n.type === BaselinePopover);

it('asks for the runtime, model and effort before it starts a baseline from the more menu', () => {
  const onStart = vi.fn();
  const h = view({
    projectId: 'project-a',
    baseline: { link: null, start: '重新摸底', busy: false, error: null, onStart },
  });
  expect(hasPopover(h.value)).toBe(false);
  item(h.value, '重新摸底').props.onClick();
  h.render();
  expect(onStart).not.toHaveBeenCalled();
  const popover = popoverOf(h.value);
  expect(find(popover, (n) => n.type === Popover.Popup).props['aria-label']).toBe(
    zh('projects.baseline.model'),
  );
  const launch = find(popover, (n) => n.type === BaselineLaunch);
  expect(launch.props).toMatchObject({ project_id: 'project-a', label: '重新摸底' });
  const choice = { runtime: 'codex', model: 'gpt-5.5', effort: 'low' };
  launch.props.onStart(choice);
  h.render();
  expect(onStart).toHaveBeenCalledWith(choice);
  expect(hasPopover(h.value)).toBe(false);
});

it('starts nothing when the model popover closes', () => {
  const onStart = vi.fn();
  const h = view({
    projectId: 'project-a',
    baseline: { link: null, start: '摸底', busy: false, error: null, onStart },
  });
  item(h.value, '摸底').props.onClick();
  h.render();
  find(popoverOf(h.value), (n) => n.type === Popover.Root).props.onOpenChange(false);
  h.render();
  expect(hasPopover(h.value)).toBe(false);
  expect(onStart).not.toHaveBeenCalled();
});

it('shows a failed start as one line under the bar', () => {
  const onStart = vi.fn();
  const tree = view({
    baseline: { link: null, start: '摸底', busy: false, error: 'resource_busy：Wait', onStart },
  }).value;
  const line = named(tree, 'Failure');
  expect(line.props.error).toBe('resource_busy：Wait');
  line.props.onRetry();
  expect(onStart).toHaveBeenCalledOnce();
});

it('starts a baseline and stays on the board, busy until its session turn ends', async () => {
  const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
  await h.flush();
  h.value.props.baseline.onStart();
  h.render();
  expect(h.value.props.baseline.busy).toBe(true);
  await h.flush();
  expect(commands).toMatchObject([
    { type: 'project.baseline.start', input: { project_id: 'project-a' } },
  ]);
  expect(mock.openSession).not.toHaveBeenCalled();
  expect(h.value.props.baseline).toMatchObject({ busy: true, error: null });
  mock.board.board = {
    cursor: 2,
    session_turns: [{ id: 'baseline-turn', session_id: 'baseline-session', state: 'running' }],
  };
  h.render();
  expect(h.value.props.baseline.busy).toBe(true);
  mock.board.board = {
    cursor: 3,
    session_turns: [{ id: 'baseline-turn', session_id: 'baseline-session', state: 'completed' }],
  };
  h.render();
  expect(h.value.props.baseline).toMatchObject({ busy: false, error: null });
  expect(mock.openSession).not.toHaveBeenCalled();
});

it.each([
  ['after its turn ended', 'completed'],
  ['while its turn ran', 'running'],
])('stops being busy when the baseline session is discarded %s', async (_name, state) => {
  const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
  await h.flush();
  h.value.props.baseline.onStart();
  await h.flush();
  mock.board.board = {
    cursor: 2,
    session_turns: [{ id: 'baseline-turn', session_id: 'baseline-session', state }],
  };
  h.render();
  mock.board.board = { cursor: 3, session_turns: [] };
  h.render();
  expect(h.value.props.baseline).toMatchObject({ busy: false, error: null });
});

it('is not busy on the next project when the board shows the baseline turn in the same render as the switch', async () => {
  let projectId = 'project-a';
  const h = mount(() => boardView({ projectId, onOpenSession: noop }));
  await h.flush();
  h.value.props.baseline.onStart();
  await h.flush();
  h.render();
  expect(h.value.props.baseline.busy).toBe(true);
  mock.board.board = {
    cursor: 2,
    session_turns: [{ id: 'baseline-turn', session_id: 'baseline-session', state: 'running' }],
  };
  projectId = 'project-b';
  h.render();
  expect(h.value.props.baseline).toMatchObject({ busy: false, error: null });
});

it('stops being busy when the board lists the baseline session discarded before it showed its turn', async () => {
  const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
  await h.flush();
  h.value.props.baseline.onStart();
  await h.flush();
  expect(h.value.props.baseline.busy).toBe(true);
  mock.board.board = {
    cursor: 3,
    sessions: [{ id: 'baseline-session', state: 'closed', outcome: 'discarded' }],
    session_turns: [],
  };
  h.render();
  expect(h.value.props.baseline).toMatchObject({ busy: false, error: null });
});

it('keeps the failure of a refused baseline for the headline bar', async () => {
  reply = { ok: false, error: { code: 'resource_busy', message: 'A baseline is already running' } };
  const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
  await h.flush();
  h.value.props.baseline.onStart();
  await h.flush();
  h.render();
  expect(h.value.props.baseline.error).toContain('A baseline is already running');
  expect(mock.openSession).not.toHaveBeenCalled();
});

it('sends the picked runtime, model and effort with the start', async () => {
  const h = mount(() => boardView({ projectId: 'project-a', onOpenSession: noop }));
  await h.flush();
  h.value.props.baseline.onStart({ runtime: 'codex', model: 'gpt-5.5', effort: 'low' });
  await h.flush();
  expect(commands).toMatchObject([
    {
      type: 'project.baseline.start',
      input: { project_id: 'project-a', runtime: 'codex', model: 'gpt-5.5', effort: 'low' },
    },
  ]);
});

it('retries a start on the runtime, model and effort it was first given', async () => {
  const h = mount(() => boardView({ projectId: 'project-retry', onOpenSession: noop }));
  await h.flush();
  h.value.props.baseline.onStart({ runtime: 'codex', model: 'gpt-5.5', effort: 'low' });
  await h.flush();
  h.value.props.baseline.onStart();
  await h.flush();
  const picked = { project_id: 'project-retry', runtime: 'codex', model: 'gpt-5.5', effort: 'low' };
  expect(commands.map((command) => command.input)).toEqual([picked, picked]);
});

it('says under the bar when the first baseline read failed, and reads it again on Retry', async () => {
  const error = { code: 'ipc_failed', message: 'socket closed' };
  let fails = true;
  (window as any).pantheon.query = vi.fn(async (method: string) =>
    method !== 'project.baseline.read'
      ? { ok: true, value: { tasks: [] } }
      : fails
        ? { ok: false, error }
        : { ok: true, value: null },
  );
  const h = mount(() => boardView({ projectId: 'project-unread', onOpenSession: noop }));
  await h.flush();
  expect(h.value.props.baseline).toMatchObject({ link: null, start: null });
  const line = named(view({ baseline: h.value.props.baseline }).value, 'Failure');
  expect(line.props.error).toBe(failureText(error));
  fails = false;
  line.props.onRetry();
  await h.flush();
  expect(h.value.props.baseline).toMatchObject({ link: null, start: zh('board.baseline.start') });
  expect(
    nodes(view({ baseline: h.value.props.baseline }).value).some((n) => n.type === Failure),
  ).toBe(false);
});
