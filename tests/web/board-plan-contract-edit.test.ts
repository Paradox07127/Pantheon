import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { inputSchemas, type BoardModel } from '@pantheon/protocol';
import {
  HookHost,
  deferred,
  find,
  named,
  nodes,
  text,
  mount,
  unmountAll,
} from './web-hook-host.js';
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/runtime-status', async (actual) => ({
  ...(await actual<object>()),
  useRuntimeStatus: () => ({ read: { state: 'loading' } }),
}));
const { runCommand, projectRead } = vi.hoisted(() => ({
  runCommand: vi.fn(),
  projectRead: { current: null as unknown },
}));
vi.mock('@/data/commands', () => ({ runCommand }));
vi.mock('@/data/runtime-models', () => ({ useRuntimeModels: () => ({}) }));
vi.mock('@/data/project-read', async (actual) => ({
  ...(await actual<object>()),
  useProjectQuery: (method: string) => ({
    read: method === 'project.read' ? projectRead.current : null,
    error: null,
    unavailable: false,
    loading: false,
    reload() {},
  }),
}));
import {
  clearPlanEdit,
  contractPatch,
  contractProblem,
  editPlan,
  editTarget,
  editTiming,
  moveTaskOp,
  opChanges,
  planVersion,
  unsentEdits,
  type Contract,
  type EditOutcome,
  type PlanOp,
} from '@/data/plan-edit';
import { Select } from '@/components/Select';
import { ContractFields, PlanEdit } from '@/screens/board/PlanEdit';
import { UnsentEdits } from '@/screens/board/UnsentEdits';
import type { SnapshotSession } from '@/screens/board/panels-model';
import { zh, zhf } from './i18n-setup.js';

type Task = BoardModel['tasks'][number];
type Lead = NonNullable<BoardModel['leads']>[number];
const NOW = Date.UTC(2026, 10, 12, 12);
const claim = { session_id: 's1', runtime: 'codex', model: 'gpt-a' };

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id: `lead-1:${id}`,
  owner_session_id: 'lead-1',
  title: `task ${id}`,
  goal: `goal ${id}`,
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

