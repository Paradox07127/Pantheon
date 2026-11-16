import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'edit-mode' }),
);
const { runCommand, toast } = vi.hoisted(() => ({ runCommand: vi.fn(), toast: vi.fn() }));
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/components/Toast', () => ({ toast }));
vi.mock('@/data/runtime-models', () => ({
  useRuntimeModels: (_project: string, runtimes: string[]) =>
    Object.fromEntries(runtimes.map((runtime) => [runtime, { state: 'ready', models: [] }])),
}));
import { addDraftEdit, discardDraftEdits, draftEdits } from '@/data/plan-draft';
import type { PlanOp } from '@/data/plan-edit';
import {
  DraftTaskForm,
  EditBar,
  EditButton,
  EditMode,
  EditToolbar,
  OrderLock,
  boardEditing,
  setBoardEditing,
} from '@/screens/board/EditMode';
import { OrderLockedMark } from '@/screens/board/status';

type Task = BoardModel['tasks'][number];
type LeadState = NonNullable<BoardModel['leads']>[number]['state'];

const task = (id: string): Task =>
  ({
    id: `lead-1:${id}`,
    owner_session_id: 'lead-1',
    title: `task ${id}`,
    goal: '',
    scope: [],
    lane_id: 'lead-1:main',
    status: 'todo',
    state: 'todo',
    depends_on: [],
    planned: {},
  }) as unknown as Task;

const board = (state: LeadState = 'idle'): BoardModel =>
  ({
    since: 0,
    now: 0,
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    iterations: [],
    merges: [],
    edges: [],
    tasks: [task('a'), task('b')],
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state,
        inbox: 0,
        updated_at: 0,
        plan_version: 7,
        pending_edits: [],
        rejected_edits: [],
      },
    ],
  }) as unknown as BoardModel;

const target = (planId: string) => ({
  projectId: 'project-a',
  leadId: 'lead-1',
  planId,
  taskId: `lead-1:${planId}`,
});
const rename = (id: string): PlanOp =>
  ({ type: 'set_task', task_id: id, patch: { title: `${id} renamed` } }) as PlanOp;

const edit = (key: string) => zh(`board.editMode.${key}`);
const all = (tree: unknown) => nodes(tree as never);
const byLabel = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const byText = (tree: unknown, label: string) =>
  find(tree as never, (n) => typeof n.props.onClick === 'function' && text(n) === label);

beforeEach(() => {
  runCommand.mockReset();
  runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-1' } });
  toast.mockReset();
});
afterEach(() => {
  unmountAll();
  discardDraftEdits('project-a');
  setBoardEditing('project-a', false);
  setBoardEditing('project-b', false);
});

describe('entering and leaving the board edit mode', () => {
  it('enters edit mode for its own project from the edit button and leaves it with done', () => {
    const button = mount(() => EditButton({ projectId: 'project-a', disabled: false }));
    expect(text(button.value)).toBe(edit('edit'));
    button.value.props.onClick();
    expect(boardEditing('project-a')).toBe(true);
    expect(boardEditing('project-b')).toBe(false);

    const bar = mount(() => EditBar({ model: board(), projectId: 'project-a' }));
    byText(bar.value, edit('done')).props.onClick();
    expect(boardEditing('project-a')).toBe(false);
  });
});

