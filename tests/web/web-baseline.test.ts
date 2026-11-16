import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inputSchemas } from '@pantheon/protocol';
import type { ProjectBaseline, BaselineResult } from '@pantheon/domain';
import { find, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('@/data/project-defaults', async (actual) => ({
  ...(await actual<object>()),
  useProjectDefaults: () => ({ data: null, loading: false, error: null, reload() {} }),
  useLastProjectDefaults: () => null,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { BaselineLaunch, StartBaseline } from '@/screens/projects/BaselineBlocks';
import { Button } from '@/screens/projects/parts';
import { ModelMenu } from '@/screens/sessions/ModelMenu';
import {
  baselineConfirmRequest,
  baselineDraft,
  baselineEntry,
  baselineExtensions,
  baselineFolders,
  baselineStartRequest,
  baselineWorkstreams,
} from '@/screens/projects/baseline';
import { zh } from './i18n-setup.js';

const result = (extra: Partial<BaselineResult> = {}): BaselineResult => ({
  folders: [
    {
      root: '/work/ledger',
      stage: 'active',
      stack: ['typescript'],
      context: { instructions: ['AGENTS.md'], docs: [], task_lists: [] },
      gate: [
        { name: 'build', argv: ['pnpm', 'build'], sources: ['file:package.json'] },
        {
          name: 'test',
          argv: ['pnpm', 'test'],
          timeout_ms: 60_000,
          sources: ['file:package.json'],
        },
      ],
      commands: {},
    },
  ],
  workstreams: [
    {
      id: 'importer',
      title: 'Importer',
      status: 'running',
      reason: 'CSV parsing lands',
      items: [{ root: '/work/ledger', path: 'TODO.md', line: 3, hash: 'a1b2c3d4e5f6' }],
      commits: ['commit:abc1234'],
      next: ['Add JSON input'],
      blockers: ['Waiting for sample files'],
    },
  ],
  contradictions: [],
  findings: [{ text: 'No JSON fixtures', refs: ['file:README.md'], severity: 'risk' }],
  brief: {
    goal: 'Import every ledger format',
    goals: ['CSV', 'JSON'],
    non_goals: ['Exports'],
    sources: ['file:README.md'],
  },
  questions: [{ question: 'Keep Node 20?', options: ['Yes', 'No'] }],
  ...extra,
});

const baseline = (extra: Partial<ProjectBaseline> = {}): ProjectBaseline => ({
  id: 'baseline-1',
  revision: 4,
  project_id: 'project-a',
  state: 'submitted',
  session_id: 'session-1',
  runtime: 'claude',
  result: result(),
  dropped: 0,
  facts_id: 'facts-1',
  created_at: 1,
  ...extra,
});

describe('baselineEntry', () => {
  const expired = baseline({ state: 'failed', reason: 'baseline_window_expired' });
  // The label and the failure are projects.baseline.* catalog ids.
  it.each([
    ['offers a first read when there is no baseline and no brief', null, false, 'read'],
    ['offers a second read when the project already has a brief', null, true, 'readAgain'],
    [
      'offers a start again after a failed baseline, with its reason',
      expired,
      false,
      'read',
      'failure.expired',
    ],
  ])('%s', (_, current, brief, label, failure?: string) => {
    expect(baselineEntry(current, brief)).toEqual({
      kind: 'start',
      label: zh(`projects.baseline.${label}`),
      ...(failure && { failure: zh(`projects.baseline.${failure}`) }),
    });
  });

  it('maps each other state to its block', () => {
    expect(baselineEntry(baseline({ state: 'running' }), false).kind).toBe('running');
    expect(baselineEntry(baseline({ state: 'submitted' }), false).kind).toBe('review');
    expect(baselineEntry(baseline({ state: 'empty' }), false).kind).toBe('empty');
    expect(baselineEntry(baseline({ state: 'confirmed' }), true).kind).toBe('confirmed');
  });
});

describe('baselineStartRequest', () => {
  it('starts a baseline without a revision', () => {
    const req = baselineStartRequest('project-a');
    expect(req).toEqual({
      ok: true,
      type: 'project.baseline.start',
      input: { project_id: 'project-a' },
      expected_revision: null,
    });
    if (req.ok)
      expect(inputSchemas['project.baseline.start'].safeParse(req.input).success).toBe(true);
  });

  it.each([
    [
      'reuses the last choice of the same project',
      'project-r',
      { runtime: 'codex', model: 'gpt-5.5', effort: 'low' },
    ],
    ['adds nothing for a project that never chose', 'project-s', {}],
  ])('%s when a start gives no choice', (_name, project_id, expected) => {
    baselineStartRequest('project-r', { runtime: 'codex', model: 'gpt-5.5', effort: 'low' });
    expect(baselineStartRequest(project_id)).toMatchObject({
      ok: true,
      input: { project_id, ...expected },
    });
    const req = baselineStartRequest(project_id);
    if (req.ok) expect(Object.keys(req.input)).toHaveLength(1 + Object.keys(expected).length);
  });

  it('carries the chosen runtime, model and effort', () => {
    const req = baselineStartRequest('project-a', {
      runtime: 'codex',
      model: 'gpt-5.5',
      effort: 'low',
    });
    expect(req).toMatchObject({
      ok: true,
      input: { project_id: 'project-a', runtime: 'codex', model: 'gpt-5.5', effort: 'low' },
    });
    if (req.ok)
      expect(inputSchemas['project.baseline.start'].safeParse(req.input).success).toBe(true);
  });
});

describe('StartBaseline', () => {
  const model = (id: string, extra: object = {}) => ({
    id,
    label: id,
    permission_modes: [],
    efforts: ['low', 'medium', 'high'],
    default_effort: 'high',
    default: false,
    ...extra,
  });
  const MODELS: Record<string, unknown[]> = {
    claude: [model('opus', { default: true }), model('sonnet')],
    codex: [model('gpt-5.5', { default: true })],
  };
  const status = (runtime: string) => ({
    runtime,
    enabled: true,
    installed: true,
    auth: { state: 'ok' },
  });
  let commands: { type: string; input: unknown }[];
  beforeEach(() => {
    commands = [];
    mock.board = {
      status: { state: 'live' },
      board: {
        projects: [
          {
            id: 'project-a',
            session_defaults: {
              runtime: 'claude',
              model: 'sonnet',
              effort: 'low',
              permission_mode: 'default',
            },
          },
          { id: 'project-b' },
        ],
      },
      events: [],
      refresh() {},
    };
    vi.stubGlobal('window', {
      pantheon: {
        query: vi.fn(async (name: string, params: any) =>
          name === 'runtime.status'
            ? { ok: true, value: ['claude', 'codex'].map(status) }
            : name === 'runtime.models'
              ? { ok: true, value: MODELS[params.runtime] ?? [] }
              : { ok: true, value: [] },
        ),
        command: vi.fn(async (command: any) => {
          commands.push(command);
          return { ok: true, value: {} };
        }),
      },
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });
  // The start block with its model menu and start button drawn in one host.
  const start = (project_id: string) =>
    mount(() => {
      const tree = StartBaseline({ project_id, entry: { kind: 'start', label: '摸底' } });
      return BaselineLaunch(find(tree, (n) => n.type === BaselineLaunch).props);
    });
  const menu = (tree: unknown) => find(tree as any, (n) => n.type === ModelMenu);
  const press = (tree: unknown) =>
    find(tree as any, (n) => n.type === Button && n.props.label === '摸底').props.onPress();

  it('starts on the runtime, model and effort picked in its model menu', async () => {
    const h = start('project-a');
    await h.flush();
    expect(menu(h.value).props).toMatchObject({ mode: null, fast: null });
    menu(h.value).props.onChange({
      runtime: 'codex',
      backend: null,
      model: 'gpt-5.5',
      effort: 'medium',
    });
    h.render();
    press(h.value);
    await h.flush();
    expect(commands).toMatchObject([
      {
        type: 'project.baseline.start',
        input: { project_id: 'project-a', runtime: 'codex', model: 'gpt-5.5', effort: 'medium' },
      },
    ]);
  });

  it("starts on the project's session defaults when nothing is picked", async () => {
    const h = start('project-a');
    await h.flush();
    expect(menu(h.value).props.value).toEqual({
      runtime: 'claude',
      backend: null,
      model: 'sonnet',
      effort: 'low',
    });
    press(h.value);
    await h.flush();
    expect(commands.map((c) => c.input)).toEqual([
      { project_id: 'project-a', runtime: 'claude', model: 'sonnet', effort: 'low' },
    ]);
  });

  it("starts on the runtime's default model without project defaults", async () => {
    const h = start('project-b');
    await h.flush();
    press(h.value);
    await h.flush();
    expect(commands.map((c) => c.input)).toEqual([
      { project_id: 'project-b', runtime: 'claude', model: 'opus', effort: 'high' },
    ]);
  });
});

describe('baselineConfirmRequest', () => {
  it('asks for a board plan', () => {
    const s = baseline();
    const req = baselineConfirmRequest(s, baselineDraft(s));
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input.plan_board).toBe(true);
  });

  it('sends only the checked gate commands, without their sources', () => {
    const s = baseline();
    const draft = baselineDraft(s);
    draft.gate[0]!.checked = false;
    draft.answers[0]!.answer = 'Yes';
    const req = baselineConfirmRequest(s, draft);
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input.gates).toEqual([
      {
        root: '/work/ledger',
        commands: [{ name: 'test', argv: ['pnpm', 'test'], timeout_ms: 60_000 }],
      },
    ]);
    expect(req.input.answers).toEqual([{ question: 'Keep Node 20?', answer: 'Yes' }]);
    expect(req.expected_revision).toBe(4);
    expect(inputSchemas['project.baseline.confirm'].safeParse(req.input).success).toBe(true);
  });

  it('leaves the brief out when the baseline suggested none and the goal is empty', () => {
    const s = baseline({ result: result({ brief: undefined }) });
    const req = baselineConfirmRequest(s, baselineDraft(s));
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input).not.toHaveProperty('brief');
    expect(req.input.answers).toEqual([]);
    expect(inputSchemas['project.baseline.confirm'].safeParse(req.input).success).toBe(true);
  });

  it('refuses to confirm with the suggested goal cleared, which would plan with it anyway', () => {
    const s = baseline();
    const draft = baselineDraft(s);
    draft.goal = '  ';
    expect(baselineConfirmRequest(s, draft)).toEqual({
      ok: false,
      errors: [zh('projects.brief.goalRequired')],
    });
  });

  it('clears the gate of a folder whose suggested commands are all unchecked', () => {
    const s = baseline();
    const draft = baselineDraft(s);
    for (const item of draft.gate) item.checked = false;
    const req = baselineConfirmRequest(s, draft);
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input.gates).toEqual([{ root: '/work/ledger', commands: [] }]);
    expect(inputSchemas['project.baseline.confirm'].safeParse(req.input).success).toBe(true);
  });

  it('drops blank goal lines from the brief', () => {
    const s = baseline();
    const draft = baselineDraft(s);
    draft.goals = ['CSV', '', 'JSON'];
    const req = baselineConfirmRequest(s, draft);
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input.brief).toEqual({
      goal: 'Import every ledger format',
      goals: ['CSV', 'JSON'],
      non_goals: ['Exports'],
    });
  });

  it('groups suggested extensions by runtime and sends only the checked ones', () => {
    const browser = {
      runtime: 'claude',
      kind: 'mcp_server' as const,
      name: 'browser',
      reason: 'No workstream touches a web page',
    };
    const slides = {
      runtime: 'claude',
      kind: 'plugin' as const,
      name: 'slides@market',
      reason: 'The ledger ships no presentations',
    };
    const deploy = {
      runtime: 'codex',
      kind: 'skill' as const,
      name: 'deploy',
      reason: 'Importer work never deploys',
    };
    const s = baseline({ result: result({ extensions: [browser, slides, deploy] }) });
    const draft = baselineDraft(s);
    expect(draft.extensions.map((item) => item.checked)).toEqual([true, true, true]);
    expect(baselineExtensions(draft)).toEqual([
      { runtime: 'claude', items: [0, 1] },
      { runtime: 'codex', items: [2] },
    ]);
    draft.extensions[1]!.checked = false;
    draft.extensions[2]!.checked = false;
    const req = baselineConfirmRequest(s, draft);
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input.extensions).toEqual([browser]);
    expect(inputSchemas['project.baseline.confirm'].safeParse(req.input).success).toBe(true);

    const none = baselineConfirmRequest(baseline(), baselineDraft(baseline()));
    if (!none.ok) throw new Error(none.errors.join());
    expect(none.input).not.toHaveProperty('extensions');
    expect(baselineExtensions(baselineDraft(baseline()))).toEqual([]);
  });

  it('refuses a baseline that is not waiting for confirmation', () => {
    const s = baseline({ state: 'confirmed' });
    expect(baselineConfirmRequest(s, baselineDraft(s)).ok).toBe(false);
  });
});

