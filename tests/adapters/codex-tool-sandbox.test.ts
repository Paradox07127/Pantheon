import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAdapter, JsonRpcProcess } from '@pantheon/adapters';
import { buildClaudeOptions } from '../../packages/adapters/src/claude.js';
import { plannerInstructions } from '../../packages/adapters/src/planner.js';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});

function writerSpec(): SessionSpec {
  const cwd = path.join(process.cwd(), 'clone');
  return {
    platform_session_id: 'sandbox-session',
    project_id: 'sandbox-project',
    runtime: 'codex',
    device_id: 'local',
    role: 'writer',
    cwd,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    extensions: {
      mode: 'inherit',
      overrides: {
        disabled_mcp_servers: ['blocked', 'absent'],
        disabled_plugins: [],
        disabled_skills: [],
        disable_apps: false,
        disable_hooks: false,
      },
    },
    sandbox: {
      writable_roots: [cwd],
      protected_entries: [
        { path: path.join(process.cwd(), 'private'), deny: 'read_write' },
        { path: path.join(process.cwd(), 'source'), deny: 'write' },
        { path: path.join(cwd, '.mcp.json'), deny: 'write' },
      ],
    },
    budget: { max_turns: 2, wall_time_ms: 10000 },
  };
}

type Frame = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
function fakeServer(activeProfile?: string | null, reviewer?: string) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const frames: Frame[] = [];
  const send = (frame: Frame) => child.stdout.write(JSON.stringify(frame) + '\n');
  const intercept = vi.fn<(frame: Frame) => boolean>();
  child.stdin.on('data', (data) => {
    const frame = JSON.parse(String(data)) as Frame;
    frames.push(frame);
    if (!frame.method || frame.id === undefined) return;
    if (intercept(frame)) return;
    let result: unknown;
    switch (frame.method) {
      case 'initialize':
      case 'turn/interrupt':
        result = {};
        break;
      case 'account/read':
        result = { account: { type: 'chatgpt' } };
        break;
      case 'config/read':
        result = {
          config: {
            mcp_servers: { kept: {}, 'with.dot': {}, blocked: {}, inactive: { enabled: false } },
          },
        };
        break;
      case 'plugin/installed':
        result = { marketplaces: [] };
        break;
      case 'mcpServerStatus/list':
        result = { data: [], nextCursor: null };
        break;
      case 'skills/list':
        result = { data: [] };
        break;
      case 'thread/name/set':
        result = {};
        break;
      case 'thread/start':
      case 'thread/resume':
        result = {
          thread: { id: 'sandbox-thread' },
          approvalsReviewer: reviewer ?? frame.params?.approvalsReviewer ?? 'auto_review',
          activePermissionProfile:
            activeProfile === null
              ? undefined
              : (frame.params?.config as Record<string, unknown> | undefined)?.default_permissions
                ? {
                    id:
                      activeProfile ??
                      (frame.params!.config as Record<string, unknown>).default_permissions,
                    extends: null,
                  }
                : null,
        };
        break;
      case 'turn/start':
        result = { turn: { id: 'native-turn' } };
        break;
      default:
        throw new Error(`Unexpected client request: ${frame.method}`);
    }
    send({ id: frame.id, result });
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
  return { frames, send, close, intercept, child };
}

async function opened(spec = writerSpec(), method: 'start' | 'resume' = 'start') {
  const server = fakeServer();
  const adapter = new CodexAdapter('fake-codex');
  const events: AgentEvent[] = [];
  const handle =
    method === 'start'
      ? await adapter.start(spec, (event) => events.push(event))
      : await adapter.resume(spec, 'sandbox-thread', (event) => events.push(event));
  cleanup.push(() => adapter.close(handle, Date.now() + 1000));
  return { ...server, adapter, handle, events, spec };
}

function threadParams(frames: Frame[]) {
  return frames.find((frame) => frame.method?.startsWith('thread/'))!.params!;
}
function filesystem(params: Record<string, unknown>) {
  expect(params).not.toHaveProperty('permissions');
  const name = (params.config as Record<string, unknown>).default_permissions as string;
  expect(name).toEqual(expect.any(String));
  expect(name).not.toContain('.');
  const config = params.config as Record<string, { filesystem: Record<string, string> }>;
  return config[`permissions.${name}`]!.filesystem;
}

it.each(['start', 'resume'] as const)(
  'gives a planner a protected read-only profile and planning instructions on %s',
  async (method) => {
    const spec = writerSpec();
    spec.role = 'planner';
    spec.sandbox!.writable_roots = [];
    spec.pantheon_mcp = { command: 'fake-mcp', args: [], env: {} };
    const f = await opened(spec, method);
    const params = threadParams(f.frames);
    expect.soft(params.approvalPolicy).toBe('never');
    expect.soft(params.developerInstructions).toBe(plannerInstructions(spec));
    expect(params).not.toHaveProperty('sandbox');
    expect(params.approvalsReviewer).toBe('user');
    expect(filesystem(params)).toEqual({
      ':root': 'read',
      ...Object.fromEntries(
        spec.sandbox!.protected_entries.map((entry) => [
          entry.path,
          entry.deny === 'read_write' ? 'deny' : 'read',
        ]),
      ),
    });
    expect(Object.values(filesystem(params))).not.toContain('write');
    expect(params.config).toMatchObject({
      mcp_servers: { pantheon: { enabled: true, default_tools_approval_mode: 'approve' } },
    });
  },
);

it.each([
  [['rerun_baseline'], { tools: { rerun_baseline: { approval_mode: 'prompt' } } }],
  [[], {}],
  [undefined, {}],
] as const)(
  'prompts for the Pantheon tools %j asks for and approves the rest',
  async (ask, extra) => {
    const spec = writerSpec();
    spec.pantheon_mcp = {
      command: 'fake-mcp',
      args: [],
      env: {},
      ...(ask ? { ask_tools: [...ask] } : {}),
    };
    const f = await opened(spec);
    const config = threadParams(f.frames).config as { mcp_servers: Record<string, unknown> };
    expect(config.mcp_servers.pantheon).toEqual({
      command: 'fake-mcp',
      args: [],
      env: {},
      enabled: true,
      default_tools_approval_mode: 'approve',
      ...extra,
    });
  },
);

it('enables the MCP servers a session names next to the Pantheon server', async () => {
  const spec = writerSpec();
  spec.pantheon_mcp = { command: 'fake-mcp', args: [], env: {} };
  spec.mcp_servers = [
    { name: 'chrome_devtools', command: 'npx', args: ['-y', 'devtools'], env: { A: '1' } },
  ];
  const f = await opened(spec);
  const config = threadParams(f.frames).config as { mcp_servers: Record<string, unknown> };
  expect(config.mcp_servers.pantheon).toMatchObject({ enabled: true });
  expect(config.mcp_servers.chrome_devtools).toEqual({
    command: 'npx',
    args: ['-y', 'devtools'],
    env: { A: '1' },
    enabled: true,
  });
});

it.each(['start', 'resume'] as const)(
  'gives a reviewer a read-only permission profile with hidden paths on %s',
  async (method) => {
    const spec = writerSpec();
    spec.role = 'reviewer';
    spec.extensions = { mode: 'none' };
    spec.sandbox!.writable_roots = [];
    spec.sandbox!.protected_entries.push({ path: spec.cwd, deny: 'write' });
    const f = await opened(spec, method);
    const params = threadParams(f.frames);
    expect(params).not.toHaveProperty('sandbox');
    expect(params).not.toHaveProperty('sandboxPolicy');
    expect(params.approvalsReviewer).toBe('user');
    expect(params.developerInstructions).not.toMatch(/text protocol probe|Do not use tools/);
    expect(filesystem(params)).toEqual({
      ':root': 'read',
      ...Object.fromEntries(
        spec.sandbox!.protected_entries.map((entry) => [
          entry.path,
          entry.deny === 'read_write' ? 'deny' : 'read',
        ]),
      ),
    });
    expect(Object.values(filesystem(params))).not.toContain('write');
    expect(params.config).toMatchObject({
      mcp_servers: {
        kept: { enabled: false },
        'with.dot': { enabled: false },
        blocked: { enabled: false },
        inactive: { enabled: false },
      },
      features: { apps: false, hooks: false },
    });
  },
);

it.each(['start', 'resume'] as const)(
  'keeps a plan mode writer on a read-only profile with plan instructions on %s',
  async (method) => {
    const spec = writerSpec();
    spec.permission_mode = 'plan';
    spec.control_instructions = 'Work in the worktree.';
    const f = await opened(spec, method);
    const params = threadParams(f.frames);
    expect(params.approvalPolicy).toBe('on-request');
    expect(params.developerInstructions).toMatch(
      /Work in the worktree\.\n\nPlan mode is on: read and plan only, then call ExitPlanMode with the plan\.$/,
    );
    expect(filesystem(params)).toEqual({
      ':root': 'read',
      [spec.cwd]: 'read',
      [path.join(spec.cwd, '.git')]: 'read',
      [path.join(spec.cwd, '.git/hooks')]: 'read',
      [path.join(spec.cwd, '.git/config')]: 'read',
      [path.join(process.cwd(), 'private')]: 'deny',
      [path.join(process.cwd(), 'source')]: 'read',
      [path.join(spec.cwd, '.mcp.json')]: 'read',
    });
  },
);

it.each(['ask', 'auto_edit'] as const)(
  'keeps the writable writer profile in %s mode',
  async (mode) => {
    const spec = writerSpec();
    spec.permission_mode = mode;
    const f = await opened(spec);
    const params = threadParams(f.frames);
    expect(filesystem(params)[spec.cwd]).toBe('write');
    expect(params.developerInstructions).not.toContain('Plan mode');
  },
);

describe('Codex writer sandbox', () => {
  it('gives a device session no entries under .git, which is a file in the device worktree', async () => {
    const spec = writerSpec();
    spec.device_id = 'build-box';
    spec.remote = { transport: ['/bin/sh', '-c'], binary: '/device/bin/codex' };
    spec.cwd = '/device/w';
    spec.sandbox = {
      writable_roots: ['/device/w', '/device/tmp'],
      protected_entries: [{ path: '/device/w/.git', deny: 'write' }],
    };
    const f = await opened(spec);
    expect(filesystem(threadParams(f.frames))).toEqual({
      ':root': 'read',
      '/device/w': 'write',
      '/device/tmp': 'write',
      '/device/w/.git': 'read',
    });
  });

  for (const method of ['start', 'resume'] as const) {
    it(`configures a writer on ${method}`, async () => {
      const spec = writerSpec();
      const f = await opened(spec, method);
      expect(f.frames[0]).toMatchObject({
        method: 'initialize',
        params: { capabilities: { experimentalApi: true } },
      });
      const params = threadParams(f.frames);
      expect(params.approvalPolicy).toBe('on-request');
      expect(params).not.toHaveProperty('sandbox');
      expect(params.approvalsReviewer).toBe('user');
      expect(params).not.toHaveProperty('sandboxPolicy');
      expect(params.developerInstructions).toBe(
        'Use tools inside the Pantheon permission profile. Do not request permissions outside the sandbox.',
      );
      expect(filesystem(params)).toEqual({
        ':root': 'read',
        [spec.cwd]: 'write',
        [path.join(spec.cwd, '.git')]: 'write',
        [path.join(spec.cwd, '.git/hooks')]: 'read',
        [path.join(spec.cwd, '.git/config')]: 'read',
        [path.join(process.cwd(), 'private')]: 'deny',
        [path.join(process.cwd(), 'source')]: 'read',
        [path.join(spec.cwd, '.mcp.json')]: 'read',
      });
      expect(params.config).toMatchObject({
        mcp_servers: {
          kept: { default_tools_approval_mode: 'prompt' },
          'with.dot': { default_tools_approval_mode: 'prompt' },
          blocked: { enabled: false },
        },
      });
      const servers = (params.config as { mcp_servers: Record<string, unknown> }).mcp_servers;
      expect(servers).not.toHaveProperty('inactive');
      expect(servers).not.toHaveProperty('absent');
      expect(servers.blocked).toEqual({ enabled: false });
      if (method === 'resume') expect(params.threadId).toBe('sandbox-thread');
      await f.adapter.send(f.handle, {
        turn_id: 'sandbox-turn',
        input: 'edit a file',
      });
      const turn = f.frames.find((frame) => frame.method === 'turn/start')!.params!;
      expect(turn).not.toHaveProperty('sandboxPolicy');
      expect(turn).not.toHaveProperty('sandbox');
    });

    it(`preserves text-only parameters on ${method}`, async () => {
      const spec = writerSpec();
      delete spec.sandbox;
      delete spec.extensions;
      const f = await opened(spec, method);
      expect(f.frames[0]?.params).toEqual({
        clientInfo: {
          name: 'pantheon',
          title: 'Pantheon',
          version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
            .version,
        },
        capabilities: { experimentalApi: false },
      });
      expect(threadParams(f.frames)).toEqual({
        cwd: spec.cwd,
        modelProvider: 'openai',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        serviceTier: 'default',
        developerInstructions:
          'This is a bounded Pantheon text protocol probe. Do not use tools or access files. Respond to the user text only.',
        ...(method === 'resume' ? { threadId: 'sandbox-thread' } : {}),
      });
    });
  }

  it('inherits MCP approval prompts even without extension overrides', async () => {
    const spec = writerSpec();
    delete spec.extensions;
    const f = await opened(spec);
    expect(threadParams(f.frames).config).toMatchObject({
      mcp_servers: {
        kept: { default_tools_approval_mode: 'prompt' },
        'with.dot': { default_tools_approval_mode: 'prompt' },
        blocked: { default_tools_approval_mode: 'prompt' },
      },
    });
  });

  it('does not set MCP approval prompts when extensions are disabled', async () => {
    const spec = writerSpec();
    spec.extensions = { mode: 'none' };
    const f = await opened(spec);
    expect(threadParams(f.frames).config).toMatchObject({
      mcp_servers: {
        kept: { enabled: false },
        'with.dot': { enabled: false },
        blocked: { enabled: false },
        inactive: { enabled: false },
      },
      features: { apps: false, hooks: false },
    });
    expect(JSON.stringify(threadParams(f.frames).config)).not.toContain(
      'default_tools_approval_mode',
    );
  });

  it('never reopens a protected path through overlapping roots or entries', async () => {
    const spec = writerSpec();
    const privateRoot = path.join(spec.cwd, 'private');
    const readOnly = path.join(spec.cwd, 'read-only');
    spec.sandbox!.writable_roots.push(path.join(privateRoot, 'nested'), readOnly);
    spec.sandbox!.protected_entries.push(
      { path: privateRoot, deny: 'read_write' },
      { path: privateRoot, deny: 'write' },
      { path: path.join(privateRoot, 'child'), deny: 'write' },
      { path: readOnly, deny: 'write' },
      { path: path.join(spec.cwd, '.git/config'), deny: 'read_write' },
    );
    const f = await opened(spec);
    const entries = filesystem(threadParams(f.frames));
    expect(entries[privateRoot]).toBe('deny');
    for (const [target, access] of Object.entries(entries)) {
      if (target.startsWith(`${privateRoot}/`)) expect(access).toBe('deny');
      if (target === readOnly || target.startsWith(`${readOnly}/`)) expect(access).toBe('read');
    }
    expect(entries[path.join(spec.cwd, '.git/config')]).toBe('deny');
  });

  it('lists nothing inside a denied path', async () => {
    const spec = writerSpec();
    const state = path.join(process.cwd(), 'state');
    spec.sandbox!.protected_entries.push(
      { path: state, deny: 'read_write' },
      { path: path.join(state, 'native-sessions'), deny: 'read_write' },
      { path: path.join(state, 'notes'), deny: 'write' },
    );
    const entries = filesystem(threadParams((await opened(spec)).frames));
    expect(entries[state]).toBe('deny');
    expect(Object.keys(entries).filter((target) => target.startsWith(`${state}/`))).toEqual([]);
  });

  it('keeps a linked worktree .git file read-only and lists nothing below it', async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'pantheon-codex-worktree-'));
    cleanup.push(() => rm(worktree, { recursive: true, force: true }));
    await writeFile(path.join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/one\n');
    const spec = writerSpec();
    spec.sandbox!.writable_roots.push(worktree);
    const entries = filesystem(threadParams((await opened(spec)).frames));
    expect(entries[worktree]).toBe('write');
    expect(entries[path.join(worktree, '.git')]).toBe('read');
    expect(Object.keys(entries).filter((target) => target.startsWith(`${worktree}/.git/`))).toEqual(
      [],
    );
  });

  it('denies a task writer reading other worktrees, native session records and reviews', async () => {
    const spec = writerSpec();
    const home = path.join(process.cwd(), 'home'),
      codexHome = path.join(process.cwd(), 'codex');
    const hidden = [
      path.join(process.cwd(), 'other-worktree'),
      path.join(home, '.claude/projects'),
      path.join(codexHome, 'sessions'),
      path.join(process.cwd(), 'managed/project/reviews'),
    ];
    spec.sandbox!.protected_entries.push(
      { path: path.join(home, '.claude'), deny: 'write' },
      { path: codexHome, deny: 'write' },
      ...hidden.map((target) => ({ path: target, deny: 'read_write' as const })),
    );
    const f = await opened(spec);
    const entries = filesystem(threadParams(f.frames));
    for (const target of hidden) expect(entries[target]).toBe('deny');
    expect(entries[codexHome]).toBe('read');
    expect(entries[spec.cwd]).toBe('write');
  });

  it('fails a start whose approvals are still reviewed by a Codex agent', async () => {
    const server = fakeServer(undefined, 'auto_review');
    const events: AgentEvent[] = [];
    await expect(
      new CodexAdapter('fake-codex').start(writerSpec(), (event) => events.push(event)),
    ).rejects.toThrow();
    expect(server.close).toHaveBeenCalled();
    expect(events.some((event) => event.kind === 'session.started')).toBe(false);
  });

  it.each([
    ['start', 'unexpected-profile'],
    ['resume', 'unexpected-profile'],
    ['start', null],
  ] as const)(
    'fails %s if the server reports profile %s instead of the requested one',
    async (method, reported) => {
      const server = fakeServer(reported);
      const adapter = new CodexAdapter('fake-codex');
      const events: AgentEvent[] = [];
      const starting =
        method === 'start'
          ? adapter.start(writerSpec(), (event) => events.push(event))
          : adapter.resume(writerSpec(), 'sandbox-thread', (event) => events.push(event));
      await expect(starting).rejects.toThrow();
      expect(server.close).toHaveBeenCalled();
      expect(events.some((event) => event.kind === 'session.started')).toBe(false);
    },
  );
});

