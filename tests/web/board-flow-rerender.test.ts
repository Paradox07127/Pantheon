import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { HookHost, find, named } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'redraw' }),
);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useReactFlow: () => ({ setViewport: async () => true }),
}));
vi.mock('@/screens/board/flow-layout', async (actual) => {
  const real = (await actual()) as typeof import('@/screens/board/flow-layout');
  return { ...real, flowLayout: vi.fn(real.flowLayout) };
});
// The card counts its draws; React Flow renders it through the chart's node types.
const drawn = vi.hoisted(() => ({ cards: 0 }));
vi.mock('@/screens/board/FlowNode', async (actual) => ({
  ...(await actual<object>()),
  TaskCard: () => {
    drawn.cards++;
    return null;
  },
}));
import { act, createElement } from 'react';
import { FlowChart } from '@/screens/board/FlowPanel';
import { flowLayout } from '@/screens/board/flow-layout';
import { FakeDocument } from './web-fake-dom.js';

type Task = BoardModel['tasks'][number];
type ChartProps = Parameters<typeof FlowChart>[0];
const NOW = Date.UTC(2026, 10, 19, 12);

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  owner_session_id: 'lead-1',
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: 'main',
  milestone_id: null,
  status: 'todo',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  state: 'todo',
  planned: {},
  ...extra,
});

const milestone = {
  id: 'm1',
  title: 'ship refunds',
  session_ids: [],
  merged: 0,
  status: 'active',
  criteria: [{ text: 'one', accepted: false }],
  owner_session_id: 'lead-1',
  tasks: { done: 0, total: 1 },
};

// a feeds b; c stands alone; a belongs to milestone m1. Every call builds new objects.
const board = (p: string, extra: Partial<BoardModel> = {}): BoardModel =>
  ({
    since: 0,
    now: NOW,
    lanes: [{ id: 'main', title: 'main' }],
    merges: [],
    milestones: [],
    tasks: [
      task(`${p}a`, { milestone_id: 'm1' }),
      task(`${p}b`, { depends_on: [`${p}a`] }),
      task(`${p}c`),
    ],
    edges: [{ from: `${p}a`, to: `${p}b`, state: 'pending' }],
    ...extra,
  }) as unknown as BoardModel;

const sessions = [{ id: 'lead-1', project_id: 'project-r' }] as unknown as NonNullable<
  ChartProps['tell']
>['sessions'];
const run = async () => null;

const hosts: HookHost<ReactElement<any>>[] = [];
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.mocked(flowLayout).mockClear();
  drawn.cards = 0;
});
afterEach(() => {
  hosts.splice(0).forEach((h) => h.unmount());
  vi.unstubAllGlobals();
});

const isBox = (n: ReactElement<any>) => String(n.props.className ?? '').startsWith('bd-fc');

/** The chart's canvas mounted `width` px wide; `set` renders it again with new props. */
function chart(props: Partial<ChartProps> & { model: BoardModel }, width = 1000) {
  let current = { selected: null, onSelect() {}, ...props } as ChartProps;
  const Canvas = named(FlowChart(current), 'FlowCanvas').type as (
    p: ChartProps,
  ) => ReactElement<any>;
  const h = new HookHost(
    () => Canvas(current),
    (tree) => (find(tree, isBox).props.ref.current ??= { clientWidth: width }),
  );
  hosts.push(h);
  h.render();
  const flow = () => find(h.value, (n) => 'nodeTypes' in n.props).props;
  return {
    flow,
    set(next: Partial<ChartProps>) {
      current = { ...current, ...next };
      h.render();
    },
    /** React Flow measured the card of `id` this tall. */
    measure(id: string, height: number) {
      flow().onNodesChange([{ type: 'dimensions', id, dimensions: { width: 232, height } }]);
      h.render();
    },
  };
}

