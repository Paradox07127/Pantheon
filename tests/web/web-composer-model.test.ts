import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { BackendSummary, RuntimeModel, WorkbenchSession } from '@pantheon/protocol';
import { find, type HookHost, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { Tip } from '@/components/Tip';
import { readModels, useRuntimeModels, useSkills } from '@/data/runtime-models';
import { defaultModel, modelText, newSessionInput } from '@/screens/sessions/model';
import { ModelMenu, type ModelChoice } from '@/screens/sessions/parts';
import { NewSession, SessionCompose } from '@/screens/sessions/SessionsScreen';
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import { t } from '@/i18n';
import { zh } from './i18n-setup.js';

const model = (id: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  label: `label of ${id}`,
  permission_modes: ['plan', 'ask', 'auto_edit'],
  efforts: ['low', 'medium', 'high'],
  default_effort: 'medium',
  default: false,
  ...extra,
});

beforeEach(() => {
  mock.board = { board: { cursor: 1 }, events: [], resync: 0, status: { state: 'live' } };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('model menu text', () => {
  const models = [model('model-a'), model('model-b')];
  const alias = [model('opus', { resolved: 'claude-opus-5-5', label: 'Opus 5.5' })];
  const high = zh('sessions.model.effort.high');

  it.each<[string, Parameters<typeof modelText>, string]>([
    [
      'names the runtime, the model and the effort',
      ['claude', models, 'model-b', 'high'],
      `claude，label of model-b，${high}`,
    ],
    [
      'names an alias by its resolved model id',
      ['claude', alias, 'claude-opus-5-5', 'high'],
      `claude，Opus 5.5，${high}`,
    ],
    [
      'shows the raw id of a model the list does not name',
      ['claude', models, 'model-z', 'low'],
      `claude，model-z，${zh('sessions.model.effort.low')}`,
    ],
    ['shows only the runtime without a model', ['codex', models, null, 'max'], 'codex'],
    [
      'leaves out the effort when there is none',
      ['claude', models, 'model-a', null],
      'claude, label of model-a',
    ],
  ])('%s', (_, args, expected) => {
    expect(modelText(...args)).toBe(expected);
  });
});

describe('default model', () => {
  it('picks the model marked default, else the first, else none', () => {
    expect(defaultModel([model('model-a'), model('model-b', { default: true })])?.id).toBe(
      'model-b',
    );
    expect(defaultModel([model('model-a'), model('model-b')])?.id).toBe('model-a');
    expect(defaultModel([])).toBeNull();
  });
});

describe('new session input', () => {
  const base = {
    projectId: 'project',
    runtime: 'claude',
    permissionMode: 'ask',
    input: 'go',
  } as const;

  it('carries the model and effort when chosen', () => {
    expect(newSessionInput({ ...base, model: 'model-a', effort: 'high' })).toEqual({
      project_id: 'project',
      runtime: 'claude',
      permission_mode: 'ask',
      input: 'go',
      model: 'model-a',
      effort: 'high',
    });
  });

  it('leaves out the model and effort when not chosen', () => {
    const input = newSessionInput({ ...base, model: null, effort: null });
    expect(input).not.toHaveProperty('model');
    expect(input).not.toHaveProperty('effort');
    expect(newSessionInput(base)).not.toHaveProperty('model');
  });
});

describe('runtime models', () => {
  it.each([
    ['a non-array', { models: [] }],
    ['a model without a label', [{ id: 'model-a', efforts: [] }]],
    ['a model without efforts', [{ id: 'model-a', label: 'A' }]],
  ])('reports bad_response for %s', async (_, value) => {
    const bridge = { query: vi.fn(async () => ({ ok: true as const, value })) };
    const result = await readModels(bridge, 'project', 'claude');
    expect(result).toMatchObject({ ok: false, error: { code: 'bad_response' } });
    expect(bridge.query).toHaveBeenCalledWith('runtime.models', {
      project_id: 'project',
      runtime: 'claude',
    });
  });

  it('reads a runtime that does not list its models as no models', async () => {
    const bridge = {
      query: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'unsupported_capability', message: 'Runtime does not list its models' },
      })),
    };
    expect(await readModels(bridge, 'project', 'grok')).toEqual({ ok: true, value: [] });
  });

  it('reads each runtime once per project across mounts', async () => {
    const query = vi.fn(async (_method: string, params: { runtime: string }) => ({
      ok: true,
      value: [model(`${params.runtime}-model`)],
    }));
    vi.stubGlobal('window', { pantheon: { query } });
    const read = async () => {
      const h = mount(() => useRuntimeModels('project-cached', ['claude', 'codex']));
      await h.flush();
      return h;
    };
    const first = await read();
    expect(first.value.claude).toEqual({ state: 'ready', models: [model('claude-model')] });
    expect(first.value.codex).toEqual({ state: 'ready', models: [model('codex-model')] });
    first.unmount();
    const second = await read();
    expect(second.value.claude).toEqual({ state: 'ready', models: [model('claude-model')] });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reads the models and skills again on a later mount, showing the earlier ones meanwhile', async () => {
    vi.useFakeTimers();
    try {
      let version = 'before';
      const query = vi.fn(async (method: string) => ({
        ok: true,
        value:
          method === 'runtime.models'
            ? [model(`model-${version}`)]
            : {
                mcp_servers: [],
                plugins: [],
                skills: [{ id: `skill-${version}`, name: `skill-${version}`, enabled: true }],
                hooks: [],
                apps: false,
                connectors: [],
              },
      }));
      vi.stubGlobal('window', { pantheon: { query } });
      mock.board = {
        board: { cursor: 1, projects: [] },
        events: [],
        resync: 0,
        status: { state: 'live' },
      };
      const read = () =>
        mount(() => ({
          models: useRuntimeModels('project-aging', ['claude']),
          skills: useSkills('project-aging', 'claude'),
        }));
      const first = read();
      await first.flush();
      expect(first.value.models.claude).toEqual({
        state: 'ready',
        models: [model('model-before')],
      });
      expect(first.value.skills.map((s) => s.id)).toEqual(['skill-before']);
      first.unmount();
      version = 'after';
      vi.advanceTimersByTime(10 * 60_000);
      const second = read();
      expect(second.value.models.claude).toEqual({
        state: 'ready',
        models: [model('model-before')],
      });
      expect(second.value.skills.map((s) => s.id)).toEqual(['skill-before']);
      await second.flush();
      expect(second.value.models.claude).toEqual({
        state: 'ready',
        models: [model('model-after')],
      });
      expect(second.value.skills.map((s) => s.id)).toEqual(['skill-after']);
      expect(query).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('model menu', () => {
  const models = [
    model('model-a', { efforts: ['low', 'medium', 'high'] }),
    model('model-b', { efforts: ['low', 'medium', 'high', 'max'], default_effort: 'medium' }),
    model('model-c', { efforts: ['low', 'medium'], default_effort: 'low' }),
  ];
  const pick = (value: ModelChoice, id: string) => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const onChange = vi.fn();
    const h = mount(() =>
      ModelMenu({
        runtimes: ['claude'],
        models: { claude: { state: 'ready', models } },
        value,
        onChange,
      }),
    );
    find(
      h.value,
      (n) => n.props.value === id && typeof n.props.onClick === 'function',
    ).props.onClick();
    return onChange;
  };

  it('shows the alias label and efforts for a resolved model id', () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const h = mount(() =>
      ModelMenu({
        runtimes: ['claude'],
        models: {
          claude: {
            state: 'ready',
            models: [
              model('opus', {
                resolved: 'claude-opus-5-5',
                label: 'Opus 5.5',
                efforts: ['low', 'high'],
              }),
            ],
          },
        },
        value: { runtime: 'claude', backend: null, model: 'claude-opus-5-5', effort: 'high' },
        onChange: vi.fn(),
      }),
    );
    expect.soft(text(find(h.value, (n) => n.type === Menu.Trigger))).toContain('Opus 5.5');
    const efforts = nodes(h.value).find(
      (n) => n.props['aria-label'] === zh('sessions.composer.effort'),
    );
    expect.soft(efforts).toBeDefined();
    expect(
      nodes(efforts)
        .filter((n) => typeof n.props.onClick === 'function')
        .map((n) => n.props.value),
    ).toEqual(['low', 'high']);
  });

  it.each(['claude', 'codex'])('lists only the chosen runtime models for %s', (runtime) => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const h = mount(() =>
      ModelMenu({
        runtimes: ['claude', 'codex'],
        models: {
          claude: { state: 'ready', models: [model('claude-model')] },
          codex: { state: 'ready', models: [model('codex-model')] },
        },
        value: { runtime, backend: null, model: `${runtime}-model`, effort: 'high' },
        onChange: vi.fn(),
      }),
    );
    expect(
      nodes(h.value)
        .filter((n) => ['claude-model', 'codex-model'].includes(n.props.value) && n.props.onClick)
        .map((n) => n.props.value),
    ).toEqual([`${runtime}-model`]);
  });

  it('switches runtime to its default model and effort while keeping the menu open', () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    let value: ModelChoice = {
      runtime: 'claude',
      backend: null,
      model: 'claude-model',
      effort: 'high',
    };
    const onChange = vi.fn((next: ModelChoice) => {
      value = next;
    });
    const h = mount(() =>
      ModelMenu({
        runtimes: ['claude', 'codex'],
        models: {
          claude: { state: 'ready', models: [model('claude-model')] },
          codex: {
            state: 'ready',
            models: [
              model('codex-first'),
              model('codex-default', { default: true, default_effort: 'low' }),
            ],
          },
        },
        value,
        onChange,
      }),
    );
    h.value.props.onOpenChange(true);
    h.render();
    const runtimes = find(
      h.value,
      (n) => n.props['aria-label'] === zh('sessions.composer.runtime'),
    );
    expect(runtimes.props.value).toBe('claude');
    const codex = find(runtimes, (n) => n.props.value === 'codex' && n.props.onClick);
    expect(codex.props.closeOnClick).toBe(false);
    codex.props.onClick();
    expect(onChange).toHaveBeenCalledExactlyOnceWith({
      runtime: 'codex',
      backend: null,
      model: 'codex-default',
      effort: 'low',
    });
    h.render();
    expect(h.value.props.open).toBe(true);
    expect(
      find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.runtime')).props.value,
    ).toBe('codex');
    expect(text(h.value)).not.toContain('label of claude-model');
    expect(text(h.value)).toContain('label of codex-default');
  });

  it("puts its maker's mark before each model", () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const ids = ['gemini-3-pro', 'claude-sonnet-4-5', 'gpt-oss-120b'];
    const h = mount(() =>
      ModelMenu({
        runtimes: ['agy'],
        models: { agy: { state: 'ready', models: ids.map((id) => model(id)) } },
        value: { runtime: 'agy', backend: null, model: 'gemini-3-pro', effort: 'medium' },
        onChange: vi.fn(),
      }),
    );
    const brands = ids.map((id) => {
      const item = find(h.value, (n) => n.props.value === id && n.props.onClick);
      const mark = named(item, 'ModelMark');
      return (mark.type as (props: object) => ReactElement<any>)(mark.props).props.brand;
    });
    expect(brands).toEqual(['gemini', 'claude', 'openai']);
  });

  it('offers the default model only when it already runs while the list cannot be read', () => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const defaults = (model: string | null) => {
      const h = mount(() =>
        ModelMenu({
          runtimes: ['claude'],
          models: { claude: { state: 'failed', text: 'models unavailable' } },
          value: { runtime: 'claude', backend: null, model, effort: null },
          onChange: vi.fn(),
        }),
      );
      return nodes(h.value).filter((n) => n.props.value === '' && n.props.onClick);
    };
    expect(defaults('model-a')).toEqual([]);
    expect(defaults(null)).toHaveLength(1);
  });

  it.each([
    ['keeps the effort when the picked model accepts it', 'model-b', 'high'],
    [
      "switches to the picked model's default effort when it does not accept the current one",
      'model-c',
      'low',
    ],
  ])('%s', (_, id, effort) => {
    const onChange = pick(
      { runtime: 'claude', backend: null, model: 'model-a', effort: 'high' },
      id,
    );
    expect(onChange).toHaveBeenCalledWith({ runtime: 'claude', backend: null, model: id, effort });
  });
});