describe('Codex read-only lead turns', () => {
  const turnStarts = (frames: Frame[]) =>
    frames.filter((frame) => frame.method === 'turn/start').map((frame) => frame.params!);

  it.each(['start', 'resume'] as const)(
    'selects the read-only profile for a read-only turn and the writer profile after it on %s',
    async (method) => {
      const spec = writerSpec();
      const f = await opened(spec, method);
      const params = threadParams(f.frames);
      const writer = (params.config as Record<string, unknown>).default_permissions as string;
      const readOnly = `${writer}_read`;
      const config = params.config as Record<string, { filesystem: Record<string, string> }>;
      expect(config[`permissions.${readOnly}`]!.filesystem).toEqual({
        ...filesystem(params),
        [spec.cwd]: 'read',
        [path.join(spec.cwd, '.git')]: 'read',
      });

      // Turns that never change the profile leave the field out, as before read-only turns existed.
      await f.adapter.send(f.handle, { turn_id: 'first-turn', input: 'look' });
      expect(turnStarts(f.frames).at(-1)).not.toHaveProperty('permissions');
      completed(f.send);
      await vi.waitFor(() =>
        expect(f.events.filter((event) => event.kind === 'turn.completed')).toHaveLength(1),
      );

      await f.adapter.send(f.handle, { turn_id: 'lead-turn', input: 'plan', read_only: true });
      expect(turnStarts(f.frames).at(-1)).toMatchObject({ permissions: readOnly });
      f.send(requestFrame(fileApproval, fileParams));
      expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } });
      expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
      completed(f.send);
      await vi.waitFor(() =>
        expect(f.events.filter((event) => event.kind === 'turn.completed')).toHaveLength(2),
      );

      await f.adapter.send(f.handle, { turn_id: 'next-turn', input: 'do it' });
      expect(turnStarts(f.frames)).toHaveLength(3);
      expect(turnStarts(f.frames).at(-1)).toMatchObject({ permissions: writer });
    },
  );

  it('declines file changes of a running turn once it is made read-only', async () => {
    const f = await opened(writerSpec(), 'start');
    await f.adapter.send(f.handle, { turn_id: 'lead-turn', input: 'plan' });
    f.adapter.setTurnReadOnly(f.handle, true);
    f.send(requestFrame(fileApproval, fileParams));
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });
});

type Reply = (response: { result: unknown } | { error: { code: number; message: string } }) => void;

