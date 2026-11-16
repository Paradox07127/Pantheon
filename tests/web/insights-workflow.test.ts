import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition, WorkflowPolicy } from '@pantheon/domain';
import type { BoardModel, BridgeResult } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { autoMergeRequest } from '@/data/auto-merge';
import { useBoard } from '@/data/board';
import { useSettingsView } from '@/screens/settings/view';
import { ModeList, PolicyFields, WorkflowBar, WorkflowTab } from '@/screens/insights/WorkflowTab';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

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

const definition = (): WorkflowDefinition => ({
  slots: { before_dispatch: [], before_merge: [lint, signoff], after_merge: [] },
  plan_review: { tiers: ['t3'] },
  review: { max_rounds: 3 },
});

const gates = {
  '/work/alpha': [
    { name: 'build', argv: ['pnpm', 'build'] },
    { name: 'test', argv: ['pnpm', 'test'], timeout_ms: 600_000 },
  ],
};

const project = { id: 'alpha', revision: 1, name: 'Alpha app', roots: ['/work/alpha'], gates };

const FIXED_POLICY: Record<string, Record<string, unknown>> = {
  dispatch: { max_parallel: 3, dispatch_paused: false },
  gate: { gates, acceptance: 'task.acceptance' },
  merge: { auto_merge: false },
  handback: { handback_limit: 3 },
  wake: { acceptance_wake: 'each_merge' },
};

const view = (version = 2, def = definition()) => ({
  id: 'alpha',
  definition_version: version,
  definition: def,
  fixed_steps: FIXED.map((id) => ({ id, policy: FIXED_POLICY[id] ?? {} })),
});

const routing = {
  cells: [
    {
      domain: 'backend-logic',
      tier: 't2',
      first: { runtime: 'codex', model: 'gpt-5' },
      candidates: [],
      prior: null,
    },
    {
      domain: 'frontend-ui',
      tier: 't2',
      first: { runtime: 'claude', model: 'claude-opus-4' },
      candidates: [],
      prior: null,
    },
    {
      domain: 'docs-chore',
      tier: 't1',
      first: { runtime: 'codex', model: 'gpt-5' },
      candidates: [],
      prior: null,
    },
  ],
};

const policy = (patch: Partial<WorkflowPolicy> = {}): WorkflowPolicy => ({
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
  dispatch_paused: false,
  ...patch,
});