const backend = (id: string, extra: Partial<BackendSummary> = {}): BackendSummary => ({
  id,
  protocol: 'anthropic',
  base_url: `https://${id}.example.com`,
  models: [],
  runtimes: ['claude'],
  key: { env: `${id.toUpperCase()}_KEY` },
  key_present: true,
  ...extra,
});

describe('model menu backends', () => {
  const menu = (
    value: ModelChoice,
    backends: BackendSummary[],
    runtimes: string[] = ['claude'],
    onChange = vi.fn(),
  ) => {
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const h = mount(() =>
      ModelMenu({
        runtimes,
        models: {
          claude: { state: 'ready', models: [model('model-a'), model('model-b')] },
          codex: { state: 'ready', models: [model('codex-model')] },
        },
        value,
        onChange,
        backends,
      }),
    );
    return h;
  };
  const group = (h: HookHost<any>) =>
    nodes(h.value).find((n) => n.props['aria-label'] === zh('sessions.composer.backend'));
  const item = (h: HookHost<any>, value: string) =>
    find(group(h), (n) => n.props.value === value && typeof n.props.onClick === 'function');
  const onClaude: ModelChoice = {
    runtime: 'claude',
    backend: null,
    model: 'model-a',
    effort: 'high',
  };

  it('has no backend group when no backend serves the runtime', () => {
    const h = menu(onClaude, [backend('router', { runtimes: ['codex'] })]);
    expect(group(h)).toBeUndefined();
  });

  it('lists the backends of the runtime and picks one, on its first model when the current one is not among them', () => {
    const onChange = vi.fn();
    const backends = [
      backend('router', { models: ['router-x', 'router-y'] }),
      backend('proxy'),
      backend('other', { runtimes: ['codex'] }),
    ];
    const h = menu(onClaude, backends, ['claude'], onChange);
    expect(
      nodes(group(h))
        .filter((n) => typeof n.props.onClick === 'function')
        .map((n) => [n.props.value, text(n)]),
    ).toEqual([
      [
        '',
        t({ id: 'sessions.composer.runtimeEndpoint', defaultMessage: '' }, { runtime: 'Claude' }),
      ],
      ['router', 'router'],
      ['proxy', 'proxy'],
    ]);
    item(h, 'router').props.onClick();
    expect(onChange).toHaveBeenLastCalledWith({
      runtime: 'claude',
      backend: 'router',
      model: 'router-x',
      effort: null,
    });
    item(h, 'proxy').props.onClick();
    expect(onChange).toHaveBeenLastCalledWith({ ...onClaude, backend: 'proxy' });
  });

  it("lists only the backend's models while it is chosen", () => {
    const h = menu({ runtime: 'claude', backend: 'router', model: 'router-y', effort: null }, [
      backend('router', { models: ['router-x', 'router-y'] }),
    ]);
    const listed = find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.model'));
    expect(
      nodes(listed)
        .filter((n) => n.props.closeOnClick)
        .map((n) => n.props.value),
    ).toEqual(['router-x', 'router-y']);
    expect(
      nodes(h.value).some((n) => n.props['aria-label'] === zh('sessions.composer.effort')),
    ).toBe(false);
    expect(find(h.value, (n) => n.type === Menu.Trigger).props['aria-label']).toBe(
      t(
        { id: 'sessions.composer.modelSummary', defaultMessage: '' },
        { summary: 'claude, router-y, router' },
      ),
    );
  });

  it("returns to the runtime's default model when the backend's model is not one of the runtime's", () => {
    const onChange = vi.fn();
    const backends = [backend('router', { models: ['router-x', 'router-y'] }), backend('proxy')];
    const onRouter: ModelChoice = {
      runtime: 'claude',
      backend: 'router',
      model: 'router-y',
      effort: null,
    };
    const h = menu(onRouter, backends, ['claude'], onChange);
    item(h, '').props.onClick();
    expect(onChange).toHaveBeenLastCalledWith({
      runtime: 'claude',
      backend: null,
      model: 'model-a',
      effort: 'medium',
    });
    item(h, 'proxy').props.onClick();
    expect(onChange).toHaveBeenLastCalledWith({
      runtime: 'claude',
      backend: 'proxy',
      model: 'model-a',
      effort: 'medium',
    });
    const kept = menu({ ...onRouter, model: 'model-b' }, backends, ['claude'], onChange);
    item(kept, '').props.onClick();
    expect(onChange).toHaveBeenLastCalledWith({ ...onRouter, backend: null, model: 'model-b' });
  });

  it('disables a backend whose key is not set and says why', () => {
    const h = menu(onClaude, [backend('router', { key_present: false })]);
    const tip = find(group(h), (n) => n.type === Tip);
    expect(tip.props.content).toBe(
      t({ id: 'sessions.composer.backendKeyMissing', defaultMessage: '' }, { env: 'ROUTER_KEY' }),
    );
    expect(tip.props.children.props).toMatchObject({ value: 'router', disabled: true });
  });

  it('goes back to the runtime endpoint on another runtime', () => {
    const onChange = vi.fn();
    const h = menu(
      { ...onClaude, backend: 'router' },
      [backend('router')],
      ['claude', 'codex'],
      onChange,
    );
    find(
      find(h.value, (n) => n.props['aria-label'] === zh('sessions.composer.runtime')),
      (n) => n.props.value === 'codex' && n.props.onClick,
    ).props.onClick();
    expect(onChange.mock.calls[0]![0].backend).toBeNull();
  });
});

