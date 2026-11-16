import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BoardModel } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import { HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
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
    Object.fromEntries(runtimes.map((runtime) => [runtime, { state: 'ready', models: [] }])),
}));
import {
  addDraftEdit,
  changeDraftEdit,
  discardDraftEdits,
  draftEdits,
  draftSending,
  draftTiming,
  removeDraftEdit,
  sendDraftEdits,
} from '@/data/plan-draft';
import type { PlanOp } from '@/data/plan-edit';
import { DraftTaskForm } from '@/screens/board/EditMode';
import { PlanEdit } from '@/screens/board/PlanEdit';
import { UnsentEdits } from '@/screens/board/UnsentEdits';

type Task = BoardModel['tasks'][number];
const NOW = Date.UTC(2026, 10, 13, 12);

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id: `lead-1:${id}`,
  owner_session_id: 'lead-1',
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: 'lead-1:main',
  milestone_id: null,
  iteration_id: null,
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

const claim = { session_id: 's1', runtime: 'codex', model: 'gpt-a' };
const board = (tasks: Task[] = [task('a'), task('b')]): BoardModel =>
  ({
    since: 0,
    now: NOW,
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    iterations: [
      {
        id: 'lead-1:it-7',
        title: 'Iteration 7',
        starts_on: '2026-11-09',
        ends_on: '2026-11-20',
        planned: 0,
        done: 0,
        days: [],
      },
      {
        id: 'lead-2:it-1',
        title: 'Other lead',
        starts_on: '2026-11-09',
        ends_on: '2026-11-20',
        planned: 0,
        done: 0,
        days: [],
      },
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
      },
    ],
  }) as unknown as BoardModel;

const target = (planId: string, projectId = 'project-a') => ({
  projectId,
  leadId: 'lead-1',
  planId,
  taskId: `lead-1:${planId}`,
});
const scope = { project_id: 'project-a', lead_session_id: 'lead-1' };
const addOp = (id: string): PlanOp => ({
  type: 'add_task',
  task: {
    id,
    title: `new ${id}`,
    goal: 'goal',
    lane: 'main',
    depends_on: [],
    source: ['goal'],
    scope: ['src'],
    acceptance: ['pnpm test'],
  },
});
const set = (id: string, patch: object): PlanOp =>
  ({ type: 'set_task', task_id: id, patch }) as PlanOp;

beforeEach(() => {
  runCommand.mockReset();
  runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-1' } });
});
afterEach(() => {
  unmountAll();
  discardDraftEdits('project-a');
  discardDraftEdits('project-b');
});

