import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, named, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'edit-mount' }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign(
    (selector: any) => selector({ openSession() {}, openSessionGroup() {}, openTaskSession() {} }),
    { setState() {} },
  ),
}));
vi.mock('@/data/runtime-models', () => ({
  useRuntimeModels: (_project: string, runtimes: string[]) =>
    Object.fromEntries(runtimes.map((runtime) => [runtime, { state: 'ready', models: [] }])),
}));
import { addDraftEdit, discardDraftEdits } from '@/data/plan-draft';
import type { PlanOp } from '@/data/plan-edit';
import { BoardView } from '@/screens/board/BoardScreen';
import { boardEditing, setBoardEditing } from '@/screens/board/EditMode';
import { MainView } from '@/screens/board/MainView';

const NOW = Date.UTC(2026, 10, 13, 12);
const noop = () => {};
type Task = BoardModel['tasks'][number];

const task = (id: string): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
    goal: '',
    scope: [],
    lane_id: 'lead-1:main',
    milestone_id: null,
    status: 'todo',
    state: 'todo',
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
    depends_on: [],
    planned: {},
    pending_edit: false,
  }) as unknown as Task;

const board = (): BoardModel =>
  ({
    since: NOW - 7 * 86_400_000,
    now: NOW,
    headline: null,
    counts: {
      running: 0,
      waiting: 0,
      ready: 1,
      failed: 0,
      merged: 0,
      median_ms: null,
      tokens: 0,
      tokens_by_runtime: {},
      previous: { tokens: 0, cost_usd: null, merged: 0, median_ms: null },
      cost_usd: null,
    },
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    iterations: [],
    tasks: [task('a'), task('b')],
    edges: [],
    milestones: [],
    burnup: [],
    task_progress: {
      totals: {
        done: 0,
        running: 0,
        waiting: 0,
        idle: 0,
        ready: 2,
        failed: 0,
        discarded: 0,
        not_started: 0,
      },
      daily: [],
      cycle: { median_ms: null, p90_ms: null, sample_count: 0, buckets: [] },
    },
    usage: [],
    models: [],
    merges: [],
    findings: [],
    risks: [],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: NOW,
        plan_version: 4,
        pending_edits: [],
        rejected_edits: [],
      },
    ],
  }) as unknown as BoardModel;

const view = (page: 'now' | 'canvas' = 'now', onPage = noop) =>
  BoardView({
    model: board(),
    loading: false,
    error: null,
    onRetry: noop,
    range: 7,
    onRange: noop,
    page,
    onPage,
    projectId: 'project-a',
    onOpenSession: noop,
    onOpenStory: noop,
    onOpenTrace: noop,
    actions: { milestones: [], sessions: [], run: vi.fn() },
  });

const has = (tree: ReactNode, name: string) =>
  nodes(tree).some((n) => typeof n.type === 'function' && n.type.name === name);

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [], workspaces: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(() => new Promise(() => {})),
      command: vi.fn(async () => ({ ok: true, value: null })),
    },
  });
});
afterEach(() => {
  unmountAll();
  discardDraftEdits('project-a');
  setBoardEditing('project-a', false);
  vi.unstubAllGlobals();
});

describe('the board in edit mode', () => {
  it('draws the flow chart read-only until the edit button puts the board in edit mode', () => {
    const h = mount(() => view());
    expect(named(h.value, 'MainView').props.editing).toBe(false);
    expect(named(h.value, 'EditMode').props.on).toBe(false);
    expect(has(h.value, 'EditBar')).toBe(false);
    expect(has(h.value, 'UnsentEdits')).toBe(false);

    const edit = named(h.value, 'EditButton');
    mount(() => (edit.type as (p: object) => ReactElement<any>)(edit.props)).value.props.onClick();
    h.render();
    expect(named(h.value, 'MainView').props.editing).toBe(true);
    const body = named(h.value, 'EditMode');
    expect(body.props.on).toBe(true);
    expect(has(body.props.side, 'DraftTaskForm')).toBe(true);
    expect(has(body.props.side, 'UnsentEdits')).toBe(true);
    expect(has(h.value, 'EditBar')).toBe(true);
    expect(has(h.value, 'EditButton')).toBe(false);
  });

  it("keeps the leads' plan proposals on the board outside edit mode as well as in it", () => {
    const h = mount(() => view());
    expect(has(h.value, 'PlanProposals')).toBe(true);

    const edit = named(h.value, 'EditButton');
    mount(() => (edit.type as (p: object) => ReactElement<any>)(edit.props)).value.props.onClick();
    h.render();
    expect(has(h.value, 'PlanProposals')).toBe(true);
    expect(has(named(h.value, 'EditMode').props.side, 'PlanProposals')).toBe(false);
  });

  it('hands the edit mode to the flow chart of the main view, and only then', () => {
    const props = {
      model: board(),
      projectId: 'project-a',
      selected: null,
      onSelect: noop,
      onOpenSession: noop,
      onOpenStory: noop,
    };
    const editing = mount(() => MainView({ ...props, editing: true }));
    expect(named(editing.value, 'FlowChart').props.editing).toBe(true);
    const reading = mount(() => MainView(props));
    expect(named(reading.value, 'FlowChart').props.editing).toBeFalsy();
  });

  it('opens the task column for a new task instead of a dialog, entering edit mode first', () => {
    const focus = vi.fn();
    const h = mount(() => view());
    const button = named(h.value, 'NewTask');
    const shown = mount(() => (button.type as (p: object) => ReactNode)(button.props));
    find(shown.value, (n) => n.type === 'button').props.onClick();
    expect(has(shown.value, 'NewTaskForm')).toBe(false);
    h.render();
    expect(boardEditing('project-a')).toBe(true);
    const side = named(h.value, 'EditMode').props.side;
    const titleRef = named(side, 'DraftTaskForm').props.titleRef;
    titleRef.current = { focus };
    named(h.value, 'NewTask').props.onNew();
    h.render();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(has(h.value, 'NewTaskForm')).toBe(false);

    named(h.value, 'EditMode').props.onTask();
    h.render();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it('puts the main view back in place once done, and counts the changes left on the edit button', () => {
    setBoardEditing('project-a', true);
    const h = mount(() => view());
    const inside = (tree: ReactNode) =>
      find(named(tree, 'EditMode').props.children, (n) => n.props.className === 'bd-cv');
    expect(has(inside(h.value), 'MainView')).toBe(true);
    addDraftEdit({ projectId: 'project-a', leadId: 'lead-1', planId: 'a', taskId: 'lead-1:a' }, [
      { type: 'set_task', task_id: 'a', patch: { title: 'renamed' } } as PlanOp,
    ]);
    setBoardEditing('project-a', false);
    h.render();
    expect(named(h.value, 'EditMode').props.on).toBe(false);
    expect(has(inside(h.value), 'MainView')).toBe(true);
    expect(named(h.value, 'MainView').props.editing).toBe(false);
    expect(has(h.value, 'EditBar')).toBe(false);
    expect(named(h.value, 'EditButton').props.count).toBe(1);
  });

  it('leaves the edit button off the canvas view', () => {
    const h = mount(() => view('canvas'));
    expect(has(h.value, 'EditButton')).toBe(false);
  });
});
