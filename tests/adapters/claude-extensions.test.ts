import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options,
  SDKUserMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { ClaudeAdapter, buildClaudeOptions } from '../../packages/adapters/src/claude.js';
import {
  NATIVE_ENV_ALLOWLIST,
  type AgentEvent,
  type ExtensionOverrides,
  type SessionSpec,
} from '@pantheon/domain';

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({
  ...(await original<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  resolveSettings: vi.fn(async () => ({ effective: {}, provenance: {}, sources: [] })),
}));

const empty: ExtensionOverrides = {
  disabled_mcp_servers: [],
  disabled_plugins: [],
  disabled_skills: [],
  disable_apps: false,
  disable_hooks: false,
};
const overrides: ExtensionOverrides = {
  disabled_mcp_servers: ['blocked'],
  disabled_plugins: ['blocked@market'],
  disabled_skills: ['blocked-skill'],
  disable_apps: true,
  disable_hooks: true,
};
const spec = (extensions?: SessionSpec['extensions']): SessionSpec => ({
  platform_session_id: 'extension-session',
  project_id: 'extension-project',
  runtime: 'claude',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  extensions,
  budget: { max_turns: 1, wall_time_ms: 10000 },
});
const base = { pathToClaudeCodeExecutable: 'fake-claude', env: { PATH: '/test' } };