const bridge = {
  view: view(),
  reads: 0,
  commands: [] as Command[],
  answers: [] as BridgeResult<unknown>[],
  async query(method: string, params: Record<string, unknown>): Promise<BridgeResult<unknown>> {
    if (method === 'workflow.definition') {
      bridge.reads++;
      return { ok: true, value: bridge.view };
    }
    if (method === 'workflow.policy') return { ok: true, value: policy() };
    if (method === 'routing.table') return { ok: true, value: routing };
    if (method === 'runtime.models')
      return {
        ok: true,
        value:
          params.runtime === 'codex'
            ? [
                {
                  id: 'gpt-5',
                  label: 'GPT-5',
                  permission_modes: [],
                  efforts: ['low', 'high'],
                  default_effort: 'low',
                  default: true,
                },
              ]
            : [],
      };
    if (method === 'extensions.inventory')
      return {
        ok: true,
        value: {
          runtime: params.runtime,
          mcp_servers: [],
          plugins: [],
          skills:
            params.runtime === 'claude'
              ? [
                  { id: 'tidy', name: 'tidy', enabled: true, path: '/skills/tidy/SKILL.md' },
                  { id: 'nopath', name: 'nopath', enabled: true },
                ]
              : [],
          apps: false,
          connectors: [],
          hooks: [],
        },
      };
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
const MINUTE = 60_000;

const run = (
  id: string,
  step: { id: string; title: string; kind: { type: Run['kind'] } },
  state: Run['state'],
  ago: number,
  extra: Partial<Run> = {},
): Run => ({
  id,
  slot: 'before_merge',
  step_id: step.id,
  workflow_id: 'alpha',
  title: step.title,
  kind: step.kind.type,
  state,
  created_at: NOW - ago * MINUTE,
  ...extra,
});
const boardTask = (id: string, step_runs: Run[], extra: Partial<BoardTask> = {}) =>
  ({
    id: `lead:${id}`,
    title: `task ${id}`,
    workflow_id: 'alpha',
    step_runs,
    ...extra,
  }) as BoardTask;
const board = (tasks: BoardTask[] = [], extra: Partial<BoardModel> = {}) =>
  ({ now: NOW, tasks, ...extra }) as unknown as BoardModel;

const wf = (key: string) => zh(`insights.workflow.${key}`);
const css = readFileSync(
  new URL('../../apps/web/src/screens/insights/workflow.css', import.meta.url),
  'utf8',
);
const opened: string[] = [];
async function tab(model = board()) {
  const h = mount(() =>
    WorkflowTab({ projectId: 'alpha', model, onOpenSession: (id) => opened.push(id) }),
  );
  await h.flush();
  return h;
}
const labelled = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.props['aria-label'] === label);
const has = (tree: unknown, label: string) =>
  nodes(tree as never).some((n) => n.props['aria-label'] === label);
const button = (tree: unknown, label: string) =>
  find(tree as never, (n) => n.type === 'button' && text(n) === label);
const item = (tree: unknown, label: string) =>
  find(tree as never, (n) => typeof n.props.onClick === 'function' && text(n) === label);
const type = (tree: unknown, label: string, value: string) =>
  labelled(tree, label).props.onChange({ target: { value } });
const chart = (tree: unknown) =>
  nodes(labelled(tree, wf('chart')))
    .filter((n) => n.props['data-step'] || n.props['data-slot'])
    .map((n) => n.props['data-step'] ?? `slot:${n.props['data-slot']}`);
const stepNode = (tree: unknown, id: string) =>
  find(tree as never, (n) => n.props['data-step'] === id && n.type === 'button');
// Opens a step in the inspector.
const pick = async (h: HookHost<any>, id: string) => {
  stepNode(h.value, id).props.onClick();
  await h.flush();
};
const saved = () => bridge.commands.at(-1)!.input as { definition: WorkflowDefinition };
const barOf = (tree: unknown) => WorkflowBar(named(tree as never, 'WorkflowBar').props);
const saveButton = (tree: unknown) => button(barOf(tree), wf('saveToProject'));

beforeEach(() => {
  bridge.view = view();
  bridge.reads = 0;
  bridge.commands = [];
  bridge.answers = [];
  opened.length = 0;
  vi.stubGlobal('window', { pantheon: bridge });
  let made = 0;
  vi.stubGlobal('crypto', { randomUUID: () => (++made === 1 ? 'new-step' : `new-step-${made}`) });
  useBoard.setState({
    board: { cursor: 1, projects: [project], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  useBoard.setState({ board: null });
});

describe('workflow step chart', () => {
  it("draws the fixed steps in the daemon's order with the three slots and their steps in place", async () => {
    bridge.view = { ...view(), fixed_steps: view().fixed_steps.slice().reverse() };
    const h = await tab();
    expect(chart(h.value)).toEqual([
      'acceptance',
      'review',
      'wake',
      'handback',
      'slot:before_merge',
      'lint',
      'signoff',
      'merge',
      'slot:after_merge',
      'gate',
      'build',
      'slot:before_dispatch',
      'dispatch',
      'plan_review',
      'plan',
    ]);
    expect(text(barOf(h.value))).toContain('版本 2');
    expect(has(h.value, '派发前加步骤')).toBe(true);
    expect(has(h.value, '合并前加步骤')).toBe(true);
    expect(has(h.value, '合并后加步骤')).toBe(true);
  });

  it('shows no version before the first save', async () => {
    bridge.view = view(0);
    const h = await tab();
    expect(text(barOf(h.value))).not.toContain('版本');
  });

  it('marks the custom steps apart from the fixed ones', async () => {
    const h = await tab();
    const custom = nodes(labelled(h.value, wf('chart'))).filter((n) => n.props['data-custom']);
    expect(custom.map((n) => n.props['data-step'])).toEqual(['lint', 'signoff']);
    expect(custom.map((n) => n.props['data-kind'])).toEqual(['command', 'approval']);
  });

  it('counts on a custom step the tasks stopped at it now', async () => {
    const h = await tab(
      board([
        boardTask('a', [run('a1', lint, 'waiting', 5)]),
        boardTask('b', [run('b1', lint, 'running', 2), run('b2', signoff, 'passed', 1)]),
      ]),
    );
    expect(text(labelled(h.value, 'Lint the change'))).toContain('现在 2 个');
    expect(text(labelled(h.value, 'Sign off'))).not.toContain('现在');
    const done = await tab(
      board([
        boardTask('a', [run('a1', lint, 'passed', 5)]),
        boardTask('b', [run('b1', lint, 'passed', 2)]),
      ]),
    );
    expect(text(labelled(done.value, 'Lint the change'))).not.toContain('现在');
  });

  it('draws each way back from a failed step to the step it returns to, with its limit', async () => {
    const h = await tab();
    expect(has(h.value, '不过，重拆：从计划审查回到计划')).toBe(true);
    expect(has(h.value, '失败，最多交回 3 次：从门禁回到实现')).toBe(true);
    expect(has(h.value, '退回，最多 3 轮：从代码审查回到实现')).toBe(true);
    bridge.view = { ...view(), fixed_steps: view().fixed_steps.slice().reverse() };
    const reversed = await tab();
    expect(text(reversed.value)).not.toContain('失败，最多交回');
  });

  it('says the agent does not fix a failure and draws no way back when the hand-back limit is 0', async () => {
    bridge.view = {
      ...view(),
      fixed_steps: view().fixed_steps.map((step) =>
        step.id === 'handback' ? { ...step, policy: { handback_limit: 0 } } : step,
      ),
    };
    const h = await tab();
    const node = stepNode(h.value, 'handback');
    expect(text(node)).toContain(zh('settings.gate.fixOff'));
    expect(text(h.value)).not.toContain('失败，最多交回');
  });

  it('shows on each fixed step the values that govern it', async () => {
    const h = await tab(board([], { slots: { limit: 3, used: 2, queued: 0 } }));
    const node = (id: string) => stepNode(h.value, id);
    expect(has(node('build'), 'Claude, Codex')).toBe(true);
    expect(text(node('build'))).toContain('最多 3 个一起');
    expect(text(node('plan_review'))).toContain('T3');
    expect(text(node('gate'))).toContain('2 条命令');
    expect(text(node('merge'))).toContain(wf('sub.manualMerge'));
    expect(text(node('handback'))).toContain('最多 3 次');
    expect(text(node('wake'))).toContain(zh('data.workflowPolicy.wake.eachMerge'));
    expect(text(node('review'))).toContain('最多 3 轮');
    expect(text(node('dispatch'))).not.toContain(wf('sub.paused'));
  });

  it('colours the build bar by where its tasks stand and counts them', async () => {
    const h = await tab(
      board(
        [
          boardTask('a', [], { state: 'running' }),
          boardTask('b', [], { state: 'claimed' }),
          boardTask('c', [], { state: 'waiting_approval' }),
          boardTask('d', [], { state: 'blocked' }),
          boardTask('e', [], { state: 'merged' }),
          boardTask('f', [], { state: 'gating' }),
        ],
        { slots: { limit: 6, used: 4, queued: 0 } },
      ),
    );
    const build = stepNode(h.value, 'build');
    const bar = find(build, (n) => n.props.className === 'wfl-meter');
    expect(
      nodes(bar)
        .filter((n) => n.type === 'i')
        .map((n) => [n.props['data-state'], n.props.style.flexGrow]),
    ).toEqual([
      ['running', 2],
      ['waiting', 1],
      ['blocked', 1],
      [undefined, 2],
    ]);
    expect(bar.props['aria-label']).toBe('6 个槽位用了 4 个，2 个在跑，1 个等你，1 个卡住');
    expect(text(build)).toContain('现在 4 个');
  });

  it('lays the modes, the chart and the inspector out as columns with no panel heading', async () => {
    const h = await tab();
    expect(h.value.props.className).toBe('wfl');
    expect(h.value.props['aria-label']).toBe(zh('insights.sections.workflow'));
    expect(nodes(h.value).some((n) => n.type === 'h2')).toBe(false);
    const body = find(h.value, (n) => n.props.className === 'wfl-body');
    expect(named(body, 'ModeList').props).toEqual({ projectId: 'alpha' });
    expect(nodes(body).some((n) => n.props.className === 'wfl-main')).toBe(true);
  });

  it('numbers the selected step in the inspector header by its place in the chart', async () => {
    const h = await tab();
    const head = () => text(find(h.value, (n) => n.props.className === 'wfl-sh'));
    await pick(h, 'gate');
    expect(head()).toContain('第 5 步');
    await pick(h, 'signoff');
    expect(head()).toContain('第 7 步');
    labelled(h.value, '合并后加步骤').props.onClick();
    await h.flush();
    expect(head()).not.toContain('步');
  });
});

describe('workflow bar', () => {
  it('counts the unfinished tasks run by the workflow and saves to the project', async () => {
    const h = await tab(
      board([
        boardTask('a', [], { path: 'dispatch', state: 'running' }),
        boardTask('b', [], { path: 'direct', state: 'todo' }),
        boardTask('c', [], { path: 'dispatch', state: 'merged' }),
        boardTask('d', [], { path: 'review_loop', state: 'failed' }),
        boardTask('e', []),
      ]),
    );
    expect(named(h.value, 'WorkflowBar').props).toMatchObject({
      inUse: 2,
      version: 2,
      dirty: false,
      busy: false,
    });
    const bar = barOf(h.value);
    expect(text(bar)).toContain('在用它的任务 2');
    expect(saveButton(h.value).props.className).toBe('btn pri');
    expect(saveButton(h.value).props.disabled).toBe(true);
  });
});

describe('orchestration modes', () => {
  beforeEach(() => useSettingsView.setState({ open: false, page: 'general' }));

  it('shows the tiers each mode runs with no control to move them, and links to the workflow settings', async () => {
    const h = mount(() => ModeList({ projectId: 'alpha' }));
    await h.flush();
    const modes = nodes(h.value)
      .filter((n) => n.type === 'li')
      .map((n) => text(n));
    expect(modes).toEqual([
      `${zh('data.workflowPolicy.path.dispatch')}T2, T3`,
      zh('data.workflowPolicy.path.reviewLoop'),
      `${zh('data.workflowPolicy.path.direct')}T1`,
    ]);
    expect(nodes(h.value).filter((n) => n.props['aria-pressed'] !== undefined)).toEqual([]);
    const clickable = nodes(h.value).filter((n) => typeof n.props.onClick === 'function');
    expect(clickable.map((n) => text(n))).toEqual([wf('editInSettings')]);
    clickable[0]!.props.onClick();
    expect(useSettingsView.getState()).toMatchObject({
      open: true,
      page: 'workflow',
    });
    expect(bridge.commands).toEqual([]);
  });
});

describe('step toolbar', () => {
  const transfer = () => {
    const data = new Map<string, string>();
    return {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      get types() {
        return [...data.keys()];
      },
      effectAllowed: '',
      dropEffect: '',
    };
  };

  it('offers a skill step of its own, a prompt step that runs a skill', async () => {
    const h = await tab();
    const skill = find(
      labelled(h.value, wf('palette')),
      (n) => n.props.draggable && text(n) === 'skill',
    );
    const dataTransfer = transfer();
    skill.props.onDragStart({ dataTransfer });
    find(h.value, (n) => n.props['data-step'] === 'lint').props.onDrop({
      preventDefault() {},
      dataTransfer,
    });
    await h.flush();
    expect(labelled(h.value, wf('kind')).props.value).toBe('prompt');
    expect(nodes(h.value).some((n) => n.props['aria-label'] === 'skill' && n.props.options)).toBe(
      true,
    );
    labelled(h.value, wf('close')).props.onClick();
    await h.flush();
    item(
      labelled(labelled(h.value, wf('palette')), 'skill'),
      wf('slot.beforeDispatch'),
    ).props.onClick();
    await h.flush();
    expect(labelled(h.value, wf('kind')).props.value).toBe('prompt');
    expect(text(find(h.value, (n) => n.props.className === 'wfl-sh'))).toContain(
      wf('slot.beforeDispatch'),
    );
  });

  it('offers the step kinds and adds the one dragged where it is dropped', async () => {
    const h = await tab();
    const tools = labelled(h.value, wf('palette'));
    const kinds = nodes(tools).filter((n) => n.props.draggable);
    expect(kinds.map((n) => text(n))).toEqual([
      wf('kind.prompt'),
      wf('kind.command'),
      wf('kind.review'),
      wf('kind.approval'),
      'skill',
      wf('kind.parallel'),
      wf('kind.loop'),
    ]);
    const dataTransfer = transfer();
    kinds[3]!.props.onDragStart({ dataTransfer });
    const target = find(h.value, (n) => n.props['data-step'] === 'signoff');
    const over = { preventDefault() {}, dataTransfer };
    target.props.onDragOver(over);
    expect(dataTransfer.dropEffect).toBe('copy');
    target.props.onDrop(over);
    await h.flush();
    expect(labelled(h.value, wf('kind')).props.value).toBe('approval');
    type(h.value, wf('title'), 'Ship it');
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    expect(chart(h.value).slice(6, 10)).toEqual([
      'slot:before_merge',
      'lint',
      'new-step',
      'signoff',
    ]);
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(bridge.commands.map((c) => c.type)).toEqual(['workflow.definition.set']);
    expect(saved().definition.slots.before_merge).toEqual([
      lint,
      { id: 'new-step', title: 'Ship it', kind: { type: 'approval' } },
      signoff,
    ]);
  });

  it('adds a step of a kind at the end of the slot picked from its menu', async () => {
    const h = await tab();
    item(
      labelled(labelled(h.value, wf('palette')), wf('kind.command')),
      wf('slot.afterMerge'),
    ).props.onClick();
    await h.flush();
    expect(labelled(h.value, wf('kind')).props.value).toBe('command');
    type(h.value, wf('title'), 'Tag');
    type(h.value, wf('command'), 'git tag');
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    expect(chart(h.value).slice(10, 12)).toEqual(['slot:after_merge', 'new-step']);
  });

  it('offers each kind only where the daemon can run it', async () => {
    const h = await tab();
    const slotsOf = (item: string) =>
      nodes(labelled(labelled(h.value, wf('palette')), item))
        .filter((n) => typeof n.props.onClick === 'function')
        .map((n) => text(n));
    expect(slotsOf(wf('kind.review'))).toEqual([wf('slot.beforeMerge'), wf('slot.afterMerge')]);
    const review = find(
      labelled(h.value, wf('palette')),
      (n) => n.props.draggable && text(n) === wf('kind.review'),
    );
    const dataTransfer = transfer();
    review.props.onDragStart({ dataTransfer });
    labelled(h.value, '派发前加步骤').props.onDrop({ preventDefault() {}, dataTransfer });
    await h.flush();
    expect(has(h.value, wf('kind'))).toBe(false);

    labelled(h.value, '派发前加步骤').props.onClick();
    await h.flush();
    expect(
      nodes(labelled(h.value, wf('kind')).props.children)
        .filter((n) => n.props.value)
        .map((n) => n.props.value),
    ).toEqual(['command', 'approval', 'prompt', 'parallel', 'loop']);
    expect(has(h.value, wf('when'))).toBe(false);
    labelled(h.value, wf('kind')).props.onValueChange('prompt');
    await h.flush();
    expect(labelled(h.value, wf('target')).props.value).toBe('lead');
    expect(
      nodes(labelled(h.value, wf('target')).props.children)
        .filter((n) => n.props.value)
        .map((n) => n.props.value),
    ).toEqual(['lead']);
  });
});

describe('workflow layout', () => {
  it('wraps the kind choices in the inspector and the step toolbar', () => {
    expect(css).toMatch(/\n\.wfl-kinds \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\n\.wfl-pal \{[^}]*flex-wrap: wrap;/);
  });
});

describe('workflow top bar in a narrow window', () => {
  const props = () => ({
    inUse: 1,
    version: 2,
    dirty: true,
    busy: false,
    stale: false,
    trialTasks: null,
    onTrialTasks: vi.fn(),
    onDiscard: vi.fn(),
    onSaveAs: vi.fn(),
    onSave: vi.fn(),
  });

  it('moves the trial switch, discard and save as into a More menu and keeps saving to the project in the bar', () => {
    const p = props();
    const bar = WorkflowBar(p);
    const more = named(bar, 'Menu');
    expect(more.props.label).toBe(wf('more'));
    expect(more.props.trigger.props['aria-label']).toBe(wf('more'));
    expect(more.props.trigger.props.className).toContain('wfl-more');
    const entries = nodes(more.props.children).filter((n) => typeof n.type === 'function');
    expect(entries.map((n) => text(n))).toEqual([wf('trial.try'), wf('discard'), wf('saveAs')]);
    entries[0]!.props.onChange(true);
    expect(p.onTrialTasks).toHaveBeenCalledWith(expect.any(Number));
    entries[1]!.props.onClick();
    expect(p.onDiscard).toHaveBeenCalled();
    entries[2]!.props.onClick();
    expect(p.onSaveAs).toHaveBeenCalled();

    for (const label of [wf('discard'), wf('saveAs')])
      expect(button(bar, label).props.className).toContain('wfl-wide');
    expect(find(bar, (n) => n.type === 'label').props.className).toContain('wfl-wide');
    expect(button(bar, wf('saveToProject')).props.className).toBe('btn pri');
  });

  it('shows the More menu in place of those actions while the bar is under 1180px', () => {
    expect(css).toMatch(/\n\.wfl-bar \.wfl-more \{\s*display: none;/);
    expect(css).toMatch(
      /@container tb \(width < 1180px\) \{\s*\.wfl-bar \.wfl-wide \{\s*display: none;\s*\}\s*\.wfl-bar \.wfl-more \{\s*display: inline-flex;/,
    );
  });
});

describe('gate step', () => {
  const openGate = async () => {
    const h = await tab();
    await pick(h, 'gate');
    return h;
  };

  it('lists the gate commands in order with their timeout and the handback limit', async () => {
    const h = await openGate();
    const list = labelled(h.value, wf('gate.commands'));
    expect(
      nodes(list)
        .filter((n) => n.type === 'code')
        .map((n) => text(n)),
    ).toEqual(['pnpm build', 'pnpm test']);
    const timeout = find(
      h.value,
      (n) => n.props.className === 'wfl-row' && text(n).startsWith(wf('gate.timeout')),
    );
    expect(text(timeout)).toContain('20 分钟，10 分钟');
    expect(named(h.value, 'PolicyFields').props).toEqual({ projectId: 'alpha', step: 'gate' });
  });

  it('removes and adds a gate command with project.gate.set at the project revision', async () => {
    const h = await openGate();
    labelled(h.value, '移除 pnpm test').props.onClick();
    await h.flush();
    button(h.value, wf('gate.add')).props.onClick();
    await h.flush();
    type(h.value, wf('command'), 'node scripts/check.mjs');
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    expect(
      bridge.commands.map(({ type, input, expected_revision }) => [type, input, expected_revision]),
    ).toEqual([
      [
        'project.gate.set',
        { project_id: 'alpha', root: '/work/alpha', commands: [gates['/work/alpha'][0]] },
        1,
      ],
      [
        'project.gate.set',
        {
          project_id: 'alpha',
          root: '/work/alpha',
          commands: [
            ...gates['/work/alpha'],
            { name: 'node scripts/check.mjs', argv: ['node', 'scripts/check.mjs'] },
          ],
        },
        1,
      ],
    ]);
  });

  it('builds a gate change from the commands the board holds at its revision', async () => {
    const h = await openGate();
    labelled(h.value, '移除 pnpm test').props.onClick();
    await h.flush();
    const [build] = gates['/work/alpha'];
    useBoard.setState({
      board: {
        cursor: 2,
        projects: [{ ...project, revision: 2, gates: { '/work/alpha': [build] } }],
        sessions: [],
      },
    } as never);
    h.render();
    await h.flush();
    button(h.value, wf('gate.add')).props.onClick();
    await h.flush();
    type(h.value, wf('command'), 'node scripts/check.mjs');
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    const { type: sentType, input, expected_revision } = bridge.commands.at(-1)!;
    expect({ type: sentType, input, expected_revision }).toEqual({
      type: 'project.gate.set',
      input: {
        project_id: 'alpha',
        root: '/work/alpha',
        commands: [build, { name: 'node scripts/check.mjs', argv: ['node', 'scripts/check.mjs'] }],
      },
      expected_revision: 2,
    });
  });

  it('does not take the Enter that confirms an input method candidate as adding the command', async () => {
    const h = await openGate();
    button(h.value, wf('gate.add')).props.onClick();
    await h.flush();
    type(h.value, wf('command'), 'pnpm 测试');
    await h.flush();
    labelled(h.value, wf('command')).props.onKeyDown({
      key: 'Enter',
      nativeEvent: { isComposing: true },
    });
    await h.flush();
    expect(bridge.commands).toEqual([]);
  });

  it('reveals the whole command and its name from a focusable command', async () => {
    const h = await openGate();
    const tip = find(
      labelled(h.value, wf('gate.commands')),
      (n) => typeof n.type === 'function' && n.type.name === 'Tip' && text(n) === 'pnpm test',
    );
    expect(tip.props.content).toContain('pnpm test');
    expect(tip.props.content).toContain('test');
    expect(tip.props.content).not.toBe('test');
    expect(tip.props.children.props.tabIndex).toBe(0);
  });

  it("shows the daemon's refusal of a gate change in the panel", async () => {
    bridge.answers = [{ ok: false, error: { code: 'bad_gate', message: 'gate refused' } }];
    const h = await openGate();
    labelled(h.value, '移除 pnpm build').props.onClick();
    await h.flush();
    expect(
      text(find(labelled(h.value, wf('fixed.gate')), (n) => n.props.role === 'alert')),
    ).toContain('gate refused');
  });
});

describe('step runs table', () => {
  it('lists the runs that wait, run or failed, newest first, and opens the session of the clicked one', async () => {
    const h = await tab(
      board([
        boardTask('a', [
          run('a1', lint, 'waiting', 5, { session_id: 'worker-a' }),
          run('a2', signoff, 'passed', 4, { session_id: 'worker-a' }),
          run('a3', signoff, 'pending', 0, { session_id: 'worker-a' }),
        ]),
        boardTask('b', [run('b1', lint, 'failed', 1, { reason: 'exit 1' })], {
          claim: { session_id: 'worker-b', runtime: 'codex', model: null },
        }),
        boardTask('c', [run('c1', signoff, 'rejected', 10)]),
      ]),
    );
    const rows = nodes(labelled(h.value, wf('runs'))).filter(
      (n) => n.type === 'tr' && n.props['data-run'],
    );
    expect(rows.map((r) => r.props['data-run'])).toEqual(['b1', 'a1', 'c1']);
    expect(text(rows[0])).toContain('exit 1');
    rows[1]!.props.onClick();
    rows[0]!.props.onClick();
    expect(opened).toEqual(['worker-a', 'worker-b']);
    expect(rows[2]!.props.onClick).toBeUndefined();
  });

  it('leaves the table out without such runs', async () => {
    const h = await tab(board([boardTask('a', [run('a1', lint, 'passed', 5)])]));
    expect(has(h.value, wf('runs'))).toBe(false);
  });
});

describe('editing the steps', () => {
  it('adds, removes and reorders steps and sends the whole definition on save', async () => {
    const h = await tab();
    expect(saveButton(h.value).props.disabled).toBe(true);
    labelled(h.value, '派发前加步骤').props.onClick();
    await h.flush();
    labelled(h.value, wf('kind')).props.onValueChange('command');
    await h.flush();
    type(h.value, wf('title'), 'Typecheck');
    type(h.value, wf('command'), 'pnpm tsc');
    type(h.value, wf('timeout'), '90');
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    item(labelled(h.value, 'Sign off'), wf('moveUp')).props.onClick();
    await h.flush();
    item(labelled(h.value, 'Lint the change'), wf('delete')).props.onClick();
    await h.flush();
    expect(chart(h.value).slice(2, 4)).toEqual(['slot:before_dispatch', 'new-step']);
    expect(saveButton(h.value).props.disabled).toBe(false);
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(bridge.commands.map((c) => c.type)).toEqual(['workflow.definition.set']);
    expect(bridge.commands[0]!.input).toEqual({
      project_id: 'alpha',
      id: 'alpha',
      base_version: 2,
      definition: {
        ...definition(),
        slots: {
          before_dispatch: [
            {
              id: 'new-step',
              title: 'Typecheck',
              kind: { type: 'command', command: 'pnpm tsc', timeout_seconds: 90 },
            },
          ],
          before_merge: [signoff],
          after_merge: [],
        },
      },
    });
  });

  it('reorders by dragging a step onto another and discards unsaved changes', async () => {
    const h = await tab();
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: '',
      dropEffect: '',
    };
    const step = (id: string) => find(h.value, (n) => n.props['data-step'] === id);
    step('signoff').props.onDragStart({ dataTransfer });
    step('lint').props.onDrop({ preventDefault() {}, dataTransfer });
    await h.flush();
    expect(chart(h.value).slice(6, 9)).toEqual(['slot:before_merge', 'signoff', 'lint']);
    button(barOf(h.value), wf('discard')).props.onClick();
    await h.flush();
    expect(chart(h.value).slice(6, 9)).toEqual(['slot:before_merge', 'lint', 'signoff']);
    expect(
      nodes(barOf(h.value)).some((n) => n.type === 'button' && text(n) === wf('discard')),
    ).toBe(false);
    expect(saveButton(h.value).props.disabled).toBe(true);
  });

  it('reads the definition again after a version conflict and keeps the unsaved changes', async () => {
    const h = await tab();
    item(labelled(h.value, 'Sign off'), wf('delete')).props.onClick();
    await h.flush();
    bridge.answers.push({
      ok: false,
      error: { code: 'version_conflict', message: 'Supply the current base_version' },
    });
    bridge.view = view(3);
    const before = bridge.reads;
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(bridge.reads).toBeGreaterThan(before);
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain('已重新读取');
    expect(chart(h.value)).not.toContain('signoff');
    expect(text(barOf(h.value))).toContain('版本 3');
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(bridge.commands.map((c) => c.input.base_version)).toEqual([2, 3]);
    expect(saved().definition.slots.before_merge).toEqual([lint]);
  });

  it("shows the daemon's refusal in the panel and keeps the draft", async () => {
    const h = await tab();
    labelled(h.value, '合并后加步骤').props.onClick();
    await h.flush();
    labelled(h.value, wf('kind')).props.onValueChange('prompt');
    await h.flush();
    type(h.value, wf('title'), 'Summarise');
    type(h.value, wf('prompt'), 'Summarise the change');
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    bridge.answers.push({
      ok: false,
      error: {
        code: 'unsupported_step_kind',
        message: 'Workflow step kind prompt is not implemented',
      },
    });
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(text(find(h.value, (n) => n.props.role === 'alert'))).toContain(
      'Workflow step kind prompt is not implemented',
    );
    expect(chart(h.value)).toContain('new-step');
    expect(saveButton(h.value).props.disabled).toBe(false);
  });
});

describe('step form', () => {
  const side = (tree: unknown) => find(tree as never, (n) => n.type === 'aside');
  const fields = (tree: unknown) =>
    [
      wf('command'),
      wf('timeout'),
      wf('prompt'),
      wf('target'),
      'skill',
      wf('runtime'),
      wf('blocking'),
    ].filter((label) => has(side(tree), label));

  it('asks each kind for its own fields and every kind for its scope', async () => {
    const h = await tab();
    labelled(h.value, '合并前加步骤').props.onClick();
    await h.flush();
    const kinds = labelled(h.value, wf('kind'));
    expect(
      nodes(kinds.props.children)
        .filter((n) => n.props.value)
        .map((n) => text(n)),
    ).toEqual([
      wf('kind.command'),
      wf('kind.approval'),
      wf('kind.prompt'),
      wf('kind.review'),
      wf('kind.parallel'),
      wf('kind.loop'),
    ]);
    const seen: Record<string, string[]> = {};
    for (const kind of ['command', 'approval', 'prompt', 'review']) {
      labelled(h.value, wf('kind')).props.onValueChange(kind);
      await h.flush();
      seen[kind] = fields(h.value);
      expect(has(h.value, wf('title'))).toBe(true);
      expect(has(h.value, wf('tiers'))).toBe(true);
      expect(has(h.value, wf('domains'))).toBe(true);
    }
    expect(seen).toEqual({
      command: [wf('command'), wf('timeout')],
      approval: [],
      prompt: [wf('prompt'), wf('target'), 'skill'],
      review: [wf('runtime'), wf('blocking')],
    });
  });

  it('builds a prompt step with its target, skill and scope, and a review step', async () => {
    const h = await tab();
    labelled(h.value, '合并前加步骤').props.onClick();
    await h.flush();
    labelled(h.value, wf('kind')).props.onValueChange('prompt');
    await h.flush();
    expect(
      labelled(side(h.value), 'skill').props.options.map((o: { label: string }) => o.label),
    ).toEqual([wf('noSkill'), 'tidy']);
    type(h.value, wf('title'), 'Tidy up');
    type(h.value, wf('prompt'), 'Tidy the change');
    labelled(h.value, wf('target')).props.onValueChange('lead');
    labelled(side(h.value), 'skill').props.onChange('/skills/tidy/SKILL.md');
    labelled(labelled(h.value, wf('tiers')), 'T2').props.onClick();
    labelled(
      labelled(h.value, wf('domains')),
      zh('data.workflowPolicy.domain.frontendUi'),
    ).props.onClick();
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    labelled(h.value, '合并后加步骤').props.onClick();
    await h.flush();
    labelled(h.value, wf('kind')).props.onValueChange('review');
    await h.flush();
    type(h.value, wf('title'), 'Second look');
    labelled(h.value, wf('runtime')).props.onChange('codex');
    labelled(h.value, wf('blocking')).props.onChange({
      target: { checked: true },
    });
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(saved().definition.slots.before_merge.at(-1)).toEqual({
      id: 'new-step',
      title: 'Tidy up',
      applies_to: { tiers: ['t2'], domains: ['frontend-ui'] },
      kind: {
        type: 'prompt',
        prompt: 'Tidy the change',
        target: 'lead',
        skill: { name: 'tidy', path: '/skills/tidy/SKILL.md' },
      },
    });
    expect(saved().definition.slots.after_merge).toEqual([
      {
        id: 'new-step-2',
        title: 'Second look',
        kind: { type: 'review', runtime: 'codex', blocking: true },
      },
    ]);
  });

  it("saves a review step's model and effort, and leaves them out on the default", async () => {
    const h = await tab();
    labelled(h.value, '合并后加步骤').props.onClick();
    await h.flush();
    labelled(h.value, wf('kind')).props.onValueChange('review');
    await h.flush();
    type(h.value, wf('title'), 'Deep look');
    labelled(h.value, wf('runtime')).props.onChange('codex');
    await h.flush();
    expect(
      labelled(h.value, wf('model')).props.options.map((o: { label: string }) => o.label),
    ).toEqual([wf('byDefault'), 'GPT-5']);
    labelled(h.value, wf('model')).props.onChange('gpt-5');
    await h.flush();
    labelled(h.value, wf('effort')).props.onChange('high');
    await h.flush();
    button(h.value, wf('add')).props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(saved().definition.slots.after_merge).toEqual([
      {
        id: 'new-step',
        title: 'Deep look',
        kind: { type: 'review', runtime: 'codex', model: 'gpt-5', effort: 'high', blocking: false },
      },
    ]);
    bridge.view = view(3, {
      ...definition(),
      slots: { ...definition().slots, after_merge: saved().definition.slots.after_merge },
    });
    const again = await tab();
    await pick(again, 'new-step');
    expect(labelled(again.value, wf('effort')).props.value).toBe('high');
    labelled(again.value, wf('model')).props.onChange('');
    labelled(again.value, wf('effort')).props.onChange('');
    await again.flush();
    button(again.value, wf('apply')).props.onClick();
    await again.flush();
    saveButton(again.value).props.onClick();
    await again.flush();
    expect(saved().definition.slots.after_merge[0]!.kind).toStrictEqual({
      type: 'review',
      runtime: 'codex',
      blocking: false,
    });
  });

  it('edits a custom step in place', async () => {
    const h = await tab();
    await pick(h, 'lint');
    expect(labelled(h.value, wf('command')).props.value).toBe('pnpm lint');
    type(h.value, wf('command'), 'pnpm lint --fix');
    await h.flush();
    button(h.value, wf('apply')).props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(saved().definition.slots.before_merge[0]).toEqual({
      ...lint,
      kind: { ...lint.kind, command: 'pnpm lint --fix' },
    });
  });
});

describe('fixed steps', () => {
  it('writes the plan review tiers and the most review rounds into the definition', async () => {
    const h = await tab();
    await pick(h, 'plan_review');
    labelled(labelled(h.value, wf('planReviewTiersOf')), 'T2').props.onClick();
    await h.flush();
    await pick(h, 'review');
    labelled(h.value, '代码审查最多几轮 加一').props.onClick();
    await h.flush();
    saveButton(h.value).props.onClick();
    await h.flush();
    expect(saved().definition.plan_review).toEqual({ tiers: ['t2', 't3'] });
    expect(saved().definition.review).toEqual({ max_rounds: 4 });
  });

  it('turns auto merge on as the settings page does, then reads the workflow again', async () => {
    const h = await tab();
    await pick(h, 'merge');
    const reads = bridge.reads;
    labelled(h.value, wf('autoMerge')).props.onChange({
      target: { checked: true },
    });
    await h.flush();
    const sent = bridge.commands.map(({ type, input, expected_revision }) => ({
      type,
      input,
      expected_revision,
    }));
    expect(sent).toEqual([autoMergeRequest(project, true)]);
    expect(bridge.reads).toBe(reads + 1);
  });

  it("shows the daemon's refusal of auto merge in its row", async () => {
    bridge.answers = [{ ok: false, error: { code: 'no_gate', message: 'add a gate first' } }];
    const h = await tab();
    await pick(h, 'merge');
    labelled(h.value, wf('autoMerge')).props.onChange({
      target: { checked: true },
    });
    await h.flush();
    const row = find(
      h.value,
      (n) => n.props.className === 'wfl-row' && text(n).startsWith(wf('autoMerge')),
    );
    expect(text(row)).toContain('add a gate first');
  });

  it('opens the policy parameters of a fixed step beside the chart', async () => {
    const h = await tab();
    await pick(h, 'handback');
    expect(named(h.value, 'PolicyFields').props).toEqual({ projectId: 'alpha', step: 'handback' });
  });

  it('opens the gates page from the handback and gate steps', async () => {
    for (const step of ['handback', 'gate']) {
      useSettingsView.setState({ open: false, page: 'general' });
      const h = mount(() => PolicyFields({ projectId: 'alpha', step }));
      await h.flush();
      button(h.value, wf('editInSettings')).props.onClick();
      expect(useSettingsView.getState()).toMatchObject({
        open: true,
        detail: 'alpha',
        page: 'gates',
      });
    }
  });
});

describe("a step's results", () => {
  const bucket = (tasks: number, passed: number) => ({ tasks, passed });
  const withResults = (
    fixed: Record<string, { tasks: number; passed: number; buckets: ReturnType<typeof bucket>[] }>,
    step_results?: Record<
      string,
      { tasks: number; passed: number; buckets: ReturnType<typeof bucket>[] }
    >,
  ) => ({
    ...view(),
    fixed_steps: view().fixed_steps.map((s) => (fixed[s.id] ? { ...s, result: fixed[s.id] } : s)),
    ...(step_results && { step_results }),
  });
  const block = (tree: unknown) =>
    nodes(tree as never).find((n) => n.props.className === 'wfl-res');
  const gate = {
    tasks: 6,
    passed: 5,
    buckets: [bucket(0, 0), bucket(1, 1), bucket(1, 0), bucket(2, 2), bucket(1, 1), bucket(1, 1)],
  };

  it('shows the gate step its first-run pass share over the last 30 days, a bar per five days', async () => {
    bridge.view = withResults({ gate });
    const h = await tab();
    await pick(h, 'gate');
    const res = block(h.value)!;
    expect(text(res)).toContain(wf('result.title'));
    expect(text(res)).toContain(wf('result.range'));
    expect(text(res)).toContain('83%');
    expect(text(res)).toContain(wf('result.firstRun'));
    const bars = labelled(res, '近 30 天 6 个任务里 5 个首次通过');
    expect(bars.props.role).toBe('img');
    const columns = nodes(bars).filter((n) => n.type === 'i');
    expect(columns.map((n) => n.props.style['--v'])).toEqual([
      '0%',
      '100%',
      '0%',
      '100%',
      '100%',
      '100%',
    ]);
    expect(columns.map((n) => !!n.props['data-empty'])).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    // Five days where no task passed at the first run draw a bar of their own, not a gap.
    expect(columns.map((n) => !!n.props['data-failed'])).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it.each([
    [
      "uses the review step's own result",
      withResults({
        gate,
        review: { tasks: 4, passed: 1, buckets: [0, 0, 0, 0, 0, 4].map((n) => bucket(n, n / 4)) },
      }),
      'review',
      '25%',
      '近 30 天 4 个任务里 1 个首次通过',
    ],
    [
      'uses the result of a saved custom step by its id',
      withResults(
        {},
        { lint: { tasks: 3, passed: 3, buckets: [0, 0, 0, 1, 1, 1].map((n) => bucket(n, n)) } },
      ),
      'lint',
      '100%',
      '近 30 天 3 个任务里 3 个首次通过',
    ],
  ])('%s', async (_name, results, step, share, label) => {
    bridge.view = results;
    const h = await tab();
    await pick(h, step);
    expect(text(block(h.value))).toContain(share);
    expect(has(h.value, label)).toBe(true);
  });

  it('leaves the block out without a result and for a step not saved yet', async () => {
    bridge.view = withResults({ gate }, { lint: gate });
    const h = await tab();
    await pick(h, 'merge');
    expect(block(h.value)).toBeUndefined();
    await pick(h, 'signoff');
    expect(block(h.value)).toBeUndefined();
    labelled(h.value, '合并后加步骤').props.onClick();
    await h.flush();
    expect(block(h.value)).toBeUndefined();
  });
});
