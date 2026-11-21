import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { inputSchemas, type BoardModel } from '@pantheon/protocol';
import { HookHost, find, named, nodes, text, mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { useId: 'new-task' }),
);
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({ read: { state: 'loading' } }),
}));
const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/data/runtime-models', () => ({
  useRuntimeModels: (_project: string, runtimes: string[]) =>
    Object.fromEntries(
      runtimes.map((runtime) => [
        runtime,
        {
          state: 'ready',
          models: [
            { id: 'gpt-a', label: 'gpt a', efforts: ['low', 'high'], default: true },
            { id: 'claude-opus', label: 'opus', efforts: ['high', 'xhigh'], default: false },
          ],
        },
      ]),
    ),
}));
import {
  clearPlanEdit,
  editPlan,
  editTiming,
  opChanges,
  unsentEdits,
  type PlanOp,
} from '@/data/plan-edit';
import { discardDraftEdits, draftEdits, sendDraftEdits } from '@/data/plan-draft';
import { DraftTaskForm } from '@/screens/board/EditMode';
import { NewTask, newTaskId, newTaskOp, type NewTaskDraft } from '@/screens/board/NewTask';
import { PlanEdit } from '@/screens/board/PlanEdit';
import { UnsentEdits } from '@/screens/board/UnsentEdits';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
type Lead = NonNullable<BoardModel['leads']>[number];
const NOW = Date.UTC(2026, 10, 12, 12);

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
  planned: {},
  pending_edit: false,
  ...extra,
});

