import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import type { WorkflowPolicy } from '@pantheon/domain';
import type { BridgeResult, RuntimeStatus } from '@pantheon/protocol';
import { type HookHost, find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
import './i18n-setup.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useBoard } from '@/data/board';
import { t as format } from '@/i18n';
import { SpawnPolicy } from '@/screens/settings/SpawnPolicy';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };
type Project = Parameters<typeof SpawnPolicy>[0]['project'];
type Policy = WorkflowPolicy & { defaults: Partial<WorkflowPolicy> };

const status = (runtime: string): RuntimeStatus => ({
  runtime,
  installed: true,
  version: '1.0.0',
  min_version: null,
  version_ok: null,
  auth: { state: 'unknown' },
  checked_at: '2026-01-01T00:00:00.000Z',
  enabled: true,
});

// Each test reads its own project, so a save another test left in the page's store shows nowhere.
let made = 0;
let project: Project;

const bridge = {
  answers: {} as Record<string, unknown>,
  replies: [] as BridgeResult<unknown>[],
  commands: [] as Command[],
  async query(method: string): Promise<BridgeResult<unknown>> {
    return method in bridge.answers
      ? { ok: true, value: bridge.answers[method] }
      : { ok: false, error: { code: 'unknown_route', message: method } };
  },
  /** Applies a workflow.policy.set as the daemon does: null follows the global value. */
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    const reply = bridge.replies.shift();
    if (reply) return reply;
    const current = bridge.answers['workflow.policy'] as Policy;
    const { project_id: _, ...patch } = command.input;
    const next: Record<string, unknown> = {
      ...current,
      revision: current.revision + 1,
      policy_version: current.policy_version + 1,
    };
    const own = new Set(current.overridden);
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value ?? current.defaults[key as keyof WorkflowPolicy];
      if (value === null) own.delete(key as never);
      else own.add(key as never);
    }
    next.overridden = [...own];
    bridge.answers['workflow.policy'] = next;
    return { ok: true, value: next };
  },
};

const SETTINGS = [
  'gate_on_fail',
  'gate_runner',
  'max_spawned',
  'runtime_parallel',
  'task_size',
  'verify_timing',
  'kind_routes',
];
/** The project sets the fields of own itself and follows the global values for the rest. */
const policy = (
  own: Partial<WorkflowPolicy> = {},
  global: Partial<WorkflowPolicy> = {},
): Policy => {
  const defaults: Partial<WorkflowPolicy> = {
    gate_on_fail: 'stop',
    gate_runner: 'daemon',
    max_spawned: 4,
    ...global,
  };
  return {
    id: project.id,
    revision: 2,
    project_id: project.id,
    policy_version: 2,
    ...defaults,
    overridden: Object.keys(own).filter((key) => SETTINGS.includes(key)) as never,
    ...own,
    defaults,
  };
};

const spawn = (id: string, values?: Record<string, string | number>) =>
  format({ id: `settings.spawn.${id}`, defaultMessage: '' }, values);
const LIMIT = spawn('limit');
const useGlobal = (field: string) => spawn('useGlobal', { field });

async function page() {
  const h = mount(() => SpawnPolicy({ project }));
  await settle(h);
  return h;
}
/** The page draws again once a save lands, as its store's subscribers would. */
async function settle(h: HookHost<any>) {
  for (let i = 0; i < 3; i++) {
    await h.flush();
    h.render();
  }
  await h.flush();
}
const tree = (h: HookHost<any>) => h.value as ReactNode;
const labelled = (t: ReactNode, label: string) => find(t, (n) => n.props['aria-label'] === label);
const section = (h: HookHost<any>, title: string) => find(tree(h), (n) => n.props.title === title);
const input = (within: () => ReactNode, label: string) => () =>
  find(within(), (n) => n.type === 'input' && n.props['aria-label'] === label);
const button = (within: ReactNode, label: string) =>
  find(within, (n) => n.type === 'button' && (n.props['aria-label'] ?? text(n)) === label);
const route = (h: HookHost<any>, n: number) => labelled(tree(h), spawn('route', { n }));
const menuIn = (within: ReactNode, label: string) => named(labelled(within, label), 'ModelMenu');
const alerts = (within: ReactNode) =>
  nodes(within)
    .filter((n) => n.props.role === 'alert')
    .map(text);
const sent = () => bridge.commands.map((c) => c.input);
async function type(h: HookHost<any>, field: () => ReactElement<any>, value: string) {
  field().props.onChange({ target: { value } });
  await h.flush();
  field().props.onBlur();
  await settle(h);
}
async function choose(h: HookHost<any>, menu: () => ReactElement<any>, choice: object) {
  menu().props.onChange({ backend: null, model: null, effort: null, ...choice });
  await settle(h);
}

