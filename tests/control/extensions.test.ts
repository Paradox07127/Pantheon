import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  AcpAdapter,
  acpProfiles,
  CodexAdapter,
  FixtureAdapter,
  JsonRpcProcess,
} from '@pantheon/adapters';
import { Control } from '@pantheon/control';
import {
  NATIVE_ENV_ALLOWLIST,
  closeUserExtensions,
  type AgentEvent,
  type ExtensionInventory,
  type ExtensionOverrides,
  type Project,
  type Session,
  type SessionHandle,
  type SessionSpec,
} from '@pantheon/domain';
import { command, inputSchemas, querySchemas } from '@pantheon/protocol';
import type { Store } from '@pantheon/store';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const empty: ExtensionOverrides = {
  disabled_mcp_servers: [],
  disabled_plugins: [],
  disabled_skills: [],
  disable_apps: false,
  disable_hooks: false,
};
const overrides: ExtensionOverrides = {
  disabled_mcp_servers: ['kept-server'],
  disabled_plugins: ['tracing@observability'],
  disabled_skills: ['/skills/kept/SKILL.md'],
  disable_apps: true,
  disable_hooks: true,
};
const inventory: ExtensionInventory = {
  runtime: 'fixture',
  mcp_servers: [{ name: 'kept-server', enabled: true }],
  plugins: [{ id: 'tracing@observability', enabled: true }],
  skills: [
    { id: '/skills/kept/SKILL.md', name: 'kept', path: '/skills/kept/SKILL.md', enabled: true },
  ],
  apps: true,
  connectors: [],
  hooks: [{ event: 'SessionStart', plugin: 'tracing@observability' }],
};
const inventoryAdapter = () =>
  Object.assign(new FixtureAdapter(), { inventory: vi.fn(async (_cwd: string) => inventory) });