describe('Codex inherited MCP approval policies', () => {
  for (const method of ['start', 'resume'] as const) {
    it.each(['writer', 'reviewer'] as const)(
      `prompts for plugin and app tools on ${method} for a %s`,
      async (role) => {
        const spec = writerSpec();
        spec.role = role;
        if (role === 'reviewer') spec.sandbox!.writable_roots = [];
        const server = fakeServer();
        server.intercept.mockImplementation((frame) => {
          let result: unknown;
          if (frame.method === 'config/read')
            result = {
              config: {
                mcp_servers: {
                  kept: { tools: { read: { approval_mode: 'approve' } } },
                },
                plugins: {
                  'toolbox@market': {
                    mcp_servers: {
                      'plugin.docs': {
                        tools: { hidden: { approval_mode: 'approve' } },
                        enabled_tools: ['read', 'hidden'],
                      },
                    },
                  },
                },
                apps: {
                  _default: {
                    enabled: false,
                    approvals_reviewer: 'auto_review',
                    default_tools_approval_mode: 'approve',
                  },
                  drive: {
                    enabled: false,
                    approvals_reviewer: 'auto_review',
                    default_tools_approval_mode: 'approve',
                    tools: { read: { approval_mode: 'approve', enabled: false } },
                    links: {
                      'personal.account': {
                        approvals_reviewer: 'auto_review',
                        default_tools_approval_mode: 'approve',
                      },
                    },
                  },
                },
              },
            };
          else if (frame.method === 'plugin/installed')
            result = {
              marketplaces:
                role === 'reviewer'
                  ? []
                  : [{ name: 'market', plugins: [{ name: 'toolbox', enabled: true }] }],
            };
          else if (frame.method === 'plugin/read')
            result = { plugin: { mcpServers: ['plugin.docs', 'plugin.extra', 'project.only'] } };
          else if (frame.method === 'mcpServerStatus/list')
            result = frame.params?.cursor
              ? {
                  data: [
                    {
                      name: 'plugin.extra',
                      pluginId: 'toolbox@market',
                      tools: {
                        qualified: { name: 'search' },
                      },
                    },
                  ],
                  nextCursor: null,
                }
              : {
                  data: [
                    {
                      name: 'kept',
                      pluginId: 'toolbox@market',
                      tools: {},
                      toolsError: 'shadowed server',
                    },
                    {
                      name: 'plugin.docs',
                      pluginId: 'toolbox@market',
                      tools: {
                        qualified: { name: 'read' },
                        outside: { name: 'outside-allowlist' },
                      },
                    },
                  ],
                  nextCursor: 'next-page',
                };
          else return false;
          server.send({ id: frame.id, result });
          return true;
        });
        const adapter = new CodexAdapter('fake-codex');
        const events: AgentEvent[] = [];
        const handle =
          method === 'start'
            ? await adapter.start(spec, (event) => events.push(event))
            : await adapter.resume(spec, 'sandbox-thread', (event) => events.push(event));
        cleanup.push(() => adapter.close(handle, Date.now() + 1000));
        const config = threadParams(server.frames).config;
        expect(config).toMatchObject({
          mcp_servers: {
            kept: {
              default_tools_approval_mode: 'prompt',
              tools: { read: { approval_mode: 'prompt' } },
            },
          },
          // A reviewer runs without plugins, so it declares no plugin servers to list.
          ...(role === 'writer'
            ? {
                plugins: {
                  'toolbox@market': {
                    mcp_servers: {
                      'plugin.docs': {
                        default_tools_approval_mode: 'prompt',
                        enabled_tools: ['read'],
                        tools: {
                          read: { approval_mode: 'prompt' },
                          hidden: { approval_mode: 'prompt' },
                        },
                      },
                      'plugin.extra': {
                        default_tools_approval_mode: 'prompt',
                        enabled_tools: ['search'],
                        tools: { search: { approval_mode: 'prompt' } },
                      },
                      'project.only': { enabled: false },
                    },
                  },
                },
              }
            : {}),
          apps: {
            _default: { approvals_reviewer: 'user', default_tools_approval_mode: 'prompt' },
            drive: {
              approvals_reviewer: 'user',
              default_tools_approval_mode: 'prompt',
              tools: { read: { approval_mode: 'prompt' } },
              links: {
                'personal.account': {
                  approvals_reviewer: 'user',
                  default_tools_approval_mode: 'prompt',
                },
              },
            },
          },
        });
        if (role === 'writer') {
          expect(server.frames.find((frame) => frame.method === 'plugin/read')?.params).toEqual({
            remoteMarketplaceName: 'market',
            pluginName: 'toolbox',
          });
          expect(events.find((event) => event.kind === 'extensions.applied')).toMatchObject({
            disabled: { mcp_servers: ['project.only'] },
          });
        }
        expect(JSON.stringify(config)).not.toContain('"enabled":true');
        expect(
          server.frames
            .filter((frame) => frame.method === 'mcpServerStatus/list')
            .map((frame) => frame.params),
        ).toEqual(
          role === 'writer'
            ? [undefined, 'next-page'].flatMap((cursor) =>
                ['plugin.docs', 'plugin.extra', 'project.only'].map((serverName) => ({
                  detail: 'toolsAndAuthOnly',
                  serverName,
                  ...(cursor ? { cursor } : {}),
                })),
              )
            : [],
        );
        await adapter.send(handle, {
          turn_id: 'sandbox-turn',
          input: 'read documents',
        });
        for (const name of ['plugin.docs', 'codex_apps']) {
          for (const decision of ['allow', 'deny'] as const) {
            const before = events.length;
            const requestId = `${name}-${decision}`;
            server.send(requestFrame(mcpApproval, { ...mcpParams, serverName: name }, requestId));
            expect(server.frames.some((frame) => frame.id === requestId)).toBe(false);
            const request = permission(events.slice(before));
            expect(request.tool).toBe(`${name}.read`);
            await adapter.answerPermission(handle, request.request_id, decision);
            expect(server.frames.at(-1)).toEqual({
              id: requestId,
              result: { action: decision === 'allow' ? 'accept' : 'decline' },
            });
          }
        }
      },
    );
  }

  it('lists only the declared plugin servers so a huge user server catalog cannot close the session', async () => {
    const server = fakeServer();
    server.intercept.mockImplementation((frame) => {
      let result: unknown;
      if (frame.method === 'plugin/installed')
        result = {
          marketplaces: [{ name: 'market', plugins: [{ name: 'toolbox', enabled: true }] }],
        };
      else if (frame.method === 'plugin/read') result = { plugin: { mcpServers: ['plugin.docs'] } };
      else if (frame.method === 'mcpServerStatus/list')
        result = frame.params?.serverName
          ? {
              data: [
                {
                  name: 'plugin.docs',
                  pluginId: 'toolbox@market',
                  tools: { read: { name: 'read' } },
                },
              ],
              nextCursor: null,
            }
          : {
              data: [
                {
                  name: 'user.huge',
                  tools: {
                    query: {
                      name: 'query',
                      outputSchema: { description: 'x'.repeat(5 * 1024 * 1024) },
                    },
                  },
                },
              ],
              nextCursor: null,
            };
      else return false;
      server.send({ id: frame.id, result });
      return true;
    });
    const adapter = new CodexAdapter('fake-codex');
    const events: AgentEvent[] = [];
    const handle = await adapter.start(writerSpec(), (event) => events.push(event));
    cleanup.push(() => adapter.close(handle, Date.now() + 1000));
    expect(events.some((event) => event.kind === 'runtime.disconnected')).toBe(false);
    const listed = server.frames.filter((frame) => frame.method === 'mcpServerStatus/list');
    expect(listed.map((frame) => frame.params?.serverName)).toEqual(['plugin.docs']);
    expect(threadParams(server.frames).config).toMatchObject({
      plugins: {
        'toolbox@market': {
          mcp_servers: { 'plugin.docs': { default_tools_approval_mode: 'prompt' } },
        },
      },
    });
  });

  it('disables and records plugin servers whose tools cannot be discovered', async () => {
    const server = fakeServer();
    server.intercept.mockImplementation((frame) => {
      let result: unknown;
      if (frame.method === 'plugin/installed')
        result = {
          marketplaces: [{ name: 'market', plugins: [{ name: 'toolbox', enabled: true }] }],
        };
      else if (frame.method === 'plugin/read') result = { plugin: { mcpServers: ['unavailable'] } };
      else if (frame.method === 'mcpServerStatus/list')
        result = {
          data: [
            {
              name: 'unavailable',
              pluginId: 'toolbox@market',
              tools: {},
              toolsError: 'catalog unavailable',
            },
          ],
          nextCursor: null,
        };
      else return false;
      server.send({ id: frame.id, result });
      return true;
    });
    const spec = writerSpec();
    delete spec.extensions;
    const adapter = new CodexAdapter('fake-codex');
    const events: AgentEvent[] = [];
    const handle = await adapter.start(spec, (event) => events.push(event));
    cleanup.push(() => adapter.close(handle, Date.now() + 1000));
    expect(threadParams(server.frames).config).toMatchObject({
      plugins: { 'toolbox@market': { mcp_servers: { unavailable: { enabled: false } } } },
    });
    expect(events.find((event) => event.kind === 'extensions.applied')).toMatchObject({
      mode: 'inherit',
      disabled: { mcp_servers: ['unavailable'] },
    });
  });

  it('disables a plugin whose details cannot be read and still starts the session', async () => {
    const server = fakeServer();
    server.intercept.mockImplementation((frame) => {
      if (frame.method === 'plugin/installed')
        server.send({
          id: frame.id,
          result: {
            marketplaces: [
              {
                name: 'market',
                plugins: [
                  { name: 'toolbox', enabled: true },
                  { name: 'gone', enabled: true },
                ],
              },
            ],
          },
        });
      else if (frame.method === 'plugin/read')
        server.send(
          (frame.params as { pluginName: string }).pluginName === 'gone'
            ? { id: frame.id, error: { code: -32600, message: 'Plugin not found' } }
            : { id: frame.id, result: { plugin: { mcpServers: ['quiet'] } } },
        );
      else if (frame.method === 'config/read')
        server.send({
          id: frame.id,
          result: { config: { mcp_servers: { bare: null }, apps: { calendar: null } } },
        });
      else if (frame.method === 'mcpServerStatus/list')
        server.send({
          id: frame.id,
          result: {
            data: [{ name: 'quiet', pluginId: 'toolbox@market', tools: null }],
            nextCursor: null,
          },
        });
      else return false;
      return true;
    });
    const spec = writerSpec();
    delete spec.extensions;
    const adapter = new CodexAdapter('fake-codex');
    const events: AgentEvent[] = [];
    const handle = await adapter.start(spec, (event) => events.push(event));
    cleanup.push(() => adapter.close(handle, Date.now() + 1000));
    expect(threadParams(server.frames).config).toMatchObject({
      plugins: { 'gone@market': { enabled: false } },
    });
    expect(threadParams(server.frames).config).toMatchObject({
      plugins: { 'toolbox@market': { mcp_servers: { quiet: { enabled: false } } } },
    });
    expect(events.find((event) => event.kind === 'extensions.applied')).toMatchObject({
      disabled: { plugins: ['gone@market'], mcp_servers: ['quiet'] },
    });
  });

  it('writes whether each account app is enabled and enables only the opened ones', async () => {
    const server = fakeServer();
    server.intercept.mockImplementation((frame) => {
      if (frame.method !== 'config/read') return false;
      server.send({
        id: frame.id,
        result: {
          config: {
            apps: {
              _default: { approvals_reviewer: 'auto_review' },
              drive: { tools: { read: { approval_mode: 'approve' } } },
              mail: { enabled: false },
            },
          },
        },
      });
      return true;
    });
    const spec = writerSpec();
    if (spec.extensions?.mode === 'inherit')
      spec.extensions.overrides.enabled_user_connectors = ['mail', 'calendar'];
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(spec, () => {});
    cleanup.push(() => adapter.close(handle, Date.now() + 1000));
    const policy = { approvals_reviewer: 'user', default_tools_approval_mode: 'prompt' };
    expect((threadParams(server.frames).config as Record<string, unknown>).apps).toEqual({
      _default: { ...policy, enabled: false },
      drive: { ...policy, enabled: false, tools: { read: { approval_mode: 'prompt' } } },
      mail: { ...policy, enabled: true },
      calendar: { ...policy, enabled: true },
    });
  });

  it('keeps each account app as the user set it when the session lists no opened apps', async () => {
    const server = fakeServer();
    server.intercept.mockImplementation((frame) => {
      if (frame.method !== 'config/read') return false;
      server.send({
        id: frame.id,
        result: { config: { apps: { _default: { enabled: false }, drive: {}, mail: null } } },
      });
      return true;
    });
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(writerSpec(), () => {});
    cleanup.push(() => adapter.close(handle, Date.now() + 1000));
    const config = threadParams(server.frames).config as Record<string, unknown>;
    const apps = config.apps as Record<string, { enabled?: unknown }>;
    expect(Object.fromEntries(Object.entries(apps).map(([id, app]) => [id, app.enabled]))).toEqual({
      _default: false,
      drive: true,
      mail: true,
    });
  });

  it('does not start a tool session when plugin server discovery fails', async () => {
    const server = fakeServer();
    server.intercept.mockImplementation((frame) => {
      if (frame.method === 'plugin/installed')
        server.send({
          id: frame.id,
          result: {
            marketplaces: [{ name: 'market', plugins: [{ name: 'toolbox', enabled: true }] }],
          },
        });
      else if (frame.method === 'plugin/read')
        server.send({ id: frame.id, result: { plugin: { mcpServers: ['unavailable'] } } });
      else if (frame.method === 'mcpServerStatus/list')
        server.send({
          id: frame.id,
          error: { code: -32001, message: 'MCP inventory unavailable' },
        });
      else return false;
      return true;
    });
    await expect(new CodexAdapter('fake-codex').start(writerSpec(), () => {})).rejects.toThrow(
      'MCP inventory unavailable',
    );
    expect(server.frames.some((frame) => frame.method?.startsWith('thread/'))).toBe(false);
    expect(server.close).toHaveBeenCalled();
  });
  it('waits past the default request timeout while Codex starts MCP servers to list their tools', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const server = fakeServer();
      const listed = Promise.withResolvers<string | number>();
      server.intercept.mockImplementation((frame) => {
        if (frame.method === 'plugin/installed')
          server.send({
            id: frame.id,
            result: {
              marketplaces: [{ name: 'market', plugins: [{ name: 'toolbox', enabled: true }] }],
            },
          });
        else if (frame.method === 'plugin/read')
          server.send({ id: frame.id, result: { plugin: { mcpServers: ['slow'] } } });
        else if (frame.method === 'mcpServerStatus/list') listed.resolve(frame.id!);
        else return false;
        return true;
      });
      const adapter = new CodexAdapter('fake-codex');
      const started = adapter.start(writerSpec(), () => {});
      started.catch(() => {});
      const id = await listed.promise;
      await vi.advanceTimersByTimeAsync(20_000);
      server.send({ id, result: { data: [], nextCursor: null } });
      const handle = await started;
      cleanup.push(() => adapter.close(handle, Date.now() + 1000));
      expect(server.frames.some((frame) => frame.method === 'thread/start')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Codex skill overrides', () => {
  const skills = [
    { name: 'adopt-github-project', path: '/skills/user/adopt-github-project/SKILL.md' },
    { name: 'adopt-github-project', path: '/skills/repo/adopt-github-project/SKILL.md' },
    { name: 'release-notes', path: '/skills/user/release-notes/SKILL.md' },
  ];
  async function applied(disabledSkills: string[]) {
    const server = fakeServer();
    server.intercept.mockImplementation((frame) => {
      if (frame.method !== 'skills/list') return false;
      server.send({
        id: frame.id,
        result: { data: [{ skills: skills.map((skill) => ({ ...skill, enabled: true })) }] },
      });
      return true;
    });
    const spec = writerSpec();
    spec.extensions = {
      mode: 'inherit',
      overrides: {
        disabled_mcp_servers: [],
        disabled_plugins: [],
        disabled_skills: disabledSkills,
        disable_apps: false,
        disable_hooks: false,
      },
    };
    const adapter = new CodexAdapter('fake-codex');
    const events: AgentEvent[] = [];
    const handle = await adapter.start(spec, (event) => events.push(event));
    cleanup.push(() => adapter.close(handle, Date.now() + 1000));
    const event = events.find((item) => item.kind === 'extensions.applied') as
      (AgentEvent & { disabled: { skills: string[] }; not_applied?: unknown }) | undefined;
    return { event: event!, config: threadParams(server.frames).config };
  }

  it('disables every skill whose name matches and passes their paths to Codex', async () => {
    const { event, config } = await applied(['adopt-github-project']);
    expect(event.disabled.skills).toEqual([skills[0]!.path, skills[1]!.path]);
    expect(event.not_applied).toBeUndefined();
    expect(config).toMatchObject({
      skills: {
        config: [
          { path: skills[0]!.path, enabled: false },
          { path: skills[1]!.path, enabled: false },
        ],
      },
    });
  });

  it('still disables a skill by its path id', async () => {
    const { event } = await applied([skills[2]!.path]);
    expect(event.disabled.skills).toEqual([skills[2]!.path]);
    expect(event.not_applied).toBeUndefined();
  });

  it('reports a skill that matches neither an id nor a name as not applied', async () => {
    const { event } = await applied(['missing-skill']);
    expect(event.disabled.skills).toEqual([]);
    expect(event.not_applied).toEqual([{ item: 'missing-skill', reason: 'Unknown skill id' }]);
  });
});

describe('JSON-RPC server request opt-in', () => {
  it('rejects requests by default and permits deferred replies only after opt-in', async () => {
    const server = fakeServer();
    const rpc = new JsonRpcProcess('fake-codex', ['app-server']);
    cleanup.push(() => rpc.close());
    const denied = vi.fn();
    rpc.on('deniedRequest', denied);
    await rpc.initialize();
    const frame = { id: 0, method: 'server/probe', params: { value: 'input' } };
    server.send(frame);
    expect(server.frames.at(-1)).toEqual({
      id: 0,
      error: { code: -32601, message: 'Pantheon has not granted this server request' },
    });
    expect(denied).toHaveBeenCalledWith(frame);

    const incoming: { frame: Frame; reply: Reply }[] = [];
    const receive = (frame: Frame, reply: Reply) => incoming.push({ frame, reply });
    rpc.on('request', receive);
    const before = server.frames.length;
    for (const id of [0, '0', 2]) server.send({ ...frame, id });
    expect(server.frames).toHaveLength(before);
    expect(incoming.map(({ frame }) => frame.id)).toEqual([0, '0', 2]);
    // A server request must not steal a client response with the same id.
    await expect(rpc.request('account/read')).resolves.toEqual({ account: { type: 'chatgpt' } });
    incoming[2]!.reply({ result: {} });
    incoming[1]!.reply({ error: { code: -32601, message: 'Unknown method' } });
    incoming[0]!.reply({ result: { accepted: true } });
    incoming[0]!.reply({ result: { accepted: false } });
    expect(server.frames.filter((frame) => !frame.method && frame.id === 0)).toEqual([
      { id: 0, error: { code: -32601, message: 'Pantheon has not granted this server request' } },
      { id: 0, result: { accepted: true } },
    ]);
    expect(server.frames.find((frame) => !frame.method && frame.id === '0')).toEqual({
      id: '0',
      error: { code: -32601, message: 'Unknown method' },
    });
    rpc.off('request', receive);
    server.send({ ...frame, id: 'after-opt-out' });
    expect(denied).toHaveBeenCalledTimes(2);
    expect(server.frames.at(-1)).toMatchObject({ id: 'after-opt-out', error: { code: -32601 } });
  });
});

const commandApproval = 'item/commandExecution/requestApproval';
const fileApproval = 'item/fileChange/requestApproval';
const mcpApproval = 'mcpServer/elicitation/request';
const commandParams = { command: 'echo hello', cwd: '/workspace', itemId: 'command-item' };
const fileParams = { itemId: 'patch-item', reason: 'Apply a patch', grantRoot: null };
const patchTarget = path.join(process.cwd(), 'clone', 'src', 'edit.ts');
/** Codex announces a patch item with its changes before it asks to apply it. */
function patchStarted(
  changes: { path: string; kind: Record<string, unknown> }[] = [
    { path: patchTarget, kind: { type: 'update', move_path: null } },
  ],
): Frame {
  return {
    method: 'item/started',
    params: {
      threadId: 'sandbox-thread',
      turnId: 'native-turn',
      item: {
        type: 'fileChange',
        id: 'patch-item',
        status: 'inProgress',
        changes: changes.map((change) => ({ ...change, diff: '-old\n+new\n' })),
      },
    },
  };
}
const mcpParams = {
  serverName: 'kept',
  mode: 'form',
  message: 'Allow tool?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'read', tool_params: { path: 'file' } },
};
const keptReadRule = 'mcp:["kept","read"]';
const approvals = [
  { method: fileApproval, params: fileParams, tool: 'fileChange', field: 'decision' },
  { method: mcpApproval, params: mcpParams, tool: 'kept.read', field: 'action' },
] as const;
function requestFrame(
  method: string,
  params: Record<string, unknown>,
  id: string | number = 'approval',
) {
  return {
    id,
    method,
    params: { threadId: 'sandbox-thread', turnId: 'native-turn', startedAtMs: 1, ...params },
  };
}
async function running(spec = writerSpec()) {
  const f = await opened(spec);
  await f.adapter.send(f.handle, {
    turn_id: 'sandbox-turn',
    input: 'edit a file',
  });
  return f;
}
function permission(events: AgentEvent[]) {
  const request = events.find((event) => event.kind === 'permission.requested');
  expect(request).toBeDefined();
  if (request?.kind !== 'permission.requested') throw new Error('Missing permission request');
  return request;
}
function completed(send: (frame: Frame) => unknown, status = 'completed') {
  send({
    method: 'turn/completed',
    params: { threadId: 'sandbox-thread', turn: { id: 'native-turn', status } },
  });
}

function rawItem(item: Record<string, unknown>): Frame {
  return {
    method: 'rawResponseItem/completed',
    params: { threadId: 'sandbox-thread', turnId: 'native-turn', item },
  };
}
const refusedCall = {
  type: 'function_call',
  id: 'response-item',
  call_id: 'refused-call',
  name: 'exec_command',
  arguments: JSON.stringify({ cmd: 'ls /x' }),
};
const refusedOutput = {
  type: 'function_call_output',
  call_id: 'refused-call',
  output: 'Process exited with code 1\nOutput:\nls: /x: Operation not permitted',
};

describe('Codex raw tool events', () => {
  for (const role of ['writer', 'reviewer'] as const) {
    it.each(['start', 'resume'] as const)(
      `records raw tool availability on %s for a ${role}`,
      async (method) => {
        const spec = writerSpec();
        spec.role = role;
        if (role === 'reviewer') spec.sandbox!.writable_roots = [];
        const f = await opened(spec, method);
        if (method === 'start')
          expect(threadParams(f.frames)).toHaveProperty('experimentalRawEvents', true);
        else expect(threadParams(f.frames)).not.toHaveProperty('experimentalRawEvents');
        expect(f.events.find((event) => event.kind === 'session.started')).toMatchObject({
          raw_tool_events: method === 'start' ? 'enabled' : 'unavailable_on_resume',
        });
      },
    );
  }

  it.each(['start', 'resume'] as const)(
    'reports a sandbox refusal with no v2 item after %s',
    async (method) => {
      const f = await opened(writerSpec(), method);
      await f.adapter.send(f.handle, {
        turn_id: 'sandbox-turn',
        input: 'list /x',
      });
      f.send(rawItem(refusedCall));
      f.send(rawItem(refusedOutput));
      expect(f.events.filter((event) => event.kind.startsWith('tool.'))).toEqual([]);
      completed(f.send);
      expect(f.events.filter((event) => event.kind.startsWith('tool.'))).toEqual([
        expect.objectContaining({
          kind: 'tool.started',
          tool_call_id: refusedCall.call_id,
          name: 'exec_command',
          input: { cmd: 'ls /x' },
          turn_id: 'sandbox-turn',
          native_type: 'rawResponseItem/completed',
        }),
        expect.objectContaining({
          kind: 'tool.completed',
          tool_call_id: refusedCall.call_id,
          ok: false,
          output: { text: refusedOutput.output },
          turn_id: 'sandbox-turn',
          native_type: 'rawResponseItem/completed',
        }),
      ]);
      expect(f.events.at(-1)?.kind).toBe('turn.completed');
      expect(f.events.map((event) => event.provider_sequence)).toEqual(
        f.events.map((_, index) => index + 1),
      );
    },
  );

  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall'] as const) {
    it.each(['raw first', 'v2 first', 'interleaved'])(
      `prefers ${type} over raw events with the same call id when %s`,
      async (order) => {
        const f = await running();
        const raw = [
          rawItem({ ...refusedCall, call_id: 'shared-call' }),
          rawItem({ ...refusedOutput, call_id: 'shared-call' }),
        ];
        const item = {
          id: 'shared-call',
          type,
          command: 'ls /x',
          cwd: f.spec.cwd,
          changes: [],
          server: 'files',
          tool: 'read',
          arguments: {},
          aggregatedOutput: 'v2 result',
          exitCode: 0,
        };
        const v2 = ['item/started', 'item/completed'].map((method) => ({
          method,
          params: {
            threadId: 'sandbox-thread',
            turnId: 'native-turn',
            item: { ...item, status: method === 'item/started' ? 'inProgress' : 'completed' },
          },
        }));
        const frames =
          order === 'raw first'
            ? [...raw, ...v2]
            : order === 'v2 first'
              ? [...v2, ...raw]
              : [raw[0]!, v2[0]!, raw[1]!, v2[1]!];
        for (const frame of frames) f.send(frame);
        f.send(rawItem(refusedCall));
        f.send(rawItem(refusedOutput));
        completed(f.send);
        const tools = f.events.filter((event) => event.kind.startsWith('tool.'));
        expect(tools).toEqual([
          expect.objectContaining({
            kind: 'tool.started',
            tool_call_id: 'shared-call',
            name: type === 'mcpToolCall' ? 'files.read' : type,
            native_type: 'item/started',
          }),
          expect.objectContaining({
            kind: 'tool.completed',
            tool_call_id: 'shared-call',
            ok: true,
            native_type: 'item/completed',
          }),
          expect.objectContaining({ kind: 'tool.started', tool_call_id: refusedCall.call_id }),
          expect.objectContaining({ kind: 'tool.completed', tool_call_id: refusedCall.call_id }),
        ]);
      },
    );
  }

  it.each([
    { output: 'Process exited with code 0\nOutput:\nok', ok: true },
    { output: 'Process exited with code 2\nOutput:\ninvalid option', ok: false },
    { output: 'Exit code: -1\nOutput:\nfailed', ok: false },
    { output: 'exec_command failed: SandboxDenied', ok: false },
    { output: 'Process exited with code 0\nOutput:\nls: /x: Operation not permitted', ok: true },
    { output: 'Permission denied', ok: true },
    { output: 'Read-only file system', ok: true },
    { output: JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } }), ok: true },
    { output: JSON.stringify({ output: 'failed', metadata: { exit_code: 1 } }), ok: false },
    { output: [{ type: 'input_text', text: 'done' }], ok: true },
    {
      output: [
        { type: 'input_text', text: 'Process exited with code 1' },
        { type: 'input_text', text: 'Output:\nfailed' },
      ],
      ok: false,
    },
  ])('classifies raw output $output', async ({ output, ok }) => {
    const f = await running();
    f.send(rawItem(refusedCall));
    f.send(rawItem({ ...refusedOutput, output }));
    completed(f.send);
    expect(f.events.find((event) => event.kind === 'tool.completed')).toMatchObject({
      ok,
      output: {
        text: typeof output === 'string' ? output : output.map((part) => part.text).join('\n'),
      },
    });
  });

  it('keeps a raw-only tool ok whose output quotes an exit code and a refusal', async () => {
    const f = await running();
    f.send(
      rawItem({ type: 'custom_tool_call', call_id: 'docs-call', name: 'read_docs', input: '' }),
    );
    f.send(
      rawItem({
        type: 'custom_tool_call_output',
        call_id: 'docs-call',
        output:
          'FAQ: "Permission denied" means the sandbox refused a write. See exit code 1 below.',
      }),
    );
    completed(f.send);
    expect(f.events.find((event) => event.kind === 'tool.completed')).toMatchObject({ ok: true });
  });

  it.each([
    {
      item: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** End Patch',
      },
      name: 'apply_patch',
      input: { value: '*** Begin Patch\n*** End Patch' },
      outputType: 'custom_tool_call_output',
    },
    {
      item: { type: 'function_call', namespace: 'files', name: 'read', arguments: '{invalid' },
      name: 'files.read',
      input: { value: '{invalid' },
      outputType: 'function_call_output',
    },
    {
      item: {
        type: 'local_shell_call',
        status: 'completed',
        action: { type: 'exec', command: ['ls'] },
      },
      name: 'local_shell_call',
      input: { type: 'exec', command: ['ls'] },
      outputType: 'function_call_output',
    },
  ])('maps $item.type input and its output', async ({ item, name, input, outputType }) => {
    const f = await running();
    f.send(rawItem({ ...item, call_id: 'raw-call' }));
    f.send(rawItem({ type: outputType, call_id: 'raw-call', output: 'done' }));
    completed(f.send);
    expect(f.events.filter((event) => event.kind.startsWith('tool.'))).toEqual([
      expect.objectContaining({ kind: 'tool.started', tool_call_id: 'raw-call', name, input }),
      expect.objectContaining({
        kind: 'tool.completed',
        tool_call_id: 'raw-call',
        ok: true,
        output: { text: 'done' },
      }),
    ]);
  });

  it('buffers early raw items and ignores foreign or late tool frames', async () => {
    const f = await opened();
    f.send(rawItem(refusedCall));
    f.intercept.mockImplementation((frame) => frame.method === 'turn/start');
    const sending = f.adapter.send(f.handle, {
      turn_id: 'sandbox-turn',
      input: 'list /x',
    });
    const request = f.frames.at(-1)!;
    for (const mismatch of [{ threadId: 'foreign-thread' }, { turnId: 'foreign-turn' }]) {
      const frame = rawItem({ ...refusedCall, call_id: 'foreign-call' });
      f.send({ ...frame, params: { ...frame.params, ...mismatch } });
    }
    f.send(rawItem(refusedCall));
    f.send(rawItem(refusedOutput));
    completed(f.send);
    f.send({ id: request.id, result: { turn: { id: 'native-turn' } } });
    await sending;
    const before = f.events.length;
    f.send(rawItem(refusedCall));
    f.send(rawItem(refusedOutput));
    completed(f.send);
    expect(f.events).toHaveLength(before);
    expect(f.events.filter((event) => event.kind.startsWith('tool.'))).toEqual([
      expect.objectContaining({ kind: 'tool.started', tool_call_id: refusedCall.call_id }),
      expect.objectContaining({ kind: 'tool.completed', tool_call_id: refusedCall.call_id }),
    ]);
  });
});