beforeEach(() => {
  project = { id: `project-${++made}`, revision: 4, name: 'Alpha app', roots: ['/work/alpha'] };
  bridge.answers = {
    'workflow.policy': policy(),
    'runtime.status': [status('claude'), status('codex')],
  };
  bridge.replies = [];
  bridge.commands = [];
  vi.stubGlobal('window', {
    pantheon: bridge,
    addEventListener() {},
    removeEventListener() {},
  });
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

describe('how many sessions the main agent spawns', () => {
  it('shows the default limit as the placeholder and sends a limit typed in', async () => {
    const h = await page();
    const limit = input(() => tree(h), LIMIT);
    expect(limit().props.value).toBe('');
    expect(limit().props.placeholder).toBe('4');
    await type(h, limit, '6');
    expect(sent()).toEqual([{ project_id: project.id, max_spawned: 6 }]);
    expect(limit().props.value).toBe('6');
  });

  it('sends null for a limit cleared, so the project follows the default again', async () => {
    bridge.answers['workflow.policy'] = policy({ max_spawned: 6 });
    const h = await page();
    const limit = input(() => tree(h), LIMIT);
    expect(limit().props.value).toBe('6');
    await type(h, limit, '');
    expect(sent()).toEqual([{ project_id: project.id, max_spawned: null }]);
    expect(limit().props.value).toBe('');
  });

  it('keeps a limit out of range and says why beside it', async () => {
    const h = await page();
    await type(
      h,
      input(() => tree(h), LIMIT),
      '17',
    );
    expect(sent()).toEqual([]);
    expect(alerts(tree(h))).toEqual([spawn('limitRange', { max: 16 })]);
  });

  it('sends one runtime limit with the others kept', async () => {
    bridge.answers['workflow.policy'] = policy({ runtime_parallel: { claude: 2 } });
    const h = await page();
    const codex = input(() => tree(h), spawn('runtimeLimit', { runtime: 'Codex' }));
    expect(codex().props.value).toBe('');
    await type(h, codex, '3');
    expect(sent()).toEqual([{ project_id: project.id, runtime_parallel: { claude: 2, codex: 3 } }]);
  });

  it('sends the task size and when to check, each on its own', async () => {
    const h = await page();
    labelled(tree(h), spawn('taskSize')).props.onValueChange('small');
    await settle(h);
    labelled(tree(h), spawn('verifyTiming')).props.onValueChange('before_landing');
    await settle(h);
    expect(sent()).toEqual([
      { project_id: project.id, task_size: 'small' },
      { project_id: project.id, verify_timing: 'before_landing' },
    ]);
    expect(labelled(tree(h), spawn('taskSize')).props.value).toBe('small');
  });

  it.each([
    { field: 'max_spawned', own: { max_spawned: 4 }, label: () => LIMIT },
    {
      field: 'runtime_parallel',
      own: { runtime_parallel: { claude: 2 } },
      label: () => spawn('runtimeLimits'),
    },
    { field: 'task_size', own: { task_size: 'small' as const }, label: () => spawn('taskSize') },
    {
      field: 'verify_timing',
      own: { verify_timing: 'each_session' as const },
      label: () => spawn('verifyTiming'),
    },
    {
      field: 'kind_routes',
      own: { kind_routes: [{ kind: 'docs', runtime: 'codex' }] },
      label: () => spawn('routes'),
    },
  ])(
    'sends null for $field from its own button, gone once it follows the global value',
    async ({ field, own, label }) => {
      bridge.answers['workflow.policy'] = policy(own);
      const h = await page();
      if (field === 'max_spawned') expect(input(() => tree(h), LIMIT)().props.value).toBe('4');
      button(tree(h), useGlobal(label())).props.onClick();
      await settle(h);
      expect(sent()).toEqual([{ project_id: project.id, [field]: null }]);
      expect(() => button(tree(h), useGlobal(label()))).toThrow();
    },
  );

  it('offers the global runtime limits back when the project sets none and no runtime is listed', async () => {
    bridge.answers['workflow.policy'] = policy({ runtime_parallel: {} });
    bridge.answers['runtime.status'] = [];
    const h = await page();
    button(tree(h), useGlobal(spawn('runtimeLimits'))).props.onClick();
    await settle(h);
    expect(sent()).toEqual([{ project_id: project.id, runtime_parallel: null }]);
  });

  it('drops a range error once a failed save brings the daemon values back', async () => {
    const h = await page();
    await type(
      h,
      input(() => tree(h), spawn('runtimeLimit', { runtime: 'Claude' })),
      '17',
    );
    bridge.replies.push({ ok: false, error: { code: 'conflict', message: 'stale revision' } });
    labelled(tree(h), spawn('taskSize')).props.onValueChange('small');
    await settle(h);
    expect(alerts(section(h, spawn('title')))).not.toContain(spawn('limitRange', { max: 16 }));
  });

  it('shows the global values where the project follows them', async () => {
    bridge.answers['workflow.policy'] = policy(
      {},
      {
        runtime_parallel: { claude: 2 },
        task_size: 'large',
        verify_timing: 'before_landing',
        kind_routes: [{ kind: 'docs', runtime: 'codex' }],
      },
    );
    const h = await page();
    const claude = input(() => tree(h), spawn('runtimeLimit', { runtime: 'Claude' }));
    expect(claude().props.value).toBe('');
    expect(claude().props.placeholder).toBe('2');
    const size = labelled(tree(h), spawn('taskSize'));
    expect(size.props.value).toBe('large');
    expect(nodes(size.props.children).map((n) => n.props.value)).toEqual([
      'small',
      'medium',
      'large',
    ]);
    expect(labelled(tree(h), spawn('verifyTiming')).props.value).toBe('before_landing');
    expect(input(() => route(h, 1), spawn('kind'))().props.value).toBe('docs');
    for (const label of [LIMIT, 'runtimeLimits', 'taskSize', 'verifyTiming', 'routes'])
      expect(() => button(tree(h), useGlobal(label === LIMIT ? LIMIT : spawn(label)))).toThrow();
  });

  it('keeps an unsaved route when a limit fails to save', async () => {
    bridge.replies.push({ ok: false, error: { code: 'conflict', message: 'stale revision' } });
    const h = await page();
    button(tree(h), spawn('addRoute')).props.onClick();
    await settle(h);
    await type(
      h,
      input(() => tree(h), LIMIT),
      '7',
    );
    expect(alerts(section(h, spawn('title'))).join('')).toContain('stale revision');
    expect(input(() => route(h, 1), spawn('kind'))().props.value).toBe('');
  });

  it('shows a failed save in its group and the daemon value again', async () => {
    bridge.replies.push({ ok: false, error: { code: 'conflict', message: 'stale revision' } });
    const h = await page();
    const limit = input(() => tree(h), LIMIT);
    await type(h, limit, '7');
    expect(sent()).toEqual([{ project_id: project.id, max_spawned: 7 }]);
    expect(alerts(section(h, spawn('title'))).join('')).toContain('stale revision');
    expect(alerts(section(h, spawn('routes')))).toEqual([]);
    expect(limit().props.value).toBe('');
  });
});

describe('routes by kind', () => {
  const PREFERRED = spawn('preferred');

  it('sends a route added with a fallback', async () => {
    const h = await page();
    button(tree(h), spawn('addRoute')).props.onClick();
    await settle(h);
    expect(sent()).toEqual([]);
    await choose(h, () => menuIn(route(h, 1), PREFERRED), {
      runtime: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });
    // A route without its kind waits.
    expect(sent()).toEqual([]);
    await type(
      h,
      input(() => route(h, 1), spawn('kind')),
      'backend',
    );
    button(route(h, 1), spawn('addFallback')).props.onClick();
    await settle(h);
    await choose(h, () => menuIn(route(h, 1), spawn('fallback', { n: 1 })), {
      runtime: 'claude',
      model: 'opus',
    });
    expect(sent().at(-1)).toEqual({
      project_id: project.id,
      kind_routes: [
        {
          kind: 'backend',
          runtime: 'codex',
          model: 'gpt-5',
          effort: 'high',
          fallbacks: [{ runtime: 'claude', model: 'opus' }],
        },
      ],
    });
  });

  it('sends the fallbacks in their new order after a move up and a move down', async () => {
    const fallbacks = [{ runtime: 'claude' }, { runtime: 'codex' }, { runtime: 'gemini' }];
    bridge.answers['workflow.policy'] = policy({
      kind_routes: [{ kind: 'docs', runtime: 'codex', fallbacks }],
    });
    const h = await page();
    button(route(h, 1), spawn('fallbackUp', { n: 3 })).props.onClick();
    await settle(h);
    button(route(h, 1), spawn('fallbackDown', { n: 1 })).props.onClick();
    await settle(h);
    expect(sent().map((input) => input.kind_routes)).toEqual([
      [
        {
          kind: 'docs',
          runtime: 'codex',
          fallbacks: [{ runtime: 'claude' }, { runtime: 'gemini' }, { runtime: 'codex' }],
        },
      ],
      [
        {
          kind: 'docs',
          runtime: 'codex',
          fallbacks: [{ runtime: 'gemini' }, { runtime: 'claude' }, { runtime: 'codex' }],
        },
      ],
    ]);
  });

  it('shows no error on a new route that takes the place of a deleted one', async () => {
    const h = await page();
    button(tree(h), spawn('addRoute')).props.onClick();
    await settle(h);
    input(() => route(h, 1), spawn('kind'))().props.onBlur();
    await settle(h);
    expect(alerts(route(h, 1))).not.toEqual([]);
    button(route(h, 1), spawn('deleteRoute', { n: 1 })).props.onClick();
    await settle(h);
    button(tree(h), spawn('addRoute')).props.onClick();
    await settle(h);
    expect(alerts(route(h, 1))).toEqual([]);
  });

  it('keeps a kind that breaks the naming rule and says why in its route', async () => {
    bridge.answers['workflow.policy'] = policy({
      kind_routes: [{ kind: 'docs', runtime: 'codex' }],
    });
    const h = await page();
    await type(
      h,
      input(() => route(h, 1), spawn('kind')),
      'Back End',
    );
    expect(sent()).toEqual([]);
    expect(alerts(route(h, 1))).toEqual([spawn('kindCharacters')]);
  });

  it.each([
    { edited: 2, kind: 'docs' },
    { edited: 1, kind: 'backend' },
  ])(
    'keeps route $edited renamed to the kind another route names and says why in both',
    async ({ edited, kind }) => {
      bridge.answers['workflow.policy'] = policy({
        kind_routes: [
          { kind: 'docs', runtime: 'codex' },
          { kind: 'backend', runtime: 'claude' },
        ],
      });
      const h = await page();
      await type(
        h,
        input(() => route(h, edited), spawn('kind')),
        kind,
      );
      expect(sent()).toEqual([]);
      expect(alerts(route(h, 2))).toEqual([spawn('kindDuplicate')]);
      expect(alerts(route(h, 1))).toEqual([spawn('kindDuplicate')]);
    },
  );

  it.each([
    ['whatever order its keys were read in', { runtime: 'codex', model: 'gpt-5', kind: 'docs' }],
    ['with an empty list of fallbacks', { kind: 'docs', runtime: 'codex', fallbacks: [] }],
  ])('sends nothing for a route left as it was, %s', async (_, read) => {
    bridge.answers['workflow.policy'] = policy({ kind_routes: [read as never] });
    const h = await page();
    await type(
      h,
      input(() => route(h, 1), spawn('kind')),
      'docs',
    );
    expect(sent()).toEqual([]);
  });

  it('shows routes the daemon changed after a route was left as it was', async () => {
    bridge.answers['workflow.policy'] = policy({
      kind_routes: [{ kind: 'docs', runtime: 'codex' }],
    });
    const h = await page();
    const kind = input(() => route(h, 1), spawn('kind'));
    await type(h, kind, 'docs');
    (bridge.answers['workflow.policy'] as Policy).kind_routes = [
      { kind: 'backend', runtime: 'codex' },
    ];
    await type(
      h,
      input(() => tree(h), LIMIT),
      '6',
    );
    expect(sent()).toEqual([{ project_id: project.id, max_spawned: 6 }]);
    expect(kind().props.value).toBe('backend');
  });

  it('sends no route draft started before the daemon changed the routes, and shows the new ones', async () => {
    bridge.answers['workflow.policy'] = policy({
      kind_routes: [{ kind: 'docs', runtime: 'codex' }],
    });
    const h = await page();
    button(tree(h), spawn('addRoute')).props.onClick();
    await settle(h);
    (bridge.answers['workflow.policy'] as Policy).kind_routes = [
      { kind: 'backend', runtime: 'codex' },
    ];
    await type(
      h,
      input(() => tree(h), LIMIT),
      '6',
    );
    await type(
      h,
      input(() => route(h, 2), spawn('kind')),
      'frontend',
    );
    expect(sent()).toEqual([{ project_id: project.id, max_spawned: 6 }]);
    expect(alerts(section(h, spawn('routes')))).toEqual([spawn('routesChanged')]);
    expect(input(() => route(h, 1), spawn('kind'))().props.value).toBe('backend');
  });

  it('shows a failed route save in its group and the saved routes again', async () => {
    bridge.answers['workflow.policy'] = policy({
      kind_routes: [{ kind: 'docs', runtime: 'codex' }],
    });
    bridge.replies.push({
      ok: false,
      error: { code: 'invalid_input', message: 'Unknown runtime' },
    });
    const h = await page();
    const kind = input(() => route(h, 1), spawn('kind'));
    await type(h, kind, 'writing');
    expect(sent()).toEqual([
      { project_id: project.id, kind_routes: [{ kind: 'writing', runtime: 'codex' }] },
    ]);
    expect(alerts(section(h, spawn('routes'))).join('')).toContain('Unknown runtime');
    expect(kind().props.value).toBe('docs');
  });
});