describe('the plan draft', () => {
  it('keeps changes per project until they are discarded, and adds, changes and removes one', () => {
    const first = addDraftEdit(target('a'), [set('a', { title: 'x' })]);
    const second = addDraftEdit(target('b'), [set('b', { title: 'y' })]);
    addDraftEdit(target('a', 'project-b'), [set('a', { title: 'z' })]);
    expect(draftEdits('project-a').map((d) => d.key)).toEqual([first, second]);
    expect(runCommand).not.toHaveBeenCalled();

    changeDraftEdit('project-a', first, { ops: [set('a', { title: 'x2' })] });
    expect(draftEdits('project-a')[0]!.ops).toEqual([set('a', { title: 'x2' })]);
    removeDraftEdit('project-a', second);
    expect(draftEdits('project-a').map((d) => d.key)).toEqual([first]);

    discardDraftEdits('project-a');
    expect(draftEdits('project-a')).toEqual([]);
    expect(draftEdits('project-b')).toHaveLength(1);
  });

  it('marks an added task, a change that waits for the lead, and one that applies at once', () => {
    const model = board([
      task('idle'),
      task('busy', { state: 'running', claim, turn_running: true }),
    ]);
    expect(draftTiming(model, 'lead-1', [addOp('n')])).toBe('joins_plan');
    expect(draftTiming(model, 'lead-1', [set('busy', { goal: 'g' })])).toBe('after_turn');
    expect(
      draftTiming(model, 'lead-1', [{ type: 'set_dependencies', task_id: 'busy', depends_on: [] }]),
    ).toBe('after_turn');
    expect(draftTiming(model, 'lead-1', [set('busy', { title: 'renamed' })])).toBe('now');
    expect(draftTiming(model, 'lead-1', [set('idle', { goal: 'g' })])).toBe('now');
  });

  it('sends each change on the plan version it reaches, keeps the refused ones with why, and starts a task asked to', async () => {
    const added = addDraftEdit(target('n'), [addOp('n')], true);
    const renamed = addDraftEdit(target('a'), [set('a', { title: 'x' })]);
    const refused = addDraftEdit(target('b'), [set('b', { title: 'y' })]);
    runCommand
      .mockResolvedValueOnce({ ok: true, value: { applied: true, edit_id: 'e1' } })
      .mockResolvedValueOnce({ ok: true, value: {} })
      .mockResolvedValueOnce({ ok: true, value: { applied: false, edit_id: 'e2' } })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'invalid_input', message: 'Lane missing' },
      });

    const results = await sendDraftEdits(board(), 'project-a');
    expect(runCommand.mock.calls).toEqual([
      ['board.plan.edit', { ...scope, base_version: 3, ops: [addOp('n')] }, null],
      ['task.start', { ...scope, task_ids: ['n'] }, null],
      ['board.plan.edit', { ...scope, base_version: 4, ops: [set('a', { title: 'x' })] }, null],
      ['board.plan.edit', { ...scope, base_version: 4, ops: [set('b', { title: 'y' })] }, null],
    ]);
    expect(results.map((r) => [r.key, r.outcome.kind])).toEqual([
      [added, 'applied'],
      [renamed, 'pending'],
      [refused, 'failed'],
    ]);
    const left = draftEdits('project-a');
    expect(left.map((d) => d.key)).toEqual([refused]);
    expect(left[0]!.problem).toBeTruthy();
  });

  it('sends the next change on the plan version the applied answer names', async () => {
    addDraftEdit(target('a'), [set('a', { title: 'x' })]);
    addDraftEdit(target('b'), [set('b', { title: 'y' })]);
    // The plan already held the first change, so applying it left the version where it was.
    runCommand.mockResolvedValueOnce({ ok: true, value: { applied: true, plan_version: 3 } });
    await sendDraftEdits(board(), 'project-a');
    expect(runCommand.mock.calls.map(([, input]) => input.base_version)).toEqual([3, 3]);
  });

  it('keeps an added task whose start failed as a start still to send', async () => {
    const added = addDraftEdit(target('n'), [addOp('n')], true);
    runCommand
      .mockResolvedValueOnce({ ok: true, value: { applied: true, edit_id: 'e1' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'invalid_input', message: 'No slot' } });
    await sendDraftEdits(board(), 'project-a');
    expect(draftEdits('project-a')).toMatchObject([{ key: added, ops: [], start: true }]);
    runCommand.mockClear();
    runCommand.mockResolvedValue({ ok: true, value: {} });
    await sendDraftEdits(board(), 'project-a');
    expect(runCommand.mock.calls).toEqual([['task.start', { ...scope, task_ids: ['n'] }, null]]);
    expect(draftEdits('project-a')).toEqual([]);
  });

  it('skips a change removed while an earlier one is being sent', async () => {
    let answer!: (value: unknown) => void;
    runCommand.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    addDraftEdit(target('a'), [set('a', { title: 'x' })]);
    const removed = addDraftEdit(target('b'), [set('b', { title: 'y' })]);
    const sending = sendDraftEdits(board(), 'project-a');
    removeDraftEdit('project-a', removed);
    answer({ ok: true, value: { applied: true } });
    const results = await sending;
    expect(runCommand.mock.calls).toEqual([
      ['board.plan.edit', { ...scope, base_version: 3, ops: [set('a', { title: 'x' })] }, null],
    ]);
    expect(results.map((r) => r.key)).not.toContain(removed);
    expect(draftEdits('project-a')).toEqual([]);
  });

  it('keeps a change edited while it was being sent, and drops the one left as sent', async () => {
    let answer!: (value: unknown) => void;
    runCommand.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const deps = (ids: string[]): PlanOp => ({
      type: 'set_dependencies',
      task_id: 'b',
      depends_on: ids,
    });
    const edited = addDraftEdit(target('b'), [deps(['a'])]);
    addDraftEdit(target('a'), [set('a', { title: 'x' })]);
    const sending = sendDraftEdits(board(), 'project-a');
    changeDraftEdit('project-a', edited, { ops: [deps(['a', 'c'])] });
    answer({ ok: true, value: { applied: true } });
    await sending;
    expect(runCommand.mock.calls.map(([, input]) => input.ops)).toEqual([
      [deps(['a'])],
      [set('a', { title: 'x' })],
    ]);
    expect(draftEdits('project-a')).toEqual([
      { key: edited, target: target('b'), ops: [deps(['a', 'c'])], start: false },
    ]);
  });

  it('marks the project as sending and sends nothing more while it does', async () => {
    let answer!: (value: unknown) => void;
    runCommand.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    addDraftEdit(target('a'), [set('a', { title: 'x' })]);
    const first = sendDraftEdits(board(), 'project-a');
    expect(draftSending('project-a')).toBe(true);
    expect(draftSending('project-b')).toBe(false);
    expect(await sendDraftEdits(board(), 'project-a')).toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    answer({ ok: true, value: { applied: true } });
    await first;
    expect(draftSending('project-a')).toBe(false);
  });
});