describe('Codex writer approvals', () => {
  it.each([
    { method: commandApproval, params: commandParams, result: { decision: 'decline' } },
    {
      method: commandApproval,
      params: { additionalPermissions: {} },
      result: { decision: 'decline' },
    },
    {
      method: commandApproval,
      params: { additionalPermissions: { fileSystem: { write: ['/outside'] } } },
      result: { decision: 'decline' },
    },
    {
      method: commandApproval,
      params: { networkApprovalContext: { host: 'example.invalid', protocol: 'https' } },
      result: { decision: 'decline' },
    },
    {
      method: commandApproval,
      params: { reason: 'command failed; retry without sandbox?' },
      result: { decision: 'decline' },
    },
    { method: fileApproval, params: { grantRoot: '/outside' }, result: { decision: 'decline' } },
    {
      method: 'item/permissions/requestApproval',
      params: { permissions: { network: { enabled: true } } },
      result: { permissions: {} },
    },
    { method: mcpApproval, params: { ...mcpParams, _meta: {} }, result: { action: 'decline' } },
    {
      method: mcpApproval,
      params: { ...mcpParams, _meta: { codex_approval_kind: 'tool_suggestion' } },
      result: { action: 'decline' },
    },
  ])(
    'declines $method $params without requesting permission',
    async ({ method, params, result }) => {
      const f = await running();
      f.send(requestFrame(method, params));
      expect(f.frames.at(-1)).toEqual({ id: 'approval', result });
      expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
    },
  );

  it('marks an answer to a request the running session does not hold as an unknown request', async () => {
    const f = await running();
    expect(await f.adapter.answerPermission(f.handle, 'unknown-request', 'deny')).toMatchObject({
      ok: false,
      unknown_request: true,
    });
    expect(
      await f.adapter.answerPermission({ ...f.handle }, 'unknown-request', 'deny'),
    ).not.toHaveProperty('unknown_request');
  });

  for (const { method, params, tool, field } of approvals) {
    it.each(['allow', 'deny'] as const)(
      `waits for %s on ${method} and answers once`,
      async (decision) => {
        const f = await running();
        f.send(patchStarted());
        const frame = requestFrame(
          method,
          { additionalPermissions: null, networkApprovalContext: null, ...params },
          0,
        );
        const before = f.frames.length;
        f.send(frame);
        expect(f.frames).toHaveLength(before);
        const request = permission(f.events);
        expect(request).toMatchObject({
          tool,
          turn_id: 'sandbox-turn',
          detail: { input: frame.params },
        });
        if ('itemId' in params)
          expect(request.detail).toHaveProperty('tool_call_id', params.itemId);
        else expect(request.detail).not.toHaveProperty('tool_call_id');
        expect(
          await f.adapter.answerPermission({ ...f.handle }, request.request_id, decision),
        ).toMatchObject({ ok: false });
        expect(
          await f.adapter.answerPermission(f.handle, 'unknown-request', decision),
        ).toMatchObject({ ok: false });
        expect(await f.adapter.answerPermission(f.handle, request.request_id, decision)).toEqual({
          ok: true,
        });
        expect(f.frames.at(-1)).toEqual({
          id: 0,
          result: { [field]: decision === 'allow' ? 'accept' : 'decline' },
        });
        expect(f.events.filter((event) => event.kind === 'permission.resolved')).toEqual([
          expect.objectContaining({
            request_id: request.request_id,
            decision,
            turn_id: 'sandbox-turn',
          }),
        ]);
        expect(
          await f.adapter.answerPermission(f.handle, request.request_id, decision),
        ).toMatchObject({ ok: false });
        expect(f.events.map((event) => event.provider_sequence)).toEqual(
          f.events.map((_, index) => index + 1),
        );
      },
    );
  }

  it('accepts an MCP tool allowed for the session without asking again', async () => {
    const f = await running();
    f.send(requestFrame(mcpApproval, mcpParams, 'first'));
    const request = permission(f.events);
    expect(request.tool).toBe('kept.read');
    expect(request.project_rule_supported).toBe(true);
    await f.adapter.answerPermission(f.handle, request.request_id, 'allow_session');
    expect(f.frames.at(-1)).toEqual({ id: 'first', result: { action: 'accept' } });
    f.send(requestFrame(mcpApproval, mcpParams, 'second'));
    expect(f.frames.at(-1)).toEqual({ id: 'second', result: { action: 'accept' } });
    expect(f.events.filter((event) => event.kind === 'permission.requested')).toHaveLength(1);
  });

  it('accepts an MCP tool the session spec already allows without asking', async () => {
    const f = await running({ ...writerSpec(), allowed_rules: [keptReadRule] });
    f.send(requestFrame(mcpApproval, mcpParams));
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { action: 'accept' } });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it('asks for an MCP tool the session allows while the session is in plan mode', async () => {
    const f = await running({
      ...writerSpec(),
      permission_mode: 'plan',
      allowed_rules: [keptReadRule],
    });
    f.send(requestFrame(mcpApproval, mcpParams));
    expect(f.events.filter((event) => event.kind === 'permission.requested')).toHaveLength(1);
  });

  it('asks for an MCP tool the session allows during a read-only turn', async () => {
    const f = await opened({ ...writerSpec(), allowed_rules: [keptReadRule] });
    await f.adapter.send(f.handle, { turn_id: 'lead-turn', input: 'plan', read_only: true });
    f.send(requestFrame(mcpApproval, mcpParams));
    expect(f.frames.some((frame) => frame.id === 'approval')).toBe(false);
    expect(permission(f.events)).toMatchObject({ tool: 'kept.read', rule: keptReadRule });
  });

  it('keeps a session-wide MCP allowance to the server and tool it was given for', async () => {
    const f = await running();
    const call = (serverName: string, tool_name: string) => ({
      ...mcpParams,
      serverName,
      _meta: { ...mcpParams._meta, tool_name },
    });
    f.send(requestFrame(mcpApproval, call('trusted.read', 'execute'), 'first'));
    const first = permission(f.events);
    await f.adapter.answerPermission(f.handle, first.request_id, 'allow_session');
    expect(f.frames.at(-1)).toEqual({ id: 'first', result: { action: 'accept' } });
    f.send(requestFrame(mcpApproval, call('trusted', 'read.execute'), 'second'));
    expect(f.frames.some((frame) => frame.id === 'second')).toBe(false);
    const requests = f.events.filter((event) => event.kind === 'permission.requested');
    expect(requests.map((event) => event.tool)).toEqual([
      'trusted.read.execute',
      'trusted.read.execute',
    ]);
    expect(new Set(requests.map((event) => event.rule)).size).toBe(2);
  });

  it('asks for every file change even after a session-wide allowance', async () => {
    const f = await running({ ...writerSpec(), allowed_rules: ['fileChange'] });
    f.send(patchStarted());
    f.send(requestFrame(fileApproval, fileParams, 'first'));
    expect(permission(f.events).project_rule_supported).toBe(false);
    await f.adapter.answerPermission(f.handle, permission(f.events).request_id, 'allow_session');
    expect(f.frames.at(-1)).toEqual({ id: 'first', result: { decision: 'accept' } });
    f.send(requestFrame(fileApproval, fileParams, 'second'));
    expect(f.frames.some((frame) => frame.id === 'second')).toBe(false);
    expect(f.events.filter((event) => event.kind === 'permission.requested')).toHaveLength(2);
  });

  it('shows the patch target paths on the file change approval', async () => {
    const f = await running();
    f.send(patchStarted());
    f.send(requestFrame(fileApproval, fileParams));
    expect(permission(f.events).detail).toMatchObject({
      input: {
        changes: [{ path: patchTarget, kind: { type: 'update', move_path: null } }],
        itemId: 'patch-item',
      },
    });
  });

  it('declines a file change in plan mode without asking', async () => {
    const f = await running({ ...writerSpec(), permission_mode: 'plan' });
    f.send(patchStarted());
    f.send(requestFrame(fileApproval, fileParams));
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  const clone = path.join(process.cwd(), 'clone');
  it.each([
    ['outside the writable roots', [{ path: path.join(process.cwd(), 'outside.txt') }]],
    ['in a write-protected directory', [{ path: path.join(process.cwd(), 'source', 'x.ts') }]],
    ['on a protected file in the worktree', [{ path: path.join(clone, '.mcp.json') }]],
    ['in the worktree git hooks', [{ path: path.join(clone, '.git', 'hooks', 'pre-commit') }]],
    ['in a hidden directory', [{ path: path.join(process.cwd(), 'private', 'key') }]],
    [
      'moved out of the writable roots',
      [{ path: patchTarget, move_path: path.join(process.cwd(), 'outside.txt') }],
    ],
    ['among targets inside the worktree', [{ path: patchTarget }, { path: '/elsewhere/x' }]],
  ])('declines a file change with a target %s without asking', async (_, targets) => {
    const f = await running();
    f.send(
      patchStarted(
        targets.map((target) => ({
          path: target.path,
          kind: { type: 'update', move_path: 'move_path' in target ? target.move_path : null },
        })),
      ),
    );
    f.send(requestFrame(fileApproval, fileParams));
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it.each([
    ['asks for a target inside', 'src/edit.ts', true],
    ['declines its .git file as', '.git', false],
  ])('in a linked worktree %s the worktree', async (_, target, asked) => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'pantheon-codex-linked-'));
    cleanup.push(() => rm(worktree, { recursive: true, force: true }));
    await writeFile(path.join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/one\n');
    const spec = writerSpec();
    spec.cwd = worktree;
    spec.sandbox!.writable_roots = [worktree];
    const f = await running(spec);
    f.send(
      patchStarted([
        { path: path.join(worktree, target), kind: { type: 'update', move_path: null } },
      ]),
    );
    f.send(requestFrame(fileApproval, fileParams));
    if (asked) {
      expect(permission(f.events).tool).toBe('fileChange');
      expect(f.frames.some((frame) => frame.id === 'approval')).toBe(false);
    } else {
      expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } });
    }
  });

  it.each([
    ['asks for a target inside', 'src/edit.ts', true],
    ['declines a target linked out of', 'links/authorized_keys', false],
    ['declines its .git file as', '.git', false],
  ])('in a device worktree %s the worktree', async (_, target, asked) => {
    const device = await mkdtemp(path.join(os.tmpdir(), 'pantheon-codex-device-'));
    cleanup.push(() => rm(device, { recursive: true, force: true }));
    await mkdir(path.join(device, 'w'));
    await mkdir(path.join(device, 'ssh'));
    await symlink(path.join(device, 'ssh'), path.join(device, 'w', 'links'));
    await writeFile(path.join(device, 'w', '.git'), 'gitdir: /elsewhere/.git/worktrees/one\n');
    const spec = writerSpec();
    spec.device_id = 'build-box';
    // The device link maps /device to the test directory, which this machine does not see there.
    spec.remote = {
      transport: ['/bin/sh', '-c'],
      plain_transport: [
        '/bin/sh',
        '-c',
        `exec /bin/sh -c "$(printf %s "$1" | sed 's#/device/#${device}/#g')"`,
        'sh',
      ],
      binary: '/device/bin/codex',
    };
    spec.cwd = '/device/w';
    spec.sandbox = { writable_roots: ['/device/w'], protected_entries: [] };
    const f = await running(spec);
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    cleanup.push(async () => vi.mocked(spawn).mockReset());
    f.send(
      patchStarted([
        { path: path.join('/device/w', target), kind: { type: 'update', move_path: null } },
      ]),
    );
    f.send(requestFrame(fileApproval, fileParams));
    if (asked) await vi.waitFor(() => expect(permission(f.events).tool).toBe('fileChange'));
    else
      await vi.waitFor(() =>
        expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } }),
      );
  });

  it('declines a file change of a device session when the device link fails', async () => {
    const spec = writerSpec();
    spec.device_id = 'build-box';
    spec.remote = {
      transport: ['/bin/sh', '-c'],
      plain_transport: ['/missing/device-link'],
      binary: '/device/bin/codex',
    };
    spec.cwd = '/device/w';
    spec.sandbox = { writable_roots: ['/device/w'], protected_entries: [] };
    const f = await running(spec);
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    cleanup.push(async () => vi.mocked(spawn).mockReset());
    f.send(
      patchStarted([{ path: '/device/w/src/edit.ts', kind: { type: 'update', move_path: null } }]),
    );
    f.send(requestFrame(fileApproval, fileParams));
    await vi.waitFor(() =>
      expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } }),
    );
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it('declines an approved file change whose turn became read-only while the approval waited', async () => {
    const f = await running();
    f.send(patchStarted());
    f.send(requestFrame(fileApproval, fileParams));
    const request = permission(f.events);
    f.adapter.setTurnReadOnly(f.handle, true);
    expect(await f.adapter.answerPermission(f.handle, request.request_id, 'allow')).toEqual({
      ok: true,
    });
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } });
    expect(f.events.filter((event) => event.kind === 'permission.resolved')).toEqual([
      expect.objectContaining({ request_id: request.request_id, decision: 'deny' }),
    ]);
  });

  it('declines a device file change whose turn became read-only while its paths were checked', async () => {
    const device = await mkdtemp(path.join(os.tmpdir(), 'pantheon-codex-device-'));
    cleanup.push(() => rm(device, { recursive: true, force: true }));
    await mkdir(path.join(device, 'w'));
    const spec = writerSpec();
    spec.device_id = 'build-box';
    spec.remote = {
      transport: ['/bin/sh', '-c'],
      plain_transport: [
        '/bin/sh',
        '-c',
        `exec /bin/sh -c "$(printf %s "$1" | sed 's#/device/#${device}/#g')"`,
        'sh',
      ],
      binary: '/device/bin/codex',
    };
    spec.cwd = '/device/w';
    spec.sandbox = { writable_roots: ['/device/w'], protected_entries: [] };
    const f = await running(spec);
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    cleanup.push(async () => vi.mocked(spawn).mockReset());
    f.send(
      patchStarted([{ path: '/device/w/src/edit.ts', kind: { type: 'update', move_path: null } }]),
    );
    f.send(requestFrame(fileApproval, fileParams));
    f.adapter.setTurnReadOnly(f.handle, true);
    await vi.waitFor(() =>
      expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } }),
    );
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it('declines a file change whose patch item was never announced', async () => {
    const f = await running();
    f.send(requestFrame(fileApproval, fileParams));
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'decline' } });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it('steers the rejection reason into the running turn after declining', async () => {
    const f = await running();
    f.intercept.mockImplementation((frame) => {
      if (frame.method !== 'turn/steer') return false;
      f.send({ id: frame.id, result: {} });
      return true;
    });
    f.send(patchStarted());
    f.send(requestFrame(fileApproval, fileParams));
    const request = permission(f.events);
    expect(
      await f.adapter.answerPermission(
        f.handle,
        request.request_id,
        'deny',
        undefined,
        'Use the cached report',
      ),
    ).toEqual({ ok: true });
    const reply = f.frames.findIndex((frame) => frame.id === 'approval');
    expect(f.frames[reply]).toEqual({ id: 'approval', result: { decision: 'decline' } });
    const steer = f.frames.findIndex((frame) => frame.method === 'turn/steer');
    expect(steer).toBeGreaterThan(reply);
    expect(f.frames[steer]!.params).toMatchObject({
      threadId: 'sandbox-thread',
      expectedTurnId: 'native-turn',
      input: [{ type: 'text', text: expect.stringContaining('Use the cached report') }],
    });
  });

  it.each(['completed', 'failed', 'interrupted', 'cancel', 'transport closed'])(
    'denies all pending approvals before a turn is %s',
    async (ending) => {
      const f = await running();
      f.send(patchStarted());
      for (const { method, params } of approvals) f.send(requestFrame(method, params, method));
      const requests = f.events.filter((event) => event.kind === 'permission.requested');
      expect(requests).toHaveLength(2);
      if (ending === 'cancel') await f.adapter.cancel(f.handle, Date.now() + 1000);
      else if (ending === 'transport closed') f.child.emit('close', 0, null);
      else completed(f.send, ending);
      await Promise.resolve();
      await Promise.resolve();
      for (const { method, field } of approvals) {
        expect(f.frames.filter((frame) => frame.id === method)).toEqual([
          { id: method, result: { [field]: 'decline' } },
        ]);
      }
      expect(f.events.filter((event) => event.kind === 'permission.resolved')).toEqual(
        requests.map((request) =>
          expect.objectContaining({ request_id: request.request_id, decision: 'deny' }),
        ),
      );
      expect(f.events.at(-1)?.kind).toBe('turn.completed');
      if (ending === 'cancel') {
        const interrupt = f.frames.findIndex((frame) => frame.method === 'turn/interrupt');
        for (const { method } of approvals)
          expect(f.frames.findIndex((frame) => frame.id === method)).toBeLessThan(interrupt);
      }
      for (const request of requests)
        expect(
          await f.adapter.answerPermission(f.handle, request.request_id, 'allow'),
        ).toMatchObject({ ok: false });
    },
  );

  it('declines requests with no active turn or a foreign thread or turn', async () => {
    const f = await opened();
    for (const { method, params, field } of approvals) {
      f.send(requestFrame(method, params, `idle-${method}`));
      expect(f.frames.at(-1)).toEqual({ id: `idle-${method}`, result: { [field]: 'decline' } });
    }
    await f.adapter.send(f.handle, {
      turn_id: 'sandbox-turn',
      input: 'hello',
    });
    for (const mismatch of [{ threadId: 'other-thread' }, { turnId: 'other-turn' }])
      for (const { method, params, field } of approvals) {
        f.send(requestFrame(method, { ...params, ...mismatch }));
        expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { [field]: 'decline' } });
      }
    completed(f.send);
    f.send(requestFrame(commandApproval, commandParams, 'late'));
    expect(f.frames.at(-1)).toEqual({ id: 'late', result: { decision: 'decline' } });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it('handles MCP approval without a correlated turn, tool name or item id', async () => {
    const f = await running();
    f.send(
      requestFrame(mcpApproval, {
        ...mcpParams,
        turnId: null,
        _meta: { codex_approval_kind: 'mcp_tool_call' },
      }),
    );
    const request = permission(f.events);
    expect(request).toMatchObject({ tool: 'kept', turn_id: 'sandbox-turn' });
    expect(request.detail).not.toHaveProperty('tool_call_id');
    await f.adapter.answerPermission(f.handle, request.request_id, 'allow');
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { action: 'accept' } });
  });

  it('waits for turn identity when approval arrives before the turn/start reply', async () => {
    const f = await opened();
    f.intercept.mockImplementation((frame) => frame.method === 'turn/start');
    const sending = f.adapter.send(f.handle, {
      turn_id: 'sandbox-turn',
      input: 'hello',
    });
    const start = f.frames.at(-1)!;
    f.send(patchStarted());
    f.send(requestFrame(fileApproval, fileParams));
    expect(f.frames.some((frame) => frame.id === 'approval')).toBe(false);
    expect(f.events.some((event) => event.kind === 'permission.requested')).toBe(false);
    f.send({ id: start.id, result: { turn: { id: 'native-turn' } } });
    await sending;
    const request = permission(f.events);
    await f.adapter.answerPermission(f.handle, request.request_id, 'allow');
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'accept' } });
  });

  it('declines buffered requests if cancellation wins the turn/start reply', async () => {
    const f = await opened();
    f.intercept.mockImplementation((frame) => frame.method === 'turn/start');
    const sending = f.adapter.send(f.handle, {
      turn_id: 'sandbox-turn',
      input: 'hello',
    });
    f.send(requestFrame(fileApproval, fileParams));
    expect(f.frames.some((frame) => frame.id === 'approval')).toBe(false);
    await f.adapter.cancel(f.handle, Date.now() + 1000);
    await sending;
    expect(f.frames.find((frame) => frame.id === 'approval')).toEqual({
      id: 'approval',
      result: { decision: 'decline' },
    });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it('does not cache an approval when the server asks again for the same item', async () => {
    const f = await running();
    f.send(patchStarted());
    for (const serverId of ['first-approval', 'second-approval']) {
      const before = f.events.length;
      f.send(requestFrame(fileApproval, fileParams, serverId));
      const request = permission(f.events.slice(before));
      expect(await f.adapter.answerPermission(f.handle, request.request_id, 'allow')).toEqual({
        ok: true,
      });
      expect(f.frames.at(-1)).toEqual({ id: serverId, result: { decision: 'accept' } });
    }
    const ids = f.events
      .filter((event) => event.kind === 'permission.requested')
      .map((event) => event.request_id);
    expect(new Set(ids).size).toBe(2);
  });

  it('bounds approval input without changing the server frame', async () => {
    const f = await running();
    f.send(patchStarted());
    const long = 'x'.repeat(5000);
    const frame = requestFrame(fileApproval, { ...fileParams, reason: long });
    f.send(frame);
    expect(permission(f.events).detail).toMatchObject({
      input: { reason: long.slice(0, 4096), truncated: true },
    });
    expect((frame.params as Record<string, unknown>).reason).toBe(long);
  });

  it('answers unknown methods with a JSON-RPC error and preserves text-only rejection', async () => {
    const f = await running();
    f.send(requestFrame('unknown/server/request', {}));
    expect(f.frames.at(-1)).toMatchObject({
      id: 'approval',
      error: { code: -32601, message: expect.any(String) },
    });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
    const spec = writerSpec();
    delete spec.sandbox;
    const text = await opened(spec);
    text.send(requestFrame(commandApproval, commandParams));
    expect(text.frames.at(-1)).toEqual({
      id: 'approval',
      error: { code: -32601, message: 'Pantheon has not granted this server request' },
    });
    expect(text.events.some((event) => event.kind === 'permission.requested')).toBe(false);
  });
});