describe('project extension overrides', () => {
  it('defines strict overrides and inventory inputs without accepting extension configuration', () => {
    const input = { project_id: 'project', runtime: 'codex', overrides };
    expect(inputSchemas['project.extensions.set'].parse(input)).toEqual(input);
    expect(
      inputSchemas['project.extensions.set'].safeParse({
        ...input,
        overrides: { ...overrides, env: { TOKEN: 'not-configuration' } },
      }).success,
    ).toBe(false);
    expect(
      querySchemas['extensions.inventory'].parse({ project_id: 'project', runtime: 'codex' }),
    ).toEqual({ project_id: 'project', runtime: 'codex' });
    expect(querySchemas['extensions.inventory'].safeParse({ project_id: 'project' }).success).toBe(
      false,
    );
  });

  it('stores and reads overrides per runtime, emits the change, and checks revision and user authority', async () => {
    const f = await fixture({ adapter: inventoryAdapter() });
    try {
      const input = { project_id: f.project.id, runtime: 'fixture', overrides };
      const sent = command(user.id, 'project.extensions.set', input, f.project.revision);
      const next = f.control.execute(user, sent) as Project;
      expect(next.revision).toBe(f.project.revision + 1);
      expect(next.extension_overrides).toEqual({ fixture: overrides });
      expect(f.control.execute(user, sent)).toEqual(next);
      expect(f.control.snapshot(user, f.project.id)).toMatchObject({ projects: [next] });
      expect(f.store.events(0).filter((event) => event.kind === 'project.extensions_set')).toEqual([
        expect.objectContaining({
          aggregate_id: next.id,
          aggregate_revision: next.revision,
          causation_id: sent.command_id,
          payload: { runtime: 'fixture', overrides },
        }),
      ]);
      expect(() => f.call('project.extensions.set', input, f.project.revision)).toThrow(
        expect.objectContaining({ code: 'revision_conflict' }),
      );
      expect(() => f.call('project.extensions.set', input)).toThrow(
        expect.objectContaining({ code: 'revision_conflict' }),
      );
      expect(() =>
        f.call('project.extensions.set', input, next.revision, { id: 'planner', role: 'planner' }),
      ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
      const other = Object.assign(inventoryAdapter(), { name: 'other' });
      f.control.adapters.set(other.name, other);
      const both = f.call<Project>(
        'project.extensions.set',
        { ...input, runtime: 'other', overrides: empty },
        next.revision,
      );
      expect(both.extension_overrides).toEqual({ fixture: overrides, other: empty });
      expect(
        f.call<Project>('project.extensions.set', { ...input, overrides: empty }, both.revision)
          .extension_overrides,
      ).toEqual({ fixture: empty, other: empty });
    } finally {
      await f.close();
    }
  });

  it('refuses unregistered runtimes and adapters without inventory without changing the project', async () => {
    const f = await fixture();
    try {
      for (const runtime of ['fixture', 'missing']) {
        expect(() =>
          f.call(
            'project.extensions.set',
            { project_id: f.project.id, runtime, overrides },
            f.project.revision,
          ),
        ).toThrow(expect.objectContaining({ code: 'unsupported_capability' }));
        await expect(
          f.control.extensionsInventory(user, f.project.id, runtime),
        ).rejects.toMatchObject({ code: 'unsupported_capability' });
      }
      expect(f.store.must<Project>('projects', f.project.id)).toEqual(f.project);
    } finally {
      await f.close();
    }
  });

  it('accepts agy overrides and lists its user-level extensions from the Gemini files', async () => {
    const f = await fixture();
    try {
      const home = path.join(f.root, 'agy-home');
      mkdirSync(path.join(home, '.agents', 'skills', 'y'), { recursive: true });
      const agy = new AcpAdapter({ name: 'agy', profile: acpProfiles.agy!, home });
      f.control.adapters.set(agy.name, agy);
      const next = f.call<Project>(
        'project.extensions.set',
        {
          project_id: f.project.id,
          runtime: 'agy',
          overrides: { ...empty, enabled_user_mcp_servers: [], enabled_user_skills: ['y'] },
        },
        f.project.revision,
      );
      expect(next.extension_overrides?.agy?.enabled_user_skills).toEqual(['y']);
      expect(await f.control.extensionsInventory(user, f.project.id, 'agy')).toMatchObject({
        mcp_servers: [],
        skills: [{ id: 'y', name: 'y', user: true }],
      });
    } finally {
      await f.close();
    }
  });

  it('accepts grok overrides and lists its user-level extensions from grok inspect', async () => {
    const f = await fixture();
    try {
      const home = path.join(f.root, 'grok-home');
      mkdirSync(home);
      const output = path.join(f.root, 'inspect.json');
      writeFileSync(
        output,
        JSON.stringify({
          mcpServers: [],
          plugins: [],
          skills: [
            {
              name: 'y',
              source: { type: 'user', path: path.join(home, '.grok', 'skills', 'y', 'SKILL.md') },
            },
          ],
        }),
      );
      const binary = path.join(f.root, 'grok');
      writeFileSync(binary, `#!/bin/sh\ncat '${output}'\n`, { mode: 0o755 });
      const grok = new AcpAdapter({ name: 'grok', profile: acpProfiles.grok!, binary, home });
      f.control.adapters.set(grok.name, grok);
      const next = f.call<Project>(
        'project.extensions.set',
        {
          project_id: f.project.id,
          runtime: 'grok',
          overrides: { ...empty, enabled_user_mcp_servers: [], enabled_user_skills: ['y'] },
        },
        f.project.revision,
      );
      expect(next.extension_overrides?.grok?.enabled_user_skills).toEqual(['y']);
      expect(await f.control.extensionsInventory(user, f.project.id, 'grok')).toMatchObject({
        mcp_servers: [],
        skills: [{ id: 'y', name: 'y', user: true }],
      });
    } finally {
      await f.close();
    }
  });

  it('checks project read access before fetching inventory with the project root', async () => {
    const adapter = inventoryAdapter(),
      f = await fixture({ adapter });
    try {
      await expect(
        f.control.extensionsInventory(
          { id: 'outsider', role: 'writer' },
          f.project.id,
          adapter.name,
        ),
      ).rejects.toMatchObject({ code: 'permission_denied' });
      expect(adapter.inventory).not.toHaveBeenCalled();
      await expect(
        f.control.extensionsInventory(user, f.project.id, adapter.name),
      ).resolves.toEqual(inventory);
      expect(adapter.inventory).toHaveBeenCalledExactlyOnceWith(f.project.roots[0]!);
    } finally {
      await f.close();
    }
  });

  it('reads the inventory of the personal home, which has no roots, in the personal agent folder', async () => {
    const adapter = inventoryAdapter(),
      f = await fixture({ adapter });
    try {
      const home = f.store.transaction(() =>
        f.store.insert<Project>('projects', {
          id: 'personal-home',
          revision: 1,
          name: 'Personal',
          roots: [],
          kind: 'personal',
        }),
      );
      await expect(f.control.extensionsInventory(user, home.id, adapter.name)).resolves.toEqual(
        inventory,
      );
      expect(adapter.inventory.mock.calls.map(([cwd]) => path.basename(cwd))).toEqual([
        'personal-agent',
      ]);
    } finally {
      await f.close();
    }
  });

  it('returns the union of every folder inventory, enabled when any folder enables it', async () => {
    let folder = '';
    const second: ExtensionInventory = {
      runtime: 'fixture',
      mcp_servers: [
        { name: 'kept-server', enabled: false },
        { name: 'second-server', enabled: false },
      ],
      plugins: [{ id: 'tracing@observability', enabled: false }],
      skills: [{ id: '/skills/other/SKILL.md', name: 'other', enabled: true }],
      apps: false,
      connectors: [],
      hooks: [{ event: 'SessionStart', plugin: 'tracing@observability' }, { event: 'Stop' }],
    };
    const adapter = Object.assign(new FixtureAdapter(), {
        inventory: vi.fn(async (cwd: string) => (cwd === folder ? second : inventory)),
      }),
      f = await fixture({ adapter });
    try {
      mkdirSync(path.join(f.root, 'second'));
      folder = realpathSync(path.join(f.root, 'second'));
      await f.call(
        'project.environment.set',
        {
          project_id: f.project.id,
          name: f.project.name,
          roots: [f.project.roots[0]!, folder],
          env: {},
        },
        f.project.revision,
      );
      await expect(
        f.control.extensionsInventory(user, f.project.id, adapter.name),
      ).resolves.toEqual({
        runtime: 'fixture',
        mcp_servers: [
          { name: 'kept-server', enabled: true },
          { name: 'second-server', enabled: false },
        ],
        plugins: [{ id: 'tracing@observability', enabled: true }],
        skills: [...inventory.skills, ...second.skills],
        apps: true,
        connectors: [],
        hooks: [{ event: 'SessionStart', plugin: 'tracing@observability' }, { event: 'Stop' }],
      });
      expect(adapter.inventory.mock.calls.map(([cwd]) => cwd)).toEqual([
        f.project.roots[0]!,
        folder,
      ]);
    } finally {
      await f.close();
    }
  });

  for (const mode of ['start', 'resume'] as const)
    it.each(['project', 'missing', 'legacy'] as const)(
      `starts the main session without extensions despite %s overrides on ${mode}`,
      async (source) => {
        const adapter = inventoryAdapter(),
          f = await fixture({ adapter });
        const control = new Control(f.store, f.files, [adapter]);
        const start = vi.spyOn(adapter, 'start'),
          resume = vi.spyOn(adapter, 'resume');
        vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
          turn_id: turn.turn_id,
          status: 'delivered',
        }));
        try {
          if (source === 'project')
            f.call(
              'project.extensions.set',
              { project_id: f.project.id, runtime: adapter.name, overrides },
              f.project.revision,
            );
          if (source === 'legacy') setLegacyExtensions(f.store, f.project);
          const session = f.store.insert<Session>('sessions', {
            id: 'main-session',
            revision: 1,
            project_id: f.project.id,
            runtime: adapter.name,
            device_id: 'local',
            state: 'open',
            turn_count: 0,
            ...(mode === 'resume' ? { native_id: 'existing-thread' } : {}),
          });
          f.call('session.send', { session_id: session.id, input: 'hello' }, session.revision);
          await control.tick();
          const spec = (mode === 'resume' ? resume : start).mock.calls[0]?.[0];
          expect(spec).toBeDefined();
          expect(spec?.extensions).toEqual({ mode: 'none' });
          expect(adapter.inventory).not.toHaveBeenCalled();
        } finally {
          await control.shutdown();
          await f.close();
        }
      },
    );

  it.each(['project', 'missing', 'legacy'] as const)(
    'passes the %s overrides to a worktree writer session',
    async (source) => {
      // Worktree provisioning needs the real child processes.
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process');
      vi.mocked(spawn).mockImplementation(actual.spawn);
      const f = await workbenchFixture();
      try {
        const adapter = Object.assign(f.adapter, { inventory: vi.fn(async () => inventory) });
        vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
          turn_id: turn.turn_id,
          status: 'delivered',
        }));
        if (source === 'project')
          f.call(
            'project.extensions.set',
            { project_id: f.project.id, runtime: adapter.name, overrides },
            f.project.revision,
          );
        if (source === 'legacy') setLegacyExtensions(f.store, f.project);
        const session = await f.create();
        await awaitWorkspaceReady(f.control, session.workspace_id!);
        await eventually(
          () => f.start.mock.calls.length > 0,
          () => f.control.tick(),
        );
        expect(f.start.mock.calls[0]![0].extensions).toEqual({
          mode: 'inherit',
          overrides: {
            ...(source === 'project' ? overrides : empty),
            disable_apps: true,
            enabled_user_mcp_servers: [],
            enabled_user_skills: [],
            enabled_user_connectors: [],
          },
        });
        expect(adapter.inventory).not.toHaveBeenCalled();
      } finally {
        await f.control.shutdown();
        vi.mocked(spawn).mockReset();
      }
    },
  );

  it.each([
    {
      name: 'opened',
      saved: { enabled_user_connectors: ['claude.ai Gmail'] },
      closed: false,
      opened: ['claude.ai Gmail'],
    },
    {
      name: 'opened but also closed',
      saved: { enabled_user_connectors: ['claude.ai Gmail'], disable_apps: true },
      closed: true,
      opened: ['claude.ai Gmail'],
    },
    { name: 'not opened', saved: { enabled_user_connectors: [] }, closed: true, opened: [] },
    { name: 'never listed', saved: {}, closed: true, opened: [] },
  ])(
    'passes the account connectors a project $name to a worktree writer session',
    async ({ saved, closed, opened }) => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process');
      vi.mocked(spawn).mockImplementation(actual.spawn);
      const f = await workbenchFixture();
      try {
        const adapter = Object.assign(f.adapter, { inventory: vi.fn(async () => inventory) });
        vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
          turn_id: turn.turn_id,
          status: 'delivered',
        }));
        f.call(
          'project.extensions.set',
          { project_id: f.project.id, runtime: adapter.name, overrides: { ...empty, ...saved } },
          f.project.revision,
        );
        const session = await f.create();
        await awaitWorkspaceReady(f.control, session.workspace_id!);
        await eventually(
          () => f.start.mock.calls.length > 0,
          () => f.control.tick(),
        );
        const extensions = f.start.mock.calls[0]![0].extensions;
        expect(extensions?.mode === 'inherit' && extensions.overrides.disable_apps).toBe(closed);
        expect(
          extensions?.mode === 'inherit' && extensions.overrides.enabled_user_connectors,
        ).toEqual(opened);
      } finally {
        await f.control.shutdown();
        vi.mocked(spawn).mockReset();
      }
    },
  );

  it('keeps the account connectors off for a project saved with the retired connector switch', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    const f = await workbenchFixture();
    try {
      const adapter = Object.assign(f.adapter, { inventory: vi.fn(async () => inventory) });
      vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
        turn_id: turn.turn_id,
        status: 'delivered',
      }));
      f.store.update(
        'projects',
        {
          ...f.project,
          extension_overrides: {
            [adapter.name]: { ...empty, enabled_user_apps: true } as ExtensionOverrides,
          },
        },
        f.project.revision,
      );
      const session = await f.create();
      await awaitWorkspaceReady(f.control, session.workspace_id!);
      await eventually(
        () => f.start.mock.calls.length > 0,
        () => f.control.tick(),
      );
      const extensions = f.start.mock.calls[0]![0].extensions;
      expect(extensions).toMatchObject({
        mode: 'inherit',
        overrides: { disable_apps: true, enabled_user_connectors: [] },
      });
    } finally {
      await f.control.shutdown();
      vi.mocked(spawn).mockReset();
    }
  });

  const mixedInventory: ExtensionInventory = {
    runtime: 'fixture',
    mcp_servers: [
      { name: 'personal-server', enabled: true, user: true },
      { name: 'repository-server', enabled: true },
    ],
    plugins: [],
    skills: [
      { id: 'personal-skill', name: 'personal-skill', enabled: true, user: true },
      { id: 'repository-skill', name: 'repository-skill', enabled: true },
    ],
    apps: true,
    connectors: [],
    hooks: [],
  };

  it.each([
    {
      name: 'a project without extension settings closes user-level',
      opened: undefined,
      disabled: { mcp_servers: ['personal-server'], skills: ['personal-skill'] },
    },
    {
      name: 'a project that opened them keeps user-level',
      opened: {
        enabled_user_mcp_servers: ['personal-server'],
        enabled_user_skills: ['personal-skill'],
      },
      disabled: { mcp_servers: [], skills: [] },
    },
  ])('$name MCP servers and skills in a worktree writer session', async ({ opened, disabled }) => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    const f = await workbenchFixture();
    try {
      const adapter = Object.assign(f.adapter, { inventory: vi.fn(async () => mixedInventory) });
      vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
        turn_id: turn.turn_id,
        status: 'delivered',
      }));
      if (opened)
        f.call(
          'project.extensions.set',
          { project_id: f.project.id, runtime: adapter.name, overrides: { ...empty, ...opened } },
          f.project.revision,
        );
      const session = await f.create();
      await awaitWorkspaceReady(f.control, session.workspace_id!);
      await eventually(
        () => f.start.mock.calls.length > 0,
        () => f.control.tick(),
      );
      const extensions = f.start.mock.calls[0]![0].extensions;
      expect(extensions).toEqual({
        mode: 'inherit',
        overrides: {
          ...empty,
          disable_apps: true,
          enabled_user_mcp_servers: opened?.enabled_user_mcp_servers ?? [],
          enabled_user_skills: opened?.enabled_user_skills ?? [],
          enabled_user_connectors: [],
        },
      });
      const applied = closeUserExtensions(
        extensions?.mode === 'inherit' ? extensions.overrides : empty,
        mixedInventory,
      );
      expect(applied.disabled_mcp_servers).toEqual(disabled.mcp_servers);
      expect(applied.disabled_skills).toEqual(disabled.skills);
    } finally {
      await f.control.shutdown();
      vi.mocked(spawn).mockReset();
    }
  });
});