const board = (tasks: Task[], lead: Partial<Lead> = {}): BoardModel =>
  ({
    since: NOW - 3_600_000,
    now: NOW,
    counts: { median_ms: null },
    lanes: [{ id: 'lead-1:main', title: 'main' }],
    merges: [],
    edges: [],
    milestones: [],
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
const target = { projectId: 'project-a', leadId: 'lead-1', planId: 'a', taskId: 'lead-1:a' };
const accepted = (ops: unknown[]) =>
  inputSchemas['board.plan.edit'].safeParse({ ...scope, base_version: 3, ops }).success;

const contract = (extra: Partial<Contract> = {}): Contract => ({
  goal: 'Add retries',
  scope: ['src/retry'],
  acceptance: ['pnpm test'],
  done_when: 'merged',
  milestone: 'beta',
  path: null,
  ...extra,
});

const read = (planTask: object) => ({
  plans: [
    {
      lead_session_id: 'lead-1',
      plan_version: 3,
      pending_edits: [],
      tasks: [
        {
          id: 'a',
          title: 'task a',
          goal: 'Add retries',
          lane: 'main',
          milestone: 'beta',
          depends_on: [],
          source: ['Add retries'],
          scope: ['src/retry'],
          acceptance: ['pnpm test'],
          ...planTask,
        },
      ],
    },
  ],
  milestones: [
    { milestone: { id: 'ms-1', key: 'beta', title: 'Beta', owner_session_id: 'lead-1' } },
    { milestone: { id: 'ms-2', key: 'ga', title: 'GA', owner_session_id: 'lead-1' } },
    { milestone: { id: 'ms-3', key: 'other', title: 'Other lead', owner_session_id: 'lead-2' } },
  ],
});

beforeEach(() => {
  runCommand.mockReset();
  runCommand.mockResolvedValue({ ok: true, value: { applied: true, edit_id: 'edit-1' } });
  projectRead.current = read({});
});
afterEach(() => {
  unmountAll();
  for (const id of ['lead-1:a', 'lead-1:b', 'lead-1:c', 'lead-1:d']) clearPlanEdit(id);
});

const label = (tree: unknown, name: string) =>
  find(tree as never, (n) => n.props['aria-label'] === name).props;

describe('the contract fields of a plan task', () => {
  it('puts only the changed fields into the patch, without blank list entries', () => {
    expect(contractPatch(contract(), contract())).toEqual({});
    expect(
      contractPatch(
        contract(),
        contract({ goal: ' Add retries ', scope: ['src/retry', '  ', 'src/csv '] }),
      ),
    ).toEqual({ scope: ['src/retry', 'src/csv'] });
    expect(
      contractPatch(contract(), contract({ done_when: 'report', milestone: null, acceptance: [] })),
    ).toEqual({ acceptance: [], done_when: 'report', milestone: null });
  });

  it('refuses a task done by merging without a scope path or an acceptance check', () => {
    expect(contractProblem(contract())).toEqual([]);
    expect(contractProblem(contract({ scope: ['  '] }))).toEqual(['scope']);
    expect(contractProblem(contract({ scope: [], acceptance: [] }))).toEqual([
      'scope',
      'acceptance',
    ]);
    expect(contractProblem(contract({ done_when: 'report', scope: [], acceptance: [] }))).toEqual(
      [],
    );
  });

  function fields(model = board([task('a')])) {
    const drawer = mount(() =>
      PlanEdit({
        model,
        task: model.tasks[0]!,
        target,
        lead,
        run: async () => null,
        onClose() {},
      }),
    );
    const element = named(drawer.value, 'ContractFields');
    return mount(() => (element.type as (p: object) => ReactElement<any>)(element.props));
  }
  const save = (h: HookHost<any>) =>
    find(h.value, (n) => n.type === 'button' && text(n) === zh('board.plan.contract.save')).props;

  it('sends the edited fields as one set_task patch the protocol accepts', async () => {
    const h = fields();
    expect(save(h).disabled).toBe(true);
    label(h.value, zh('board.plan.field.goal')).onChange({
      target: { value: 'Add retries with backoff' },
    });
    h.render();
    label(h.value, zh('board.plan.contract.acceptanceAdd')).onClick();
    h.render();
    label(h.value, zhf('board.plan.contract.acceptanceItem', { n: 2 })).onChange({
      target: { value: 'pnpm lint' },
    });
    h.render();
    label(h.value, zh('board.plan.field.milestone')).onChange('');
    h.render();
    save(h).onClick();
    await h.flush();
    expect(runCommand.mock.calls).toHaveLength(1);
    const [type, input] = runCommand.mock.calls[0]!;
    expect(type).toBe('board.plan.edit');
    expect(input).toMatchObject({ ...scope, base_version: 3 });
    expect(input.ops).toEqual([
      {
        type: 'set_task',
        task_id: 'a',
        patch: {
          goal: 'Add retries with backoff',
          acceptance: ['pnpm test', 'pnpm lint'],
          milestone: null,
        },
      },
    ]);
    expect(accepted(input.ops)).toBe(true);
  });

  it('keeps the fields off while the read is of an older plan than the board', () => {
    const h = fields(board([task('a')], { plan_version: 4 }));
    expect(label(h.value, zh('board.plan.field.goal')).disabled).toBe(true);
    expect(save(h).disabled).toBe(true);
  });

  it('sends the contract on the plan version it was read at', async () => {
    const send = vi.fn(async (): Promise<EditOutcome> => ({ kind: 'applied' }));
    const h = mount(() => ContractFields({ model: board([task('a')]), target, busy: false, send }));
    label(h.value, zh('board.plan.field.goal')).onChange({ target: { value: 'Add backoff' } });
    h.render();
    save(h).onClick();
    await h.flush();
    expect(send.mock.calls).toEqual([[{ goal: 'Add backoff' }, 3]]);
  });

  it('sends no workflow when it saves a task whose plan still names one', async () => {
    const named = { ...contract(), workflow_id: 'wf-old' };
    expect(contractPatch(named, contract({ goal: 'Add backoff' }))).toEqual({
      goal: 'Add backoff',
    });
    projectRead.current = read({ workflow_id: 'wf-old' });
    const h = fields();
    label(h.value, zh('board.plan.field.goal')).onChange({ target: { value: 'Add backoff' } });
    h.render();
    save(h).onClick();
    await h.flush();
    const [, input] = runCommand.mock.calls[0]!;
    expect(input.ops).toEqual([{ type: 'set_task', task_id: 'a', patch: { goal: 'Add backoff' } }]);
    expect(accepted(input.ops)).toBe(true);
  });

  it('keeps the button off and marks the empty list while a merged task lacks scope', () => {
    const h = fields();
    label(h.value, zhf('board.plan.contract.scopeRemove', { n: 1 })).onClick();
    h.render();
    expect(save(h).disabled).toBe(true);
    expect(label(h.value, zh('board.plan.field.scope')).role).toBe('group');
    expect(label(h.value, zh('board.plan.field.scope'))['aria-invalid']).toBe(true);
    expect(label(h.value, zh('board.plan.field.acceptance'))['aria-invalid']).toBeUndefined();
    label(h.value, zh('board.plan.field.doneWhen')).onValueChange('report');
    h.render();
    expect(save(h).disabled).toBe(false);
    expect(label(h.value, zh('board.plan.field.scope'))['aria-invalid']).toBeUndefined();
  });

  it('offers the lead milestones and none', () => {
    const h = fields();
    const select = find(
      h.value,
      (n) => n.type === Select && n.props['aria-label'] === zh('board.plan.field.milestone'),
    );
    expect(select.props.value).toBe('beta');
    expect(
      (select.props.options as { value: string; label: string }[]).map((o) => [o.value, o.label]),
    ).toEqual([
      ['', zh('board.plan.field.noMilestone')],
      ['beta', 'Beta'],
      ['ga', 'GA'],
    ]);
  });

  it('says the contract waits for the lead while the task has an unfinished session', () => {
    const shown = (model: BoardModel) =>
      nodes(fields(model).value).some(
        (n) => n.props.className === 'bd-pchip' && text(n) === zh('board.plan.contract.held'),
      );
    expect(shown(board([task('a')]))).toBe(false);
    expect(shown(board([task('a', { state: 'running', status: 'running', claim })]))).toBe(true);
  });

  it('sets the flow path of the task and takes it back to the default', async () => {
    expect(contractPatch(contract(), contract({ path: 'dispatch' }))).toEqual({ path: 'dispatch' });
    const chosen = fields();
    expect(label(chosen.value, zh('board.plan.field.path')).value).toBe('');
    label(chosen.value, zh('board.plan.field.path')).onChange('review_loop');
    chosen.render();
    save(chosen).onClick();
    await chosen.flush();
    projectRead.current = read({ path: 'review_loop' });
    const back = fields();
    expect(label(back.value, zh('board.plan.field.path')).value).toBe('review_loop');
    label(back.value, zh('board.plan.field.path')).onChange('');
    back.render();
    save(back).onClick();
    await back.flush();
    const ops = runCommand.mock.calls.map(([, input]) => input.ops);
    expect(ops).toEqual([
      [{ type: 'set_task', task_id: 'a', patch: { path: 'review_loop' } }],
      [{ type: 'set_task', task_id: 'a', patch: { path: null } }],
    ]);
    expect(ops.every((o) => accepted(o))).toBe(true);
  });

  it('offers the default and every flow path, and fixes it while the task ends in a report', () => {
    const h = fields();
    const group = () => label(h.value, zh('board.plan.field.path'));
    expect(
      (group().options as { value: string; label: string }[]).map((o) => [o.value, o.label]),
    ).toEqual([
      ['', zh('board.plan.field.pathDefault')],
      ['direct', zh('data.workflowPolicy.path.direct')],
      ['dispatch', zh('data.workflowPolicy.path.dispatch')],
      ['review_loop', zh('data.workflowPolicy.path.reviewLoop')],
    ]);
    expect(group().disabled).toBe(false);
    label(h.value, zh('board.plan.field.doneWhen')).onValueChange('report');
    h.render();
    expect(group().disabled).toBe(true);
  });

  it('words contract changes by count and first entry', () => {
    const model = board([task('a')]);
    const op: PlanOp = {
      type: 'set_task',
      task_id: 'a',
      patch: {
        goal: 'New goal',
        scope: ['src/retry', 'src/csv'],
        acceptance: [],
        done_when: 'report',
        milestone: null,
      },
    };
    expect(opChanges(model, 'lead-1', op)).toEqual([
      { field: zh('data.planEdit.field.goal'), before: 'goal a', after: 'New goal' },
      { field: zh('data.planEdit.field.scope'), before: null, after: '2 条：src/retry' },
      {
        field: zh('data.planEdit.field.acceptance'),
        before: null,
        after: zh('data.planEdit.none'),
      },
      {
        field: zh('data.planEdit.field.doneWhen'),
        before: null,
        after: zh('data.planEdit.doneWhen.report'),
      },
      { field: zh('data.planEdit.field.milestone'), before: null, after: zh('data.planEdit.none') },
    ]);
    const path = (value: 'review_loop' | null): PlanOp => ({
      type: 'set_task',
      task_id: 'a',
      patch: { path: value },
    });
    expect(opChanges(model, 'lead-1', path('review_loop'))).toEqual([
      {
        field: zh('data.planEdit.field.path'),
        before: null,
        after: zh('data.workflowPolicy.path.reviewLoop'),
      },
    ]);
    expect(opChanges(model, 'lead-1', path(null))).toEqual([
      {
        field: zh('data.planEdit.field.path'),
        before: null,
        after: zh('data.planEdit.path.default'),
      },
    ]);
  });

  it('words a model or effort taken away as the runtime default', () => {
    const model = board([task('a', { planned: { model: 'gpt-other', effort: 'high' } })]);
    const op: PlanOp = {
      type: 'set_task',
      task_id: 'a',
      patch: { model: null, effort: null },
    };
    expect(opChanges(model, 'lead-1', op)).toEqual([
      {
        field: zh('data.planEdit.field.model'),
        before: 'gpt-other',
        after: zh('data.planEdit.runtimeDefault'),
      },
      {
        field: zh('data.planEdit.field.effort'),
        before: zh('sessions.model.effort.high'),
        after: zh('data.planEdit.runtimeDefault'),
      },
    ]);
  });

  it('lists a changed device or flow path reason as its own change', () => {
    const model = board([
      task('a', { planned: { device: 'mac-mini', device_reason: 'Has the GPU' } }),
    ]);
    const op: PlanOp = {
      type: 'set_task',
      task_id: 'a',
      patch: { device_reason: 'Holds the dataset', flow_reason: 'Chosen by the user' },
    };
    expect(opChanges(model, 'lead-1', op)).toEqual([
      { field: zh('data.planEdit.field.flowReason'), before: null, after: 'Chosen by the user' },
      {
        field: zh('data.planEdit.field.deviceReason'),
        before: 'Has the GPU',
        after: 'Holds the dataset',
      },
    ]);
  });
});

describe('the drafts of the plan task editor', () => {
  const targetB = { ...target, planId: 'b', taskId: 'lead-1:b' };
  const input = (tree: unknown, name: string) =>
    find(tree as never, (n) => n.type === 'input' && n.props['aria-label'] === name).props;

  it('measures the budget against the tokens the task has used so far', () => {
    const segment = { id: 's1', status: 'running', started_at: NOW, ended_at: null, runtime: null };
    const running = task('a', {
      state: 'running',
      status: 'running',
      claim,
      token_budget: 1000,
      segments: [{ ...segment, tokens: 300 } as never],
    });
    const model = board([running]);
    const h = mount(() =>
      PlanEdit({ model, task: running, target, lead, run: async () => null, onClose() {} }),
    );
    expect(find(h.value, (n) => n.props.role === 'meter').props['aria-valuenow']).toBe(300);
  });

  it("keeps the budget input's own width among the plan fields, whichever sheet loads last", () => {
    const sheet = (name: string) =>
      readFileSync(
        new URL(`../../apps/web/src/screens/board/${name}.css`, import.meta.url),
        'utf8',
      ).replace(/\/\*[\s\S]*?\*\//g, '');
    // The selectors of the sheet's rules that set a minimum width.
    const sizing = (css: string) =>
      [...css.matchAll(/\n([^{}\n][^{}]*)\{([^}]*)\}/g)]
        .filter(([, , body]) => /(^|[;\s])min-width:/.test(body!))
        .flatMap(([, selectors]) => selectors!.split(',').map((s) => s.trim()));
    const classes = (selector: string) => selector.match(/\.[\w-]+/g)?.length ?? 0;
    const fields = sizing(sheet('flow')).filter((s) => s === '.bd-fields .bd-fsel');
    const budget = sizing(sheet('edits')).filter(
      (s) => s.startsWith('.bd-fields ') && s.endsWith('.bd-bud-in'),
    );
    expect(fields).toHaveLength(1);
    expect(Math.max(0, ...budget.map(classes))).toBeGreaterThan(classes(fields[0]!));
  });

  it('drops the unsent title and budget of one task when another with the same values opens', () => {
    const same = { title: 'same', token_budget: 1000 };
    const model = board([task('a', same), task('b', same)]);
    let props = { model, task: model.tasks[0]!, target, lead, run: async () => null, onClose() {} };
    const h = mount(() => PlanEdit(props));
    input(h.value, zh('board.plan.field.title')).onChange({ target: { value: 'typed for a' } });
    input(h.value, zh('board.plan.field.tokenBudget')).onChange({ target: { value: '5000' } });
    h.render();
    props = { ...props, task: model.tasks[1]!, target: targetB };
    h.render();
    expect(input(h.value, zh('board.plan.field.title')).value).toBe('same');
    expect(input(h.value, zh('board.plan.field.tokenBudget')).value).toBe('1000');
  });

  it('drops the unsent contract of one task when another with the same contract opens', () => {
    const plan = read({});
    projectRead.current = {
      ...plan,
      plans: [
        {
          ...plan.plans[0]!,
          tasks: [plan.plans[0]!.tasks[0]!, { ...plan.plans[0]!.tasks[0]!, id: 'b' }],
        },
      ],
    };
    const model = board([task('a'), task('b')]);
    let shown = target;
    const h = mount(() =>
      ContractFields({
        model,
        target: shown,
        busy: false,
        send: async () => ({ kind: 'applied' }),
      }),
    );
    label(h.value, zh('board.plan.field.goal')).onChange({ target: { value: 'typed for a' } });
    h.render();
    shown = targetB;
    h.render();
    expect(label(h.value, zh('board.plan.field.goal')).value).toBe('Add retries');
  });
  const saveButton = (tree: unknown) =>
    find(tree as never, (n) => n.type === 'button' && text(n) === zh('board.plan.contract.save'))
      .props;

  it('keeps the draft of the task opened next when the held answer of the one before lands', async () => {
    const plan = read({});
    const first = plan.plans[0]!.tasks[0]!;
    projectRead.current = {
      ...plan,
      plans: [{ ...plan.plans[0]!, tasks: [first, { ...first, id: 'b', goal: 'goal of b' }] }],
    };
    const model = board([task('a'), task('b')]);
    const answer = deferred<EditOutcome>();
    let shown = target;
    const h = mount(() =>
      ContractFields({ model, target: shown, busy: false, send: () => answer.promise }),
    );
    const goal = () => label(h.value, zh('board.plan.field.goal'));
    goal().onChange({ target: { value: 'typed for a' } });
    h.render();
    saveButton(h.value).onClick();
    shown = targetB;
    h.render();
    goal().onChange({ target: { value: 'typed for b' } });
    h.render();
    answer.resolve({ kind: 'pending', editId: 'edit-1' });
    await h.flush();
    expect(goal().value).toBe('typed for b');
  });

  it('leaves the drawer open on the task opened next when the removal of the one before lands', async () => {
    const model = board([task('a'), task('b')]);
    const answer = deferred<unknown>();
    runCommand.mockReturnValueOnce(answer.promise);
    const onClose = vi.fn();
    let props = { model, task: model.tasks[0]!, target, lead, run: async () => null, onClose };
    const h = mount(() => PlanEdit(props));
    const remove = () =>
      find(h.value, (n) => n.type === 'button' && text(n) === zh('board.plan.task.remove')).props;
    remove().onClick();
    props = { ...props, task: model.tasks[1]!, target: targetB };
    h.render();
    answer.resolve({ ok: true, value: { applied: true } });
    await h.flush();
    expect(onClose).not.toHaveBeenCalled();
    remove().onClick();
    await h.flush();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('a refused edit after the drawer closes', () => {
  it('stays in the unsent list until it is resent or discarded', async () => {
    runCommand.mockResolvedValue({
      ok: false,
      error: { code: 'revision_conflict', message: 'The plan is at version 5' },
    });
    const model = board([task('a')]);
    const drawer = mount(() =>
      PlanEdit({ model, task: model.tasks[0]!, target, lead, run: async () => null, onClose() {} }),
    );
    label(drawer.value, zh('board.plan.field.priority')).onValueChange('high');
    await drawer.flush();
    drawer.unmount();
    const list = mount(() => UnsentEdits({ model, projectId: 'project-a' }));
    expect(nodes(list.value).filter((n) => n.props.className === 'bd-ed-row')).toHaveLength(1);
  });
});

describe('moving a plan task', () => {
  const model = board([
    task('a', { order: 0 }),
    task('b', { order: 1 }),
    task('c', { order: 2 }),
    task('x', { order: 0, id: 'lead-2:x', owner_session_id: 'lead-2' }),
  ]);

  it('takes the place of the task it lands on, within one lead', () => {
    expect(moveTaskOp(model, 'lead-1:c', 'lead-1:a')).toEqual({
      type: 'move_task',
      task_id: 'c',
      before: 'a',
    });
    expect(moveTaskOp(model, 'lead-1:a', 'lead-1:b')).toEqual({
      type: 'move_task',
      task_id: 'a',
      before: 'c',
    });
    expect(moveTaskOp(model, 'lead-1:a', 'lead-1:c')).toEqual({
      type: 'move_task',
      task_id: 'a',
      before: null,
    });
    expect(moveTaskOp(model, 'lead-1:a', 'lead-1:a')).toBeNull();
    expect(moveTaskOp(model, 'lead-1:a', 'lead-2:x')).toBeNull();
    const op = moveTaskOp(model, 'lead-1:a', 'lead-1:b');
    expect(accepted([op])).toBe(true);
  });
});

describe('where an edit of a plan task goes', () => {
  const other = { id: 'lead-2', project_id: 'project-b' };

  it("targets the lead's own project, and nothing for a lead no session names", () => {
    expect(editTarget(task('a'), [other, { id: 'lead-1', project_id: 'project-a' }])).toEqual(
      target,
    );
    expect(editTarget(task('a'), [other])).toBeNull();
  });

  it("is on the lead's own plan version, and 0 for a lead the board does not list", () => {
    const model = board([]);
    const leads = [
      model.leads![0]!,
      { ...model.leads![0]!, session_id: 'lead-2', plan_version: 7 },
    ];
    expect(planVersion({ leads }, 'lead-2')).toBe(7);
    expect(planVersion({ leads }, 'lead-9')).toBe(0);
  });
});

describe('when an edit takes effect', () => {
  const model = board([
    task('idle'),
    task('open', { state: 'running', status: 'running', claim }),
    task('busy', { state: 'running', status: 'running', claim, turn_running: true }),
  ]);
  const set = (id: string, patch: object): PlanOp =>
    ({ type: 'set_task', task_id: id, patch }) as PlanOp;

  it('is now or once the lead decides, whether or not a turn runs', () => {
    expect(editTiming(model, 'lead-1', [set('busy', { title: 'x', milestone: null })])).toBe('now');
    expect(editTiming(model, 'lead-1', [set('busy', { iteration: null, estimate: 3 })])).toBe(
      'now',
    );
    expect(
      editTiming(model, 'lead-1', [{ type: 'move_task', task_id: 'busy', before: null }]),
    ).toBe('now');
    expect(editTiming(model, 'lead-1', [set('idle', { goal: 'x' })])).toBe('now');
    expect(editTiming(model, 'lead-1', [set('open', { scope: ['src'] })])).toBe('lead');
    expect(editTiming(model, 'lead-1', [set('busy', { goal: 'x' })])).toBe('lead');
  });

  it('waits for the lead to change the flow path of a task with an unfinished session', () => {
    expect(editTiming(model, 'lead-1', [set('open', { path: 'review_loop' })])).toBe('lead');
    expect(editTiming(model, 'lead-1', [set('idle', { path: null })])).toBe('now');
  });
});

describe('the unsent edits list against the held edits of the board', () => {
  const effort: PlanOp = { type: 'set_task', task_id: 'b', patch: { effort: 'low' } };
  const held = {
    id: 'edit-9',
    task_ids: ['b'],
    summary: 'set_task b',
    state: 'pending' as const,
    ops: [effort],
    base_version: 3,
    created_at: NOW - 5 * 60_000,
  };
  const sentHeld = {
    target: { ...target, planId: 'b', taskId: 'lead-1:b' },
    outcome: { kind: 'pending' as const, editId: 'edit-9' },
    ops: [effort],
  };

  it('lists the board held edits with their time and drops the local copy', () => {
    const model = board([task('b', { state: 'running', claim })], { pending_edits: [held] });
    const listed = unsentEdits(model, 'project-a', [sentHeld]);
    expect(listed.map((e) => [e.key, e.status, e.editId, e.createdAt])).toEqual([
      ['held:edit-9', 'pending', 'edit-9', NOW - 5 * 60_000],
    ]);
    const h = mount(() => UnsentEdits({ model, projectId: 'project-a' }));
    expect(text(find(h.value, (n) => n.props.className === 'bd-bn-at'))).toBe('5 分钟');
  });

  it('keeps a local held edit while the board does not list held edits', () => {
    const model = board([task('b', { state: 'running', claim })], { pending_edits: undefined });
    expect(
      unsentEdits(model, 'project-a', [sentHeld]).map((e) => [e.key, e.status, e.editId]),
    ).toEqual([['sent:lead-1:b', 'pending', 'edit-9']]);
  });

  it('keeps a local held edit and its Withdraw while withdrawing it, and shows a refusal', async () => {
    const model = board([task('b', { state: 'running', claim })], { pending_edits: undefined });
    runCommand.mockResolvedValueOnce({ ok: true, value: { applied: false, edit_id: 'edit-9' } });
    await editPlan(sentHeld.target, [effort], 3);
    const list = () => mount(() => UnsentEdits({ model, projectId: 'project-a' })).value;
    const rows = () => nodes(list()).filter((n) => n.props.className === 'bd-ed-row');
    expect(rows()).toHaveLength(1);
    const withdraw = named(list(), 'Withdraw');
    const w = mount(() => (withdraw.type as (p: object) => ReactElement<any>)(withdraw.props));
    const answer = deferred<unknown>();
    runCommand.mockReturnValueOnce(answer.promise);
    find(w.value, (n) => n.type === 'button').props.onClick();
    expect(rows()).toHaveLength(1);
    answer.resolve({ ok: false, error: { code: 'edit_not_pending', message: 'Already decided' } });
    await w.flush();
    expect(rows()).toHaveLength(1);
    expect(nodes(w.value).some((n) => n.props.className === 'bd-perr')).toBe(true);
    runCommand.mockResolvedValueOnce({ ok: true, value: {} });
    find(w.value, (n) => n.type === 'button').props.onClick();
    await w.flush();
    expect(rows()).toHaveLength(0);
  });
});