describe('the edit bar', () => {
  it('names the plan version it edits and says when a running lead reads the changes', () => {
    const idle = mount(() => EditBar({ model: board('idle'), projectId: 'project-a' }));
    expect(text(find(idle.value, (n) => n.props.className === 'chip'))).toBe(
      edit('editing').replace('{version}', '7'),
    );
    expect(text(idle.value)).not.toContain(edit('leadRunning'));
    const running = mount(() => EditBar({ model: board('running'), projectId: 'project-a' }));
    expect(text(running.value)).toContain(edit('leadRunning'));
  });

  it('sends the drafted changes and keeps a failure in the bar, not in a toast', async () => {
    addDraftEdit(target('a'), [rename('a')]);
    addDraftEdit(target('b'), [rename('b')]);
    const h = mount(() => EditBar({ model: board(), projectId: 'project-a' }));
    expect(all(h.value).some((n) => n.props.role === 'alert')).toBe(false);
    runCommand.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_input', message: 'Lane missing' },
    });
    byText(h.value, '送出 2 处改动').props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(draftEdits('project-a')).toHaveLength(1);
    h.render();
    const alert = find(h.value, (n) => n.props.role === 'alert');
    expect(text(alert)).toMatch(/^1 处改动没送出：.+/);
    expect(toast).not.toHaveBeenCalled();
  });

  it('asks before discarding every drafted change and names how many go', () => {
    addDraftEdit(target('a'), [rename('a')]);
    addDraftEdit(target('b'), [rename('b')]);
    const h = mount(() => EditBar({ model: board(), projectId: 'project-a' }));
    byText(h.value, zh('board.edits.discard')).props.onClick();
    h.render();
    expect(draftEdits('project-a')).toHaveLength(2);
    const dialog = named(h.value, 'DiscardDrafts');
    const confirm = mount(() => (dialog.type as (p: object) => ReactElement<any>)(dialog.props));
    expect(text(confirm.value)).toContain('放弃 2 处改动？');
    expect(text(confirm.value)).toContain('还没送出的 2 处改动会丢掉，不能撤销。');
    find(
      confirm.value,
      (n) => n.type === 'button' && text(n) === zh('board.edits.discard'),
    ).props.onClick();
    expect(draftEdits('project-a')).toEqual([]);
  });

  it('offers neither send nor discard while nothing is drafted', () => {
    const h = mount(() => EditBar({ model: board(), projectId: 'project-a' }));
    expect(all(h.value).filter((n) => text(n) === zh('board.edits.discard'))).toEqual([]);
    expect(all(h.value).some((n) => /送出/.test(text(n)))).toBe(false);
  });
});

describe('the edit toolbar', () => {
  const handlers = () => ({
    onTask: vi.fn(),
    onMilestone: vi.fn(),
    onConnect: vi.fn(),
  });

  it('hands each tool to its handler and undoes the newest drafted change', () => {
    const on = handlers();
    const first = addDraftEdit(target('a'), [rename('a')]);
    addDraftEdit(target('b'), [rename('b')]);
    const h = mount(() => EditToolbar({ projectId: 'project-a', connecting: true, ...on }));
    expect(byLabel(h.value, edit('tools'))).toBeTruthy();
    for (const [label, fn] of [
      [edit('tools.task'), on.onTask],
      [edit('tools.milestone'), on.onMilestone],
      [edit('tools.connect'), on.onConnect],
    ] as const) {
      byText(h.value, label).props.onClick();
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(byText(h.value, edit('tools.connect')).props['aria-pressed']).toBe(true);
    byText(h.value, edit('tools.undo')).props.onClick();
    expect(draftEdits('project-a').map((d) => d.key)).toEqual([first]);
  });

  it('has nothing to undo while nothing is drafted', () => {
    const h = mount(() =>
      EditToolbar({ projectId: 'project-a', connecting: false, ...handlers() }),
    );
    expect(byText(h.value, edit('tools.undo')).props.disabled).toBe(true);
  });

  it('offers no auto layout tool, as the chart always lays itself out', () => {
    const h = mount(() =>
      EditToolbar({ projectId: 'project-a', connecting: false, ...handlers() }),
    );
    expect(all(h.value).filter((n) => text(n) === '自动排版')).toEqual([]);
  });
});

describe('locking the task order', () => {
  const ordered = (locked: boolean): BoardModel => {
    const model = board();
    return {
      ...model,
      tasks: ['a', 'b', 'c'].map((id, order) => ({
        ...task(id),
        order,
        ...(locked && id !== 'c' ? { order_locked: true as const } : {}),
      })),
    };
  };
  const pick = (tree: unknown, title: string) =>
    find(
      find(tree as never, (n) => n.type === 'label' && text(n) === title),
      (n) => n.type === 'input',
    ).props.onChange();
  const editOf = (ops: unknown[]) => [
    'board.plan.edit',
    { project_id: 'project-a', lead_session_id: 'lead-1', base_version: 7, ops },
    null,
  ];

  it('locks the order of the picked tasks once two are picked, by their plan ids', async () => {
    const h = mount(() => OrderLock({ model: ordered(false), projectId: 'project-a' }));
    expect(byText(h.value, edit('lockOrder')).props.disabled).toBe(true);
    expect(all(h.value).filter((n) => text(n) === edit('unlockOrder'))).toEqual([]);
    pick(h.value, 'task c');
    h.render();
    expect(byText(h.value, edit('lockOrder')).props.disabled).toBe(true);
    pick(h.value, 'task a');
    h.render();
    byText(h.value, edit('lockOrder')).props.onClick();
    await h.flush();
    expect(runCommand.mock.calls).toEqual([editOf([{ type: 'lock_order', task_ids: ['a', 'c'] }])]);
  });

  it('marks the locked tasks and unlocks them', async () => {
    const h = mount(() => OrderLock({ model: ordered(true), projectId: 'project-a' }));
    expect(all(h.value).filter((n) => n.type === OrderLockedMark)).toHaveLength(2);
    expect(OrderLockedMark().props['aria-label']).toBe(zh('board.task.orderLocked'));
    byText(h.value, edit('unlockOrder')).props.onClick();
    await h.flush();
    expect(runCommand.mock.calls).toEqual([editOf([{ type: 'unlock_order' }])]);
  });

  it("shows the daemon's refusal", async () => {
    runCommand.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid_input', message: 'Order lock must name tasks in the plan' },
    });
    const h = mount(() => OrderLock({ model: ordered(true), projectId: 'project-a' }));
    byText(h.value, edit('unlockOrder')).props.onClick();
    await h.flush();
    h.render();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain(
      'Order lock must name tasks in the plan',
    );
  });
});

