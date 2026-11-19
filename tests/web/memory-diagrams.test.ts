import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { Visual } from '@pantheon/domain';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh, zhf } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, {
    layoutEffect: true,
    useId: 'diagrams-id',
  }),
);
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { DiagramsGrid, useDiagrams, type DiagramsState } from '@/screens/memory/DiagramsPage';
import { MemoryScreen } from '@/screens/memory/MemoryScreen';

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

let pinned: Visual[] = [];
const command = vi.fn(
  async (sent: { type: string; input: Record<string, unknown> }): Promise<any> => {
    if (sent.type === 'visual.list') return { ok: true, value: { visuals: pinned } };
    if (sent.type === 'session.send') return { ok: true, value: { id: 'turn-1' } };
    return { ok: true, value: {} };
  },
);
const sent = (type: string) =>
  command.mock.calls.filter(([c]) => c.type === type).map(([c]) => c as any);

beforeEach(() => {
  pinned = [];
  command.mockClear();
  vi.stubGlobal('window', { pantheon: { command, query: command } });
  useBoard.setState({
    events: [],
    resync: 0,
    board: {
      sessions: [{ id: 'session-1', state: 'open', revision: 4 }],
      session_turns: [],
    } as never,
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const state = (extra: Partial<DiagramsState> = {}): DiagramsState => ({
  read: { data: [], loading: false, error: null, gone: false },
  editing: false,
  setEditing: vi.fn(),
  refreshable: [],
  refreshing: new Set(),
  started: new Map(),
  failed: new Set(),
  progress: null,
  refreshAll: vi.fn(),
  error: null,
  ...extra,
});
const grid = (diagrams: DiagramsState) =>
  mount(() => DiagramsGrid({ projectId: 'project-1', diagrams }));
const cards = (tree: ReactNode) => nodes(tree).filter((n) => n.props.visual);
const cells = (tree: ReactNode) => nodes(tree).filter((n) => n.props.className === 'mdg-cell');

describe('memory diagrams tab', () => {
  it('sits between the graph and the learned tabs and draws the pinned diagrams', () => {
    const tree = mount(() => MemoryScreen({ projectId: 'project-1' })).value;
    const tabs = nodes(tree).filter((n) => n.props.className === 'tb-tab');
    expect(tabs.map((n) => n.props.value)).toEqual([
      'overview',
      'entries',
      'graph',
      'diagrams',
      'learned',
    ]);
    expect(text(tabs[3])).toBe(zh('memory.tab.diagrams'));
    const panel = find(
      tree,
      (n) => n.props.value === 'diagrams' && n.props.className === 'bd-body',
    );
    expect(named(panel, 'DiagramsPage').props.projectId).toBe('project-1');
  });

  it('lays each pinned visual out as its card, in pinned order, over the columns of its width', () => {
    const data = [
      visual('v1', { pin: { size: 'S', width: 4, position: 0 } as Visual['pin'] }),
      visual('v2', { session_id: null }),
    ];
    const h = grid(state({ read: { data, loading: false, error: null, gone: false } }));
    expect(cards(h.value).map((c) => [c.props.visual.id, c.props.size])).toEqual([
      ['v1', 'S'],
      ['v2', 'M'],
    ]);
    expect(cells(h.value).map((c) => c.props['data-w'])).toEqual([4, 6]);
    expect(cards(h.value).map((c) => typeof c.props.onRefresh)).toEqual(['function', 'function']);
    expect(cards(h.value).map((c) => c.props.redrawable)).toEqual([true, false]);
    expect(text(h.value)).toContain(`${zh('memory.diagrams.pinned')}2`);
  });

  it('says in one line that nothing is pinned yet', () => {
    const h = grid(state());
    expect(cards(h.value)).toEqual([]);
    expect(find(h.value, (n) => n.props.inline).props.title).toBe(zh('memory.diagrams.empty'));
  });

  it('counts the turns in the redraw all button and turns it off with none to redraw', () => {
    const data = [visual('v1'), visual('v2'), visual('v3', { session_id: null })];
    const read = { data, loading: false, error: null, gone: false };
    const redrawAll = (tree: ReactNode) => {
      const tools = named(tree, 'DiagramsTools');
      const drawn = mount(() => (tools.type as (props: unknown) => ReactNode)(tools.props)).value;
      return find(drawn, (n) => n.type === 'button' && text(n).startsWith('全部重画'));
    };
    const some = redrawAll(grid(state({ read, refreshable: data.slice(0, 2) })).value);
    expect(text(some)).toBe(zhf('memory.diagrams.redrawAll', { count: 2 }));
    expect(text(some)).toBe('全部重画（2 个回合）');
    expect(some.props['aria-disabled']).toBeUndefined();
    const none = redrawAll(grid(state({ read: { ...read, data: data.slice(2) } })).value);
    expect(text(none)).toBe('全部重画（0 个回合）');
    expect(none.props['aria-disabled']).toBe(true);
  });

  it('redraws every pinned visual whose session is still there', async () => {
    pinned = [visual('a'), visual('orphan', { session_id: null })];
    const h = mount(() => useDiagrams('project-1'));
    await h.flush();
    expect(h.value.refreshable.map((v: Visual) => v.id)).toEqual(['a']);
    h.value.refreshAll();
    h.render();
    expect(h.value.progress).toEqual({ done: 0, total: 1 });
    await h.flush();
    expect(sent('session.send')).toHaveLength(1);
  });

  it('sends the new pinned order when a diagram is dropped before another while editing', async () => {
    const data = [visual('v1'), visual('v2')];
    const h = grid(
      state({ editing: true, read: { data, loading: false, error: null, gone: false } }),
    );
    const grip = find(
      h.value,
      (n) => n.props['aria-label'] === zhf('memory.diagrams.drag', { title: 'drawing v2' }),
    );
    grip.props.onDragStart({
      dataTransfer: { setData() {}, setDragImage() {}, effectAllowed: '' },
      currentTarget: { closest: () => null },
    });
    h.render();
    const target = cells(h.value)[0] as ReactElement<any>;
    target.props.onDragOver({ preventDefault() {} });
    target.props.onDrop({ preventDefault() {} });
    h.render();
    await h.flush();
    expect(sent('visual.arrange').map((c) => c.input)).toEqual([
      { project_id: 'project-1', order: ['v2', 'v1'] },
    ]);
    expect(cards(h.value).map((c) => c.props.visual.id)).toEqual(['v2', 'v1']);
  });

  it('unpins a diagram from its edit row', async () => {
    const h = grid(
      state({
        editing: true,
        read: { data: [visual('v1')], loading: false, error: null, gone: false },
      }),
    );
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === zh('memory.diagrams.unpin'),
    ).props.onClick();
    await h.flush();
    expect(sent('visual.unpin').map((c) => c.input)).toEqual([{ visual_id: 'v1' }]);
  });
});