describe('Claude query options', () => {
  it('inherits without overriding the user extension setup', () => {
    const options = buildClaudeOptions(spec({ mode: 'inherit', overrides: empty }), base);
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    for (const key of ['strictMcpConfig', 'mcpServers', 'settings', 'skills'])
      expect(options).not.toHaveProperty(key);
    expect(options).toMatchObject({
      ...base,
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
    });
  });

  it('uses only a session settings overlay and a discovered skill allowlist', () => {
    const options = buildClaudeOptions(spec({ mode: 'inherit', overrides }), base, [
      'kept-skill',
      'blocked-skill',
    ]);
    expect(options.settings).toEqual({
      deniedMcpServers: [{ serverName: 'blocked' }],
      enabledPlugins: { 'blocked@market': false },
      disableAllHooks: true,
      disableClaudeAiConnectors: true,
      permissions: { deny: ['Skill(blocked-skill)'] },
    });
    expect(options.skills).toEqual(['kept-skill']);
    expect(options).not.toHaveProperty('strictMcpConfig');
    expect(options).not.toHaveProperty('mcpServers');
  });

  it('denies an excluded skill before approval while retaining path guards and unrelated approval', async () => {
    const input = spec({ mode: 'inherit', overrides });
    input.sandbox = {
      writable_roots: [input.cwd],
      protected_entries: [{ path: '/private/native-state', deny: 'read_write' }],
    };
    const request = vi.fn(async (_tool, toolInput) => ({
      behavior: 'allow' as const,
      updatedInput: toolInput,
    }));
    const options = buildClaudeOptions(input, base, ['kept-skill', 'blocked-skill'], request);
    expect(options.settings).toMatchObject({
      permissions: {
        deny: [
          'Skill(blocked-skill)',
          'Read(//private/native-state)',
          'Read(//private/native-state/**)',
          // On Linux an Edit rule for a missing path outside the writable roots is left out.
          ...(process.platform === 'linux'
            ? []
            : ['Edit(//private/native-state)', 'Edit(//private/native-state/**)']),
        ],
      },
    });
    const permission = {
      signal: new AbortController().signal,
      toolUseID: 'skill-call',
      requestId: 'skill-call',
    };
    expect(
      await options.canUseTool!('Skill', { skill: 'blocked-skill' }, permission),
    ).toMatchObject({ behavior: 'deny' });
    expect(request).not.toHaveBeenCalled();
    expect(
      await options.canUseTool!('Read', { file_path: '/private/native-state/token' }, permission),
    ).toMatchObject({ behavior: 'deny' });
    expect(request).not.toHaveBeenCalled();
    expect(await options.canUseTool!('Skill', { skill: 'kept-skill' }, permission)).toMatchObject({
      behavior: 'allow',
    });
    expect(request).not.toHaveBeenCalled();
    expect(await options.canUseTool!('mcp__x__y', {}, permission)).toMatchObject({
      behavior: 'allow',
    });
    expect(request).toHaveBeenCalledOnce();
    expect(
      await options.canUseTool!('Read', { file_path: `${input.cwd}/README.md` }, permission),
    ).toMatchObject({ behavior: 'allow' });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([undefined, { mode: 'none' } as const])('isolates %j extensions', (extensions) => {
    const options = buildClaudeOptions(spec(extensions), base);
    expect(options).toMatchObject({
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      tools: [],
      permissionMode: 'dontAsk',
    });
  });

  it.each([{ mode: 'inherit', overrides }, { mode: 'none' }] as const)(
    'routes every tool through canUseTool in $mode mode even with user hooks disabled',
    async (extensions) => {
      const options = buildClaudeOptions(spec(extensions), base);
      const matchers = options.hooks?.PreToolUse;
      expect(matchers).toHaveLength(1);
      expect(matchers![0]?.matcher).toBeUndefined();
      for (const tool_name of ['Bash', 'Read', 'mcp__server__tool', 'ToolSearch']) {
        const input = {
          hook_event_name: 'PreToolUse',
          tool_name,
          tool_input: {},
          tool_use_id: 'call',
          session_id: 'native',
          transcript_path: '',
          cwd: process.cwd(),
        } as const;
        expect(
          await matchers![0]!.hooks[0]!(input, 'call', { signal: new AbortController().signal }),
        ).toEqual({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: expect.any(String),
          },
        });
        expect(
          await options.canUseTool!(
            tool_name,
            {},
            { signal: new AbortController().signal, toolUseID: 'call', requestId: 'call' },
          ),
        ).toMatchObject({ behavior: 'deny' });
      }
    },
  );
});

const privateValue = 'private-configuration-do-not-return';
function fakeQuery(fail = false, userLevel = false, connectors = false) {
  const streams: ReturnType<typeof makeStream>[] = [];
  const mutation = vi.fn(() => {
    throw new Error('User configuration must not be written');
  });
  const prompts: (string | AsyncIterable<SDKUserMessage>)[] = [];
  const options: Options[] = [];
  const inputReads: Promise<IteratorResult<SDKUserMessage>>[] = [];
  function makeStream(
    opts: Options,
    prompt: string | AsyncIterable<SDKUserMessage>,
    inputResults: IteratorResult<SDKUserMessage>[],
    inputRead?: Promise<IteratorResult<SDKUserMessage>>,
  ) {
    const inherit = opts.settingSources?.includes('user');
    const settings = typeof opts.settings === 'object' ? opts.settings : {};
    const servers = inherit
      ? [
          {
            name: 'kept',
            status: 'connected',
            config: { command: privateValue, args: [privateValue], env: { TOKEN: privateValue } },
          },
          ...(!settings.deniedMcpServers?.length ? [{ name: 'blocked', status: 'connected' }] : []),
          { name: 'offline', status: 'failed', error: privateValue },
          { name: 'disabled', status: 'disabled' },
          ...(!settings.disableClaudeAiConnectors
            ? [
                {
                  name: 'connector',
                  status: 'connected',
                  scope: 'claudeai',
                  config: { url: privateValue },
                },
              ]
            : []),
          ...(connectors && !settings.disableClaudeAiConnectors
            ? [
                { name: 'claude.ai Gmail', status: 'connected', scope: 'claudeai' },
                { name: 'claude.ai Drive', status: 'connected', source: 'claudeai' },
              ].filter(
                (server) =>
                  !settings.deniedMcpServers?.some((entry) => entry.serverName === server.name),
              )
            : []),
          ...(userLevel
            ? [
                ...(settings.deniedMcpServers?.some((entry) => entry.serverName === 'personal')
                  ? []
                  : [{ name: 'personal', status: 'connected', scope: 'user' }]),
                { name: 'repository', status: 'connected', scope: 'project' },
              ]
            : []),
        ]
      : [];
    for (const [name, config] of Object.entries(opts.mcpServers ?? {}))
      servers.push({ name, status: 'connected', config } as (typeof servers)[number]);
    const plugins = inherit
      ? [
          { name: 'kept', source: 'kept@market', path: privateValue },
          { name: 'builtin', source: 'builtin@builtin', path: privateValue },
          ...(settings.enabledPlugins?.['blocked@market'] === false
            ? []
            : [{ name: 'blocked', source: 'blocked@market', path: privateValue }]),
        ]
      : [];
    // system/init reports discovered skills even when initialize.skills excludes one.
    const skills = inherit
      ? ['kept-skill', 'blocked-skill', ...(userLevel ? ['personal-skill'] : [])]
      : [];
    return {
      close: vi.fn(),
      initializationResult: vi.fn(async () => {
        if (fail) throw new Error(privateValue);
        await Promise.resolve();
        if (typeof prompt !== 'string') expect(inputResults).toEqual([]);
        return {
          commands: [],
          hooks_applied: true,
          account: {
            token: privateValue,
            subscriptionType: 'max',
            apiProvider: 'firstParty',
          },
        };
      }),
      mcpServerStatus: vi.fn(async () => servers),
      reloadPlugins: vi.fn(async () => ({ plugins, commands: [], mcpServers: servers })),
      supportedCommands: vi.fn(async () => [
        ...skills.map((name) => ({ name, description: privateValue, argumentHint: privateValue })),
        { name: 'help', builtin: true, description: privateValue, argumentHint: '' },
      ]),
      // The context breakdown lists only the skills the model can call, and omits them when there are none.
      getContextUsage: vi.fn(async () => {
        const callable = opts.skills
          ? skills.filter((name) => opts.skills!.includes(name))
          : skills;
        return callable.length
          ? {
              skills: {
                skillFrontmatter: callable.map((name) => ({
                  name,
                  source: name === 'personal-skill' ? 'userSettings' : 'projectSettings',
                  path: privateValue,
                  tokens: 1,
                })),
              },
            }
          : {};
      }),
      toggleMcpServer: mutation,
      updateSettings: mutation,
      async *[Symbol.asyncIterator]() {
        if (typeof prompt !== 'string' && (await inputRead)!.done)
          throw new Error('Inventory must use control requests, not consume model messages');
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'native',
          skills,
          plugins,
          mcp_servers: servers,
          tools: [],
        };
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'native',
          skills,
          plugins,
          mcp_servers: servers,
          tools: [],
        };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: 0,
        };
      },
    };
  }
  const query = vi.fn(
    (args: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
      prompts.push(args.prompt);
      options.push(args.options!);
      const inputResults: IteratorResult<SDKUserMessage>[] = [];
      let inputRead: Promise<IteratorResult<SDKUserMessage>> | undefined;
      if (typeof args.prompt !== 'string') {
        inputRead = args.prompt[Symbol.asyncIterator]()
          .next()
          .then((result) => {
            inputResults.push(result);
            return result;
          });
        inputReads.push(inputRead);
      }
      const stream = makeStream(args.options!, args.prompt, inputResults, inputRead);
      streams.push(stream);
      return stream;
    },
  );
  const adapter = new ClaudeAdapter('fake-claude', 'test', query as never);
  return { adapter, query, streams, prompts, options, mutation, inputReads };
}