describe('the edit mode layout', () => {
  it('puts the canvas with its toolbar beside a task column', () => {
    const h = mount(() =>
      EditMode({
        projectId: 'project-a',
        connecting: false,
        onTask() {},
        onMilestone() {},
        onConnect() {},
        side: 'form',
        children: 'canvas',
      }),
    );
    const canvas = byLabel(h.value, edit('canvas'));
    expect(text(canvas)).toBe('canvas');
    expect(named(canvas, 'EditToolbar').props.projectId).toBe('project-a');
    expect(text(byLabel(h.value, edit('side')))).toBe('form');
    expect(byLabel(h.value, edit('side')).type).toBe('aside');
  });

  it('adds a new task from the column to the draft without sending it', async () => {
    const h = mount(() => DraftTaskForm({ model: board(), projectId: 'project-a' }));
    const form = named(h.value, 'NewTaskForm');
    const op: PlanOp = {
      type: 'add_task',
      task: {
        id: 'retry',
        title: 'Retry',
        goal: 'g',
        lane: 'main',
        depends_on: [],
        source: ['g'],
        scope: ['src'],
        acceptance: ['pnpm test'],
      },
    };
    expect(await form.props.onSubmit(op, true)).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
    expect(draftEdits('project-a')).toMatchObject([
      { target: target('retry'), ops: [op], start: true },
    ]);
    h.render();
    expect(named(h.value, 'NewTaskForm').key).not.toBe(form.key);
  });

  it('gives each task added to the draft an id neither the plan nor the draft holds', async () => {
    const h = mount(() => DraftTaskForm({ model: board(), projectId: 'project-a' }));
    // The form picks its id from the plan alone, so two tasks named alike both come as a-2.
    const add = (): PlanOp => ({
      type: 'add_task',
      task: {
        id: 'a-2',
        title: 'A',
        goal: 'g',
        lane: 'main',
        depends_on: [],
        source: ['g'],
        scope: ['src'],
        acceptance: ['pnpm test'],
      },
    });
    await named(h.value, 'NewTaskForm').props.onSubmit(add(), false);
    h.render();
    await named(h.value, 'NewTaskForm').props.onSubmit(add(), false);
    const added = draftEdits('project-a');
    expect(added.map((d) => d.target)).toEqual([target('a-2'), target('a-3')]);
    expect(added.map((d) => d.ops[0]!.type === 'add_task' && d.ops[0]!.task.id)).toEqual([
      'a-2',
      'a-3',
    ]);
  });
});