const userInput = 'item/tool/requestUserInput';
const databaseQuestion = {
  id: 'q1',
  header: 'Database',
  question: 'Which db?',
  isOther: true,
  isSecret: false,
  options: [
    { label: 'Postgres', description: 'A server database' },
    { label: 'SQLite', description: 'A file database' },
  ],
};
const userInputParams = { itemId: 'ask-call', isBlocking: false, questions: [databaseQuestion] };

describe('Codex user input questions', () => {
  it('lets a writer thread ask in default mode and leaves a planner thread alone', async () => {
    const writer = await opened();
    expect(threadParams(writer.frames).config).toMatchObject({
      features: { default_mode_request_user_input: true },
    });
    const spec = writerSpec();
    spec.role = 'planner';
    spec.sandbox!.writable_roots = [];
    const planner = await opened(spec);
    expect(JSON.stringify(threadParams(planner.frames).config)).not.toContain(
      'default_mode_request_user_input',
    );
  });

  it('turns a request into an AskUserQuestion card', async () => {
    const f = await running();
    const nameQuestion = {
      id: 'q2',
      header: 'Name',
      question: 'Project name?',
      isOther: true,
      isSecret: false,
      options: null,
    };
    f.send(
      requestFrame(userInput, { ...userInputParams, questions: [databaseQuestion, nameQuestion] }),
    );
    expect(f.frames.some((frame) => frame.id === 'approval')).toBe(false);
    const request = permission(f.events);
    expect(request).toMatchObject({
      tool: 'AskUserQuestion',
      turn_id: 'sandbox-turn',
      detail: {
        tool_call_id: 'ask-call',
        questions: [
          {
            question: 'Which db?',
            header: 'Database',
            options: databaseQuestion.options,
            multiSelect: false,
          },
          { question: 'Project name?', header: 'Name', options: [], multiSelect: false },
        ],
      },
    });
    expect(request).not.toHaveProperty('rule');
  });

  it('replies with the answers keyed by question id', async () => {
    const f = await running();
    f.send(requestFrame(userInput, userInputParams));
    const request = permission(f.events);
    expect(
      await f.adapter.answerPermission(f.handle, request.request_id, 'allow', {
        'Which db?': 'Postgres',
      }),
    ).toEqual({ ok: true });
    expect(f.frames.at(-1)).toEqual({
      id: 'approval',
      result: { answers: { q1: { answers: ['Postgres'] } } },
    });
  });

  it('replies with no answers when the user rejects or the request is withdrawn', async () => {
    const f = await running();
    f.send(requestFrame(userInput, userInputParams, 'rejected'));
    await f.adapter.answerPermission(f.handle, permission(f.events).request_id, 'deny');
    expect(f.frames.at(-1)).toEqual({ id: 'rejected', result: { answers: {} } });
    const before = f.events.length;
    f.send(requestFrame(userInput, userInputParams, 'withdrawn'));
    permission(f.events.slice(before));
    await f.adapter.close(f.handle, Date.now() + 1000);
    expect(f.frames.find((frame) => frame.id === 'withdrawn')).toEqual({
      id: 'withdrawn',
      result: { answers: {} },
    });
  });

  it('asks during a read-only turn', async () => {
    const f = await opened();
    await f.adapter.send(f.handle, { turn_id: 'lead-turn', input: 'plan', read_only: true });
    f.send(requestFrame(userInput, userInputParams));
    expect(permission(f.events)).toMatchObject({ tool: 'AskUserQuestion' });
    expect(f.frames.some((frame) => frame.id === 'approval')).toBe(false);
  });

  it('replies with no answers to a request of a foreign turn', async () => {
    const f = await running();
    f.send(requestFrame(userInput, { ...userInputParams, turnId: 'other-turn' }));
    expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { answers: {} } });
    expect(f.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it.each([
    {
      question: databaseQuestion,
      card: { id: 'q1', other: true, secret: false, options: databaseQuestion.options },
    },
    {
      question: { ...databaseQuestion, id: 'token', isOther: false, isSecret: true },
      card: { id: 'token', other: false, secret: true, options: databaseQuestion.options },
    },
    {
      question: { ...databaseQuestion, id: 'free', isOther: true, options: null },
      card: { id: 'free', other: true, secret: false, options: [] },
    },
  ])(
    'passes the id and the other and secret flags of question $card.id',
    async ({ question, card }) => {
      const f = await running();
      f.send(requestFrame(userInput, { ...userInputParams, questions: [question] }));
      expect(permission(f.events).detail).toMatchObject({
        questions: [{ question: 'Which db?', header: 'Database', multiSelect: false, ...card }],
      });
    },
  );
});

const childThread = 'child-thread';
const spawnCall = 'spawn-call';
function collabFrame(method: string, item: Record<string, unknown>): Frame {
  return {
    method,
    params: {
      threadId: 'sandbox-thread',
      turnId: 'native-turn',
      item: {
        type: 'collabAgentToolCall',
        senderThreadId: 'sandbox-thread',
        receiverThreadIds: [childThread],
        prompt: null,
        agentsStates: {},
        status: method === 'item/started' ? 'inProgress' : 'completed',
        ...item,
      },
    },
  };
}
function childFrame(method: string, params: Record<string, unknown>): Frame {
  return { method, params: { threadId: childThread, turnId: 'child-turn', ...params } };
}
async function spawned(prompt = 'Inspect the parser') {
  const f = await running();
  f.send(collabFrame('item/started', { id: spawnCall, tool: 'spawnAgent', prompt }));
  return f;
}
const taskEvents = (events: AgentEvent[]) =>
  events.filter((event) => event.kind.startsWith('task.'));
const childTools = [
  {
    item: {
      type: 'commandExecution',
      id: 'child-command',
      command: 'ls',
      cwd: '/workspace',
      exitCode: 0,
      aggregatedOutput: 'a.ts',
    },
    name: 'commandExecution',
  },
  {
    item: { type: 'fileChange', id: 'child-patch', changes: [] },
    name: 'fileChange',
  },
  {
    item: { type: 'mcpToolCall', id: 'child-mcp', server: 'files', tool: 'read', arguments: {} },
    name: 'files.read',
  },
];

describe('Codex subagents', () => {
  it.each([
    { prompt: 'Inspect the parser\nThen report', description: 'Inspect the parser' },
    { prompt: 'p'.repeat(300), description: 'p'.repeat(200) },
    { prompt: null, description: '' },
  ])(
    'starts a task for each thread a spawn dispatches, described as $description',
    async ({ prompt, description }) => {
      const f = await running();
      const before = Date.now();
      f.send(
        collabFrame('item/started', {
          id: spawnCall,
          tool: 'spawnAgent',
          prompt,
          receiverThreadIds: [childThread, 'second-child'],
        }),
      );
      const tasks = taskEvents(f.events);
      expect(tasks).toEqual(
        [childThread, 'second-child'].map((id) =>
          expect.objectContaining({
            kind: 'task.started',
            turn_id: 'sandbox-turn',
            task: {
              id,
              kind: 'agent',
              tool_call_id: spawnCall,
              description,
              background: false,
              started_at: expect.any(Number),
            },
          }),
        ),
      );
      for (const task of tasks)
        if (task.kind === 'task.started')
          expect(task.task.started_at).toBeGreaterThanOrEqual(before);
    },
  );

  it.each(['wait', 'sendInput', 'closeAgent'])('starts no task for a %s call', async (tool) => {
    const f = await running();
    f.send(collabFrame('item/started', { id: 'collab-call', tool }));
    expect(taskEvents(f.events)).toEqual([]);
  });

  it.each([
    { status: 'completed', state: 'completed' },
    { status: 'errored', state: 'failed' },
  ])('ends the task once when a later call marks its thread $status', async ({ status, state }) => {
    const f = await spawned();
    f.send(
      collabFrame('item/completed', {
        id: spawnCall,
        tool: 'spawnAgent',
        agentsStates: { [childThread]: { status: 'running', message: null } },
      }),
    );
    for (const id of ['wait-call', 'second-wait'])
      f.send(
        collabFrame('item/completed', {
          id,
          tool: 'wait',
          agentsStates: { [childThread]: { status, message: 'done' } },
        }),
      );
    expect(taskEvents(f.events).filter((event) => event.kind === 'task.ended')).toEqual([
      expect.objectContaining({ kind: 'task.ended', task_id: childThread, state }),
    ]);
  });

  it.each(childTools)('reports a subagent $name call under its spawn', async ({ item, name }) => {
    const f = await spawned();
    const before = f.events.length;
    f.send(childFrame('item/started', { item: { ...item, status: 'inProgress' } }));
    f.send(childFrame('item/completed', { item: { ...item, status: 'completed' } }));
    expect(f.events.slice(before)).toEqual([
      expect.objectContaining({
        kind: 'tool.started',
        tool_call_id: item.id,
        name,
        parent_tool_use_id: spawnCall,
        turn_id: 'sandbox-turn',
      }),
      expect.objectContaining({ kind: 'task.progress', task_id: childThread, last_tool: name }),
      expect.objectContaining({
        kind: 'tool.completed',
        tool_call_id: item.id,
        ok: true,
        parent_tool_use_id: spawnCall,
      }),
    ]);
  });

  it('drops the message, usage and turn frames of a subagent and every frame of an unknown thread', async () => {
    const f = await spawned();
    const before = f.events.length;
    f.send(childFrame('item/agentMessage/delta', { delta: 'child text' }));
    f.send(childFrame('thread/tokenUsage/updated', { tokenUsage: { last: {}, total: {} } }));
    f.send(childFrame('turn/completed', { turn: { id: 'child-turn', status: 'completed' } }));
    for (const method of ['item/started', 'item/completed'])
      f.send({
        method,
        params: { threadId: 'unknown-thread', turnId: 'child-turn', item: childTools[0]!.item },
      });
    expect(f.events.slice(before)).toEqual([]);
    expect(f.frames.some((frame) => frame.method === 'turn/interrupt')).toBe(false);
  });

  it.each(approvals)(
    'asks for a subagent $tool request and replies to it',
    async ({ method, params, tool, field }) => {
      const f = await spawned();
      const patch = patchStarted();
      f.send(childFrame('item/started', { item: (patch.params as { item: unknown }).item }));
      f.send(requestFrame(method, { ...params, threadId: childThread, turnId: 'child-turn' }));
      expect(f.frames.some((frame) => frame.id === 'approval')).toBe(false);
      const request = permission(f.events);
      expect(request).toMatchObject({ tool, turn_id: 'sandbox-turn' });
      if ('itemId' in params) expect(request.detail).toMatchObject({ tool_call_id: params.itemId });
      await f.adapter.answerPermission(f.handle, request.request_id, 'allow');
      expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { [field]: 'accept' } });
    },
  );
});