describe('baselineDraft', () => {
  it('starts with every gate command checked and no question answered', () => {
    const draft = baselineDraft(baseline());
    expect(draft.goal).toBe('Import every ledger format');
    expect(draft.gate.map((g) => g.checked)).toEqual([true, true]);
    expect(draft.answers.map((a) => a.answer)).toEqual([null]);
  });

  it('groups the gate checklist under each folder with its stage and stack', () => {
    const two = result({
      folders: [
        result().folders[0]!,
        {
          root: '/work/site',
          stage: 'early',
          gate: [{ name: 'lint', argv: ['npm', 'run', 'lint'], sources: ['file:package.json'] }],
        },
        { root: '/work/notes', stage: 'empty', stack: [], gate: [] },
      ],
    });
    const s = baseline({ result: two });
    const draft = baselineDraft(s);
    expect(baselineFolders(s, draft)).toEqual([
      {
        root: '/work/ledger',
        facts: `${zh('projects.baseline.stage.active')}，typescript`,
        gate: [0, 1],
      },
      { root: '/work/site', facts: zh('projects.baseline.stage.early'), gate: [2] },
      { root: '/work/notes', facts: zh('projects.baseline.stage.empty'), gate: [] },
    ]);
    draft.gate[1]!.checked = false;
    const req = baselineConfirmRequest(s, draft);
    if (!req.ok) throw new Error(req.errors.join());
    expect(req.input.gates).toEqual([
      { root: '/work/ledger', commands: [{ name: 'build', argv: ['pnpm', 'build'] }] },
      { root: '/work/site', commands: [{ name: 'lint', argv: ['npm', 'run', 'lint'] }] },
    ]);
    expect(inputSchemas['project.baseline.confirm'].safeParse(req.input).success).toBe(true);
  });

  it('starts empty without a brief', () => {
    const draft = baselineDraft(baseline({ result: result({ brief: undefined }) }));
    expect(draft).toMatchObject({ goal: '', goals: [], non_goals: [] });
  });
});

describe('baselineWorkstreams', () => {
  it('lists each workstream with its reason and its counts from the newest facts', () => {
    const counts = [
      {
        id: 'importer',
        title: 'Importer',
        status: 'running' as const,
        done: 2,
        open: 3,
        missing: 1,
      },
    ];
    expect(baselineWorkstreams(baseline(), counts)).toEqual([
      {
        id: 'importer',
        title: 'Importer',
        status: 'running',
        reason: 'CSV parsing lands',
        done: 2,
        open: 3,
        missing: 1,
      },
    ]);
    expect(baselineWorkstreams(baseline(), [])).toEqual([
      {
        id: 'importer',
        title: 'Importer',
        status: 'running',
        reason: 'CSV parsing lands',
        done: 0,
        open: 0,
        missing: 0,
      },
    ]);
    expect(baselineWorkstreams(baseline({ state: 'running', result: undefined }), counts)).toEqual(
      [],
    );
  });
});