describe('the unsent changes list', () => {
  it('lists each drafted change with when it takes effect, and why one was not sent', async () => {
    const model = board([task('a'), task('busy', { state: 'running', claim })]);
    addDraftEdit(target('n'), [addOp('n')]);
    addDraftEdit(target('busy'), [set('busy', { goal: 'g' })]);
    addDraftEdit(target('a'), [set('a', { title: 'x' })]);
    const h = mount(() => UnsentEdits({ model, projectId: 'project-a' }));
    expect(text(find(h.value, (n) => n.props.className === 'bd-ed-n'))).toBe('3');
    expect(
      nodes(h.value)
        .filter((n) => n.props.className === 'bd-ed-when')
        .map(text),
    ).toEqual([
      zh('board.edits.draft.joinsPlan'),
      zh('board.edits.timing.lead'),
      zh('board.edits.draft.now'),
    ]);

    find(h.value, (n) => n.props['aria-label'] === '移除 task a').props.onClick();
    h.render();
    expect(draftEdits('project-a')).toHaveLength(2);

    runCommand.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'Boom' } });
    await sendDraftEdits(model, 'project-a');
    h.render();
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(draftEdits('project-a')).toHaveLength(1);
    expect(nodes(h.value).some((n) => n.props.className === 'bd-perr' && text(n))).toBe(true);
    // The edit bar sends and discards; the list has neither.
    expect(nodes(h.value).filter((n) => n.type === 'button' && /送出|放弃/.test(text(n)))).toEqual(
      [],
    );
  });
});

describe('the new task form', () => {
  function openForm(model: BoardModel) {
    const column = mount(() => DraftTaskForm({ model, projectId: 'project-a' }));
    const form = column.value as ReactElement<any>;
    return mount(() => (form.type as (p: object) => ReactElement<any>)(form.props));
  }
  const field = (tree: unknown, label: string) =>
    find(tree as never, (n) => n.props['aria-label'] === label);
  const fill = (form: HookHost<any>) => {
    for (const [label, value] of [
      [zh('board.plan.field.title'), 'task n'],
      [zh('board.newTask.goal'), 'Add retries'],
      [zh('board.newTask.scope'), 'src/retry'],
      [zh('board.newTask.acceptance'), 'pnpm test'],
    ]) {
      field(form.value, label!).props.onChange({ target: { value } });
      form.render();
    }
  };
  const submit = (tree: unknown) =>
    find(tree as never, (n) => n.type === 'form').props.onSubmit({ preventDefault() {} });

  it('picks upstream tasks as chips that can be removed, and an iteration of the lead', async () => {
    const form = openForm(board());
    fill(form);
    expect(named(form.value, 'Menu').props.trigger.props['aria-label']).toBe(
      zh('board.newTask.upstreamAdd'),
    );
    find(form.value, (n) => n.props['data-pick'] === 'a').props.onClick();
    form.render();
    find(form.value, (n) => n.props['data-pick'] === 'b').props.onClick();
    form.render();
    field(form.value, '移除上游 task b').props.onClick();
    form.render();
    expect(
      field(form.value, zh('board.plan.field.iteration')).props.options.map(
        (o: { value: string }) => o.value,
      ),
    ).toEqual(['', 'it-7']);
    field(form.value, zh('board.plan.field.iteration')).props.onChange('it-7');
    form.render();
    submit(form.value);
    await form.flush();
    await sendDraftEdits(board(), 'project-a');
    expect(runCommand.mock.calls[0]![1].ops[0].task).toMatchObject({
      depends_on: ['a'],
      iteration: 'it-7',
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('starts the task once sent when the user picks that', async () => {
    const form = openForm(board());
    fill(form);
    expect(field(form.value, zh('board.newTask.startMode')).props.value).toBe('lead');
    field(form.value, zh('board.newTask.startMode')).props.onValueChange('now');
    form.render();
    submit(form.value);
    await form.flush();
    await sendDraftEdits(board(), 'project-a');
    expect(runCommand.mock.calls.map(([type]) => type)).toEqual(['board.plan.edit', 'task.start']);
    expect(runCommand.mock.calls[1]![1]).toEqual({ ...scope, task_ids: ['task-n'] });
  });
});

describe('the iteration of a plan task in the drawer', () => {
  it('sets and clears the iteration as a set_task patch', async () => {
    const model = board([task('a', { iteration_id: 'lead-1:it-7' })]);
    const h = mount(() =>
      PlanEdit({
        model,
        task: model.tasks[0]!,
        target: target('a'),
        lead: undefined,
        run: async () => null,
        onClose() {},
      }),
    );
    const select = find(
      h.value,
      (n) => n.props['aria-label'] === zh('board.plan.field.iteration'),
    ).props;
    expect(select.value).toBe('it-7');
    select.onChange('');
    await h.flush();
    expect(runCommand.mock.calls[0]![1].ops).toEqual([set('a', { iteration: null })]);
  });
});
