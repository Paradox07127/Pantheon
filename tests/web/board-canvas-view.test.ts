import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import type { Visual } from '@pantheon/domain';
import { find, mount, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { refreshVisual, refreshVisuals, useRedrawFailed, useRefreshing } from '@/data/visuals';
import {
  CanvasBar,
  CanvasGrid,
  useCanvas,
  type CanvasPanel,
  type CanvasState,
} from '@/screens/board/CanvasView';
import {
  DEFAULT_LAYOUT,
  canvasOrder,
  moveBefore,
  readCanvasOrder,
  stepKey,
  visualKey,
  type BoardLayout,
  type PanelPlace,
} from '@/screens/board/panel-layout';

const visual = (id: string, extra: Partial<Visual> = {}): Visual =>
  ({
    id,
    revision: 1,
    project_id: 'project-1',
    session_id: 'session-1',
    title: `drawing ${id}`,
    kind: 'mermaid',
    spec: { source: 'graph LR\na-->b' },
    created_at: 1,
    updated_at: 1,
    pin: { size: 'M', position: 0 },
    ...extra,
  }) as Visual;

let turn = 0;
const command = vi.fn(
  async (sent: { type: string; input: Record<string, unknown> }): Promise<any> => {
    if (sent.type === 'visual.list') return { ok: true, value: { visuals: [] } };
    if (sent.type === 'session.send' || sent.type === 'session.steer')
      return { ok: true, value: { id: `turn-${++turn}` } };
    return { ok: true, value: {} };
  },
);
const sent = (type: string) =>
  command.mock.calls.filter(([c]) => c.type === type).map(([c]) => c as any);

const canvasText = (key: string, values: Record<string, string | number> = {}) =>
  Object.entries(values).reduce(
    (said, [name, value]) => said.replace(`{${name}}`, String(value)),
    zh(`board.canvas.${key}`),
  );

let stored: Map<string, string>;
beforeEach(() => {
  turn = 0;
  command.mockClear();
  stored = new Map();
  vi.stubGlobal('window', { pantheon: { command } });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  useBoard.setState({
    events: [],
    resync: 0,
    board: {
      sessions: [
        { id: 'session-1', state: 'open', revision: 4 },
        { id: 'session-2', state: 'running', revision: 9 },
      ],
      session_turns: [],
    } as never,
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('canvas order', () => {
  it('lays the panels out first and the pinned visuals after them in pinned order', () => {
    expect(canvasOrder([], ['table', 'trend'], ['v1', 'v2'])).toEqual([
      'table',
      'trend',
      visualKey('v1'),
      visualKey('v2'),
    ]);
  });

  it('keeps the stored order, fills its visual places in pinned order and adds new items at the end', () => {
    const order = canvasOrder(
      [visualKey('v2'), 'table', visualKey('v1'), 'gone', visualKey('unpinned'), 'table'],
      ['table', 'trend'],
      ['v1', 'v2', 'v3'],
    );
    expect(order).toEqual([visualKey('v1'), 'table', visualKey('v2'), 'trend', visualKey('v3')]);
  });

  it('moves a key before another or to the end, and steps it past the next shown key', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
    // b is hidden, so a steps past c.
    expect(stepKey(['a', 'b', 'c', 'd'], ['a', 'c', 'd'], 'a', 1)).toEqual(['b', 'c', 'a', 'd']);
    expect(stepKey(['a', 'b', 'c'], ['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(stepKey(['a', 'b'], ['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
  });
});

describe('visual refresh', () => {
  it('asks each source session once to redraw its visuals in place', async () => {
    const failed = await refreshVisuals([
      visual('v1'),
      visual('v2', { session_id: 'session-2' }),
      visual('v3'),
    ]);
    expect(failed).toBeNull();
    const asks = [...sent('session.send'), ...sent('session.steer')];
    expect(asks.map((c) => [c.type, c.input.session_id, c.expected_revision])).toEqual([
      ['session.send', 'session-1', 4],
      ['session.steer', 'session-2', 9],
    ]);
    expect(asks[0].input.input).toContain('"v1"');
    expect(asks[0].input.input).toContain('"v3"');
    expect(asks[0].input.input).toContain('replaces');
    expect(asks[1].input.input).toContain('"v2"');
  });

  it('counts a visual as refreshing until a newer revision is drawn or the asking turn ends', async () => {
    const shown = [visual('v1'), visual('v2')];
    const h = mount(() => useRefreshing(shown));
    expect(await refreshVisual(shown[0]!)).toBeNull();
    expect(await refreshVisual(shown[1]!)).toBeNull();
    h.render();
    expect([...h.value].sort()).toEqual(['v1', 'v2']);

    useBoard.setState({
      events: [
        {
          sequence: 3,
          kind: 'visual.drawn',
          project_id: 'project-1',
          payload: { visual_id: 'v1', revision: 2 },
        },
      ] as never,
    });
    h.render();
    expect([...h.value]).toEqual(['v2']);

    useBoard.setState({
      board: {
        ...useBoard.getState().board,
        session_turns: [{ id: 'turn-2', session_id: 'session-1', state: 'completed' }],
      } as never,
    });
    h.render();
    expect([...h.value]).toEqual([]);
  });

  it('shows the refresh-all progress over the visuals whose session is still there', async () => {
    command.mockImplementation(async (c: { type: string }) => {
      if (c.type === 'visual.list')
        return {
          ok: true,
          value: {
            visuals: [visual('a'), visual('b'), visual('orphan', { session_id: null })],
          },
        };
      if (c.type === 'session.send') return { ok: true, value: { id: 'turn-all' } };
      return { ok: true, value: {} };
    });
    const h = mount(() => useCanvas('project-1'));
    await h.flush();
    expect(h.value.refreshable.map((v: Visual) => v.id)).toEqual(['a', 'b']);
    h.value.refreshAll();
    h.render();
    expect(h.value.progress).toEqual({ done: 0, total: 2 });
    await h.flush();
    expect(sent('session.send')).toHaveLength(1);

    useBoard.setState({
      events: [
        {
          sequence: 4,
          kind: 'visual.drawn',
          project_id: 'project-1',
          payload: { visual_id: 'a', revision: 2 },
        },
      ] as never,
    });
    h.render();
    expect(h.value.progress).toEqual({ done: 1, total: 2 });
    useBoard.setState({
      board: {
        ...useBoard.getState().board,
        session_turns: [{ id: 'turn-all', session_id: 'session-1', state: 'completed' }],
      } as never,
    });
    h.render();
    expect(h.value.progress).toBeNull();
  });

  it('fails a redraw whose asking turn ended with no newer revision, and not while it runs or once drawn', async () => {
    command.mockImplementation(async (c: { type: string }) =>
      c.type === 'session.send' ? { ok: true, value: { id: `turn-${++turn}` } } : { ok: true },
    );
    const shown = [visual('f1'), visual('f2')];
    const h = mount(() => ({ waiting: useRefreshing(shown), failed: useRedrawFailed(shown) }));
    await refreshVisuals(shown);
    h.render();
    expect([...h.value.failed]).toEqual([]);

    useBoard.setState({
      board: {
        ...useBoard.getState().board,
        session_turns: [{ id: 'turn-1', session_id: 'session-1', state: 'running' }],
      } as never,
    });
    h.render();
    expect([...h.value.failed]).toEqual([]);

    useBoard.setState({
      events: [
        {
          sequence: 5,
          kind: 'visual.drawn',
          project_id: 'project-1',
          payload: { visual_id: 'f1', revision: 2 },
        },
      ] as never,
      board: {
        ...useBoard.getState().board,
        session_turns: [{ id: 'turn-1', session_id: 'session-1', state: 'completed' }],
      } as never,
    });
    h.render();
    expect([...h.value.failed]).toEqual(['f2']);
    expect([...h.value.waiting]).toEqual([]);

    // A retry starts a new redraw, which waits again.
    await refreshVisual(shown[1]!);
    h.render();
    expect([...h.value.failed]).toEqual([]);
    expect([...h.value.waiting]).toEqual(['f2']);
  });

  it('keeps a redraw steered into a running session waiting until the running turn ends', async () => {
    command.mockImplementation(async (c: { type: string }) =>
      c.type === 'session.steer' ? { ok: true, value: { id: 'turn-1' } } : { ok: true, value: {} },
    );
    const shown = [visual('s1', { session_id: 'session-2' })];
    const h = mount(() => ({ waiting: useRefreshing(shown), failed: useRedrawFailed(shown) }));
    expect(await refreshVisual(shown[0]!)).toBeNull();
    expect(sent('session.steer')).toHaveLength(1);
    const steer = {
      id: 'turn-1',
      session_id: 'session-2',
      kind: 'steer',
      delivery: 'delivered',
      state: 'completed',
    };
    useBoard.setState({
      board: {
        ...useBoard.getState().board,
        session_turns: [
          { id: 'turn-running', session_id: 'session-2', kind: 'send', state: 'running' },
          steer,
        ],
      } as never,
    });
    h.render();
    expect([...h.value.failed]).toEqual([]);
    expect([...h.value.waiting]).toEqual(['s1']);

    useBoard.setState({
      board: {
        ...useBoard.getState().board,
        session_turns: [
          { id: 'turn-running', session_id: 'session-2', kind: 'send', state: 'completed' },
          steer,
        ],
      } as never,
    });
    h.render();
    expect([...h.value.failed]).toEqual(['s1']);
    expect([...h.value.waiting]).toEqual([]);
  });

  it('counts a failed redraw as ended in the refresh-all progress and marks it on the canvas', async () => {
    command.mockImplementation(async (c: { type: string }) => {
      if (c.type === 'visual.list')
        return { ok: true, value: { visuals: [visual('g1'), visual('g2')] } };
      if (c.type === 'session.send') return { ok: true, value: { id: 'turn-g' } };
      return { ok: true, value: {} };
    });
    const h = mount(() => useCanvas('project-1'));
    await h.flush();
    h.value.refreshAll();
    await h.flush();
    useBoard.setState({
      events: [
        {
          sequence: 6,
          kind: 'visual.drawn',
          project_id: 'project-1',
          payload: { visual_id: 'g1', revision: 2 },
        },
      ] as never,
    });
    h.render();
    expect(h.value.progress).toEqual({ done: 1, total: 2 });
    useBoard.setState({
      board: {
        ...useBoard.getState().board,
        session_turns: [{ id: 'turn-g', session_id: 'session-1', state: 'failed' }],
      } as never,
    });
    h.render();
    expect(h.value.progress).toBeNull();
    expect([...h.value.failed]).toEqual(['g2']);
  });
});

const canvas = (extra: Partial<CanvasState> = {}): CanvasState => ({
  projectId: 'project-1',
  read: { data: [], loading: false, error: null, gone: false },
  editing: false,
  setEditing: vi.fn(),
  refreshable: [],
  refreshing: new Set(),
  failed: new Set(),
  progress: null,
  refreshAll: vi.fn(),
  error: null,
  ...extra,
});

const place = (key: string, extra: Partial<PanelPlace> = {}): PanelPlace => ({
  key,
  span: 12,
  height: 'auto',
  hidden: false,
  ...extra,
});
const panel = (key: string, title: string, extra: Partial<PanelPlace> = {}): CanvasPanel => ({
  place: place(key, extra),
  title,
  node: createElement('section', { 'aria-label': title }, title),
});
const PANELS = [panel('table', '进度表'), panel('trend', '完成趋势', { span: 6 })];

function view(
  props: {
    projectId?: string;
    canvas?: CanvasState;
    panels?: CanvasPanel[];
    boardEmpty?: boolean;
  } = {},
) {
  const onLayout = vi.fn();
  const onDraw = vi.fn();
  const h = mount(() =>
    CanvasGrid({
      projectId: props.projectId ?? 'project-1',
      canvas: props.canvas ?? canvas(),
      panels: props.panels ?? PANELS,
      boardEmpty: props.boardEmpty ?? false,
      onLayout,
      onDraw,
    }),
  );
  return { h, onLayout, onDraw };
}
const cells = (tree: ReactNode) =>
  nodes(tree).filter(
    (n) => typeof n.props.className === 'string' && /\bcv-cell\b/.test(n.props.className),
  );
const cellName = (cell: ReactElement<any>) => {
  const card = nodes(cell.props.children).find((n) => n.props.visual);
  return card
    ? card.props.visual.id
    : find(cell.props.children, (n) => n.type === 'section').props['aria-label'];
};
const labelled = (tree: ReactNode, label: string) =>
  find(tree, (n) => n.props['aria-label'] === label);

describe('canvas view', () => {
  it('lays the pinned visuals out with the panels in one grid, each visual as its card', () => {
    const { h } = view({
      canvas: canvas({ read: { data: [visual('v1')], loading: false, error: null, gone: false } }),
    });
    const shown = cells(h.value);
    expect(shown.map(cellName)).toEqual(['进度表', '完成趋势', 'v1']);
    expect(shown.map((c) => c.props.className.split(' ')[0])).toEqual(['bd-s12', 'bd-s6', 'bd-s6']);
    const card = nodes(shown[2]).find((n) => n.props.visual)!;
    expect(card.props.size).toBe('M');
  });

  it('spans a visual over the columns of its pinned width, and six without one', () => {
    const data = [4, 8, 12, undefined].map((width, i) =>
      visual(`w${i}`, {
        pin: { size: 'M', position: i, ...(width && { width }) } as Visual['pin'],
      }),
    );
    const { h } = view({
      panels: [],
      canvas: canvas({ read: { data, loading: false, error: null, gone: false } }),
    });
    expect(cells(h.value).map((c) => c.props.className.split(' ')[0])).toEqual([
      'bd-s4',
      'bd-s8',
      'bd-s12',
      'bd-s6',
    ]);
  });

  it('offers the width tiers beside the size of each visual while editing and pins at the picked width', async () => {
    const { h } = view({
      panels: [],
      canvas: canvas({
        editing: true,
        read: {
          data: [visual('v1', { pin: { size: 'S', width: 4, position: 0 } })],
          loading: false,
          error: null,
          gone: false,
        },
      }),
    });
    const [width] = nodes(h.value).filter((n) => n.props['aria-label'] === canvasText('width'));
    expect(width!.props.value).toBe(4);
    expect(nodes(width!.props.children).map((n) => n.props.value)).toEqual([4, 6, 8, 12]);
    width!.props.onValueChange(12);
    await h.flush();
    expect(sent('visual.pin').map((c) => c.input)).toEqual([
      { visual_id: 'v1', size: 'S', width: 12 },
    ]);
  });

  it('marks the cards whose redraw failed', () => {
    const { h } = view({
      canvas: canvas({
        read: { data: [visual('v1'), visual('v2')], loading: false, error: null, gone: false },
        failed: new Set(['v2']),
      }),
    });
    const cards = nodes(h.value).filter((n) => n.props.visual);
    expect(cards.map((c) => c.props.failed)).toEqual([false, true]);
  });

  it('gives a card its own refresh, marks the cards a redraw is asked of, and offers none once the session is gone', () => {
    const { h } = view({
      canvas: canvas({
        read: {
          data: [visual('v1'), visual('v2', { session_id: null })],
          loading: false,
          error: null,
          gone: false,
        },
        refreshing: new Set(['v1']),
      }),
    });
    const cards = nodes(h.value).filter((n) => n.props.visual);
    expect(cards.map((c) => typeof c.props.onRefresh)).toEqual(['function', 'undefined']);
    expect(cards.map((c) => c.props.refreshing)).toEqual([true, false]);
  });

  it('gives a panel with a picked height its height tier and leaves hidden panels out', () => {
    const { h } = view({
      panels: [
        panel('table', '进度表', { height: 'L' }),
        panel('trend', '完成趋势', { hidden: true }),
      ],
    });
    const shown = cells(h.value);
    expect(shown.map(cellName)).toEqual(['进度表']);
    expect(shown[0]!.props['data-h']).toBe('L');
  });

  it('says the canvas has no drawing yet and offers to ask an agent for one', () => {
    const { h, onDraw } = view({ boardEmpty: true });
    expect(cells(h.value)).toEqual([]);
    expect(text(h.value)).toContain(canvasText('empty'));
    const draw = find(h.value, (n) => n.type === 'button' && text(n).includes(canvasText('draw')));
    draw.props.onClick();
    expect(onDraw).toHaveBeenCalled();
  });

  it('draws the column guides, a drag handle, the size tiers and remove on every card while editing', () => {
    const { h } = view({
      canvas: canvas({
        editing: true,
        read: { data: [visual('v1')], loading: false, error: null, gone: false },
      }),
    });
    const guides = find(h.value, (n) => n.props.className === 'cv-guides');
    expect(nodes(guides.props.children).filter((n) => n.type === 'i')).toHaveLength(12);
    expect(labelled(h.value, canvasText('drag', { title: '进度表' })).props.draggable).toBe(true);
    expect(labelled(h.value, canvasText('drag', { title: 'drawing v1' })).props.draggable).toBe(
      true,
    );
    const sizes = nodes(h.value).filter((n) => n.props['aria-label'] === canvasText('size'));
    expect(sizes).toHaveLength(3);
    expect(
      nodes(h.value).filter((n) => n.props['aria-label'] === canvasText('width')),
    ).toHaveLength(3);
    expect(sizes[2]!.props.value).toBe('M');
    expect(
      nodes(h.value).filter((n) => n.type === 'button' && text(n) === canvasText('remove')),
    ).toHaveLength(3);
  });

  it('offers a panel its half and full width and the auto height beside the fixed ones', () => {
    const { h, onLayout } = view({ canvas: canvas({ editing: true }) });
    const widths = nodes(h.value).filter((n) => n.props['aria-label'] === canvasText('width'));
    expect(widths.map((w) => w.props.value)).toEqual([12, 6]);
    expect(nodes(widths[0]!.props.children).map((n) => n.props.value)).toEqual([6, 12]);
    const sizes = nodes(h.value).filter((n) => n.props['aria-label'] === canvasText('size'));
    expect(sizes[0]!.props.value).toBe('auto');
    expect(nodes(sizes[0]!.props.children).map((n) => n.props.value)).toEqual([
      'auto',
      'S',
      'M',
      'L',
    ]);
    expect(text(nodes(sizes[0]!.props.children)[0]!)).toBe(zh('board.layout.auto'));
    widths[0]!.props.onValueChange(6);
    sizes[0]!.props.onValueChange('L');
    sizes[0]!.props.onValueChange('auto');
    const placed = onLayout.mock.calls.map(([change]) => {
      const table = (change as (l: BoardLayout) => BoardLayout)({
        ...DEFAULT_LAYOUT,
        progress: [place('table', { height: 'M' })],
      }).progress[0]!;
      return [table.span, table.height];
    });
    expect(placed).toEqual([
      [6, 'M'],
      [12, 'L'],
      [12, 'auto'],
    ]);
  });

  it('moves a card with the arrow keys on its handle and keeps the order', () => {
    const { h } = view({ projectId: 'project-keys', canvas: canvas({ editing: true }) });
    labelled(h.value, canvasText('drag', { title: '进度表' })).props.onKeyDown({
      key: 'ArrowDown',
      preventDefault() {},
    });
    h.render();
    expect(readCanvasOrder('project-keys')).toEqual(['trend', 'table']);
    expect(cells(h.value).map(cellName)).toEqual(['完成趋势', '进度表']);
  });

  it('sends the new pinned order when a visual is dropped before another', async () => {
    const data = [visual('v1'), visual('v2')];
    const { h } = view({
      canvas: canvas({ editing: true, read: { data, loading: false, error: null, gone: false } }),
    });
    const data0 = { setData() {}, setDragImage() {}, effectAllowed: '' };
    labelled(h.value, canvasText('drag', { title: 'drawing v2' })).props.onDragStart({
      dataTransfer: data0,
      currentTarget: { closest: () => null },
    });
    h.render();
    const target = cells(h.value).find((c) => cellName(c) === 'v1')!;
    target.props.onDragOver({ preventDefault() {} });
    target.props.onDrop({ preventDefault() {} });
    h.render();
    await h.flush();
    expect(sent('visual.arrange').map((c) => c.input)).toEqual([
      { project_id: 'project-1', order: ['v2', 'v1'] },
    ]);
    expect(cells(h.value).map(cellName)).toEqual(['进度表', '完成趋势', 'v2', 'v1']);
  });

  it('pins a visual at the picked size, unpins it on remove and hides a removed panel', async () => {
    const { h, onLayout } = view({
      canvas: canvas({
        editing: true,
        read: { data: [visual('v1')], loading: false, error: null, gone: false },
      }),
    });
    const sizes = nodes(h.value).filter((n) => n.props['aria-label'] === canvasText('size'));
    sizes[2]!.props.onValueChange('L');
    const removes = nodes(h.value).filter(
      (n) => n.type === 'button' && text(n) === canvasText('remove'),
    );
    removes[2]!.props.onClick();
    await h.flush();
    expect(sent('visual.pin').map((c) => c.input)).toEqual([{ visual_id: 'v1', size: 'L' }]);
    expect(sent('visual.unpin').map((c) => c.input)).toEqual([{ visual_id: 'v1' }]);

    removes[0]!.props.onClick();
    const change = onLayout.mock.calls[0]![0] as (l: BoardLayout) => BoardLayout;
    expect(change(DEFAULT_LAYOUT).progress.find((p) => p.key === 'table')!.hidden).toBe(true);
  });
});

describe('canvas bar', () => {
  const buttons = (tree: ReactNode) =>
    nodes(tree)
      .filter((n) => n.type === 'button')
      .map((n) => [text(n), n.props['aria-disabled'] ?? false]);

  it('offers refresh all and edit layout, and done while editing', () => {
    const state = canvas({ refreshable: [visual('v1')] });
    expect(buttons(CanvasBar({ canvas: state, empty: false }))).toEqual([
      [canvasText('refreshAll'), false],
      [canvasText('editLayout'), false],
    ]);
    nodes(CanvasBar({ canvas: state, empty: false }))
      .find((n) => text(n) === canvasText('editLayout'))!
      .props.onClick();
    expect(state.setEditing).toHaveBeenCalledWith(true);
    expect(buttons(CanvasBar({ canvas: canvas({ editing: true }), empty: false }))).toEqual([
      [canvasText('done'), false],
    ]);
  });

  it('counts the refresh and holds edit layout until it ends, and holds both on an empty canvas', () => {
    const busy = canvas({
      refreshable: [visual('v1'), visual('v2')],
      progress: { done: 1, total: 2 },
    });
    expect(buttons(CanvasBar({ canvas: busy, empty: false }))).toEqual([
      [canvasText('refreshing', { done: 1, total: 2 }), true],
      [canvasText('editLayout'), true],
    ]);
    expect(buttons(CanvasBar({ canvas: canvas(), empty: true }))).toEqual([
      [canvasText('refreshAll'), true],
      [canvasText('editLayout'), true],
    ]);
  });
});