const board = (tasks: Task[] = [task('a'), task('b')], lead: Partial<Lead> = {}): BoardModel =>
  ({
    since: 0,
    now: NOW,
    lanes: [
      { id: 'lead-1:main', title: 'main' },
      { id: 'lead-1:side', title: 'side' },
    ],
    merges: [],
    edges: [],
    tasks,
    leads: [
      {
        session_id: 'lead-1',
        title: 'lead',
        state: 'idle',
        inbox: 0,
        updated_at: 0,
        plan_version: 3,
        pending_edits: [],
        rejected_edits: [],
        ...lead,
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
const scope = { project_id: 'project-a', lead_session_id: 'lead-1' };

const draft = (extra: Partial<NewTaskDraft> = {}): NewTaskDraft => ({
  title: 'Ship importer!',
  goal: 'Import the CSV files the user drops',
  lane: 'main',
  dependsOn: ['a'],
  scope: 'src/import\n\n  src/csv  ',
  acceptance: 'pnpm test',
  priority: 'high',
  doneWhen: 'merged',
  route: { runtime: 'codex', model: 'gpt-a', effort: 'high' },
  path: null,
  iteration: null,
  taskType: null,
  budget: '',
  ...extra,
});

const accepted = (ops: unknown[]) =>
  inputSchemas['board.plan.edit'].safeParse({ ...scope, base_version: 3, ops }).success;

beforeEach(() => {
  runCommand.mockReset();
  runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-1' } });
});
afterEach(() => {
  unmountAll();
  for (const id of ['lead-1:a', 'lead-1:b', 'lead-1:ship-importer']) clearPlanEdit(id);
  discardDraftEdits('project-a');
});

describe('new task form', () => {
  it('builds an add_task op the protocol accepts, with an id no task of the plan has', () => {
    const built = newTaskOp(draft(), new Set(['a', 'ship-importer', 'ship-importer-2']));
    expect(built).toEqual({
      op: {
        type: 'add_task',
        task: {
          id: 'ship-importer-3',
          title: 'Ship importer!',
          goal: 'Import the CSV files the user drops',
          lane: 'main',
          depends_on: ['a'],
          source: ['Import the CSV files the user drops'],
          scope: ['src/import', 'src/csv'],
          acceptance: ['pnpm test'],
          priority: 'high',
          done_when: 'merged',
          runtime: 'codex',
          model: 'gpt-a',
          effort: 'high',
        },
      },
    });
    expect(accepted(['op' in built ? built.op : null])).toBe(true);
    expect(newTaskId('导入任务', new Set())).toBe('task');
    expect(newTaskId('导入任务', new Set(['task']))).toBe('task-2');
    expect(newTaskId('x'.repeat(60), new Set())).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
  });

  it('refuses an empty title and any field over the protocol limits', () => {
    const taken = new Set<string>();
    expect(newTaskOp(draft({ title: '   ' }), taken)).toEqual({ problem: 'title' });
    expect(newTaskOp(draft({ title: 'x'.repeat(81) }), taken)).toEqual({ problem: 'title' });
    expect(newTaskOp(draft({ goal: '' }), taken)).toEqual({ problem: 'goal' });
    expect(newTaskOp(draft({ goal: 'x'.repeat(401) }), taken)).toEqual({ problem: 'goal' });
    expect(newTaskOp(draft({ scope: '' }), taken)).toEqual({ problem: 'scope' });
    expect(newTaskOp(draft({ acceptance: 'x'.repeat(401) }), taken)).toEqual({
      problem: 'acceptance',
    });
    const report = newTaskOp(draft({ doneWhen: 'report', scope: '', acceptance: '' }), taken);
    expect(accepted(['op' in report ? report.op : null])).toBe(true);
  });

  /** The task column's form, rendered on its own from the props the column gives it. */
  function openForm(model: BoardModel) {
    const column = mount(() => DraftTaskForm({ model, projectId: 'project-a' }));
    const form = column.value as ReactElement<any>;
    return mount(() => (form.type as (p: object) => ReactElement<any>)(form.props));
  }
  const field = (tree: unknown, label: string) =>
    find(tree as never, (n) => n.props['aria-label'] === label);
  const submit = (tree: unknown) =>
    find(tree as never, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });

  it('checks the spelling of the goal only', () => {
    const form = openForm(board());
    expect(field(form.value, zh('board.newTask.goal')).props.spellCheck).toBe(true);
    expect(field(form.value, zh('board.newTask.scope')).props.spellCheck).toBeUndefined();
  });

  it('sends the filled form as add_task on the plan version and refuses an empty title', async () => {
    const form = openForm(board());
    submit(form.value);
    form.render();
    expect(runCommand).not.toHaveBeenCalled();
    expect(text(find(form.value, (n) => n.props.role === 'alert'))).toBe(
      zhf('board.newTask.problem.title', { max: 80 }),
    );
    expect(field(form.value, zh('board.plan.field.title')).props['aria-invalid']).toBe(true);

    field(form.value, zh('board.plan.field.title')).props.onChange({ target: { value: 'task a' } });
    form.render();
    field(form.value, zh('board.newTask.goal')).props.onChange({
      target: { value: 'Add retries' },
    });
    form.render();
    field(form.value, zh('board.plan.field.lane')).props.onChange('side');
    form.render();
    field(form.value, zh('board.newTask.scope')).props.onChange({ target: { value: 'src/retry' } });
    form.render();
    field(form.value, zh('board.newTask.acceptance')).props.onChange({
      target: { value: 'pnpm test' },
    });
    form.render();
    submit(form.value);
    await form.flush();
    await sendDraftEdits(board(), 'project-a');
    const [type, input] = runCommand.mock.calls[0]!;
    expect(type).toBe('board.plan.edit');
    expect(input).toMatchObject({ ...scope, base_version: 3 });
    expect(input.ops).toEqual([
      {
        type: 'add_task',
        task: {
          id: 'task-a',
          title: 'task a',
          goal: 'Add retries',
          lane: 'side',
          depends_on: [],
          source: ['Add retries'],
          scope: ['src/retry'],
          acceptance: ['pnpm test'],
          priority: 'normal',
          done_when: 'merged',
        },
      },
    ]);
    expect(accepted(input.ops)).toBe(true);
  });

  it('gives a task added to the draft an id no earlier unsent addition has', async () => {
    for (const title of ['导入任务', '重试任务']) {
      const form = openForm(board());
      for (const [label, value] of [
        [zh('board.plan.field.title'), title],
        [zh('board.newTask.goal'), 'Add retries'],
        [zh('board.newTask.scope'), 'src/retry'],
        [zh('board.newTask.acceptance'), 'pnpm test'],
      ]) {
        field(form.value, label!).props.onChange({ target: { value } });
        form.render();
      }
      submit(form.value);
      await form.flush();
    }
    expect(draftEdits('project-a').map((d) => d.target.planId)).toEqual(['task', 'task-2']);
  });

  it('names the flow path the user picked, with the reason, and leaves both out by default', async () => {
    const chosen = newTaskOp(draft({ path: 'review_loop' }), new Set());
    expect('op' in chosen && chosen.op.task).toMatchObject({
      path: 'review_loop',
      flow_reason: 'Chosen by the user',
    });
    expect(accepted(['op' in chosen ? chosen.op : null])).toBe(true);
    const form = openForm(board());
    expect(field(form.value, zh('board.plan.field.path')).props.value).toBe('');
    for (const [label, value] of [
      [zh('board.plan.field.title'), 'task a'],
      [zh('board.newTask.goal'), 'Add retries'],
      [zh('board.newTask.scope'), 'src/retry'],
      [zh('board.newTask.acceptance'), 'pnpm test'],
    ]) {
      field(form.value, label!).props.onChange({ target: { value } });
      form.render();
    }
    submit(form.value);
    await form.flush();
    await sendDraftEdits(board(), 'project-a');
    const sent = runCommand.mock.calls[0]![1].ops[0].task;
    expect('path' in sent || 'flow_reason' in sent).toBe(false);
    const picked = openForm(board());
    field(picked.value, zh('board.plan.field.path')).props.onValueChange('dispatch');
    picked.render();
    for (const [label, value] of [
      [zh('board.plan.field.title'), 'task b'],
      [zh('board.newTask.goal'), 'Add retries'],
      [zh('board.newTask.scope'), 'src/retry'],
      [zh('board.newTask.acceptance'), 'pnpm test'],
    ]) {
      field(picked.value, label!).props.onChange({ target: { value } });
      picked.render();
    }
    submit(picked.value);
    await picked.flush();
    await sendDraftEdits(board(), 'project-a');
    expect(runCommand.mock.calls[1]![1].ops[0].task).toMatchObject({
      path: 'dispatch',
      flow_reason: 'Chosen by the user',
    });
  });

  it('keeps the button off without a lead plan or while the board is out of date', () => {
    const none = { ...board(), leads: [] } as BoardModel;
    const off = (model: BoardModel, disabled: boolean) => {
      const h = mount(() => NewTask({ model, disabled, onNew() {} }));
      const button = find(h.value, (n) => n.type === 'button');
      return [button.props['aria-disabled'], button.props['aria-describedby']];
    };
    expect(off(none, false)).toEqual([true, 'new-task']);
    expect(off(board(), true)).toEqual([true, 'new-task']);
    expect(off(board(), false)).toEqual([undefined, undefined]);
  });
});

describe('editing the record fields of a plan task', () => {
  const target = { projectId: 'project-a', leadId: 'lead-1', planId: 'a', taskId: 'lead-1:a' };
  function editor(planned: Task['planned'] = {}) {
    const model = board([task('a', { planned })]);
    return mount(() =>
      PlanEdit({
        model,
        task: model.tasks[0]!,
        target,
        lead,
        run: async () => null,
        onClose() {},
      }),
    );
  }
  const control = (h: HookHost<any>, label: string) =>
    find(h.value, (n) => n.props['aria-label'] === label).props;

  it('sends title, lane, priority and kind as set_task patches', async () => {
    const h = editor({ kind: { domain: 'frontend-ui', tier: 't2' } });
    control(h, zh('board.plan.field.title')).onChange({ target: { value: '  Renamed  ' } });
    h.render();
    control(h, zh('board.plan.field.title')).onBlur();
    await h.flush();
    control(h, zh('board.plan.field.lane')).onChange('side');
    await h.flush();
    control(h, zh('board.plan.field.priority')).onValueChange('high');
    await h.flush();
    control(h, zh('board.plan.field.domain')).onChange('backend-logic');
    await h.flush();
    control(h, zh('board.plan.field.tier')).onValueChange('t3');
    await h.flush();
    const patches = runCommand.mock.calls.map(([, input]) => input.ops[0].patch);
    expect(patches).toEqual([
      { title: 'Renamed' },
      { lane: 'side' },
      { priority: 'high' },
      { kind: { domain: 'backend-logic', tier: 't2' } },
      { kind: { domain: 'frontend-ui', tier: 't3' } },
    ]);
    for (const [, input] of runCommand.mock.calls) expect(accepted(input.ops)).toBe(true);
  });

  it('words each record field change against the current value', () => {
    const model = board([task('a', { planned: { kind: { domain: 'frontend-ui', tier: 't2' } } })]);
    const op: PlanOp = {
      type: 'set_task',
      task_id: 'a',
      patch: {
        title: 'Renamed',
        lane: 'side',
        priority: 'high',
        kind: { domain: 'backend-logic', tier: 't3' },
      },
    };
    expect(opChanges(model, 'lead-1', op)).toEqual([
      { field: zh('data.planEdit.field.title'), before: 'task a', after: 'Renamed' },
      { field: zh('data.planEdit.field.lane'), before: 'main', after: 'side' },
      {
        field: zh('data.planEdit.field.priority'),
        before: null,
        after: zh('data.planEdit.priority.high'),
      },
      { field: zh('data.planEdit.field.kind'), before: '前端界面 T2', after: '后端逻辑 T3' },
    ]);
  });

  it('words a change of workflow, iteration, estimate, device, needs, uses or parts', () => {
    const model = {
      ...board([
        task('a', {
          iteration_id: 'lead-1:it-1',
          estimate: 2,
          planned: { device: 'mac-a', needs: ['gpu'], uses: { gpu: 1 } },
        }),
      ]),
      iterations: [
        { id: 'lead-1:it-1', title: 'Sprint 1' },
        { id: 'lead-1:it-2', title: 'Sprint 2' },
      ],
    } as unknown as BoardModel;
    const part = (title: string) => ({
      title,
      goal: 'g',
      scope: ['src'],
      acceptance: ['pnpm test'],
    });
    const op: PlanOp = {
      type: 'set_task',
      task_id: 'a',
      patch: {
        iteration: 'it-2',
        estimate: 5,
        device: 'linux-b',
        needs: ['gpu', 'docker'],
        uses: { gpu: 2 },
        parallel: [part('API'), part('UI')],
      },
    };
    expect(opChanges(model, 'lead-1', op)).toEqual([
      { field: zh('data.planEdit.field.iteration'), before: 'Sprint 1', after: 'Sprint 2' },
      { field: zh('data.planEdit.field.estimate'), before: '2 点', after: '5 点' },
      { field: zh('data.planEdit.field.device'), before: 'mac-a', after: 'linux-b' },
      { field: zh('data.planEdit.field.needs'), before: 'gpu', after: 'gpu, docker' },
      { field: zh('data.planEdit.field.uses'), before: 'gpu × 1', after: 'gpu × 2' },
      { field: zh('data.planEdit.field.parts'), before: null, after: 'API, UI' },
    ]);
    const cleared: PlanOp = {
      type: 'set_task',
      task_id: 'a',
      patch: { iteration: null },
    };
    expect(opChanges(model, 'lead-1', cleared)).toEqual([
      {
        field: zh('data.planEdit.field.iteration'),
        before: 'Sprint 1',
        after: zh('data.planEdit.none'),
      },
    ]);
    for (const o of [op, cleared]) expect(accepted([o])).toBe(true);
  });
});

describe('a plan task type and token budget', () => {
  function openForm(model: BoardModel) {
    const column = mount(() => DraftTaskForm({ model, projectId: 'project-a' }));
    const form = column.value as ReactElement<any>;
    return mount(() => (form.type as (p: object) => ReactElement<any>)(form.props));
  }
  const labelled = (tree: unknown, label: string) =>
    find(tree as never, (n) => n.props['aria-label'] === label);
  const budgetInput = (tree: unknown) =>
    find(
      tree as never,
      (n) => n.type === 'input' && n.props['aria-label'] === zh('board.plan.field.tokenBudget'),
    );
  const fill = (form: HookHost<any>) => {
    for (const [label, value] of [
      [zh('board.plan.field.title'), 'task a'],
      [zh('board.newTask.goal'), 'Add retries'],
      [zh('board.newTask.scope'), 'src/retry'],
      [zh('board.newTask.acceptance'), 'pnpm test'],
    ]) {
      labelled(form.value, label!).props.onChange({ target: { value } });
      form.render();
    }
  };
  const send = async (form: HookHost<any>) => {
    find(form.value, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });
    await form.flush();
    await sendDraftEdits(board(), 'project-a');
    return runCommand.mock.calls.at(-1)![1].ops as PlanOp[];
  };

  it('sends the type and budget of a new task in its add_task op', async () => {
    const form = openForm(board());
    const types = labelled(form.value, zh('board.plan.field.taskType'));
    expect(nodes(types.props.children).flatMap((n) => n.props.value ?? [])).toEqual([
      'feature',
      'fix',
      'research',
      'infra',
      'docs',
    ]);
    types.props.onValueChange('fix');
    form.render();
    budgetInput(form.value).props.onChange({ target: { value: '300000' } });
    form.render();
    expect(text(form.value)).toContain('30万 token');
    expect(find(form.value, (n) => n.props.role === 'meter').props['aria-valuenow']).toBe(0);
    fill(form);
    const ops = await send(form);
    expect(ops[0]).toMatchObject({
      type: 'add_task',
      task: { title: 'task a', task_type: 'fix', token_budget: 300000 },
    });
    expect(accepted(ops)).toBe(true);
  });

  it('leaves both fields out without a type or a budget, picking the checked type again clearing it', async () => {
    const form = openForm(board());
    labelled(form.value, zh('board.plan.field.taskType')).props.onValueChange('docs');
    form.render();
    find(
      form.value,
      (n) => n.props['aria-label'] === zh('board.task.type.docs') && n.props.value === 'docs',
    ).props.onClick();
    form.render();
    expect(labelled(form.value, zh('board.plan.field.taskType')).props.value).toBe('');
    expect(nodes(form.value).some((n) => n.props.role === 'meter')).toBe(false);
    expect(budgetInput(form.value).props.placeholder).toBe(
      zh('board.plan.field.tokenBudgetPlaceholder'),
    );
    fill(form);
    const task = (await send(form))[0] as Extract<PlanOp, { type: 'add_task' }>;
    expect('task_type' in task.task || 'token_budget' in task.task).toBe(false);
  });

  it('refuses a budget that is not a whole number above 0', () => {
    expect(newTaskOp(draft({ budget: '0' }), new Set())).toEqual({ problem: 'budget' });
    expect(newTaskOp(draft({ budget: '1.5' }), new Set())).toEqual({ problem: 'budget' });
  });

  it.each(
    [
      {
        name: 'sends a plan task type and budget as set_task patches, worded against the current ones',
        pick: (h: HookHost<any>) =>
          labelled(h.value, zh('board.plan.field.taskType')).props.onValueChange('research'),
        budget: '250000',
        patch: { task_type: 'research', token_budget: 250000 },
        after: [zh('board.task.type.research'), '25万 token'],
      },
      {
        name: 'takes a plan task type and budget away with null patches',
        pick: (h: HookHost<any>) =>
          find(
            h.value,
            (n) =>
              n.props['aria-label'] === zh('board.task.type.feature') &&
              n.props.value === 'feature',
          ).props.onClick(),
        budget: '',
        patch: { task_type: null, token_budget: null },
        after: [zh('data.planEdit.none'), zh('data.planEdit.none')],
      },
    ].map((row) => [row.name, row] as const),
  )('%s', async (_name, { pick, budget, patch, after }) => {
    const target = { projectId: 'project-a', leadId: 'lead-1', planId: 'a', taskId: 'lead-1:a' };
    const model = board([task('a', { task_type: 'feature', token_budget: 100000 })]);
    const h = mount(() =>
      PlanEdit({ model, task: model.tasks[0]!, target, lead, run: async () => null, onClose() {} }),
    );
    expect(labelled(h.value, zh('board.plan.field.taskType')).props.value).toBe('feature');
    pick(h);
    await h.flush();
    budgetInput(h.value).props.onChange({ target: { value: budget } });
    h.render();
    budgetInput(h.value).props.onBlur();
    await h.flush();
    const ops = runCommand.mock.calls.map(([, input]) => input.ops);
    expect(ops.map((o) => o[0].patch)).toEqual([
      { task_type: patch.task_type },
      { token_budget: patch.token_budget },
    ]);
    for (const o of ops) expect(accepted(o)).toBe(true);
    expect(opChanges(model, 'lead-1', { type: 'set_task', task_id: 'a', patch } as PlanOp)).toEqual(
      [
        {
          field: zh('data.planEdit.field.taskType'),
          before: zh('board.task.type.feature'),
          after: after[0],
        },
        { field: zh('data.planEdit.field.tokenBudget'), before: '10万 token', after: after[1] },
      ],
    );
  });
});

describe('when an edit takes effect', () => {
  const claim = { session_id: 's1', runtime: 'codex', model: 'gpt-a' };
  const model = board([
    task('idle'),
    task('open', { state: 'running', status: 'running', claim }),
    task('busy', { state: 'running', status: 'running', claim, turn_running: true }),
    task('done', { state: 'merged', status: 'done', claim }),
  ]);
  const set = (id: string, patch: object): PlanOp =>
    ({ type: 'set_task', task_id: id, patch }) as PlanOp;

  it('is now for an added task, record fields, or a task without an unfinished session', () => {
    const add = newTaskOp(draft(), new Set());
    expect(editTiming(model, 'lead-1', ['op' in add ? add.op : set('idle', {})])).toBe('now');
    expect(editTiming(model, 'lead-1', [set('busy', { title: 'x', priority: 'low' })])).toBe('now');
    expect(editTiming(model, 'lead-1', [set('idle', { model: 'claude-opus' })])).toBe('now');
    expect(editTiming(model, 'lead-1', [set('done', { model: 'claude-opus' })])).toBe('now');
  });

  it('waits for the lead when other fields of a task with an unfinished session change', () => {
    expect(editTiming(model, 'lead-1', [set('open', { model: 'claude-opus' })])).toBe('lead');
    expect(
      editTiming(model, 'lead-1', [{ type: 'set_dependencies', task_id: 'open', depends_on: [] }]),
    ).toBe('lead');
  });

  it("waits for the lead while the session's turn runs too", () => {
    expect(editTiming(model, 'lead-1', [set('busy', { title: 'x', effort: 'low' })])).toBe('lead');
  });
});

describe('the unsent edits list', () => {
  const effort: PlanOp = { type: 'set_task', task_id: 'a', patch: { effort: 'low' } };
  const target = { projectId: 'project-a', leadId: 'lead-1', planId: 'a', taskId: 'lead-1:a' };
  const held = {
    id: 'edit-9',
    task_ids: ['b'],
    summary: 'set_task b',
    state: 'pending' as const,
    ops: [{ type: 'set_task' as const, task_id: 'b', patch: { model: 'claude-opus' } }],
    base_version: 3,
    created_at: NOW,
  };
  const claim = { session_id: 's1', runtime: 'codex', model: 'gpt-a' };
  const model = (version: number) =>
    board([task('a'), task('b', { state: 'running', claim })], {
      plan_version: version,
      pending_edits: [held],
    });
  /** The withdraw control of the held edit, rendered from the props the list gives it. */
  const withdraw = (tree: unknown) => {
    const element = named(tree as never, 'Withdraw');
    return mount(() => (element.type as (p: object) => ReactElement<any>)(element.props));
  };

  it('lists a refused edit and a held one with their timing, and resends on the new version', async () => {
    runCommand.mockResolvedValue({
      ok: false,
      error: { code: 'revision_conflict', message: 'The plan is at version 5' },
    });
    await editPlan(target, [effort], 3);
    runCommand.mockClear();
    runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-3' } });
    const listed = unsentEdits(model(5), 'project-a', [
      { target, outcome: { kind: 'conflict', ops: [effort], base: 3 }, ops: [effort] },
    ]);
    expect(listed.map((e) => [e.status, e.timing, e.target.taskId])).toEqual([
      ['conflict', 'now', 'lead-1:a'],
      ['pending', 'lead', 'lead-1:b'],
    ]);
    expect(unsentEdits(model(5), 'project-b', [])).toHaveLength(1);

    const h = mount(() => UnsentEdits({ model: model(5), projectId: 'project-a' }));
    expect(text(find(h.value, (n) => n.props.className === 'bd-ed-n'))).toBe('2');
    const button = (label: string) =>
      find(h.value, (n) => n.type === 'button' && text(n) === label).props;
    button(zhf('board.plan.edit.retry', { version: 5 })).onClick();
    await h.flush();
    expect(runCommand.mock.calls).toEqual([
      ['board.plan.edit', { ...scope, base_version: 5, ops: [effort] }, null],
    ]);

    const w = withdraw(h.value);
    find(
      w.value,
      (n) => n.props['aria-label'] === zh('board.plan.edit.withdrawLabel'),
    ).props.onClick();
    await w.flush();
    expect(runCommand.mock.calls.at(-1)).toEqual([
      'board.plan.edit.withdraw',
      { ...scope, edit_id: 'edit-9' },
      null,
    ]);
  });

  it('holds the withdraw button while it is sent, and shows why a withdraw was refused', async () => {
    let answer!: (value: unknown) => void;
    runCommand.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const h = mount(() => UnsentEdits({ model: model(3), projectId: 'project-a' }));
    const w = withdraw(h.value);
    const button = () =>
      find(w.value, (n) => n.props['aria-label'] === zh('board.plan.edit.withdrawLabel')).props;
    button().onClick();
    w.render();
    expect(button().disabled).toBe(true);
    button().onClick();
    answer({ ok: false, error: { code: 'not_found', message: 'The edit was already decided' } });
    await w.flush();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(false);
    expect(text(w.value)).toContain('The edit was already decided');
  });

  it('drops a refused edit the user discards', async () => {
    runCommand.mockResolvedValue({
      ok: false,
      error: { code: 'revision_conflict', message: 'The plan is at version 5' },
    });
    await editPlan(target, [effort], 3);
    const h = mount(() => UnsentEdits({ model: model(5), projectId: 'project-a' }));
    expect(nodes(h.value).filter((n) => n.props.className === 'bd-ed-row')).toHaveLength(2);
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === zh('board.plan.edit.discard'),
    ).props.onClick();
    h.render();
    expect(nodes(h.value).filter((n) => n.props.className === 'bd-ed-row')).toHaveLength(1);
  });
});