function setLegacyExtensions(store: Store, project: Project) {
  store.update(
    'projects',
    {
      ...project,
      extensions: {
        fixture: {
          mcp_servers: ['legacy-server'],
          plugins: [],
          skills: [],
          apps: true,
          hooks: true,
        },
      },
    },
    project.revision,
  );
}

const spec = (runtime = 'codex', extensions?: SessionSpec['extensions']): SessionSpec => ({
  platform_session_id: 'extension-session',
  project_id: 'extension-project',
  runtime,
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  extensions,
  budget: { max_turns: 1, wall_time_ms: 10000 },
});
const privateValue = 'private-config-token-do-not-return';
const replies = {
  'account/read': { account: { type: 'chatgpt', planType: 'plus' } },
  'config/read': {
    config: {
      model_provider: 'openai',
      mcp_servers: {
        'kept-server': {
          command: 'private-command',
          args: [privateValue],
          env: { TOKEN: privateValue },
        },
        'unselected-server': {
          url: 'https://private.invalid',
          headers: { Authorization: privateValue },
        },
        'already-disabled': { command: 'private-command', enabled: false },
      },
    },
  },
  'plugin/installed': {
    marketplaces: [
      { name: 'observability', plugins: [{ name: 'tracing', enabled: true }] },
      {
        name: 'bundled',
        plugins: [
          { name: 'computer', enabled: true },
          { name: 'inactive', enabled: false },
        ],
      },
    ],
  },
  'skills/list': {
    data: [
      {
        skills: [
          { name: 'kept', path: '/skills/kept/SKILL.md', enabled: true, description: privateValue },
          {
            name: 'plugin-skill',
            path: '/skills/plugin/SKILL.md',
            enabled: true,
            pluginId: 'computer@bundled',
          },
          { name: 'inactive', path: '/skills/inactive/SKILL.md', enabled: false },
        ],
      },
    ],
  },
  'hooks/list': {
    data: [
      {
        hooks: [
          { eventName: 'SessionStart', pluginId: 'tracing@observability', command: privateValue },
          { eventName: 'Stop', pluginId: null, command: privateValue },
        ],
      },
    ],
  },
};
type Request = { id?: number; method: string; params: Record<string, unknown> };
function fakeServer(failure?: string, failureOccurrence = 1) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: Request[] = [];
  child.stdin.on('data', (data) => {
    const request = JSON.parse(String(data)) as Request;
    requests.push(request);
    if (request.id === undefined) return;
    const result =
      request.method === 'initialize'
        ? {}
        : request.method.startsWith('thread/')
          ? { thread: { id: 'extension-thread' } }
          : replies[request.method as keyof typeof replies];
    child.stdout.write(
      JSON.stringify(
        (request.method === failure &&
          requests.filter(({ method }) => method === failure).length === failureOccurrence) ||
          result === undefined
          ? { id: request.id, error: { message: privateValue } }
          : { id: request.id, result },
      ) + '\n',
    );
  });
  const close = vi.spyOn(JsonRpcProcess.prototype, 'close').mockImplementation(async function (
    this: JsonRpcProcess,
    deadline = Date.now() + 1000,
  ) {
    this.child.emit('close', 0, null);
    return {
      stopped: true,
      deadline,
      finished_at: new Date().toISOString(),
      evidence: { method: 'none', members: [] },
    };
  });
  return { child, requests, close };
}

