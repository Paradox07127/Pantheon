import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel, TaskTraceKind } from '@pantheon/protocol';
import {
  ArrowRight,
  ChartColumn,
  CheckCheck,
  Eye,
  EyeOff,
  RotateCcw,
  Square,
  Table2,
  Trash,
  UserPen,
  X,
} from '../../apps/web/node_modules/lucide-react';
import { find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true, useId: 'icons' }),
);
// The real zustand hook runs on React's own dispatcher; read the store directly instead.
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async () => {
  const { createStore } = await vi.importActual<any>(
    '../../apps/web/node_modules/zustand/esm/vanilla.mjs',
  );
  const build = (init: any) => {
    const api = createStore(init);
    return Object.assign((select = (s: unknown) => s) => select(api.getState()), api);
  };
  return { create: (init?: any) => (init ? build(init) : build) };
});
vi.mock('../../apps/web/node_modules/@xyflow/react/dist/esm/index.mjs', async (actual) => ({
  ...(await actual<object>()),
  useReactFlow: () => ({ setViewport: async () => true }),
}));
vi.mock('@/data/commands', () => ({ runCommand: vi.fn() }));
vi.mock('@/data/runtime-models', () => ({ useRuntimeModels: () => ({}) }));
import { MergeBlockedMark, StateGlyph } from '@/components/SessionStateIcon';
import { useBoard } from '@/data/board';
import { ViewToggle } from '@/screens/board/Charts';
import { FlowChart } from '@/screens/board/FlowPanel';
import { PlanEdit } from '@/screens/board/PlanEdit';
import { TaskDrawer } from '@/screens/board/TaskDrawer';
import { TraceList } from '@/screens/board/TaskTimeline';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { FolderFields, VariableFields } from '@/screens/projects/EnvironmentFields';
import { ProjectsScreen } from '@/screens/projects/ProjectsScreen';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
type Tree = ReturnType<typeof nodes>[number];
const NOW = Date.UTC(2026, 10, 10, 12);
const noop = () => {};

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id: `lead-1:${id}`,
  owner_session_id: 'lead-1',
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: 'lead-1:main',
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
  depends_on: [],
  planned: { runtime: 'codex', model: 'gpt-a', effort: 'high' },
  pending_edit: false,
  ...extra,
});

// a feeds b; the lead has a model change of b waiting.
const board = (b: Partial<Task> = {}): BoardModel =>
  ({
    since: 0,
    now: NOW,
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    merges: [],
    milestones: [],
    tasks: [task('a'), task('b', { depends_on: ['a'], ...b })],
    edges: [{ from: 'lead-1:a', to: 'lead-1:b', state: 'pending' }],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: 0,
        plan_version: 3,
        pending_edits: [
          {
            id: 'edit-1',
            task_ids: ['b'],
            ops: [{ type: 'set_task', task_id: 'b', patch: { model: 'claude-opus' } }],
          },
        ],
        rejected_edits: [],
      },
    ],
  }) as unknown as BoardModel;

const lead = {
  id: 'lead-1',
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state: 'open',
  turn_count: 1,
} as SnapshotSession;
const tell = { sessions: [lead], run: async () => null };

beforeEach(() => {
  const listeners = { addEventListener: noop, removeEventListener: noop };
  vi.stubGlobal('window', {
    ...listeners,
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
    pantheon: { query: () => new Promise(() => {}) },
  });
  vi.stubGlobal('document', { ...listeners, activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null, events: [] });
});

const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
/** The icon element a control or row draws. */
const icon = (node: Tree) =>
  find(
    node.props.children,
    (n) => n.type === 'svg' || typeof n.type === 'function' || typeof n.type === 'object',
  );

describe('task trace glyphs', () => {
  const glyphOf = (kind: TaskTraceKind) => {
    const tree = TraceList({
      entries: [{ at: NOW, kind }],
      merges: [],
      segments: [],
      now: NOW,
      onOpenSession: noop,
      onOpenStory: noop,
    });
    return find(tree, (n) => n.props.className === 'bd-tl-g');
  };

  it('draws the session merge glyphs for a blocked and a finished merge', () => {
    const blocked = icon(glyphOf('merge_blocked'));
    expect(blocked.type).toBe(MergeBlockedMark);
    expect(blocked.props.merge.state).toBe('blocked');
    const merged = icon(glyphOf('merged'));
    expect([merged.type, merged.props.name]).toEqual([StateGlyph, 'merged']);
  });

  it('draws a discarded entry as the slashed circle, not the delete bin', () => {
    const discarded = icon(glyphOf('discarded'));
    expect([discarded.type, discarded.props.name]).toEqual([StateGlyph, 'discarded']);
  });

  it('draws an acceptance as a double check and a user edit as a person with a pen', () => {
    expect(icon(glyphOf('accepted')).type).toBe(CheckCheck);
    expect(icon(glyphOf('user_edit')).type).toBe(UserPen);
  });

  it('keeps the drawn glyphs out of the accessibility tree beside their name', () => {
    expect(glyphOf('merged').props['aria-hidden']).toBe('true');
  });
});