/** Mounts the chart of `p`'s board with a's card measured `height` tall. */
function open(
  p: string,
  {
    width = 1000,
    height = 140,
    ...props
  }: Partial<ChartProps> & { width?: number; height?: number },
) {
  const c = chart({ model: board(p), ...props }, width);
  c.measure(`${p}a`, height);
  return c;
}

describe('the flow chart layout', () => {
  it('reuses the layout of an earlier mount whose inputs read the same', () => {
    open('again-', {});
    hosts.splice(0).forEach((h) => h.unmount());
    vi.mocked(flowLayout).mockClear();
    open('again-', {});
    expect(flowLayout).not.toHaveBeenCalled();
  });

  it.each([
    {
      input: 'the tasks',
      p: 'tasks-',
      change: {
        model: board('tasks-', { tasks: [...board('tasks-').tasks, task('tasks-d')] }),
      },
    },
    {
      input: 'their dependencies',
      p: 'deps-',
      change: {
        model: board('deps-', { edges: [{ from: 'deps-a', to: 'deps-c', state: 'pending' }] }),
      },
    },
    { input: 'the grouping', p: 'group-', change: { group: 'state' as const } },
    {
      input: 'the current milestone',
      p: 'milestone-',
      change: { model: board('milestone-', { milestones: [milestone] as never }) },
    },
    { input: 'a card height', p: 'height-', change: { height: 160 } },
    { input: 'the chart width', p: 'width-', change: { width: 1200 } },
  ])('lays out again when $input changes', ({ p, change }) => {
    open(p, {});
    hosts.splice(0).forEach((h) => h.unmount());
    vi.mocked(flowLayout).mockClear();
    open(p, change);
    expect(flowLayout).toHaveBeenCalled();
  });
});

describe('the cards a refresh hands React Flow', () => {
  const ids = ['cards-a', 'cards-b', 'cards-c'];
  // The board hands a new command context and needs-you handler on every render.
  const refresh = (model: BoardModel) => ({ model, tell: { sessions, run }, onAskNeed: () => {} });
  const data = (c: ReturnType<typeof chart>) =>
    new Map<string, unknown>(
      c.flow().nodes.map((n: { id: string; data: unknown }) => [n.id, n.data]),
    );

  it('keeps every card data object while the tasks read the same', () => {
    const c = chart(refresh(board('cards-')));
    const before = data(c);
    c.set(refresh(board('cards-')));
    const after = data(c);
    for (const id of ids) expect(after.get(id)).toBe(before.get(id));
  });

  it('replaces only the data of the task that changed', () => {
    const c = chart(refresh(board('cards-')));
    const before = data(c);
    const model = board('cards-');
    c.set(
      refresh({
        ...model,
        tasks: model.tasks.map((t) => (t.id === 'cards-b' ? { ...t, title: 'renamed' } : t)),
      }),
    );
    const after = data(c);
    expect(after.get('cards-b')).not.toBe(before.get('cards-b'));
    expect((after.get('cards-b') as { task: Task }).task.title).toBe('renamed');
    for (const id of ['cards-a', 'cards-c']) expect(after.get(id)).toBe(before.get(id));
  });
});

describe('a task card on the chart', () => {
  it('draws again for new data, not for a new position or size', async () => {
    const Card = chart({ model: board('draw-') }).flow().nodeTypes.task;
    const doc = new FakeDocument();
    const win = {
      document: doc,
      HTMLIFrameElement: class {},
      addEventListener() {},
      removeEventListener() {},
    };
    doc.defaultView = win;
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as never);
    const data = { task: task('draw-a') };
    const draw = (props: object): ReactNode =>
      createElement(Card, { id: 'draw-a', type: 'task', ...props });
    await act(() => root.render(draw({ data, positionAbsoluteY: 0, height: 108 })));
    await act(() => root.render(draw({ data, positionAbsoluteY: 40, height: 140 })));
    expect(drawn.cards).toBe(1);
    await act(() => root.render(draw({ data: { ...data }, positionAbsoluteY: 40, height: 140 })));
    expect(drawn.cards).toBe(2);
    act(() => root.unmount());
  });
});