describe('Codex extension configuration', () => {
  for (const method of ['start', 'resume'] as const) {
    it.each([
      {
        name: 'inherited',
        choice: { mode: 'inherit', overrides: empty },
        config: undefined,
        disabled: { mcp_servers: [], plugins: [], skills: [], apps: false, hooks: false },
        loaded: {
          mcp_servers: ['kept-server', 'unselected-server'],
          plugins: ['tracing@observability', 'computer@bundled'],
          skills: ['/skills/kept/SKILL.md', '/skills/plugin/SKILL.md'],
          apps: true,
          hooks: true,
        },
      },
      {
        name: 'overridden',
        choice: {
          mode: 'inherit',
          overrides: {
            ...overrides,
            disabled_mcp_servers: ['kept-server', 'plugin:computer:server'],
            disabled_plugins: ['computer@bundled', 'missing@market'],
            disabled_skills: ['/skills/kept/SKILL.md', '/skills/missing/SKILL.md'],
          },
        },
        config: {
          mcp_servers: { 'kept-server': { enabled: false } },
          plugins: { 'computer@bundled': { enabled: false } },
          skills: {
            config: [
              { path: '/skills/kept/SKILL.md', enabled: false },
              { path: '/skills/inactive/SKILL.md', enabled: false },
            ],
          },
          features: { apps: false, hooks: false },
        },
        disabled: {
          mcp_servers: ['kept-server'],
          plugins: ['computer@bundled'],
          skills: ['/skills/kept/SKILL.md'],
          apps: true,
          hooks: true,
        },
        loaded: {
          mcp_servers: ['unselected-server'],
          plugins: ['tracing@observability'],
          skills: [],
          apps: false,
          hooks: false,
        },
      },
      {
        name: 'isolated',
        choice: { mode: 'none' },
        config: {
          mcp_servers: {
            'kept-server': { enabled: false },
            'unselected-server': { enabled: false },
            'already-disabled': { enabled: false },
          },
          plugins: {
            'tracing@observability': { enabled: false },
            'computer@bundled': { enabled: false },
          },
          skills: {
            config: [
              { path: '/skills/kept/SKILL.md', enabled: false },
              { path: '/skills/plugin/SKILL.md', enabled: false },
              { path: '/skills/inactive/SKILL.md', enabled: false },
            ],
          },
          features: { apps: false, hooks: false },
        },
        disabled: {
          mcp_servers: ['kept-server', 'unselected-server', 'already-disabled'],
          plugins: ['tracing@observability', 'computer@bundled'],
          skills: ['/skills/kept/SKILL.md', '/skills/plugin/SKILL.md'],
          apps: true,
          hooks: true,
        },
        loaded: { mcp_servers: [], plugins: [], skills: [], apps: false, hooks: false },
      },
    ] as const)(
      `applies $name extensions on ${method}`,
      async ({ choice, config, disabled, loaded }) => {
        const server = fakeServer(),
          adapter = new CodexAdapter('fake-codex'),
          events: AgentEvent[] = [];
        let handle: SessionHandle | undefined;
        try {
          const input = spec('codex', structuredClone(choice) as SessionSpec['extensions']);
          handle =
            method === 'start'
              ? await adapter.start(input, (event) => events.push(event))
              : await adapter.resume(input, 'previous-thread', (event) => events.push(event));
          expect(server.requests.map((request) => request.method)).toEqual([
            'initialize',
            'initialized',
            'account/read',
            'config/read',
            'config/read',
            'plugin/installed',
            'skills/list',
            `thread/${method}`,
            ...(method === 'start' ? ['thread/name/set'] : []),
          ]);
          const params = server.requests.find(
            (request) => request.method === `thread/${method}`,
          )!.params;
          expect(params.config).toEqual(config);
          if (!config) expect(params).not.toHaveProperty('config');
          expect(params).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' });
          if (method === 'resume') expect(params.threadId).toBe('previous-thread');
          const applied = events.filter((event) => event.kind === 'extensions.applied');
          expect(applied).toEqual([
            expect.objectContaining({ mode: choice.mode, disabled, loaded }),
          ]);
          if (choice.mode === 'inherit' && choice.overrides.disabled_mcp_servers.length)
            expect(applied[0]?.not_applied).toEqual([
              { item: 'plugin:computer:server', reason: expect.stringMatching(/user-defined/) },
              { item: 'missing@market', reason: expect.stringMatching(/Unknown plugin/) },
              { item: '/skills/missing/SKILL.md', reason: expect.stringMatching(/Unknown skill/) },
            ]);
          else expect(applied[0]?.not_applied).toBeUndefined();
          expect(events.map((event) => event.provider_sequence)).toEqual(
            events.map((_, index) => index + 1),
          );
          expect(JSON.stringify(events)).not.toContain(privateValue);
        } finally {
          if (handle) await adapter.close(handle, Date.now() + 1000);
        }
      },
    );

    it(`preserves ${method} parameters when extensions are undefined`, async () => {
      const server = fakeServer(),
        adapter = new CodexAdapter('fake-codex');
      const handle =
        method === 'start'
          ? await adapter.start(spec(), () => {})
          : await adapter.resume(spec(), 'previous-thread', () => {});
      try {
        expect(server.requests.map((request) => request.method)).toEqual([
          'initialize',
          'initialized',
          'account/read',
          'config/read',
          `thread/${method}`,
          ...(method === 'start' ? ['thread/name/set'] : []),
        ]);
        expect(
          server.requests.find((request) => request.method === `thread/${method}`)?.params,
        ).not.toHaveProperty('config');
      } finally {
        await adapter.close(handle, Date.now() + 1000);
      }
    });
  }

  it('preserves user-disabled skills when a project overrides another skill', async () => {
    const server = fakeServer(),
      adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(
      spec('codex', {
        mode: 'inherit',
        overrides: {
          ...empty,
          disabled_skills: ['/skills/kept/SKILL.md'],
        },
      }),
      () => {},
    );
    try {
      expect(
        server.requests.find((request) => request.method === 'thread/start')?.params.config,
      ).toEqual({
        skills: {
          config: [
            { path: '/skills/kept/SKILL.md', enabled: false },
            { path: '/skills/inactive/SKILL.md', enabled: false },
          ],
        },
      });
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('returns only inventory identifiers and enabled states and closes its process', async () => {
    const server = fakeServer(),
      adapter = new CodexAdapter('fake-codex');
    expect(await adapter.inventory(process.cwd())).toEqual({
      runtime: 'codex',
      mcp_servers: [
        { name: 'kept-server', enabled: true },
        { name: 'unselected-server', enabled: true },
        { name: 'already-disabled', enabled: false },
      ],
      plugins: [
        { id: 'tracing@observability', enabled: true },
        { id: 'computer@bundled', enabled: true },
        { id: 'inactive@bundled', enabled: false },
      ],
      skills: [
        { id: '/skills/kept/SKILL.md', name: 'kept', path: '/skills/kept/SKILL.md', enabled: true },
        {
          id: '/skills/plugin/SKILL.md',
          name: 'plugin-skill',
          path: '/skills/plugin/SKILL.md',
          plugin: 'computer@bundled',
          enabled: true,
        },
        {
          id: '/skills/inactive/SKILL.md',
          name: 'inactive',
          path: '/skills/inactive/SKILL.md',
          enabled: false,
        },
      ],
      apps: true,
      connectors: [],
      hooks: [{ event: 'SessionStart', plugin: 'tracing@observability' }, { event: 'Stop' }],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('fails closed and preserves discovery errors', async () => {
    const server = fakeServer('config/read', 2),
      adapter = new CodexAdapter('fake-codex');
    const events: AgentEvent[] = [];
    await expect(
      adapter.start(spec('codex', { mode: 'inherit', overrides }), (event) => events.push(event)),
    ).rejects.toEqual(new Error(JSON.stringify({ message: privateValue })));
    expect(server.requests.some((request) => request.method === 'thread/start')).toBe(false);
    expect(server.close).toHaveBeenCalled();
    expect(events.some((event) => event.kind === 'extensions.applied')).toBe(false);
  });

  it('closes inventory transport and preserves hook errors', async () => {
    const server = fakeServer('hooks/list'),
      adapter = new CodexAdapter('fake-codex');
    await expect(adapter.inventory(process.cwd())).rejects.toEqual(
      new Error(JSON.stringify({ message: privateValue })),
    );
    expect(server.close).toHaveBeenCalledOnce();
  });
});

it('preserves undiscovered skill disables from effective configuration', async () => {
  const config = replies['config/read'].config;
  Object.assign(config, {
    skills: {
      config: [
        { path: '/skills/missing/SKILL.md', enabled: false },
        { path: '/skills/enabled/SKILL.md', enabled: true },
      ],
    },
  });
  const server = fakeServer(),
    adapter = new CodexAdapter('fake-codex');
  let handle: SessionHandle | undefined;
  try {
    handle = await adapter.start(spec('codex', { mode: 'inherit', overrides }), () => {});
    const skills = (
      server.requests.find((request) => request.method === 'thread/start')!.params.config as {
        skills: { config: unknown[] };
      }
    ).skills.config;
    expect(skills).toContainEqual({ path: '/skills/missing/SKILL.md', enabled: false });
  } finally {
    delete (config as Record<string, unknown>).skills;
    if (handle) await adapter.close(handle, Date.now() + 1000);
  }
});

it.each([true, false])('reports the known machine hooks switch as %s', async (enabled) => {
  const config = replies['config/read'].config;
  Object.assign(config, { features: { hooks: enabled } });
  fakeServer();
  try {
    expect(await new CodexAdapter('fake-codex').inventory(process.cwd())).toHaveProperty(
      'hooks_enabled',
      enabled,
    );
  } finally {
    delete (config as Record<string, unknown>).features;
  }
});