it.each(['writer', 'reviewer', 'planner'] as const)(
  'mounts Pantheon with per-server approval for a %s on start and resume without passing its token file to the app-server',
  async (role) => {
    for (const method of ['start', 'resume'] as const) {
      const spec = writerSpec();
      spec.role = role;
      if (role === 'planner') delete spec.sandbox;
      if (role === 'reviewer') {
        spec.extensions = { mode: 'none' };
        spec.sandbox!.writable_roots = [];
      }
      spec.pantheon_mcp = {
        command: process.execPath,
        args: ['/app/apps/cli/dist/index.js', 'mcp'],
        env: {
          PANTHEON_SESSION_TOKEN_FILE: '/data/session-tokens/session',
          PANTHEON_DAEMON_URL: 'http://127.0.0.1:4321',
        },
      };
      const f = await opened(spec, method);
      expect(threadParams(f.frames).config).toMatchObject({
        mcp_servers: { pantheon: { ...spec.pantheon_mcp, default_tools_approval_mode: 'approve' } },
      });
      const env = vi.mocked(spawn).mock.calls.at(-1)![2]!.env;
      expect(env).not.toHaveProperty('PANTHEON_SESSION_TOKEN_FILE');
      expect(f.events.find((event) => event.kind === 'extensions.applied')).toMatchObject({
        loaded: { mcp_servers: expect.arrayContaining(['pantheon']) },
      });
      if (role !== 'planner') expect(threadParams(f.frames).approvalPolicy).toBe('on-request');
      else {
        const instructions = threadParams(f.frames).developerInstructions as string;
        expect(instructions).toBe(buildClaudeOptions(spec, {}).systemPrompt);
        expect(instructions).not.toContain(spec.project_id);
        expect(instructions).toContain(spec.cwd);
        for (const text of ['shell', 'files', 'read-only']) expect(instructions).toContain(text);
      }
      if (role === 'reviewer')
        expect(Object.values(filesystem(threadParams(f.frames)))).not.toContain('write');
    }
  },
);

