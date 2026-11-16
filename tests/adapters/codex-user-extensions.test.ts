import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAdapter, JsonRpcProcess } from '@pantheon/adapters';
import {
  NATIVE_ENV_ALLOWLIST,
  type AgentEvent,
  type ExtensionOverrides,
  type SessionHandle,
  type SessionSpec,
} from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const layer = (type: 'user' | 'project') => ({
  name:
    type === 'user'
      ? { type, file: '/home/.codex/config.toml' }
      : { type, dotCodexFolder: '/repo/.codex' },
  version: '1',
});
const replies: Record<string, unknown> = {
  'account/read': { account: { type: 'chatgpt', planType: 'plus' } },
  'config/read': {
    config: {
      model_provider: 'openai',
      mcp_servers: {
        personal: { command: 'personal-command' },
        repository: { command: 'repository-command' },
      },
    },
    origins: {
      'mcp_servers.personal.command': layer('user'),
      'mcp_servers.repository.command': layer('project'),
      model_provider: layer('user'),
    },
  },
  'plugin/installed': { marketplaces: [] },
  'hooks/list': { data: [] },
  'app/list': {
    data: [
      { id: 'calendar', name: 'Calendar', isAccessible: true, isEnabled: true },
      { id: 'drive', name: 'Drive', isAccessible: true, isEnabled: false },
      { id: 'unlinked', name: 'Unlinked', isAccessible: false, isEnabled: true },
    ],
    nextCursor: null,
  },
  'skills/list': {
    data: [
      {
        skills: [
          {
            name: 'personal',
            path: '/home/.codex/skills/personal/SKILL.md',
            enabled: true,
            scope: 'user',
          },
          {
            name: 'repository',
            path: '/repo/.codex/skills/repository/SKILL.md',
            enabled: true,
            scope: 'repo',
          },
        ],
      },
    ],
  },
};

type Request = { id?: number; method: string; params: Record<string, unknown> };
function fakeServer(answers: Record<string, unknown> = replies) {
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
          ? { thread: { id: 'user-extension-thread' } }
          : answers[request.method];
    child.stdout.write(
      JSON.stringify(
        result === undefined
          ? { id: request.id, error: { message: 'unexpected request' } }
          : { id: request.id, result },
      ) + '\n',
    );
  });
  vi.spyOn(JsonRpcProcess.prototype, 'close').mockImplementation(async function (
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
  return requests;
}

const empty: ExtensionOverrides = {
  disabled_mcp_servers: [],
  disabled_plugins: [],
  disabled_skills: [],
  disable_apps: false,
  disable_hooks: false,
};
const spec = (overrides: ExtensionOverrides): SessionSpec => ({
  platform_session_id: 'user-extension-session',
  project_id: 'user-extension-project',
  runtime: 'codex',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  extensions: { mode: 'inherit', overrides },
  budget: { max_turns: 1, wall_time_ms: 10000 },
});

it('lists which Codex MCP servers and skills come from the user configuration', async () => {
  fakeServer();
  const inventory = await new CodexAdapter('fake-codex').inventory(process.cwd());
  expect(inventory.mcp_servers).toEqual([
    { name: 'personal', enabled: true, user: true },
    { name: 'repository', enabled: true },
  ]);
  expect(inventory.skills.map(({ name, user }) => ({ name, user }))).toEqual([
    { name: 'personal', user: true },
    { name: 'repository', user: undefined },
  ]);
});

it.each([
  {
    name: 'disables',
    opened: {},
    config: {
      mcp_servers: { personal: { enabled: false } },
      skills: { config: [{ path: '/home/.codex/skills/personal/SKILL.md', enabled: false }] },
    },
    disabled: { mcp_servers: ['personal'], skills: ['/home/.codex/skills/personal/SKILL.md'] },
  },
  {
    name: 'keeps',
    opened: {
      enabled_user_mcp_servers: ['personal'],
      enabled_user_skills: ['/home/.codex/skills/personal/SKILL.md'],
    },
    config: undefined,
    disabled: { mcp_servers: [], skills: [] },
  },
])(
  '$name the user-level MCP server and skill by whether the project opened them',
  async ({ opened, config, disabled }) => {
    const requests = fakeServer();
    const adapter = new CodexAdapter('fake-codex');
    const events: AgentEvent[] = [];
    let handle: SessionHandle | undefined;
    try {
      handle = await adapter.start(
        spec({ ...empty, enabled_user_mcp_servers: [], enabled_user_skills: [], ...opened }),
        (event) => events.push(event),
      );
      expect(requests.find((request) => request.method === 'thread/start')?.params.config).toEqual(
        config,
      );
      expect(events.find((event) => event.kind === 'extensions.applied')).toMatchObject({
        disabled,
      });
    } finally {
      if (handle) await adapter.close(handle, Date.now() + 1000);
    }
  },
);

it('lists the account apps Codex reports as connected', async () => {
  const requests = fakeServer();
  const inventory = await new CodexAdapter('fake-codex').inventory(process.cwd());
  expect(requests.some((request) => request.method === 'app/list')).toBe(true);
  expect(inventory.connectors).toEqual([
    { name: 'calendar', title: 'Calendar', enabled: true },
    { name: 'drive', title: 'Drive', enabled: false },
  ]);
});

it('lists no account apps when Codex cannot list them', async () => {
  const { 'app/list': _, ...answers } = replies;
  fakeServer(answers);
  const inventory = await new CodexAdapter('fake-codex').inventory(process.cwd());
  expect(inventory.connectors).toEqual([]);
  expect(inventory.mcp_servers).toHaveLength(2);
});

it('enables only the account apps the project opened', async () => {
  const requests = fakeServer();
  const adapter = new CodexAdapter('fake-codex');
  let handle: SessionHandle | undefined;
  try {
    handle = await adapter.start(
      spec({
        ...empty,
        enabled_user_mcp_servers: ['personal'],
        enabled_user_skills: ['/home/.codex/skills/personal/SKILL.md'],
        enabled_user_connectors: ['calendar'],
      }),
      () => {},
    );
    expect(requests.find((request) => request.method === 'thread/start')?.params.config).toEqual({
      apps: { _default: { enabled: false }, calendar: { enabled: true } },
    });
  } finally {
    if (handle) await adapter.close(handle, Date.now() + 1000);
  }
});
