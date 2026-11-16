import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition, WorkflowPolicy, WorkflowStep } from '@pantheon/domain';
import type { BoardModel, BridgeResult } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import { deferred, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { WorkflowBar, WorkflowTab } from '@/screens/insights/WorkflowTab';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'] };

const FIXED = [
  'plan',
  'plan_review',
  'dispatch',
  'build',
  'gate',
  'merge',
  'handback',
  'wake',
  'review',
  'acceptance',
];

const lint = {
  id: 'lint',
  title: 'Lint the change',
  kind: { type: 'command' as const, command: 'pnpm lint', timeout_seconds: 120 },
};
const signoff = { id: 'signoff', title: 'Sign off', kind: { type: 'approval' as const } };

const definition = (before_merge: WorkflowStep[] = [lint, signoff]): WorkflowDefinition => ({
  slots: { before_dispatch: [], before_merge, after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
});

const view = (id: string, name: string, version = 2, def = definition(), extra = {}) => ({
  id,
  name,
  is_default: id === 'alpha',
  definition_version: version,
  definition: def,
  fixed_steps: FIXED.map((step) => ({
    id: step,
    policy: step === 'handback' ? { handback_limit: 3 } : {},
  })),
  ...extra,
});

const policy = (): WorkflowPolicy => ({
  id: 'alpha',
  revision: 2,
  project_id: 'alpha',
  policy_version: 2,
  improvement_mode: 'confirm',
  path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
  acceptance_wake: 'each_merge',
  max_parallel: 3,
  max_parallel_limit: 4,
  handback_limit: 3,
  budget: {},
  pinned: [],
});

const bridge = {
  views: {} as Record<string, ReturnType<typeof view>>,
  defaultId: 'alpha',
  // While set, workflow.definition reads stay out until the test ends.
  hold: false,
  release: [] as (() => void)[],
  list: [] as { id: string; name: string; version: number; is_default: boolean }[],
  reads: [] as Record<string, unknown>[],
  commands: [] as Command[],
  answers: [] as BridgeResult<unknown>[],
  async query(method: string, params: Record<string, unknown>): Promise<BridgeResult<unknown>> {
    if (method === 'workflow.definition') {
      bridge.reads.push(params);
      if (bridge.hold)
        return new Promise((resolve) =>
          bridge.release.push(() =>
            resolve({ ok: false, error: { code: 'ipc_failed', message: 'test ended' } }),
          ),
        );
      return {
        ok: true,
        value: bridge.views[(params.id as string | undefined) ?? bridge.defaultId],
      };
    }
    if (method === 'workflow.definition.list') return { ok: true, value: bridge.list };
    if (method === 'workflow.policy') return { ok: true, value: policy() };
    if (method === 'routing.table') return { ok: true, value: { cells: [] } };
    return { ok: false, error: { code: 'unknown_route', message: method } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return bridge.answers.shift() ?? { ok: true, value: {} };
  },
};

type BoardTask = BoardModel['tasks'][number];
type Run = NonNullable<BoardTask['step_runs']>[number];
const NOW = 1_800_000_000_000;
const board = (tasks: BoardTask[] = []) => ({ now: NOW, tasks }) as unknown as BoardModel;

const wf = (key: string) => zh(`insights.workflow.${key}`);
async function open(model = board()) {
  const h = mount(() => WorkflowTab({ projectId: 'alpha', model, onOpenSession() {} }));
  await h.flush();
  return h;
}
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const has = (tree: unknown, label: string) =>
  nodes(tree as never).some((n) => n.props['aria-label'] === label);
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n) === label);
const type = (tree: unknown, label: string, value: string) =>
  labelled(tree, label).props.onChange({ target: { value } });
const chart = (tree: unknown) =>
  nodes(labelled(tree, wf('chart')))
    .filter((n) => n.props['data-step'] || n.props['data-slot'])
    .map((n) => n.props['data-step'] ?? `slot:${n.props['data-slot']}`);
const barOf = (tree: unknown) => WorkflowBar(named(tree as never, 'WorkflowBar').props);
const saveButton = (tree: unknown) => button(barOf(tree), wf('saveToProject'));
const remove = (tree: unknown, title: string) =>
  find(
    labelled(tree, title),
    (n) => typeof n.props.onClick === 'function' && text(n) === wf('delete'),
  ).props.onClick();
const sent = () => bridge.commands.map(({ type, input }) => [type, input]);
const lastSaved = () =>
  bridge.commands.filter((c) => c.type === 'workflow.definition.set').at(-1)!.input as {
    definition: WorkflowDefinition;
  };

beforeEach(() => {
  bridge.views = {
    alpha: view('alpha', 'Default'),
    'wf-fast': view('wf-fast', 'Fast', 1, definition([lint])),
  };
  bridge.list = [
    { id: 'alpha', name: 'Default', version: 2, is_default: true },
    { id: 'wf-fast', name: 'Fast', version: 1, is_default: false },
  ];
  bridge.defaultId = 'alpha';
  bridge.hold = false;
  bridge.reads = [];
  bridge.commands = [];
  bridge.answers = [];
  vi.stubGlobal('window', { pantheon: bridge });
  let made = 0;
  vi.stubGlobal('crypto', { randomUUID: () => (++made === 1 ? 'new-step' : `new-step-${made}`) });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(async () => {
  unmountAll();
  // A read still out would be joined by the next test's queries of the same input.
  for (const release of bridge.release.splice(0)) release();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('named workflows', () => {
  const workflows = (tree: unknown) => labelled(tree, wf('workflows'));
  const chip = (tree: unknown, name: string) =>
    find(workflows(tree), (n) => n.type === 'button' && text(n).startsWith(name));

  it("lists the project's workflows with the default marked and edits the one picked", async () => {
    const h = await open();
    const chips = nodes(workflows(h.value)).filter((n) => n.props['aria-pressed'] !== undefined);
    expect(chips.map((n) => [text(n), n.props['aria-pressed']])).toEqual([
      ['Default', true],
      ['Fast', false],
    ]);
    expect(labelled(chip(h.value, 'Default'), wf('isDefault')).props.role).toBe('img');
    chip(h.value, 'Fast').props.onClick();
    await h.flush();
    expect(bridge.reads.at(-1)).toEqual({ project_id: 'alpha', id: 'wf-fast' });
    expect(chart(h.value)).toContain('lint');
    expect(chart(h.value)).not.toContain('signoff');
    expect(chip(h.value, 'Fast').props['aria-pressed']).toBe(true);
    expect(text(barOf(h.value))).toContain('版本 1');
    find(h.value, (n) => n.props['data-step'] === 'lint' && n.type === 'button').props.onClick();
    await h.flush();
    type(h.value, wf('command'), 'pnpm lint --fix');
    await h.flush();
    button(h.value, wf('apply')).props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(bridge.commands.at(-1)!.input).toMatchObject({
      project_id: 'alpha',
      id: 'wf-fast',
      base_version: 1,
    });
  });

  it('saves the workflow with its unsaved changes under a new name and edits the copy', async () => {
    const h = await open();
    remove(h.value, 'Sign off');
    await h.flush();
    button(barOf(h.value), wf('saveAs')).props.onClick();
    await h.flush();
    type(h.value, wf('saveAs.name'), 'Careful');
    await h.flush();
    bridge.answers.push({ ok: true, value: view('wf-new', 'Careful', 1) });
    bridge.views['wf-new'] = view('wf-new', 'Careful', 2, definition([lint]));
    bridge.list = [
      ...bridge.list,
      { id: 'wf-new', name: 'Careful', version: 2, is_default: false },
    ];
    button(workflows(h.value), wf('saveAs.save')).props.onClick();
    await h.flush();
    await h.flush();
    expect(sent()).toEqual([
      ['workflow.definition.save_as', { project_id: 'alpha', from_id: 'alpha', name: 'Careful' }],
      [
        'workflow.definition.set',
        { project_id: 'alpha', id: 'wf-new', definition: definition([lint]), base_version: 1 },
      ],
    ]);
    expect(bridge.reads.at(-1)).toEqual({ project_id: 'alpha', id: 'wf-new' });
    expect(chip(h.value, 'Careful').props['aria-pressed']).toBe(true);
  });

  it('makes the workflow being edited the default', async () => {
    const h = await open();
    expect(nodes(workflows(h.value)).some((n) => text(n) === wf('setDefault'))).toBe(false);
    chip(h.value, 'Fast').props.onClick();
    await h.flush();
    button(workflows(h.value), wf('setDefault')).props.onClick();
    await h.flush();
    expect(sent()).toEqual([
      ['workflow.definition.set_default', { project_id: 'alpha', id: 'wf-fast' }],
    ]);
  });

  it('saves the workflow being edited after another one becomes the default', async () => {
    const h = await open();
    remove(h.value, 'Sign off');
    await h.flush();
    bridge.views['wf-fast'] = view('wf-fast', 'Fast', 2, definition([signoff]), {
      is_default: true,
    });
    bridge.defaultId = 'wf-fast';
    useBoard.setState({ board: { cursor: 2, projects: [project], sessions: [] } } as never);
    h.render();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(lastSaved()).toMatchObject({
      id: 'alpha',
      base_version: 2,
      definition: definition([lint]),
    });
  });

  it('keeps an edit made while a save is out', async () => {
    const h = await open();
    remove(h.value, 'Sign off');
    await h.flush();
    const answer = deferred<BridgeResult<unknown>>();
    bridge.answers.push(answer.promise as never);
    saveButton(h.value).props.onClick();
    await h.flush();
    remove(h.value, 'Lint the change');
    await h.flush();
    answer.resolve({ ok: true, value: {} });
    await h.flush();
    expect(chart(h.value)).not.toContain('lint');
    expect(named(h.value, 'WorkflowBar').props.dirty).toBe(true);
  });

  it('keeps an edit made while a copy is being saved', async () => {
    const h = await open();
    remove(h.value, 'Sign off');
    await h.flush();
    button(barOf(h.value), wf('saveAs')).props.onClick();
    await h.flush();
    type(h.value, wf('saveAs.name'), 'Careful');
    await h.flush();
    const answer = deferred<BridgeResult<unknown>>();
    bridge.answers.push(answer.promise as never);
    bridge.views['wf-new'] = view('wf-new', 'Careful', 2, definition([lint]));
    button(workflows(h.value), wf('saveAs.save')).props.onClick();
    await h.flush();
    remove(h.value, 'Lint the change');
    await h.flush();
    answer.resolve({ ok: true, value: view('wf-new', 'Careful', 1) });
    await h.flush();
    await h.flush();
    expect(bridge.reads.at(-1)).toEqual({ project_id: 'alpha', id: 'wf-new' });
    expect(chart(h.value)).not.toContain('lint');
    expect(named(h.value, 'WorkflowBar').props.dirty).toBe(true);
  });

  it('does not take the Enter that confirms an input method candidate as saving the copy', async () => {
    const h = await open();
    button(barOf(h.value), wf('saveAs')).props.onClick();
    await h.flush();
    type(h.value, wf('saveAs.name'), '仔细');
    await h.flush();
    labelled(h.value, wf('saveAs.name')).props.onKeyDown({
      key: 'Enter',
      nativeEvent: { isComposing: true },
    });
    await h.flush();
    expect(bridge.commands).toEqual([]);
  });

  it('leaves the save controls off while the cached read is not confirmed', async () => {
    const first = await open();
    first.unmount();
    bridge.hold = true;
    const h = await open();
    remove(h.value, 'Sign off');
    await h.flush();
    expect(saveButton(h.value).props.disabled).toBe(true);
    expect(saveButton(h.value).props['aria-busy']).toBe(true);
    expect(button(barOf(h.value), wf('saveAs')).props.disabled).toBe(true);
  });

  it('counts the tasks and lists the step runs of the workflow picked only', async () => {
    const run = (id: string, workflow_id: string, state: Run['state'], ago = 1): Run => ({
      id,
      slot: 'before_merge',
      step_id: 'lint',
      workflow_id,
      title: 'Lint the change',
      kind: 'command',
      state,
      created_at: NOW - ago * 60_000,
    });
    const task = (id: string, workflow_id: string, state: BoardTask['state'], runs: Run[]) =>
      ({
        id: `lead:${id}`,
        title: `task ${id}`,
        path: 'dispatch',
        workflow_id,
        state,
        step_runs: runs,
      }) as BoardTask;
    const h = await open(
      board([
        task('a', 'alpha', 'running', [run('a1', 'alpha', 'running')]),
        task('b', 'wf-fast', 'running', [run('b1', 'wf-fast', 'waiting')]),
        task('c', 'wf-fast', 'blocked', [run('c1', 'wf-fast', 'failed', 0)]),
      ]),
    );
    const shown = () => ({
      inUse: named(h.value, 'WorkflowBar').props.inUse,
      runs: nodes(labelled(h.value, wf('runs')))
        .filter((n) => n.type === 'tr' && n.props['data-run'])
        .map((n) => n.props['data-run']),
      here: text(labelled(h.value, 'Lint the change')).includes('现在 1 个'),
      build: find(h.value, (n) => n.props.className === 'wfl-meter').props['aria-label'],
    });
    expect(shown()).toEqual({ inUse: 1, runs: ['a1'], here: true, build: '1 个在跑' });
    chip(h.value, 'Fast').props.onClick();
    await h.flush();
    expect(shown()).toEqual({
      inUse: 2,
      runs: ['c1', 'b1'],
      here: true,
      build: '1 个在跑，1 个卡住',
    });
  });

  describe('switching projects', () => {
    let projectId = 'alpha';
    const mountSwitching = async () => {
      projectId = 'alpha';
      const h = mount(() => WorkflowTab({ projectId, model: board(), onOpenSession() {} }));
      await h.flush();
      return h;
    };
    const beta = { ...project, id: 'beta', name: 'Beta app' };

    it('reads the default workflow of the project switched to', async () => {
      const h = await mountSwitching();
      chip(h.value, 'Fast').props.onClick();
      await h.flush();
      useBoard.setState({ board: { cursor: 1, projects: [project, beta], sessions: [] } } as never);
      projectId = 'beta';
      h.render();
      await h.flush();
      expect(bridge.reads.at(-1)).toEqual({ project_id: 'beta' });
    });

    it("keeps a save's answer from the project left out of the one switched to", async () => {
      const h = await mountSwitching();
      remove(h.value, 'Sign off');
      await h.flush();
      const answer = deferred<BridgeResult<unknown>>();
      bridge.answers.push(answer.promise as never);
      saveButton(h.value).props.onClick();
      await h.flush();
      useBoard.setState({ board: { cursor: 1, projects: [project, beta], sessions: [] } } as never);
      projectId = 'beta';
      h.render();
      await h.flush();
      answer.resolve({ ok: false, error: { code: 'bad_input', message: 'alpha refused' } });
      await h.flush();
      expect(nodes(h.value).some((n) => n.props.role === 'alert')).toBe(false);
      expect(named(h.value, 'WorkflowBar').props.dirty).toBe(false);
    });
  });
});

describe('workflow trial', () => {
  it('lets only the next tasks try a saved change', async () => {
    const h = await open();
    remove(h.value, 'Sign off');
    await h.flush();
    labelled(barOf(h.value), wf('trial.try')).props.onChange({
      target: { checked: true },
    });
    await h.flush();
    expect(text(labelled(barOf(h.value), wf('trial.tasks')))).toContain('5');
    labelled(barOf(h.value), '试用的任务数 加一').props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(bridge.commands.at(-1)!.input).toEqual({
      project_id: 'alpha',
      id: 'alpha',
      definition: definition([lint]),
      base_version: 2,
      trial_tasks: 6,
    });
  });

  it('shows how far a running trial has come', async () => {
    bridge.views.alpha = view('alpha', 'Default', 3, definition(), {
      trial: { tasks: 5, done: 2, previous_version: 2 },
    });
    const h = await open();
    const progress = labelled(barOf(h.value), '试用：5 个任务里 2 个已完成');
    expect(text(progress)).toContain('2 / 5');
  });

  it('does not offer saving to the project while a trial runs', async () => {
    bridge.views.alpha = view('alpha', 'Default', 3, definition(), {
      trial: { tasks: 5, done: 2, previous_version: 2 },
    });
    const h = await open();
    remove(h.value, 'Sign off');
    await h.flush();
    expect(saveButton(h.value).props.disabled).toBe(true);
    expect(button(barOf(h.value), wf('saveAs')).props.disabled).toBe(false);
  });
});

describe('conditional, parallel and loop steps', () => {
  const part = (tree: unknown, n: number) => labelled(tree, `第 ${n} 个子步骤`);

  it('saves the paths a step runs for, one glob a line', async () => {
    const h = await open();
    labelled(h.value, '合并前加步骤').props.onClick();
    await h.flush();
    type(h.value, wf('title'), 'Schema check');
    type(h.value, wf('command'), 'pnpm schema');
    type(h.value, wf('when'), 'src/db/**\n\n  migrations/*.sql \n');
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(lastSaved().definition.slots.before_merge.at(-1)).toEqual({
      id: 'new-step',
      title: 'Schema check',
      when: { changed_paths: ['src/db/**', 'migrations/*.sql'] },
      kind: { type: 'command', command: 'pnpm schema', timeout_seconds: 300 },
    });
  });

  it('builds a parallel group of two to four steps', async () => {
    const h = await open();
    labelled(h.value, '合并前加步骤').props.onClick();
    await h.flush();
    labelled(h.value, wf('kind')).props.onValueChange('parallel');
    await h.flush();
    expect(has(h.value, '第 1 个子步骤')).toBe(true);
    expect(has(h.value, '第 2 个子步骤')).toBe(true);
    expect(has(h.value, '第 3 个子步骤')).toBe(false);
    type(h.value, wf('title'), 'Checks');
    labelled(part(h.value, 1), wf('kind')).props.onValueChange('command');
    await h.flush();
    type(part(h.value, 1), wf('title'), 'Types');
    type(part(h.value, 1), wf('command'), 'pnpm tsc');
    labelled(part(h.value, 2), wf('kind')).props.onValueChange('approval');
    await h.flush();
    type(part(h.value, 2), wf('title'), 'Look');
    await h.flush();
    button(h.value, wf('part.add')).props.onClick();
    await h.flush();
    expect(has(h.value, '第 3 个子步骤')).toBe(true);
    expect(button(h.value, wf('add')).props.disabled).toBe(true);
    labelled(h.value, '移除第 3 个子步骤').props.onClick();
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(lastSaved().definition.slots.before_merge.at(-1)).toEqual({
      id: 'new-step',
      title: 'Checks',
      kind: {
        type: 'parallel',
        steps: [
          {
            id: 'new-step-2',
            title: 'Types',
            kind: { type: 'command', command: 'pnpm tsc', timeout_seconds: 300 },
          },
          { id: 'new-step-3', title: 'Look', kind: { type: 'approval' } },
        ],
      },
    });
  });

  it('builds a loop of one step run until it passes, at most a number of times', async () => {
    const h = await open();
    labelled(h.value, '合并前加步骤').props.onClick();
    await h.flush();
    labelled(h.value, wf('kind')).props.onValueChange('loop');
    await h.flush();
    expect(has(h.value, '第 2 个子步骤')).toBe(false);
    type(h.value, wf('title'), 'Until green');
    labelled(part(h.value, 1), wf('kind')).props.onValueChange('command');
    await h.flush();
    type(part(h.value, 1), wf('title'), 'Tests');
    type(part(h.value, 1), wf('command'), 'pnpm test');
    labelled(h.value, '最多跑几次 加一').props.onClick();
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(lastSaved().definition.slots.before_merge.at(-1)).toEqual({
      id: 'new-step',
      title: 'Until green',
      kind: {
        type: 'loop',
        step: {
          id: 'new-step-2',
          title: 'Tests',
          kind: { type: 'command', command: 'pnpm test', timeout_seconds: 300 },
        },
        max: 4,
        until: 'passes',
      },
    });
  });

  const group: WorkflowStep = {
    id: 'checks',
    title: 'Checks',
    kind: { type: 'parallel', steps: [lint, { ...signoff, id: 'look', title: 'Look' }] },
  };
  const loop: WorkflowStep = {
    id: 'green',
    title: 'Until green',
    kind: { type: 'loop', step: { ...lint, id: 'tests', title: 'Tests' }, max: 3, until: 'passes' },
  };

  it('draws a parallel group side by side and a loop with a mark back to itself', async () => {
    bridge.views.alpha = view('alpha', 'Default', 2, definition([group, loop]));
    const h = await open();
    const node = (id: string) =>
      find(h.value, (n) => n.props['data-step'] === id && n.type === 'button');
    const side = find(node('checks'), (n) => n.props.className === 'wfl-par');
    expect(
      nodes(side)
        .filter((n) => n.props['data-part'])
        .map((n) => text(n)),
    ).toEqual(['Lint the change', 'Look']);
    expect(labelled(labelled(h.value, 'Until green'), '不过就再跑，最多 3 次').props.role).toBe(
      'img',
    );
    node('checks').props.onClick();
    await h.flush();
    expect(labelled(h.value, wf('kind')).props.value).toBe('parallel');
    expect(labelled(part(h.value, 2), wf('title')).props.value).toBe('Look');
  });

  it("keeps the scope and paths of a group's steps when the group is applied", async () => {
    const scoped = {
      ...lint,
      applies_to: { tiers: ['t2' as const] },
      when: { changed_paths: ['src/**'] },
    };
    const checks: WorkflowStep = {
      id: 'checks',
      title: 'Checks',
      kind: { type: 'parallel', steps: [scoped, { ...signoff, id: 'look', title: 'Look' }] },
    };
    const green: WorkflowStep = {
      id: 'green',
      title: 'Until green',
      kind: {
        type: 'loop',
        step: { ...scoped, id: 'tests', title: 'Tests' },
        max: 3,
        until: 'passes',
      },
    };
    bridge.views.alpha = view('alpha', 'Default', 2, definition([checks, green]));
    const h = await open();
    const node = (id: string) =>
      find(h.value, (n) => n.props['data-step'] === id && n.type === 'button');
    node('checks').props.onClick();
    await h.flush();
    type(h.value, wf('title'), 'All checks');
    await h.flush();
    button(h.value, wf('apply')).props.onClick();
    await h.flush();
    node('green').props.onClick();
    await h.flush();
    type(h.value, wf('title'), 'Green');
    await h.flush();
    button(h.value, wf('apply')).props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(lastSaved().definition.slots.before_merge).toEqual([
      { ...checks, title: 'All checks' },
      { ...green, title: 'Green' },
    ]);
  });

  it('marks a skipped step run apart in the runs table', async () => {
    const skipped: Run = {
      id: 'r1',
      slot: 'before_merge',
      step_id: 'lint',
      workflow_id: 'alpha',
      title: 'Lint the change',
      kind: 'command',
      state: 'skipped',
      reason: 'condition',
      created_at: NOW - 60_000,
    };
    const h = await open(board([{ id: 'lead:a', title: 'a', step_runs: [skipped] } as BoardTask]));
    const row = find(labelled(h.value, wf('runs')), (n) => n.props['data-run'] === 'r1');
    expect(row.props['data-state']).toBe('skipped');
    expect(text(row)).toContain(wf('run.skipped'));
  });
});