it.each(['start', 'resume'] as const)(
  'appends pinned writer context after native permission instructions on %s',
  async (method) => {
    const spec = writerSpec();
    spec.control_instructions =
      'Pinned original requirements\nUntrusted failed-check evidence: expected array.';
    const f = await opened(spec, method);
    const params = threadParams(f.frames);
    expect(params.developerInstructions).toBe(
      'Use tools inside the Pantheon permission profile. Do not request permissions outside the sandbox.\n\n' +
        spec.control_instructions,
    );
    expect(params.approvalPolicy).toBe('on-request');
    expect(params.approvalsReviewer).toBe('user');
    expect(filesystem(params)[spec.cwd]).toBe('write');
    expect(filesystem(params)[path.join(process.cwd(), 'private')]).toBe('deny');
  },
);

describe('Codex turn wall clock and withdrawn requests', () => {
  const HOUR = 3_600_000;
  const ended = (events: AgentEvent[]) => events.find((event) => event.kind === 'turn.completed');
  async function timed() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const spec = writerSpec();
    spec.budget = { max_turns: 2, wall_time_ms: HOUR };
    return running(spec);
  }

  it('stops the wall clock while a permission request waits and resumes it with the time left', async () => {
    try {
      const f = await timed();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      f.send(patchStarted());
      f.send(requestFrame(fileApproval, fileParams));
      await vi.advanceTimersByTimeAsync(7 * HOUR);
      expect(ended(f.events)).toBeUndefined();
      await f.adapter.answerPermission(f.handle, permission(f.events).request_id, 'allow');
      expect(f.frames.at(-1)).toEqual({ id: 'approval', result: { decision: 'accept' } });
      await vi.advanceTimersByTimeAsync(50 * 60_000 - 1);
      expect(ended(f.events)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(ended(f.events)).toMatchObject({
        status: 'failed',
        error: 'Codex turn deadline exceeded',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a turn with no waiting request at the wall clock limit', async () => {
    try {
      const f = await timed();
      await vi.advanceTimersByTimeAsync(HOUR + 1);
      expect(ended(f.events)).toMatchObject({
        status: 'failed',
        error: 'Codex turn deadline exceeded',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a turn ended at the wall clock limit the deadline reason code', async () => {
    try {
      const f = await timed();
      await vi.advanceTimersByTimeAsync(HOUR + 1);
      expect(ended(f.events)).toMatchObject({ status: 'failed', error_code: 'turn_deadline' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a request withdrawn by closing the session as cancelled, unlike a user denial', async () => {
    const f = await running();
    f.send(patchStarted());
    f.send(requestFrame(fileApproval, fileParams, 'denied'));
    await f.adapter.answerPermission(f.handle, permission(f.events).request_id, 'deny');
    const before = f.events.length;
    f.send(requestFrame(fileApproval, fileParams, 'withdrawn'));
    const withdrawn = permission(f.events.slice(before));
    await f.adapter.close(f.handle, Date.now() + 1000);
    expect(f.frames.find((frame) => frame.id === 'withdrawn')).toEqual({
      id: 'withdrawn',
      result: { decision: 'decline' },
    });
    const resolved = f.events.filter((event) => event.kind === 'permission.resolved');
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).not.toHaveProperty('cancelled');
    expect(resolved[1]).toMatchObject({
      request_id: withdrawn.request_id,
      decision: 'deny',
      cancelled: true,
    });
  });
});

it.each(['start', 'resume'] as const)(
  'uses full access without changing approvals on %s',
  async (method) => {
    const f = await opened({ ...writerSpec(), permission_mode: 'full_access' }, method);
    const params = threadParams(f.frames);
    expect(params.sandbox).toBe('danger-full-access');
    expect(params.approvalPolicy).toBe('on-request');
    expect(params.approvalsReviewer).toBe('user');
    expect(params.config).not.toHaveProperty('default_permissions');
    await f.adapter.send(f.handle, { turn_id: 'full-access-turn', input: 'Work' });
    expect(f.frames.find((frame) => frame.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  },
);