describe('task drawer icons', () => {
  const drawer = (b: Partial<Task> = {}) =>
    mount(() =>
      TaskDrawer({
        model: board(b),
        taskId: 'lead-1:b',
        onSelect: noop,
        onOpenSession: noop,
        onOpenStory: noop,
        tell,
      }),
    );

  it('closes the drawer and removes a dependency with the lucide cross', () => {
    const tree = drawer().value;
    expect(icon(labelled(tree, zh('board.task.drawer.close'))).type).toBe(X);
    const links = nodes(tree).find(
      (n) => n.type === named(tree, 'TaskLinks').type && n.props.remove,
    )!;
    const list = (links.type as (p: object) => ReactElement<any>)(links.props);
    expect(
      icon(labelled(list, zhf('board.task.dependency.remove', { from: 'task a', to: 'task b' })))
        .type,
    ).toBe(X);
  });

  const editor = (b: Partial<Task>) => {
    const props = named(drawer(b).value, 'PlanEdit').props;
    return mount(() => PlanEdit(props)).value;
  };
  const action = (tree: unknown, label: string) =>
    icon(find(tree as never, (n) => n.type === 'button' && text(n) === label));

  it('draws stop, restart and delete with lucide icons', () => {
    const claim = { session_id: 's1', runtime: 'codex', model: 'gpt-a' };
    const running = editor({ state: 'running', claim });
    expect(action(running, zh('board.plan.task.stop')).type).toBe(Square);
    const failed = editor({ state: 'failed', claim });
    expect(action(failed, zh('board.plan.task.restart')).type).toBe(RotateCcw);
    expect(action(failed, zh('board.plan.task.remove')).type).toBe(Trash);
    for (const label of [zh('board.plan.task.restart'), zh('board.plan.task.remove')])
      expect(action(failed, label).props['aria-hidden']).toBe('true');
  });

  it('draws the old-to-new arrow of a waiting edit with lucide', () => {
    const tree = editor({});
    const change = find(tree, (n) => n.props.className === 'bd-diff');
    expect(icon(change).type).toBe(ArrowRight);
  });
});

describe('flow chart icons', () => {
  type ChartProps = Parameters<typeof FlowChart>[0];
  const box = (tree: unknown) =>
    find(tree as any, (n) => String(n.props.className ?? '').startsWith('bd-fc'));
  const canvas = () => {
    const all: ChartProps = {
      model: board(),
      selected: null,
      onSelect() {},
      title: 'flow',
      tell,
      editing: true,
    };
    const Canvas = find(
      FlowChart(all),
      (n) => typeof n.type === 'function' && n.type.name === 'FlowCanvas',
    ).type as (p: ChartProps) => ReactElement<any>;
    return mount(() => {
      const tree = Canvas(all);
      box(tree).props.ref.current ??= { clientWidth: 1000 };
      return tree;
    });
  };

  it('deletes a picked dependency with the lucide bin', () => {
    const h = canvas();
    const flow = () => find(h.value, (n) => 'nodeTypes' in n.props).props;
    const picked = () => flow().edges[0];
    flow().onEdgeClick({}, picked());
    h.render();
    const Edge = flow().edgeTypes.flow as (p: object) => ReactElement<any>;
    const drawn = Edge({
      id: picked().id,
      source: picked().source,
      target: picked().target,
      sourceX: 0,
      sourceY: 0,
      targetX: 100,
      targetY: 0,
      data: picked().data,
    });
    expect(icon(labelled(drawn, '删除依赖：task a 到 task b')).type).toBe(Trash);
  });
});

describe('chart view toggle icons', () => {
  it('offers the table as a lucide table and the chart as a lucide column chart', () => {
    expect(icon(ViewToggle({ table: false, onToggle: noop })).type).toBe(Table2);
    expect(icon(ViewToggle({ table: true, onToggle: noop })).type).toBe(ChartColumn);
  });
});

describe('project screen icons', () => {
  it('removes a folder and a variable with the lucide cross', () => {
    const folders = mount(() => FolderFields({ value: ['/work/app'], onChange: noop })).value;
    expect(
      icon(labelled(folders, zhf('projects.folders.remove', { root: '/work/app' }))).type,
    ).toBe(X);
    const vars = mount(() =>
      VariableFields({ value: [{ id: 0, key: 'A', value: '1' }], onChange: noop }),
    ).value;
    expect(icon(labelled(vars, zhf('projects.variables.delete', { n: 1 }))).type).toBe(X);
  });

  it('shows a hidden value as a slashed eye and a shown one as an eye', () => {
    const h = mount(() =>
      VariableFields({ value: [{ id: 0, key: 'A', value: '1' }], onChange: noop }),
    );
    expect(icon(labelled(h.value, zhf('projects.variables.show', { n: 1 }))).type).toBe(EyeOff);
    labelled(h.value, zhf('projects.variables.show', { n: 1 })).props.onClick();
    h.render();
    expect(icon(labelled(h.value, zhf('projects.variables.hide', { n: 1 }))).type).toBe(Eye);
  });
});