describe('composer backends', () => {
  // backend.list is read once across mounts; each test moves the clock past the earlier read.
  let clock = Date.now();
  const reread = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((clock += 10 * 60_000));
  };
  let command: ReturnType<typeof vi.fn>;
  const stub = (answers: Record<string, unknown>) => {
    reread();
    command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
    vi.stubGlobal('window', {
      pantheon: {
        query: vi.fn(async (method: string) =>
          method in answers
            ? { ok: true, value: answers[method] }
            : { ok: false, error: { code: 'unknown_route', message: method } },
        ),
        command,
        chooseFiles: vi.fn(async () => ({ ok: true, value: [] })),
      },
      addEventListener() {},
      removeEventListener() {},
    });
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  };
  beforeEach(() => {
    mock.board = {
      board: { cursor: 1, projects: [{ id: 'project-b', name: 'Pantheon' }] },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
  });
  afterEach(() => vi.useRealTimers());
  const sent = () => command.mock.calls.map(([c]: any) => c);

  it('creates a new session on the picked backend and leaves the field out without one', async () => {
    stub({ 'runtime.models': [model('model-a')], 'backend.list': [backend('router')] });
    const created = async (taskId: string, pick: boolean) => {
      const h = mount(() =>
        NewSession({
          projectId: 'project-b',
          defaults: undefined,
          focus: 0,
          onCreated: () => {},
          task: { id: taskId, title: 'Add the API', goal: 'Serve the board' },
          recent: [],
          onOpen: () => {},
          onClose: () => {},
        }),
      );
      await h.flush();
      const shown = named(h.value, 'ModelMenu').props;
      expect(shown.backends.map((b: BackendSummary) => b.id)).toEqual(['router']);
      expect(shown.value.backend).toBeNull();
      if (pick) {
        shown.onChange({ ...shown.value, backend: 'router' });
        h.render();
      }
      named(h.value, 'SendButton').props.onPress();
      await h.flush();
      return sent().at(-1).input;
    };
    expect(await created('lead-1:on-backend', true)).toMatchObject({
      runtime: 'claude',
      backend: 'router',
    });
    expect(await created('lead-1:on-runtime', false)).not.toHaveProperty('backend');
  });

  const listed = (extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
    id: 'session-b',
    created_at: '2026-01-01T00:00:00.000Z',
    title: 'Backend work',
    runtime: 'claude',
    model: 'model-a',
    effort: 'medium',
    permission_mode: 'ask',
    workspace_id: 'workspace-b',
    workspace_kind: 'linked_worktree',
    state: 'idle',
    waiting: 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-01-01T00:00:00.000Z',
    changes: null,
    merge: null,
    ...extra,
  });
  const composer = async (view: WorkbenchSession) => {
    stub({
      'runtime.models': [model('model-a'), model('model-b')],
      'backend.list': [backend('router', { models: ['router-x'] })],
    });
    const h = mount(() =>
      SessionCompose({
        session: {
          id: 'session-b',
          revision: 7,
          project_id: 'project-b',
          runtime: 'claude',
          state: 'open',
          turn_count: 1,
        },
        listed: view,
        title: 'Backend work',
      }),
    );
    await h.flush();
    return h;
  };
  const change = async (h: HookHost<any>, next: Partial<ModelChoice>) => {
    const shown = named(h.value, 'ModelMenu').props;
    shown.onChange({ ...shown.value, ...next });
    await h.flush();
    return sent().at(-1);
  };

  it('switches an open session to another backend at its revision', async () => {
    const h = await composer(listed());
    expect(named(h.value, 'ModelMenu').props.value.backend).toBeNull();
    expect(await change(h, { backend: 'router', model: 'router-x', effort: null })).toMatchObject({
      type: 'session.setBackend',
      input: { session_id: 'session-b', backend: 'router', model: 'router-x' },
      expected_revision: 7,
    });
  });

  it("goes back to the runtime's endpoint with a null backend", async () => {
    const h = await composer(listed({ backend_id: 'router', model: 'router-x' }));
    expect(named(h.value, 'ModelMenu').props.value.backend).toBe('router');
    const sentCommand = await change(h, { backend: null, model: null, effort: null });
    expect(sentCommand).toMatchObject({
      type: 'session.setBackend',
      input: { session_id: 'session-b', backend: null },
      expected_revision: 7,
    });
    expect(sentCommand.input).not.toHaveProperty('model');
    expect(sentCommand.input).not.toHaveProperty('effort');
  });

  it('sends the picked model and effort with a new backend, even the model the session lists', async () => {
    const h = await composer(listed());
    expect(
      (await change(h, { backend: 'router', model: 'model-a', effort: 'high' })).input,
    ).toEqual({ session_id: 'session-b', backend: 'router', model: 'model-a', effort: 'high' });
  });

  it('changes only the model with session.setModel', async () => {
    const h = await composer(listed({ backend_id: 'router' }));
    expect(await change(h, { model: 'model-b' })).toMatchObject({
      type: 'session.setModel',
      input: { session_id: 'session-b', model: 'model-b' },
    });
  });

  it('creates a new session in fast mode only while its model has fast mode', async () => {
    stub({
      'runtime.models': [model('model-a', { fast: true, default: true }), model('model-b')],
      'backend.list': [],
    });
    const h = mount(() =>
      NewSession({
        projectId: 'project-b',
        defaults: undefined,
        focus: 0,
        onCreated: () => {},
        task: { id: 'lead-1:fast', title: 'Add the API', goal: 'Serve the board' },
        recent: [],
        onOpen: () => {},
        onClose: () => {},
      }),
    );
    await h.flush();
    const shown = () => named(h.value, 'ModelMenu').props;
    expect(shown().fast).toEqual({ on: false });
    shown().onFast(true);
    h.render();
    const create = async () => {
      named(h.value, 'SendButton').props.onPress();
      await h.flush();
      return sent().at(-1).input;
    };
    expect(await create()).toMatchObject({ model: 'model-a', fast: true });
    shown().onChange({ ...shown().value, model: 'model-b' });
    h.render();
    expect(await create()).not.toHaveProperty('fast');
  });

  it('sends a fast mode switch at the revision and answers with why it was refused', async () => {
    const h = await composer(listed({ fast_mode: { on: false } }));
    const shown = named(h.value, 'ModelMenu').props;
    expect(shown.fast).toEqual({ on: false });
    expect(await shown.onFast(true)).toBeNull();
    expect(sent().at(-1)).toMatchObject({
      type: 'session.setFastMode',
      input: { session_id: 'session-b', fast: true },
      expected_revision: 7,
    });
    command.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'conflict', message: 'The session changed meanwhile' },
    }));
    expect(await shown.onFast(false)).toEqual(expect.any(String));
  });
});