describe('Claude extension discovery', () => {
  it('uses a prompt-free session, disables user hooks, and returns only identifiers', async () => {
    const f = fakeQuery();
    const result = await f.adapter.inventory(process.cwd());
    expect(f.query).toHaveBeenCalledOnce();
    expect(typeof f.prompts[0]).not.toBe('string');
    expect(await Promise.all(f.inputReads)).toEqual([{ done: true, value: undefined }]);
    const input = f.prompts[0] as AsyncIterable<SDKUserMessage>;
    expect(await input[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    expect(f.options[0]).toMatchObject({
      settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true },
      tools: ['Skill'],
    });
    expect(f.options[0]).not.toHaveProperty('strictMcpConfig');
    expect(result).toEqual({
      runtime: 'claude',
      mcp_servers: [
        { name: 'kept', enabled: true },
        { name: 'blocked', enabled: true },
        { name: 'offline', enabled: true },
        { name: 'disabled', enabled: false },
      ],
      plugins: [
        { id: 'kept@market', enabled: true },
        { id: 'builtin@builtin', enabled: true },
        { id: 'blocked@market', enabled: true },
      ],
      skills: [
        { id: 'kept-skill', name: 'kept-skill', enabled: true },
        { id: 'blocked-skill', name: 'blocked-skill', enabled: true },
      ],
      apps: true,
      connectors: [{ name: 'connector', enabled: true }],
      hooks: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|command|args|env|headers|url|token/i);
    for (const name of [
      'initializationResult',
      'mcpServerStatus',
      'reloadPlugins',
      'supportedCommands',
    ] as const)
      expect(f.streams[0]![name]).toHaveBeenCalledOnce();
    expect(f.streams[0]?.close).toHaveBeenCalledOnce();
    expect(f.mutation).not.toHaveBeenCalled();
  });

  it('closes inventory and preserves the SDK error message', async () => {
    const f = fakeQuery(true);
    await expect(f.adapter.inventory(process.cwd())).rejects.toThrow(privateValue);
    expect(f.streams[0]?.close).toHaveBeenCalledOnce();
    expect(f.mutation).not.toHaveBeenCalled();
  });

  it.each(['start', 'resume'] as const)(
    'reports the skills in the model context, not native discovery, as loaded on %s',
    async (method) => {
      const f = fakeQuery(),
        events: AgentEvent[] = [];
      const input = spec({ mode: 'inherit', overrides });
      let done!: () => void;
      const completed = new Promise<void>((resolve) => {
        done = resolve;
      });
      const sink = (event: AgentEvent) => {
        events.push(event);
        if (event.kind === 'turn.completed') done();
      };
      const handle =
        method === 'start'
          ? await f.adapter.start(input, sink)
          : await f.adapter.resume(input, 'previous', sink);
      await f.adapter.send(handle, { turn_id: 'turn', input: 'hello' });
      await completed;
      expect(events.at(-1)).toMatchObject({ kind: 'turn.completed', status: 'completed' });
      expect(f.query).toHaveBeenCalledTimes(2);
      expect(typeof f.prompts[0]).not.toBe('string');
      expect(typeof f.prompts[1]).not.toBe('string');
      expect(await f.inputReads[1]).toMatchObject({
        done: false,
        value: { type: 'user', message: { role: 'user', content: 'hello' } },
      });
      expect(f.options[1]?.skills).toEqual(['kept-skill']);
      expect(f.options[1]?.settings).toMatchObject({
        permissions: { deny: ['Skill(blocked-skill)'] },
      });
      expect(f.options[1]?.resume).toBe(method === 'resume' ? 'previous' : undefined);
      expect(events.filter((event) => event.kind === 'extensions.applied')).toEqual([
        expect.objectContaining({
          mode: 'inherit',
          disabled: {
            mcp_servers: ['blocked'],
            plugins: ['blocked@market'],
            skills: ['blocked-skill'],
            apps: true,
            hooks: true,
          },
          configured_skills: {
            allowlist: ['kept-skill'],
            denied: ['Skill(blocked-skill)'],
            source: 'sdk_options_and_permission_rules',
          },
          loaded: {
            mcp_servers: ['kept'],
            plugins: ['kept@market', 'builtin@builtin'],
            skills: ['kept-skill'],
            apps: false,
            hooks: false,
          },
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain(privateValue);
      expect(f.mutation).not.toHaveBeenCalled();
      for (const stream of f.streams) expect(stream.close).toHaveBeenCalledOnce();
      await f.adapter.close(handle, Date.now() + 1000);
    },
  );

  it('reports no loaded skill when the project turned every listed skill off', async () => {
    const f = fakeQuery(),
      events: AgentEvent[] = [];
    let done!: () => void;
    const completed = new Promise<void>((resolve) => {
      done = resolve;
    });
    const handle = await f.adapter.start(
      spec({
        mode: 'inherit',
        overrides: { ...overrides, disabled_skills: ['kept-skill', 'blocked-skill'] },
      }),
      (event) => {
        events.push(event);
        if (event.kind === 'turn.completed') done();
      },
    );
    await f.adapter.send(handle, { turn_id: 'turn', input: 'hello' });
    await completed;
    expect(f.options[1]?.skills).toEqual([]);
    expect(events.find((event) => event.kind === 'extensions.applied')).toMatchObject({
      loaded: { skills: [] },
    });
    await f.adapter.close(handle, Date.now() + 1000);
  });

  it('keeps the servers, plugins and apps a session disables off while listing its skills', async () => {
    const f = fakeQuery();
    const handle = await f.adapter.start(spec({ mode: 'inherit', overrides }), () => {});
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.options[0]?.settings).toEqual({
      deniedMcpServers: [{ serverName: 'blocked' }],
      enabledPlugins: { 'blocked@market': false },
      disableAllHooks: true,
      disableClaudeAiConnectors: true,
    });
    expect(f.options[0]).not.toHaveProperty('skills');
    expect(f.options[1]?.skills).toEqual(['kept-skill']);
    await f.adapter.close(handle, Date.now() + 1000);
  });

  it.each([
    ['the protected path', (protectedPath: string) => protectedPath],
    ['a folder holding the protected path', (protectedPath: string) => path.dirname(protectedPath)],
    ['a path inside the protected path', (protectedPath: string) => `${protectedPath}/token`],
  ])(
    'refuses a sandboxed session whose inherited settings re-allow reading %s',
    async (_name, allowed) => {
      const protectedPath = path.join(os.tmpdir(), 'pantheon-protected-data');
      const input = spec({ mode: 'inherit', overrides: empty });
      input.sandbox = {
        writable_roots: [input.cwd],
        protected_entries: [{ path: protectedPath, deny: 'read_write' }],
      };
      vi.mocked(resolveSettings).mockResolvedValueOnce({
        effective: {},
        provenance: {},
        sources: [
          {
            source: 'user',
            path: path.join(os.homedir(), '.claude/settings.json'),
            settings: {
              sandbox: { filesystem: { allowRead: ['~/notes', allowed(protectedPath)] } },
            },
          },
        ],
      });
      const f = fakeQuery();
      await expect(f.adapter.start(input, () => {})).rejects.toMatchObject({
        code: 'protected_read_allowed',
      });
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'an allowWrite outside the writable roots',
      { sandbox: { filesystem: { allowWrite: ['~/elsewhere'] } } },
      'sandbox.filesystem.allowWrite "~/elsewhere"',
    ],
    [
      'an excluded command',
      { sandbox: { excludedCommands: ['docker *'] } },
      'sandbox.excludedCommands "docker *"',
    ],
    [
      'an Edit allow rule outside the writable roots',
      { permissions: { allow: ['Edit(//etc/**)'] } },
      'permissions.allow "Edit(//etc/**)"',
    ],
    [
      'an Edit allow rule for every path',
      { permissions: { allow: ['Edit'] } },
      'permissions.allow "Edit"',
    ],
  ])(
    'refuses a sandboxed session whose inherited settings widen it with %s',
    async (_, settings, rule) => {
      const input = spec({ mode: 'inherit', overrides: empty });
      input.sandbox = { writable_roots: [input.cwd], protected_entries: [] };
      const file = path.join(os.homedir(), '.claude/settings.json');
      vi.mocked(resolveSettings).mockResolvedValueOnce({
        effective: {},
        provenance: {},
        sources: [{ source: 'user', path: file, settings }],
      });
      const f = fakeQuery();
      await expect(f.adapter.start(input, () => {})).rejects.toMatchObject({
        code: 'sandbox_widened',
        message: expect.stringContaining(`${rule} in ${file}`),
      });
      expect(f.query).not.toHaveBeenCalled();
    },
  );

  it('starts a sandboxed session whose inherited write rules stay inside its writable roots', async () => {
    const input = spec({ mode: 'inherit', overrides: empty });
    input.sandbox = { writable_roots: [input.cwd], protected_entries: [] };
    vi.mocked(resolveSettings).mockResolvedValueOnce({
      effective: {},
      provenance: {},
      sources: [
        {
          source: 'project',
          path: path.join(input.cwd, '.claude/settings.json'),
          settings: {
            sandbox: { filesystem: { allowWrite: ['./build'] } },
            permissions: { allow: ['Edit(src/**)', 'Edit(/docs/**)', 'Read(//etc/**)'] },
          },
        },
        {
          source: 'managed',
          path: '/etc/claude-code/managed-settings.json',
          settings: { sandbox: { excludedCommands: ['docker *'] } },
        },
      ],
    });
    const f = fakeQuery();
    const handle = await f.adapter.start(input, () => {});
    await f.adapter.close(handle, Date.now() + 1000);
  });

  it('starts a sandboxed session whose inherited settings re-allow reading elsewhere', async () => {
    const input = spec({ mode: 'inherit', overrides: empty });
    input.sandbox = {
      writable_roots: [input.cwd],
      protected_entries: [
        { path: path.join(os.tmpdir(), 'pantheon-protected-data'), deny: 'read_write' },
      ],
    };
    vi.mocked(resolveSettings).mockResolvedValueOnce({
      effective: {},
      provenance: {},
      sources: [
        {
          source: 'user',
          path: path.join(os.homedir(), '.claude/settings.json'),
          settings: { sandbox: { filesystem: { allowRead: ['~/notes'] } } },
        },
      ],
    });
    const f = fakeQuery();
    const handle = await f.adapter.start(input, () => {});
    expect(f.query).toHaveBeenCalledOnce();
    await f.adapter.close(handle, Date.now() + 1000);
  });

  it('completes the turn when reading the extensions it loaded fails', async () => {
    const f = fakeQuery(),
      events: AgentEvent[] = [];
    const completed = Promise.withResolvers<void>();
    const handle = await f.adapter.start(spec({ mode: 'inherit', overrides: empty }), (event) => {
      events.push(event);
      if (event.kind === 'turn.completed') completed.resolve();
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      f.streams.at(-1)!.reloadPlugins.mockRejectedValue(new Error('plugins unavailable'));
      await f.adapter.send(handle, { turn_id: 'turn', input: 'hello' });
      await completed.promise;
      expect(events.find((event) => event.kind === 'turn.completed')).toMatchObject({
        status: 'completed',
      });
      expect(warn).toHaveBeenCalledWith(
        'Claude loaded extensions were not read:',
        'plugins unavailable',
      );
    } finally {
      warn.mockRestore();
      await f.adapter.close(handle, Date.now() + 1000);
    }
  });

  it('records isolation without doing inheritance discovery', async () => {
    const f = fakeQuery(),
      events: AgentEvent[] = [];
    let done!: () => void;
    const completed = new Promise<void>((resolve) => {
      done = resolve;
    });
    const handle = await f.adapter.start(spec({ mode: 'none' }), (event) => {
      events.push(event);
      if (event.kind === 'turn.completed') done();
    });
    await f.adapter.send(handle, { turn_id: 'turn', input: 'hello' });
    await completed;
    expect(f.query).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.kind === 'extensions.applied')).toEqual([
      expect.objectContaining({
        mode: 'none',
        loaded: { mcp_servers: [], plugins: [], skills: [], apps: false, hooks: false },
      }),
    ]);
    expect(f.mutation).not.toHaveBeenCalled();
    await f.adapter.close(handle, Date.now() + 1000);
  });
});

it.each([
  { name: 'denies', opened: [] as string[] },
  { name: 'keeps', opened: ['personal'] },
])(
  '$name the user-level MCP server and skill by whether the project opened them',
  async ({ opened }) => {
    // The listing probe of an in-place session also denies the unopened servers of the real home.
    const home = mkdtempSync(path.join(os.tmpdir(), 'pantheon-claude-empty-home-'));
    vi.stubEnv('HOME', home);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });
    const f = fakeQuery(false, true);
    const events: AgentEvent[] = [];
    const completed = Promise.withResolvers<void>();
    const closed = opened.length === 0;
    const handle = await f.adapter.start(
      spec({
        mode: 'inherit',
        overrides: {
          ...empty,
          enabled_user_mcp_servers: opened,
          enabled_user_skills: closed ? [] : ['personal-skill'],
        },
      }),
      (event) => {
        events.push(event);
        if (event.kind === 'turn.completed') completed.resolve();
      },
    );
    try {
      await f.adapter.send(handle, { turn_id: 'user-level-turn', input: 'hello' });
      await completed.promise;
      expect(f.query).toHaveBeenCalledTimes(2);
      expect(f.options[1]?.settings).toEqual(
        closed
          ? {
              deniedMcpServers: [{ serverName: 'personal' }],
              permissions: { deny: ['Skill(personal-skill)'] },
            }
          : undefined,
      );
      expect(f.options[1]?.skills).toEqual(closed ? ['kept-skill', 'blocked-skill'] : undefined);
      const applied = events.find((event) => event.kind === 'extensions.applied');
      expect(applied).toMatchObject({
        disabled: {
          mcp_servers: closed ? ['personal'] : [],
          skills: closed ? ['personal-skill'] : [],
        },
      });
      const loaded = applied?.kind === 'extensions.applied' ? applied.loaded.mcp_servers : [];
      expect(loaded).toContain('repository');
      expect(loaded.includes('personal')).toBe(!closed);
    } finally {
      await f.adapter.close(handle, Date.now() + 1000);
    }
  },
);

describe('Claude extension listing per session', () => {
  // A managed session reads the user-level items of the home it projects.
  let emptyHome = '';
  beforeEach(() => {
    emptyHome = mkdtempSync(path.join(os.tmpdir(), 'pantheon-claude-empty-home-'));
    vi.stubEnv('HOME', emptyHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(emptyHome, { recursive: true, force: true });
  });
  const projectOverrides = (opened: string[]): ExtensionOverrides => ({
    ...empty,
    disable_apps: !opened.length,
    enabled_user_mcp_servers: [],
    enabled_user_skills: [],
    enabled_user_connectors: opened,
  });
  const listings = (f: ReturnType<typeof fakeQuery>) =>
    f.options.filter((options) => JSON.stringify(options.tools) === '["Skill"]').length;
  async function twoTurns(f: ReturnType<typeof fakeQuery>, input: SessionSpec) {
    let completed = Promise.withResolvers<void>();
    const handle = await f.adapter.start(input, (event) => {
      if (event.kind === 'turn.completed') completed.resolve();
    });
    try {
      for (const turn_id of ['first-listing-turn', 'second-listing-turn']) {
        completed = Promise.withResolvers<void>();
        await f.adapter.send(handle, { turn_id, input: 'hello' });
        await completed.promise;
        await vi.waitFor(() => expect(f.streams.at(-1)!.close).toHaveBeenCalled());
      }
    } finally {
      await f.adapter.close(handle, Date.now() + 1000);
    }
  }
  const managed = (overrides: ExtensionOverrides) => ({
    ...spec({ mode: 'inherit', overrides }),
    native_state_dir: mkdtempSync(path.join(os.tmpdir(), 'pantheon-claude-listing-')),
  });

  it('does not list for a managed session that opens no connector', async () => {
    const f = fakeQuery(false, true);
    const input = managed(projectOverrides([]));
    try {
      await twoTurns(f, input);
      expect(f.query).toHaveBeenCalledTimes(2);
      expect(listings(f)).toBe(0);
      expect(f.options.at(-1)?.settings).toEqual({ disableClaudeAiConnectors: true });
      expect(f.options.at(-1)).not.toHaveProperty('skills');
    } finally {
      rmSync(input.native_state_dir, { recursive: true, force: true });
    }
  });

  it('lists for every query of a managed session that opens a connector', async () => {
    const f = fakeQuery(false, true, true);
    const input = managed(projectOverrides(['claude.ai Gmail']));
    try {
      await twoTurns(f, input);
      expect(f.query).toHaveBeenCalledTimes(4);
      expect(listings(f)).toBe(2);
      expect(f.options.at(-1)?.settings).toEqual({
        deniedMcpServers: [{ serverName: 'connector' }, { serverName: 'claude.ai Drive' }],
      });
    } finally {
      rmSync(input.native_state_dir, { recursive: true, force: true });
    }
  });

  it('starts the turn with every connector off when listing times out', async () => {
    const f = fakeQuery(false, true, true);
    const listing = vi
      .spyOn(f.adapter, 'inventory')
      .mockRejectedValue(new Error('Inventory deadline exceeded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const input = managed(projectOverrides(['claude.ai Gmail']));
    try {
      await twoTurns(f, input);
      expect(listing).toHaveBeenCalledTimes(2);
      expect(f.query).toHaveBeenCalledTimes(2);
      for (const options of f.options)
        expect(options.settings).toEqual({ disableClaudeAiConnectors: true });
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('Inventory deadline exceeded'),
      );
    } finally {
      warn.mockRestore();
      rmSync(input.native_state_dir, { recursive: true, force: true });
    }
  });

  it('lists for every query of an in-place session and closes the user-level items it did not open', async () => {
    const f = fakeQuery(false, true);
    await twoTurns(f, spec({ mode: 'inherit', overrides: projectOverrides([]) }));
    expect(f.query).toHaveBeenCalledTimes(4);
    expect(listings(f)).toBe(2);
    expect(f.options.at(-1)?.settings).toEqual({
      deniedMcpServers: [{ serverName: 'personal' }],
      permissions: { deny: ['Skill(personal-skill)'] },
      disableClaudeAiConnectors: true,
    });
  });

  it('lists again for a rebuilt query, so a user-level server added meanwhile stays closed', async () => {
    const f = fakeQuery();
    const listed = (names: string[]) => ({
      runtime: 'claude',
      mcp_servers: names.map((name) => ({ name, enabled: true, user: true })),
      plugins: [],
      skills: [],
      apps: false,
      connectors: [],
      hooks: [],
    });
    const listing = vi
      .spyOn(f.adapter, 'inventory')
      .mockResolvedValueOnce(listed(['personal']))
      .mockResolvedValue(listed(['personal', 'newcomer']));
    await twoTurns(f, spec({ mode: 'inherit', overrides: projectOverrides([]) }));
    expect(listing).toHaveBeenCalledTimes(2);
    expect(f.options.at(-1)?.settings).toMatchObject({
      deniedMcpServers: [{ serverName: 'personal' }, { serverName: 'newcomer' }],
    });
  });

  it('denies the user-level servers and skills a managed session did not open, apart from its shared folder', async () => {
    const f = fakeQuery();
    const home = mkdtempSync(path.join(os.tmpdir(), 'pantheon-claude-home-'));
    mkdirSync(path.join(home, '.claude', 'skills', 'personal-skill'), { recursive: true });
    mkdirSync(path.join(home, '.claude', 'skills', 'other-skill'), { recursive: true });
    writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { personal: {}, other: {} },
        projects: { [process.cwd()]: { mcpServers: { local: {} } } },
      }),
    );
    vi.stubEnv('HOME', home);
    const input = managed({
      ...projectOverrides([]),
      enabled_user_mcp_servers: ['other'],
      enabled_user_skills: ['other-skill'],
    });
    try {
      await twoTurns(f, input);
      expect(listings(f)).toBe(0);
      expect(f.options.at(-1)?.settings).toEqual({
        deniedMcpServers: [{ serverName: 'personal' }, { serverName: 'local' }],
        permissions: { deny: ['Skill(personal-skill)'] },
        disableClaudeAiConnectors: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(input.native_state_dir, { recursive: true, force: true });
    }
  });

  it('keeps the user-level servers an in-place session did not open from starting for its listing', async () => {
    const f = fakeQuery(false, true);
    writeFileSync(
      path.join(emptyHome, '.claude.json'),
      JSON.stringify({ mcpServers: { personal: {} } }),
    );
    await twoTurns(f, spec({ mode: 'inherit', overrides: projectOverrides([]) }));
    const probes = f.options.filter((options) => JSON.stringify(options.tools) === '["Skill"]');
    expect(probes).toHaveLength(2);
    for (const probe of probes)
      expect(probe.settings).toMatchObject({ deniedMcpServers: [{ serverName: 'personal' }] });
    expect(f.options.at(-1)?.settings).toEqual({
      deniedMcpServers: [{ serverName: 'personal' }],
      permissions: { deny: ['Skill(personal-skill)'] },
      disableClaudeAiConnectors: true,
    });
  });

  it('closes only the local servers of its own folder and source repository for a managed worktree session', async () => {
    const f = fakeQuery();
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-claude-worktree-')));
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'worktree');
    mkdirSync(path.join(repo, '.git', 'worktrees', 'worktree'), { recursive: true });
    mkdirSync(worktree);
    writeFileSync(
      path.join(worktree, '.git'),
      `gitdir: ${path.join(repo, '.git', 'worktrees', 'worktree')}\n`,
    );
    writeFileSync(
      path.join(emptyHome, '.claude.json'),
      JSON.stringify({
        mcpServers: { personal: {} },
        projects: {
          [repo]: { mcpServers: { 'repository-local': {} } },
          [path.join(root, 'unrelated')]: { mcpServers: { github: {} } },
        },
      }),
    );
    const input = { ...managed(projectOverrides([])), cwd: worktree };
    try {
      await twoTurns(f, input);
      expect(f.options.at(-1)?.settings).toEqual({
        deniedMcpServers: [{ serverName: 'personal' }, { serverName: 'repository-local' }],
        disableClaudeAiConnectors: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(input.native_state_dir, { recursive: true, force: true });
    }
  });

  it('refuses to start an in-place session whose listing fails, and lists again next time', async () => {
    const f = fakeQuery(false, true);
    const listing = vi
      .spyOn(f.adapter, 'inventory')
      .mockRejectedValueOnce(new Error('Inventory deadline exceeded'));
    const input = spec({ mode: 'inherit', overrides: projectOverrides([]) });
    await expect(f.adapter.start(input, () => {})).rejects.toThrow('Inventory deadline exceeded');
    const handle = await f.adapter.start(input, () => {});
    await f.adapter.close(handle, Date.now() + 1000);
    expect(listing).toHaveBeenCalledTimes(2);
  });
});

it('lists the claude.ai connectors apart from the MCP servers', async () => {
  const f = fakeQuery(false, false, true);
  const result = await f.adapter.inventory(process.cwd());
  expect(result.connectors).toEqual([
    { name: 'connector', enabled: true },
    { name: 'claude.ai Gmail', enabled: true },
    { name: 'claude.ai Drive', enabled: true },
  ]);
  expect(result.mcp_servers.map((server) => server.name)).toEqual([
    'kept',
    'blocked',
    'offline',
    'disabled',
  ]);
});

it.each([
  {
    name: 'denies by name the connectors the project did not open',
    opened: ['claude.ai Gmail'],
    settings: {
      deniedMcpServers: [{ serverName: 'connector' }, { serverName: 'claude.ai Drive' }],
    },
    loaded: ['claude.ai Gmail'],
  },
  {
    name: 'shuts every connector when the project opened none',
    opened: [],
    settings: { disableClaudeAiConnectors: true },
    loaded: [],
  },
])('$name', async ({ opened, settings, loaded }) => {
  const f = fakeQuery(false, false, true);
  const events: AgentEvent[] = [];
  const completed = Promise.withResolvers<void>();
  const handle = await f.adapter.start(
    spec({ mode: 'inherit', overrides: { ...empty, enabled_user_connectors: opened } }),
    (event) => {
      events.push(event);
      if (event.kind === 'turn.completed') completed.resolve();
    },
  );
  try {
    await f.adapter.send(handle, { turn_id: 'connector-list-turn', input: 'hello' });
    await completed.promise;
    expect(f.options.at(-1)?.settings).toEqual(settings);
    const applied = events.find((event) => event.kind === 'extensions.applied');
    const servers = applied?.kind === 'extensions.applied' ? applied.loaded.mcp_servers : [];
    expect(servers.filter((name) => name.startsWith('claude.ai'))).toEqual(loaded);
    expect(f.mutation).not.toHaveBeenCalled();
  } finally {
    await f.adapter.close(handle, Date.now() + 1000);
  }
});

it('recognizes scope-only Claude connectors in the applied receipt', async () => {
  const f = fakeQuery();
  const events: AgentEvent[] = [];
  const completed = Promise.withResolvers<void>();
  const handle = await f.adapter.start(spec({ mode: 'inherit', overrides: empty }), (event) => {
    events.push(event);
    if (event.kind === 'turn.completed') completed.resolve();
  });
  try {
    await f.adapter.send(handle, {
      turn_id: 'connector-turn',
      input: 'hello',
    });
    await completed.promise;
    expect(events.find((event) => event.kind === 'extensions.applied')).toMatchObject({
      loaded: { apps: true },
    });
  } finally {
    await f.adapter.close(handle, Date.now() + 1000);
  }
});

it.each([true, false])(
  'reports Claude hooks enablement as %s before the inventory override',
  async (enabled) => {
    vi.mocked(resolveSettings).mockResolvedValueOnce({
      effective: { disableAllHooks: !enabled },
      provenance: {},
      sources: [],
    });
    const f = fakeQuery();
    const inventory = await f.adapter.inventory(process.cwd());
    expect(inventory).toHaveProperty('hooks_enabled', enabled);
    expect(f.options[0]?.settings).toMatchObject({ disableAllHooks: true });
  },
);

it.each(['writer', 'reviewer', 'planner'] as const)(
  'mounts the Pantheon MCP channel for a %s without passing its token file to the runtime or asking permission',
  async (role) => {
    const input = spec(
      role === 'reviewer' ? { mode: 'none' } : { mode: 'inherit', overrides: empty },
    );
    input.role = role;
    input.pantheon_mcp = {
      command: process.execPath,
      args: ['/app/apps/cli/dist/index.js', 'mcp'],
      env: {
        PANTHEON_SESSION_TOKEN_FILE: '/data/session-tokens/session',
        PANTHEON_DAEMON_URL: 'http://127.0.0.1:4321',
      },
    };
    if (role !== 'planner')
      input.sandbox = {
        writable_roots: role === 'writer' ? [input.cwd] : [],
        protected_entries: [],
      };
    const request = vi.fn();
    const options = buildClaudeOptions(input, base, [], request);
    expect(options.mcpServers).toEqual({ pantheon: { type: 'stdio', ...input.pantheon_mcp } });
    expect(options.env).not.toHaveProperty('PANTHEON_SESSION_TOKEN_FILE');
    expect(options.maxTurns).toBeUndefined();
    if (role === 'reviewer') expect(options.strictMcpConfig).toBe(true);
    expect(
      await options.canUseTool!(
        'mcp__pantheon__review_finding',
        { quote: 'quoted' },
        {
          signal: new AbortController().signal,
          toolUseID: 'finding',
          requestId: 'finding',
          mcpServer: { name: 'pantheon', source: 'dynamic' },
        },
      ),
    ).toEqual({ behavior: 'allow', updatedInput: { quote: 'quoted' } });
    expect(request).not.toHaveBeenCalled();
    const f = fakeQuery();
    const events: AgentEvent[] = [];
    const handle = await f.adapter.start(input, (event) => events.push(event));
    await f.adapter.send(handle, {
      turn_id: 'mcp-turn',
      input: 'Use Pantheon',
    });
    await vi.waitFor(() =>
      expect(events.some((event) => event.kind === 'extensions.applied')).toBe(true),
    );
    expect(events.find((event) => event.kind === 'extensions.applied')).toMatchObject({
      loaded: { mcp_servers: expect.arrayContaining(['pantheon']) },
    });
    await f.adapter.close(handle, Date.now() + 1000);
  },
);

it('mounts the MCP servers a session names next to the Pantheon channel and does not deny them', () => {
  const input = spec({
    mode: 'inherit',
    overrides: { ...empty, disabled_mcp_servers: ['chrome_devtools', 'blocked'] },
  });
  input.pantheon_mcp = { command: 'pantheon-mcp', args: ['mcp'], env: {} };
  input.mcp_servers = [
    { name: 'chrome_devtools', command: 'npx', args: ['-y', 'devtools'], env: { A: '1' } },
  ];
  const options = buildClaudeOptions(input, base);
  expect(options.mcpServers).toEqual({
    pantheon: { type: 'stdio', command: 'pantheon-mcp', args: ['mcp'], env: {} },
    chrome_devtools: { type: 'stdio', command: 'npx', args: ['-y', 'devtools'], env: { A: '1' } },
  });
  expect(options.settings).toMatchObject({ deniedMcpServers: [{ serverName: 'blocked' }] });
});
