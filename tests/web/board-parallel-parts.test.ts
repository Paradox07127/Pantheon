import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { named, nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useStore: (select: (s: { transform: [number, number, number] }) => unknown) =>
    select({ transform: [0, 0, 1] }),
}));
vi.mock('@/data/backends', () => ({ useBackends: () => [] }));
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({ read: { state: 'loading' } }),
}));
vi.mock('@/data/runtime-models', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeModels: () => ({}),
}));
import { TaskCard } from '@/screens/board/FlowNode';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 14, 12);
const noop = () => {};

const task = (patch: Partial<Task> = {}): Task =>
  ({
    id: 'lead-1:split',
    owner_session_id: 'lead-1',
    title: 'split the importer',
    goal: '',
    scope: [],
    lane_id: null,
    milestone_id: null,
    status: 'running',
    state: 'running',
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
    ...patch,
  }) as Task;

const parallel = task({
  path: 'parallel',
  parallel: [
    { title: 'parse rows', session_id: 'part-a', status: 'done' },
    { title: 'write rows', session_id: 'part-b', status: 'running' },
    { title: 'report errors' },
  ],
});

const board = (tasks: Task[]) =>
  ({
    since: NOW - 86_400_000,
    now: NOW,
    lanes: [],
    edges: [],
    merges: [],
    tasks,
    milestones: [],
    leads: [],
  }) as unknown as BoardModel;

const expand = (tree: ReactNode): ReactNode => {
  if (Array.isArray(tree)) return tree.map(expand);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return tree;
  const el = tree as ReactElement<any>;
  if (typeof el.type === 'function' && el.type.name !== 'Tip')
    return expand((el.type as (p: unknown) => ReactNode)(el.props));
  return { ...el, props: { ...el.props, children: expand(el.props.children) } } as ReactElement;
};

const card = (t: Task) =>
  mount(() =>
    expand(
      TaskCard({
        data: { task: t, selected: false, now: NOW, critical: false, ready: false, line: null },
      } as unknown as Parameters<typeof TaskCard>[0]),
    ),
  ).value as ReactNode;
const openSession = vi.fn();
const drawer = (t: Task) =>
  mount(() =>
    TaskDrawer({
      model: board([t]),
      taskId: t.id,
      onSelect: noop,
      onOpenSession: openSession,
      onOpenStory: noop,
    }),
  ).value as ReactNode;
/** A part's name and status as the catalog message `id` joins them. */
const part = (id: string, title: string, status: string) =>
  zhf(id, { title, status: zh(`board.task.status.${status}`) });
const partsOf = (tree: ReactNode) =>
  nodes(tree).find((n) => typeof n.type === 'function' && n.type.name === 'ParallelParts');
const glyphs = (tree: ReactNode) =>
  nodes(tree)
    .filter((n) => String(n.props.className ?? '').includes('bd-nparts'))
    .flatMap((n) => [n.props.children].flat(2) as ReactElement<any>[]);

beforeEach(() => {
  const listeners = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal('window', {
    ...listeners,
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { ...listeners, activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  openSession.mockClear();
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('the parts of a parallel task', () => {
  it('draws one glyph per part on the flow node, in plan order, with its status', () => {
    const drawn = glyphs(card(parallel));
    expect(drawn.map((n) => n.props['aria-label'])).toEqual([
      part('board.plan.flow.part', 'parse rows', 'done'),
      part('board.plan.flow.part', 'write rows', 'running'),
      part('board.plan.flow.part', 'report errors', 'todo'),
    ]);
    expect(drawn.map((n) => n.props['data-status'])).toEqual(['done', 'running', 'todo']);
  });

  it('lists the parts in the drawer; a part with a session opens it, one without is plain text', () => {
    const list = mount(() => expand(named(drawer(parallel), 'ParallelParts'))).value as ReactNode;
    const rows = nodes(list).filter((n) => n.type === 'li');
    expect(rows.map(text)).toEqual(['parse rows', 'write rows', 'report errors']);
    const buttons = nodes(list).filter((n) => n.type === 'button');
    expect(buttons.map((n) => n.props['aria-label'])).toEqual([
      part('board.task.link.label', 'parse rows', 'done'),
      part('board.task.link.label', 'write rows', 'running'),
    ]);
    buttons[1]!.props.onClick();
    expect(openSession).toHaveBeenCalledWith('part-b');
    expect(nodes(rows[2]).some((n) => n.type === 'button')).toBe(false);
    expect(nodes(rows[2]).find((n) => n.props.role === 'img')?.props['aria-label']).toBe(
      zh('board.task.status.todo'),
    );
  });

  it('draws no parts for a task without them', () => {
    const plain = task({ path: 'direct' });
    expect(
      nodes(card(plain)).some((n) => String(n.props.className ?? '').includes('bd-nparts')),
    ).toBe(false);
    expect(partsOf(drawer(plain))).toBeUndefined();
  });
});