describe('new session composer', () => {
  it("shows where the session starts and creates it on the runtime's default model", async () => {
    mock.board = {
      board: { cursor: 1, projects: [{ id: 'project-new', name: 'Pantheon' }] },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    const values: Record<string, unknown> = {
      'runtime.models': [model('model-a'), model('model-b', { default: true })],
      'project.head': { branch: 'main', sha: 'abcdef1234567', subject: 'Fix the board' },
    };
    const query = vi.fn(async (method: string) =>
      method in values
        ? { ok: true, value: values[method] }
        : { ok: false, error: { code: 'unknown_route', message: method } },
    );
    const command = vi.fn(async () => ({ ok: true, value: { id: 'session-new' } }));
    vi.stubGlobal('window', {
      pantheon: { query, command },
      addEventListener() {},
      removeEventListener() {},
    });
    const onOpen = vi.fn();
    const recent = {
      id: 'session-r',
      created_at: '2026-01-01T00:00:00.000Z',
      title: 'Recent work',
      runtime: 'claude',
      model: null,
      effort: null,
      permission_mode: 'ask',
      workspace_id: 'workspace-r',
      workspace_kind: 'linked_worktree',
      state: 'idle',
      waiting: 0,
      reconciling: false,
      stopping: false,
      last_activity_at: '2026-01-01T00:00:00.000Z',
      changes: null,
      merge: null,
    } as const;
    const h = mount(() =>
      NewSession({
        projectId: 'project-new',
        defaults: undefined,
        focus: 0,
        onCreated: () => {},
        task: { id: 'lead-1:api', title: 'Add the API', goal: 'Serve the board' },
        recent: [recent],
        onOpen,
        onClose: () => {},
      }),
    );
    expect(named(h.value, 'ModelMenu').props.value).toEqual({
      runtime: 'claude',
      backend: null,
      model: null,
      effort: null,
    });
    await h.flush();
    const at = (className: string) => text(find(h.value, (n) => n.props.className === className));
    expect(at('cr-pk')).toBe('Pantheon');
    expect(at('cr-head')).toBe('mainabcdef1Fix the board');
    expect(at('cr-card')).toBe('Add the API');
    expect(named(h.value, 'ModelMenu').props.value).toEqual({
      runtime: 'claude',
      backend: null,
      model: 'model-b',
      effort: 'medium',
    });
    named(h.value, 'SendButton').props.onPress();
    await h.flush();
    expect(command).toHaveBeenCalledTimes(1);
    expect((command.mock.calls[0] as any)[0].input).toMatchObject({
      runtime: 'claude',
      model: 'model-b',
      effort: 'medium',
    });
  });

  it("opens on the project's default effort only on the project's default runtime and model", async () => {
    mock.board = {
      board: { cursor: 1, projects: [{ id: 'project-new', name: 'Pantheon' }] },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    const models = [model('model-a'), model('model-b', { default: true })];
    vi.stubGlobal('window', {
      pantheon: {
        query: vi.fn(async (method: string) =>
          method === 'runtime.models'
            ? { ok: true, value: models }
            : { ok: false, error: { code: 'unknown_route', message: method } },
        ),
        command: vi.fn(),
      },
      addEventListener() {},
      removeEventListener() {},
    });
    const opened = async (defaults: { runtime: string; model?: string }) => {
      const h = mount(() =>
        NewSession({
          projectId: 'project-new',
          defaults: { ...defaults, permission_mode: 'ask', effort: 'high' },
          focus: 0,
          onCreated: () => {},
          recent: [],
          onOpen: () => {},
          onClose: () => {},
        }),
      );
      await h.flush();
      return named(h.value, 'ModelMenu').props.value;
    };
    expect(await opened({ runtime: 'claude', model: 'model-a' })).toEqual({
      runtime: 'claude',
      backend: null,
      model: 'model-a',
      effort: 'high',
    });
    expect(await opened({ runtime: 'claude', model: 'model-gone' })).toEqual({
      runtime: 'claude',
      backend: null,
      model: 'model-b',
      effort: 'medium',
    });
  });
});
