import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AcpAdapter, acpProfiles, type AcpProfile, readProcessIdentity } from '@pantheon/adapters';
import {
  NATIVE_ENV_ALLOWLIST,
  SessionStartError,
  type AgentEvent,
  type HarnessAdapter,
  type SessionHandle,
  type SessionSpec,
} from '@pantheon/domain';

const server = fileURLToPath(new URL('./fake-acp-server.mjs', import.meta.url));
const roots: string[] = [];
const open: { adapter: AcpAdapter; handle: SessionHandle }[] = [];

type Frame = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: { outcome?: { outcome: string; optionId?: string } };
};

function setup(
  env: Record<string, string> = {},
  requestTimeoutMs?: number,
  profile: Partial<AcpProfile> = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-acp-'));
  roots.push(root);
  const log = path.join(root, 'frames.jsonl');
  const spec: SessionSpec = {
    platform_session_id: 'acp-session',
    project_id: 'acp-project',
    runtime: 'scripted-acp',
    device_id: 'local',
    role: 'writer',
    cwd: root,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    env: { FAKE_ACP_LOG: log, ...env },
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 60000 },
  };
  const adapter = new AcpAdapter({
    name: 'scripted-acp',
    binary: process.execPath,
    args: [server],
    profile: { binary: process.execPath, args: [], resume: 'resume', ...profile },
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  const events: AgentEvent[] = [];
  const frames = (): Frame[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Frame)
      : [];
  const start = async (resumeId?: string) => {
    const handle =
      resumeId === undefined
        ? await adapter.start(spec, (event) => events.push(event))
        : await adapter.resume(spec, resumeId, (event) => events.push(event));
    open.push({ adapter, handle });
    return handle;
  };
  const completions = () => events.filter((event) => event.kind === 'turn.completed');
  const ofTurn = (turn_id: string) => events.filter((event) => event.turn_id === turn_id);
  return { adapter, spec, events, frames, start, completions, ofTurn };
}

afterEach(async () => {
  for (const { adapter, handle } of open.splice(0)) await adapter.close(handle, Date.now() + 5000);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ACP adapter', () => {
  // No live ACP agent has been seen to send session_info_update, so Pantheon names the session.
  it('defines safe spawn profiles for every ACP runtime and appends configured arguments', () => {
    expect(acpProfiles).toMatchObject({
      grok: {
        binary: 'grok',
        args: ['--permission-mode', 'default', 'agent', 'stdio'],
        resume: 'resume',
      },
      agy: { binary: 'agy', args: ['acp'], resume: 'resume' },
      dsh: { binary: 'dsh', args: ['--profile', 'acp'], resume: 'resume' },
      muse: { binary: 'muse', args: ['acp'], resume: 'resume' },
      opencode: { binary: 'opencode', args: ['acp'], resume: 'resume' },
      cursor: { binary: 'cursor-agent', args: ['acp'], resume: 'load' },
      copilot: { binary: 'copilot', args: ['--acp'], resume: 'load' },
      gemini: { binary: 'gemini', args: ['--acp'], resume: 'load' },
      kilo: { binary: 'kilo', args: ['acp'], resume: 'resume' },
      cline: { binary: 'cline', args: ['--acp'], resume: 'load' },
      qwen: { binary: 'qwen', args: ['--acp'], resume: 'resume' },
      kimi: { binary: 'kimi', args: ['acp'], resume: 'resume' },
      goose: { binary: 'goose', args: ['acp'], resume: 'load' },
      openhands: { binary: 'openhands', args: ['acp'], resume: 'load' },
      auggie: { binary: 'auggie', args: ['--acp'], resume: 'load' },
      kiro: { binary: 'kiro-cli', args: ['acp'], resume: 'load' },
      junie: { binary: 'junie', args: ['--acp', 'true'], resume: 'resume' },
      devin: { binary: 'devin', args: ['acp'], resume: 'load' },
      vibe: { binary: 'vibe-acp', args: [], resume: 'load' },
      hermes: { binary: 'hermes', args: ['acp'], resume: 'load' },
      omp: { binary: 'omp', args: ['acp'], resume: 'load' },
      codebuddy: { binary: 'codebuddy', args: ['--acp'], resume: 'load' },
      droid: { binary: 'droid', args: ['exec', '--output-format', 'acp-daemon'], resume: 'resume' },
      qoder: { binary: 'qodercli', args: ['--acp'], resume: 'resume' },
    });
    const adapter = new AcpAdapter({
      name: 'grok',
      profile: acpProfiles.grok!,
      binary: '/opt/grok',
      args: ['--verbose'],
    });
    expect(adapter.binary).toBe('/opt/grok');
    expect(adapter.args).toEqual(['--permission-mode', 'default', 'agent', 'stdio', '--verbose']);
    const defaultAdapter = new AcpAdapter({ name: 'agy', profile: acpProfiles.agy! });
    expect(defaultAdapter.binary).toBe('agy');
    expect(defaultAdapter.args).toEqual(['acp']);
  });

  it('declares neither generated titles nor a question tool', () => {
    const adapter: HarnessAdapter = setup().adapter;
    expect(adapter.generatesTitles).toBeUndefined();
    expect(adapter.questionTool).toBeUndefined();
  });

  it('handshakes with protocol version 1 over JSON-RPC 2.0 and reports the session', async () => {
    const acp = setup();
    const handle = await acp.start();
    const [initialize, created] = acp.frames();
    expect(initialize).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          elicitation: { form: {} },
        },
      },
    });
    expect(created).toMatchObject({
      jsonrpc: '2.0',
      method: 'session/new',
      params: { cwd: acp.spec.cwd, mcpServers: [] },
    });
    expect(acp.events).toEqual([
      expect.objectContaining({
        kind: 'session.started',
        native_session_id: 'fake-session-1',
        reported_model: 'Fake model',
      }),
    ]);
    expect(handle.native_session_id).toBe('fake-session-1');
  });

  it('sends image attachments as ACP image blocks when initialize advertises images', async () => {
    const acp = setup({ FAKE_ACP_IMAGES: 'true' });
    const handle = await acp.start();
    const image = path.join(acp.spec.cwd, 'image.png');
    writeFileSync(image, Buffer.from([137, 80, 78, 71]));
    await acp.adapter.send(handle, {
      turn_id: 'image-turn',
      input: 'text',
      attachments: [{ id: 'image', name: 'image.png', path: image, mime: 'image/png' }],
    });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.frames().find((frame) => frame.method === 'session/prompt')?.params?.prompt).toEqual(
      [
        { type: 'text', text: 'text' },
        { type: 'image', data: 'iVBORw==', mimeType: 'image/png' },
      ],
    );
    expect(acp.adapter.report.capabilities.images?.status).toBe('supported');
  });

  it('rejects image input with a clear code before starting an unsupported turn', async () => {
    const acp = setup();
    const handle = await acp.start();
    await expect(
      acp.adapter.send(handle, {
        turn_id: 'image-turn',
        input: 'text',
        attachments: [
          {
            id: 'image',
            name: 'image.png',
            path: path.join(acp.spec.cwd, 'image.png'),
            mime: 'image/png',
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'unsupported_images',
      message: expect.stringContaining('image'),
    });
    expect(acp.ofTurn('image-turn')).toEqual([]);
    expect(acp.frames().map((frame) => frame.method)).not.toContain('session/prompt');
    expect((await acp.adapter.inspect(handle)).state).toBe('idle');
    expect(acp.adapter.report.capabilities.images?.status).toBe('unsupported');
    await acp.adapter.send(handle, { turn_id: 'text-turn', input: 'text' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
  });

  it('routes vendor requests to the profile and retains method-not-found for unhandled requests', async () => {
    const handleRequest = vi.fn((request: { method: string }) =>
      request.method === 'vendor/question' ? { result: { answer: 'continue' } } : undefined,
    );
    const acp = setup({}, undefined, { handleRequest });
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'vendor-turn', input: 'vendor' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(handleRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'vendor/question',
        params: { sessionId: handle.native_session_id, question: 'Continue?' },
      }),
    );
    expect(acp.frames()).toContainEqual(
      expect.objectContaining({ id: 'agent-1', result: { answer: 'continue' } }),
    );
    handleRequest.mockReturnValue(undefined);
    await acp.adapter.send(handle, { turn_id: 'unhandled-turn', input: 'vendor' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(2));
    expect(acp.frames()).toContainEqual(
      expect.objectContaining({
        id: 'agent-2',
        error: { code: -32601, message: 'Method not found' },
      }),
    );
    await acp.adapter.send(handle, { turn_id: 'permission-turn', input: 'permission' });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'permission.requested' })),
    );
    expect(handleRequest).toHaveBeenCalledTimes(2);
  });

  it('uses the profile load method without trying resume', async () => {
    const acp = setup({ FAKE_ACP_RESUME_METHOD: 'load' }, undefined, { resume: 'load' });
    const handle = await acp.start('earlier-session');
    expect(handle.native_session_id).toBe('earlier-session');
    expect(acp.frames()[1]).toMatchObject({
      method: 'session/load',
      params: { sessionId: 'earlier-session', cwd: acp.spec.cwd, mcpServers: [] },
    });
    expect(acp.frames().map((frame) => frame.method)).not.toContain('session/resume');
  });

  it('reports ACP limits and the configured resume method even after a version probe', async () => {
    const acp = setup({}, undefined, { resume: 'load' });
    await acp.adapter.probe();
    expect(acp.adapter.report.capabilities).toMatchObject({
      images: { status: 'unknown' },
      resume: { status: 'supported', method: 'load' },
      deny_reason: { status: 'unsupported' },
      steer: { status: 'unsupported' },
      write_isolation: { status: 'unsupported' },
    });
  });

  it('streams a text turn and ends it with one completion', async () => {
    const acp = setup();
    const handle = await acp.start();
    expect(await acp.adapter.send(handle, { turn_id: 'text-turn', input: 'text' })).toEqual({
      turn_id: 'text-turn',
      status: 'delivered',
    });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    const turn = acp.ofTurn('text-turn');
    expect(turn[0]).toMatchObject({ kind: 'turn.started' });
    expect(
      turn.filter((event) => event.kind === 'message.delta').map((event) => event.text),
    ).toEqual(['Hel', 'lo', ' world']);
    expect(turn.filter((event) => event.kind === 'usage.updated')).toEqual([
      expect.objectContaining({
        context_tokens: 1200,
        context_window: 200000,
        cost_usd: 0.25,
        cost_source: 'provider_reported',
      }),
      expect.objectContaining({ context_tokens: 1300, cost_source: 'unknown' }),
    ]);
    expect(turn.filter((event) => event.kind === 'usage.updated')[1]).not.toHaveProperty(
      'cost_usd',
    );
    expect(turn).toContainEqual(
      expect.objectContaining({ kind: 'title.generated', title: 'Greeting' }),
    );
    expect(turn).toContainEqual(
      expect.objectContaining({ kind: 'native', native_type: 'available_commands_update' }),
    );
    expect(turn.at(-1)).toMatchObject({ kind: 'turn.completed', status: 'completed' });
    expect(acp.events.map((event) => event.provider_sequence)).toEqual(
      acp.events.map((_, index) => index + 1),
    );
    expect((await acp.adapter.inspect(handle)).state).toBe('idle');
  });

  it('reads the turn tokens from the prompt response before completing the turn', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'usage-turn', input: 'usage' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    const turn = acp.ofTurn('usage-turn');
    const usage = turn.filter((event) => event.kind === 'usage.updated');
    expect(usage.at(-1)).toMatchObject({
      input_tokens: 1500,
      cached_input_tokens: 1000,
      cache_write_input_tokens: 200,
      output_tokens: 400,
      reasoning_output_tokens: 150,
      cost_source: 'provider_reported',
    });
    expect(turn.indexOf(usage.at(-1)!)).toBeLessThan(
      turn.findIndex((event) => event.kind === 'turn.completed'),
    );
  });

  it('keeps a prompt open past the request timeout that bounds other requests', async () => {
    // The timeout must outlast a node start on a loaded machine.
    const slowInit = setup({ FAKE_ACP_INIT_DELAY: '6000' }, 1500);
    await expect(slowInit.start()).rejects.toThrow(/RPC timeout: initialize/);
    const acp = setup({ FAKE_ACP_SLOW_PROMPT_DELAY: '2500' }, 1500);
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'slow-turn', input: 'slow' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1), { timeout: 10000 });
    expect(acp.completions()[0]).toMatchObject({ turn_id: 'slow-turn', status: 'completed' });
    expect(acp.ofTurn('slow-turn')).toContainEqual(
      expect.objectContaining({ kind: 'message.delta', text: 'late' }),
    );
  }, 30000);

  it('reports tool calls that succeed and fail', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'tool-turn', input: 'tools' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    const tools = acp
      .ofTurn('tool-turn')
      .filter((event) => event.kind === 'tool.started' || event.kind === 'tool.completed');
    expect(tools).toEqual([
      expect.objectContaining({
        kind: 'tool.started',
        tool_call_id: 'call-read',
        name: 'Read notes.md',
        input: { path: 'notes.md' },
      }),
      expect.objectContaining({
        kind: 'tool.completed',
        tool_call_id: 'call-read',
        ok: true,
        output: { content: 'notes' },
      }),
      expect.objectContaining({
        kind: 'tool.started',
        tool_call_id: 'call-run',
        name: 'Run tests',
      }),
      expect.objectContaining({ kind: 'tool.completed', tool_call_id: 'call-run', ok: false }),
    ]);
    expect(acp.ofTurn('tool-turn')).toContainEqual(
      expect.objectContaining({ kind: 'native', native_type: 'tool_call_update' }),
    );
  });

  it('completes a tool from its merged state, including one done in its first frame', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'merged-turn', input: 'tools-merged' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    const tools = acp
      .ofTurn('merged-turn')
      .filter((event) => event.kind === 'tool.started' || event.kind === 'tool.completed');
    expect(tools).toEqual([
      expect.objectContaining({
        kind: 'tool.started',
        tool_call_id: 'call-done',
        input: { path: 'a.md' },
      }),
      expect.objectContaining({
        kind: 'tool.completed',
        tool_call_id: 'call-done',
        ok: true,
        output: { content: 'a' },
      }),
      expect.objectContaining({ kind: 'tool.started', tool_call_id: 'call-part' }),
      expect.objectContaining({
        kind: 'tool.completed',
        tool_call_id: 'call-part',
        ok: true,
        output: [{ type: 'content', content: { type: 'text', text: 'b' } }],
      }),
    ]);
  });

  it('reports the model the agent falls back to', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'fallback-turn', input: 'model-fallback' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(handle.reported_model).toBe('Other model');
    expect(acp.ofTurn('fallback-turn')).toContainEqual(
      expect.objectContaining({
        kind: 'session.started',
        native_session_id: 'fake-session-1',
        reported_model: 'Other model',
      }),
    );
  });

  it('denies a pending write request once its turn turns read-only', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'pending-turn', input: 'permission' });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'permission.requested' })),
    );
    const request = acp.events.find((event) => event.kind === 'permission.requested')!;
    acp.adapter.setTurnReadOnly!(handle, true);
    await acp.adapter.answerPermission(
      handle,
      (request as { request_id: string }).request_id,
      'allow',
    );
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.frames().find((frame) => frame.result?.outcome)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject-once' },
    });
    expect(acp.events).toContainEqual(
      expect.objectContaining({ kind: 'permission.resolved', decision: 'deny' }),
    );
  });

  it('marks an answer to a request the running session does not hold as an unknown request', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'permission-turn', input: 'permission' });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'permission.requested' })),
    );
    expect(await acp.adapter.answerPermission(handle, 'unknown-request', 'deny')).toMatchObject({
      ok: false,
      unknown_request: true,
    });
    expect(
      await acp.adapter.answerPermission({ ...handle }, 'unknown-request', 'deny'),
    ).not.toHaveProperty('unknown_request');
  });

  it.each([
    ['allow', 'opt-allow-once'],
    ['allow_session', 'opt-allow-always'],
    ['deny', 'opt-reject-once'],
  ] as const)('answers a permission request with %s', async (decision, optionId) => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'permission-turn', input: 'permission' });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'permission.requested' })),
    );
    const requested = acp.events.find((event) => event.kind === 'permission.requested')!;
    expect(requested).toMatchObject({
      turn_id: 'permission-turn',
      tool: 'Edit notes.md',
      project_rule_supported: false,
    });
    if (requested.kind !== 'permission.requested') throw new Error('unreachable');
    expect(await acp.adapter.answerPermission(handle, requested.request_id, decision)).toEqual({
      ok: true,
    });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.frames().find((frame) => frame.result?.outcome)).toMatchObject({
      jsonrpc: '2.0',
      id: 'agent-1',
      result: { outcome: { outcome: 'selected', optionId } },
    });
    expect(acp.events).toContainEqual(
      expect.objectContaining({
        kind: 'permission.resolved',
        request_id: requested.request_id,
        decision,
      }),
    );
  });

  it('refuses an allow the agent offers no allow-once option for and keeps the request open', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, {
      turn_id: 'permission-turn',
      input: 'permission-no-allow-once',
    });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'permission.requested' })),
    );
    const requested = acp.events.find((event) => event.kind === 'permission.requested')!;
    if (requested.kind !== 'permission.requested') throw new Error('unreachable');
    expect(await acp.adapter.answerPermission(handle, requested.request_id, 'allow')).toEqual({
      ok: false,
      reason: 'The agent offers no allow-once option for this request',
      refused: true,
    });
    expect(acp.events).not.toContainEqual(expect.objectContaining({ kind: 'permission.resolved' }));
    expect(acp.frames().find((frame) => frame.result?.outcome)).toBeUndefined();
    expect(
      await acp.adapter.answerPermission(handle, requested.request_id, 'allow_session'),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.frames().find((frame) => frame.result?.outcome)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow-always' },
    });
  });

  const form = (property: Record<string, unknown>) => ({
    mode: 'form',
    message: 'Pantheon needs a value',
    requestedSchema: { type: 'object', properties: { field: property } },
  });
  const elicitation = async (params: object) => {
    const acp = setup({ FAKE_ACP_ELICITATION: JSON.stringify(params) });
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'elicit-turn', input: 'elicit' });
    const reply = () => acp.frames().find((frame) => frame.id === 'agent-1' && 'result' in frame);
    return { acp, handle, reply };
  };

  it.each([
    [
      'an enum',
      { type: 'string', title: 'Pick a colour', oneOf: [{ const: 'r', title: 'Red' }] },
      { question: 'Pick a colour', options: [{ label: 'Red', description: '' }], other: false },
      'Red',
      'r',
    ],
    [
      'a boolean',
      { type: 'boolean', description: 'Keep going?' },
      {
        question: 'Keep going?',
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
        other: false,
      },
      'No',
      false,
    ],
    [
      'a string',
      { type: 'string', title: 'Your name' },
      { question: 'Your name', options: [], other: true },
      'Ada',
      'Ada',
    ],
    ['a number', { type: 'integer' }, { question: 'field', options: [], other: true }, '42', 42],
    [
      'a password',
      { type: 'string', title: 'Token', format: 'password' },
      { question: 'Token', options: [], other: true, secret: true },
      'hunter2',
      'hunter2',
    ],
  ])(
    'asks a form field holding %s as a question card and accepts with the typed answer',
    async (_, property, question, answer, value) => {
      const { acp, handle, reply } = await elicitation(form(property));
      await vi.waitFor(() =>
        expect(acp.events).toContainEqual(
          expect.objectContaining({ kind: 'permission.requested' }),
        ),
      );
      const requested = acp.events.find((event) => event.kind === 'permission.requested')!;
      if (requested.kind !== 'permission.requested') throw new Error('unreachable');
      expect(requested.tool).toBe('AskUserQuestion');
      expect(requested.detail).toMatchObject({
        questions: [{ header: 'field', multiSelect: false, ...question }],
      });
      const asked = (requested.detail as { questions: { question: string }[] }).questions[0]!;
      expect(
        await acp.adapter.answerPermission(handle, requested.request_id, 'allow', {
          [asked.question]: answer,
        }),
      ).toEqual({ ok: true });
      await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
      expect(reply()).toMatchObject({
        result: { action: 'accept', content: { field: value } },
      });
    },
  );

  it.each([
    ['the user denies a form', form({ type: 'string', title: 'Your name' }), true],
    [
      'the agent asks for a URL',
      { mode: 'url', elicitationId: 'elicit-1', url: 'https://example.com/login' },
      false,
    ],
    [
      'a field has no question card',
      form({ type: 'array', items: { type: 'string', enum: ['a'] } }),
      false,
    ],
  ])('declines an elicitation when %s', async (_, params, asks) => {
    const { acp, handle, reply } = await elicitation(params);
    if (asks) {
      await vi.waitFor(() =>
        expect(acp.events).toContainEqual(
          expect.objectContaining({ kind: 'permission.requested' }),
        ),
      );
      const requested = acp.events.find((event) => event.kind === 'permission.requested')!;
      if (requested.kind !== 'permission.requested') throw new Error('unreachable');
      await acp.adapter.answerPermission(handle, requested.request_id, 'deny');
    }
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(reply()).toEqual({ jsonrpc: '2.0', id: 'agent-1', result: { action: 'decline' } });
    expect(acp.events.some((event) => event.kind === 'permission.requested')).toBe(asks);
  });

  it('rejects write requests of a read-only turn without asking', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, {
      turn_id: 'read-only-turn',
      input: 'permission',
      read_only: true,
    });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
    expect(acp.frames().find((frame) => frame.result?.outcome)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-reject-once' },
    });
    await acp.adapter.send(handle, { turn_id: 'flipped-turn', input: 'permission' });
    acp.adapter.setTurnReadOnly!(handle, true);
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(2));
    expect(acp.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it('still asks for a read request in a read-only turn', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, {
      turn_id: 'read-request-turn',
      input: 'permission-read',
      read_only: true,
    });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'permission.requested' })),
    );
  });

  it('interrupts a turn and withdraws its pending permission request', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'interrupted-turn', input: 'permission' });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'permission.requested' })),
    );
    expect(await acp.adapter.interrupt!(handle)).toEqual({ ok: true });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.completions()[0]).toMatchObject({
      turn_id: 'interrupted-turn',
      status: 'interrupted',
    });
    expect(acp.frames().find((frame) => frame.result?.outcome)?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(acp.frames()).toContainEqual(
      expect.objectContaining({
        method: 'session/cancel',
        params: { sessionId: 'fake-session-1' },
      }),
    );
    expect(acp.events).toContainEqual(
      expect.objectContaining({ kind: 'permission.resolved', decision: 'deny', cancelled: true }),
    );
    await acp.adapter.send(handle, { turn_id: 'held-turn', input: 'hold' });
    expect(await acp.adapter.interrupt!(handle)).toEqual({ ok: true });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(2));
    expect(acp.completions()[1]).toMatchObject({ turn_id: 'held-turn', status: 'interrupted' });
  });

  it.each([
    ['refusal', /refusal/],
    ['rpc-error', /Internal error/],
  ])('fails a turn that ends with %s', async (input, error) => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'failed-turn', input });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.completions()[0]).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(error),
    });
    expect((await acp.adapter.inspect(handle)).state).toBe('idle');
  });

  it('fails the turn once and reports the exit when the agent dies mid-turn', async () => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'dying-turn', input: 'exit' });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'session.exited' })),
    );
    expect(acp.completions()).toEqual([
      expect.objectContaining({ turn_id: 'dying-turn', status: 'failed' }),
    ]);
    expect(acp.events.at(-1)).toMatchObject({ kind: 'session.exited', code: 3 });
    expect(acp.events).toContainEqual(
      expect.objectContaining({
        kind: 'runtime.disconnected',
        reason: expect.stringContaining('scripted-acp'),
      }),
    );
    expect(acp.completions()[0]).toMatchObject({ error: expect.stringContaining('scripted-acp') });
    const completed = acp.events.indexOf(acp.completions()[0]!);
    expect(
      acp.events.slice(completed + 1).filter((event) => event.turn_id === 'dying-turn'),
    ).toEqual([]);
    expect((await acp.adapter.inspect(handle)).state).toBe('exited');
  });

  it('checks a fresh ACP connection and leaves unsupported MCP capabilities absent', async () => {
    const acp = setup();
    await acp.adapter.reconnect();
    const adapter: HarnessAdapter = acp.adapter;
    expect(adapter.mcpStatus).toBeUndefined();
    expect(adapter.reconnectMcp).toBeUndefined();
    expect(acp.events).toEqual([]);
  });

  it('resumes with session/resume and rejects a session the agent cannot find', async () => {
    const acp = setup({ FAKE_ACP_RESUME_METHOD: 'resume' });
    const handle = await acp.start('earlier-session');
    expect(acp.frames()[1]).toMatchObject({
      method: 'session/resume',
      params: { sessionId: 'earlier-session', cwd: acp.spec.cwd, mcpServers: [] },
    });
    expect(acp.frames().map((frame) => frame.method)).not.toContain('session/load');
    expect(handle.native_session_id).toBe('earlier-session');
    expect(acp.events[0]).toMatchObject({
      kind: 'session.started',
      native_session_id: 'earlier-session',
    });
    const missing = setup();
    const failure = await missing.start('missing-session').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionStartError);
    expect((failure as SessionStartError).message).toMatch(/missing-session/);
    expect((failure as SessionStartError).stop.stopped).toBe(true);
  });

  it.each(['initialize', 'session'])('throws SessionStartError when %s fails', async (step) => {
    const acp = setup({ FAKE_ACP_FAIL: step });
    await expect(acp.start()).rejects.toBeInstanceOf(SessionStartError);
  });

  it('sets the model and effort through the session config options', async () => {
    const acp = setup();
    const handle = await acp.start();
    expect(await acp.adapter.setModel!(handle, 'other-model', 'high')).toEqual({ ok: true });
    expect(acp.frames().filter((frame) => frame.method === 'session/set_config_option')).toEqual([
      expect.objectContaining({
        params: { sessionId: 'fake-session-1', configId: 'model', value: 'other-model' },
      }),
      expect.objectContaining({
        params: { sessionId: 'fake-session-1', configId: 'reasoning_effort', value: 'high' },
      }),
    ]);
    expect(handle).toMatchObject({
      requested_model: 'other-model',
      requested_effort: 'high',
      reported_model: 'Other model',
    });
  });

  it('sends the thought level the agent offers for an effort and reports the model by name', async () => {
    const acp = setup({ FAKE_ACP_GROUPED_MODELS: '1' });
    const handle = await acp.start();
    expect(handle.reported_model).toBe('fake-flash');
    expect(await acp.adapter.setModel!(handle, '["fake-account","fake-pro"]', 'none')).toEqual({
      ok: true,
    });
    expect(acp.frames().filter((frame) => frame.method === 'session/set_config_option')).toEqual([
      expect.objectContaining({
        params: {
          sessionId: 'fake-session-1',
          configId: 'model',
          value: '["fake-account","fake-pro"]',
        },
      }),
      expect.objectContaining({
        params: { sessionId: 'fake-session-1', configId: 'reasoning_effort', value: 'off' },
      }),
    ]);
    expect(handle).toMatchObject({
      requested_model: '["fake-account","fake-pro"]',
      requested_effort: 'none',
      reported_model: 'Fake-Pro (Fake account)',
    });
  });

  it('lists the models and thought levels of a probe session started with the listing arguments, naming a shared name by its group, then closes it', async () => {
    const acp = setup();
    // The probe passes the agent no session env, so node reads it from a file.
    const env = path.join(acp.spec.cwd, 'agent.env');
    const log = path.join(acp.spec.cwd, 'frames.jsonl');
    const argv = path.join(acp.spec.cwd, 'argv.json');
    writeFileSync(
      env,
      `FAKE_ACP_LOG=${log}\nFAKE_ACP_GROUPED_MODELS=1\nFAKE_ACP_ARGV_LOG=${argv}\n`,
    );
    const adapter = new AcpAdapter({
      name: 'scripted-acp',
      binary: process.execPath,
      args: [`--env-file=${env}`, server],
      profile: {
        binary: process.execPath,
        args: [],
        resume: 'resume',
        listArgs: ['--keep-no-record'],
      },
    });
    const shared = {
      permission_modes: [],
      efforts: ['none', 'low', 'high', 'max'],
      default_effort: 'high',
    };
    expect(await adapter.models(acp.spec.cwd)).toEqual([
      {
        id: '["fake-provider","fake-flash"]',
        label: 'fake-flash',
        resolved: 'fake-flash',
        default: true,
        ...shared,
      },
      {
        id: '["fake-provider","fake-pro"]',
        label: 'Fake-Pro (Fake provider)',
        description: 'Stronger reasoning',
        resolved: 'Fake-Pro (Fake provider)',
        default: false,
        ...shared,
      },
      {
        id: '["fake-account","fake-pro"]',
        label: 'Fake-Pro (Fake account)',
        resolved: 'Fake-Pro (Fake account)',
        default: false,
        ...shared,
      },
    ]);
    expect(JSON.parse(readFileSync(argv, 'utf8'))).toEqual(['--keep-no-record']);
    expect(acp.frames().map((frame) => [frame.method, frame.params])).toEqual([
      [
        'initialize',
        expect.objectContaining({
          protocolVersion: 1,
          clientInfo: {
            name: 'pantheon',
            title: 'Pantheon',
            version: JSON.parse(
              readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
            ).version,
          },
        }),
      ],
      ['session/new', { cwd: acp.spec.cwd, mcpServers: [] }],
      ['session/close', { sessionId: 'fake-session-1' }],
    ]);
  });

  it.each([
    ['', {}],
    [
      ', over the options the agent announced ahead of the session',
      {
        FAKE_ACP_STARTUP_CONFIG_UPDATE: '1',
      },
    ],
  ])('applies the requested model and effort when it opens a session%s', async (_, env) => {
    const acp = setup(env);
    acp.spec.model = 'other-model';
    acp.spec.effort = 'high';
    const handle = await acp.start();
    expect(acp.frames().filter((frame) => frame.method === 'session/set_config_option')).toEqual([
      expect.objectContaining({
        params: { sessionId: 'fake-session-1', configId: 'model', value: 'other-model' },
      }),
      expect.objectContaining({
        params: { sessionId: 'fake-session-1', configId: 'reasoning_effort', value: 'high' },
      }),
    ]);
    expect(handle.reported_model).toBe('Other model');
    expect(acp.events.filter((event) => event.kind === 'session.started')).toEqual([
      expect.objectContaining({ reported_model: 'Other model' }),
    ]);
  });

  it('applies the requested model and effort when it resumes a session', async () => {
    const acp = setup();
    acp.spec.model = 'other-model';
    acp.spec.effort = 'low';
    const handle = await acp.start('earlier-session');
    expect(acp.frames().filter((frame) => frame.method === 'session/set_config_option')).toEqual([
      expect.objectContaining({
        params: { sessionId: 'earlier-session', configId: 'model', value: 'other-model' },
      }),
      expect.objectContaining({
        params: { sessionId: 'earlier-session', configId: 'reasoning_effort', value: 'low' },
      }),
    ]);
    expect(handle.reported_model).toBe('Other model');
  });

  it('fails to start when the agent offers no model option for the requested model', async () => {
    const acp = setup({ FAKE_ACP_NO_MODEL_OPTION: '1' });
    acp.spec.model = 'other-model';
    const failure = await acp.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionStartError);
    expect((failure as SessionStartError).message).toBe(
      'The ACP agent offers no model config option',
    );
  });

  it('sends no config option when the spec names no model', async () => {
    const acp = setup();
    await acp.start();
    expect(acp.frames().map((frame) => frame.method)).not.toContain('session/set_config_option');
  });

  it('cancels and fails a turn that outlasts the wall clock', async () => {
    const acp = setup();
    acp.spec.budget.wall_time_ms = 100;
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'held-turn', input: 'hold' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.completions()[0]).toMatchObject({
      turn_id: 'held-turn',
      status: 'failed',
      error_code: 'turn_deadline',
    });
    await vi.waitFor(() =>
      expect(acp.frames()).toContainEqual(
        expect.objectContaining({
          method: 'session/cancel',
          params: { sessionId: 'fake-session-1' },
        }),
      ),
    );
  });

  it('stops the wall clock while a permission request waits for the user', async () => {
    const acp = setup();
    acp.spec.budget.wall_time_ms = 150;
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'waiting-turn', input: 'permission' });
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(expect.objectContaining({ kind: 'permission.requested' })),
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(acp.completions()).toEqual([]);
    expect((await acp.adapter.inspect(handle)).state).toBe('running');
    const requested = acp.events.find((event) => event.kind === 'permission.requested')!;
    if (requested.kind !== 'permission.requested') throw new Error('unreachable');
    await acp.adapter.answerPermission(handle, requested.request_id, 'allow');
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.completions()[0]).toMatchObject({ turn_id: 'waiting-turn', status: 'completed' });
    expect(acp.frames().map((frame) => frame.method)).not.toContain('session/cancel');
  });

  it('leaves a turn that ends within the wall clock alone', async () => {
    const acp = setup();
    acp.spec.budget.wall_time_ms = 150;
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'quick-turn', input: 'text' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(acp.completions()).toEqual([
      expect.objectContaining({ turn_id: 'quick-turn', status: 'completed' }),
    ]);
    expect(acp.frames().map((frame) => frame.method)).not.toContain('session/cancel');
  });

  it('passes the Pantheon MCP server to the agent as a stdio server', async () => {
    const acp = setup();
    acp.spec.pantheon_mcp = {
      command: '/usr/bin/pantheon-mcp',
      args: ['--session', 'acp-session'],
      env: { PANTHEON_TOKEN: 'secret', PANTHEON_URL: 'http://127.0.0.1:1' },
    };
    await acp.start();
    expect(acp.frames()[1]).toMatchObject({
      method: 'session/new',
      params: {
        mcpServers: [
          {
            name: 'pantheon',
            command: '/usr/bin/pantheon-mcp',
            args: ['--session', 'acp-session'],
            env: [
              { name: 'PANTHEON_TOKEN', value: 'secret' },
              { name: 'PANTHEON_URL', value: 'http://127.0.0.1:1' },
            ],
          },
        ],
      },
    });
    const resumed = setup();
    resumed.spec.pantheon_mcp = acp.spec.pantheon_mcp;
    await resumed.start('earlier-session');
    expect(resumed.frames()[1]).toMatchObject({
      method: 'session/resume',
      params: { mcpServers: [expect.objectContaining({ name: 'pantheon' })] },
    });
  });

  it('passes the MCP servers a session names next to the Pantheon server', async () => {
    const acp = setup();
    acp.spec.pantheon_mcp = { command: '/usr/bin/pantheon-mcp', args: [], env: {} };
    acp.spec.mcp_servers = [
      { name: 'chrome_devtools', command: 'npx', args: ['-y', 'devtools'], env: { A: '1' } },
    ];
    await acp.start();
    expect(acp.frames()[1]).toMatchObject({
      method: 'session/new',
      params: {
        mcpServers: [
          expect.objectContaining({ name: 'pantheon' }),
          {
            name: 'chrome_devtools',
            command: 'npx',
            args: ['-y', 'devtools'],
            env: [{ name: 'A', value: '1' }],
          },
        ],
      },
    });
  });

  it('stops the agent process on close', async () => {
    const acp = setup();
    const handle = await acp.start();
    const pid = handle.process_identity!.pid;
    expect(readProcessIdentity(pid)).toBeDefined();
    open.splice(0);
    const receipt = await acp.adapter.close(handle, Date.now() + 5000);
    expect(receipt.stopped).toBe(true);
    expect(readProcessIdentity(pid)).toBeUndefined();
    expect((await acp.adapter.inspect(handle)).state).toBe('exited');
  });

  it('links non-image attachments and turn skills into the prompt', async () => {
    const acp = setup();
    const handle = await acp.start();
    const notes = path.join(acp.spec.cwd, 'notes.txt');
    writeFileSync(notes, 'notes');
    const skill = path.join(acp.spec.cwd, 'review', 'SKILL.md');
    await acp.adapter.send(handle, {
      turn_id: 'linked-turn',
      input: 'text',
      attachments: [{ id: 'notes', name: 'notes.txt', path: notes, mime: 'text/plain' }],
      skills: [{ name: 'review', path: skill }],
    });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.frames().find((frame) => frame.method === 'session/prompt')?.params?.prompt).toEqual(
      [
        { type: 'text', text: 'text' },
        {
          type: 'resource_link',
          uri: pathToFileURL(notes).href,
          name: 'notes.txt',
          mimeType: 'text/plain',
        },
        { type: 'resource_link', uri: pathToFileURL(skill).href, name: 'review' },
      ],
    );
  });

  it('reports each turn the cost it added to the cumulative session cost', async () => {
    const acp = setup();
    const handle = await acp.start();
    for (const turn_id of ['first-cost-turn', 'second-cost-turn']) {
      await acp.adapter.send(handle, { turn_id, input: 'cost' });
      await vi.waitFor(() =>
        expect(acp.ofTurn(turn_id)).toContainEqual(
          expect.objectContaining({ kind: 'turn.completed' }),
        ),
      );
    }
    const costs = (turn_id: string) =>
      acp
        .ofTurn(turn_id)
        .flatMap((event) => (event.kind === 'usage.updated' ? [event.cost_usd] : []));
    expect(costs('first-cost-turn')).toEqual([1]);
    expect(costs('second-cost-turn')).toEqual([1]);
    const resumed = setup({ FAKE_ACP_RESUMED_COST: '5' });
    const resumedHandle = await resumed.start('earlier-session');
    await resumed.adapter.send(resumedHandle, { turn_id: 'resumed-cost-turn', input: 'cost' });
    await vi.waitFor(() => expect(resumed.completions()).toHaveLength(1));
    expect(
      resumed
        .ofTurn('resumed-cost-turn')
        .flatMap((event) => (event.kind === 'usage.updated' ? [event.cost_usd] : [])),
    ).toEqual([1]);
  });

  it('applies an effort without a model when it opens a session', async () => {
    const acp = setup();
    acp.spec.effort = 'high';
    const handle = await acp.start();
    expect(acp.frames().filter((frame) => frame.method === 'session/set_config_option')).toEqual([
      expect.objectContaining({
        params: { sessionId: 'fake-session-1', configId: 'reasoning_effort', value: 'high' },
      }),
    ]);
    expect(handle).toMatchObject({ requested_effort: 'high', reported_model: 'Fake model' });
    const missing = setup({ FAKE_ACP_NO_THOUGHT_OPTION: '1' });
    missing.spec.effort = 'high';
    const failure = await missing.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionStartError);
    expect((failure as SessionStartError).message).toBe(
      'The ACP agent offers no thought level config option',
    );
  });

  it('sends the control instructions ahead of the first prompt of each agent process', async () => {
    const acp = setup();
    acp.spec.control_instructions = 'Commit only in the worktree.';
    const handle = await acp.start();
    for (const turn_id of ['first-turn', 'second-turn']) {
      await acp.adapter.send(handle, { turn_id, input: 'text' });
      await vi.waitFor(() =>
        expect(acp.ofTurn(turn_id)).toContainEqual(
          expect.objectContaining({ kind: 'turn.completed' }),
        ),
      );
    }
    expect(
      acp
        .frames()
        .filter((frame) => frame.method === 'session/prompt')
        .map((frame) => frame.params?.prompt),
    ).toEqual([
      [
        { type: 'text', text: 'Commit only in the worktree.' },
        { type: 'text', text: 'text' },
      ],
      [{ type: 'text', text: 'text' }],
    ]);
  });

  it('holds queued input until the agent answers a prompt past its deadline and drops its late output', async () => {
    const acp = setup();
    acp.spec.budget.wall_time_ms = 150;
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'late-turn', input: 'slow-cancel' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.completions()[0]).toMatchObject({
      turn_id: 'late-turn',
      error_code: 'turn_deadline',
    });
    expect(await acp.adapter.send(handle, { turn_id: 'queued-turn', input: 'text' })).toMatchObject(
      {
        status: 'delivered',
      },
    );
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(2));
    expect(acp.completions()[1]).toMatchObject({ turn_id: 'queued-turn', status: 'completed' });
    const completed = acp.events.indexOf(acp.completions()[0]!);
    expect(
      acp.events
        .slice(completed + 1)
        .filter((event) => event.turn_id === 'late-turn' && event.kind !== 'usage.updated'),
    ).toEqual([]);
    expect(acp.events).not.toContainEqual(expect.objectContaining({ text: 'late' }));
  });

  it('reports the usage of a prompt answered past its deadline on its own turn', async () => {
    const acp = setup();
    acp.spec.budget.wall_time_ms = 150;
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'late-turn', input: 'slow-cancel' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    await vi.waitFor(() =>
      expect(acp.events).toContainEqual(
        expect.objectContaining({
          turn_id: 'late-turn',
          kind: 'usage.updated',
          input_tokens: 10,
          output_tokens: 20,
        }),
      ),
    );
    expect(acp.events).toContainEqual(
      expect.objectContaining({
        turn_id: 'late-turn',
        kind: 'usage.updated',
        context_tokens: 900,
        cost_usd: 7,
      }),
    );
  });

  it('ends input interrupted while it waits behind a prompt past its deadline without sending it', async () => {
    const acp = setup();
    acp.spec.budget.wall_time_ms = 150;
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'late-turn', input: 'slow-cancel' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    const sending = acp.adapter.send(handle, { turn_id: 'queued-turn', input: 'text' });
    expect(await acp.adapter.interrupt!(handle)).toEqual({ ok: true });
    expect(await sending).toMatchObject({ status: 'delivered' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(2));
    expect(acp.completions()[1]).toMatchObject({ turn_id: 'queued-turn', status: 'interrupted' });
    expect(acp.frames().filter((frame) => frame.method === 'session/prompt')).toHaveLength(1);
  });

  it('starts input made read-only while it waits behind a prompt past its deadline read-only', async () => {
    const acp = setup();
    acp.spec.budget.wall_time_ms = 150;
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'late-turn', input: 'slow-cancel' });
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    const sending = acp.adapter.send(handle, { turn_id: 'queued-turn', input: 'permission' });
    acp.adapter.setTurnReadOnly!(handle, true);
    expect(await sending).toMatchObject({ status: 'delivered' });
    await vi.waitFor(() =>
      expect(acp.frames().find((frame) => frame.result?.outcome)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'opt-reject-once' },
      }),
    );
    expect(acp.events.filter((event) => event.kind.startsWith('permission.'))).toEqual([]);
  });

  it.each([
    ['a permission request', 'permission-on-cancel', { outcome: { outcome: 'cancelled' } }],
    ['an elicitation', 'elicit-on-cancel', { action: 'cancel' }],
  ])('answers %s that crosses an interrupt with cancelled', async (_, input, result) => {
    const acp = setup();
    const handle = await acp.start();
    await acp.adapter.send(handle, { turn_id: 'crossed-turn', input });
    expect(await acp.adapter.interrupt!(handle)).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(
        acp.frames().find((frame) => frame.id === 'agent-1' && 'result' in frame)?.result,
      ).toEqual(result),
    );
    await vi.waitFor(() => expect(acp.completions()).toHaveLength(1));
    expect(acp.completions()[0]).toMatchObject({ turn_id: 'crossed-turn', status: 'interrupted' });
    expect(acp.events.filter((event) => event.kind === 'permission.requested')).toEqual([]);
  });

  it('applies overlapping model changes in order so a refused one cannot undo a later one', async () => {
    const acp = setup({ FAKE_ACP_REJECT_EFFORT: '1' });
    const handle = await acp.start();
    const [refused, taken] = await Promise.all([
      acp.adapter.setModel!(handle, 'other-model', 'high'),
      acp.adapter.setModel!(handle, 'other-model', undefined),
    ]);
    expect(refused).toMatchObject({ ok: false });
    expect(taken).toEqual({ ok: true });
    const models = acp
      .frames()
      .filter(
        (frame) =>
          frame.method === 'session/set_config_option' && frame.params?.configId === 'model',
      );
    expect(models.at(-1)?.params?.value).toBe('other-model');
    expect(handle).toMatchObject({ requested_model: 'other-model', reported_model: 'Other model' });
  });

  it.each([
    ['sets the model back', {}, 'Fake model'],
    [
      'reports the model it keeps when it refuses to set it back',
      { FAKE_ACP_REFUSE_MODEL: 'fake-model' },
      'Other model',
    ],
  ])('when the agent takes the model but refuses the effort, %s', async (_, env, reported) => {
    const acp = setup({ FAKE_ACP_REJECT_EFFORT: '1', ...env });
    const handle = await acp.start();
    expect(await acp.adapter.setModel!(handle, 'other-model', 'high')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Effort rejected'),
    });
    expect(
      acp
        .frames()
        .filter((frame) => frame.method === 'session/set_config_option')
        .map((frame) => frame.params),
    ).toEqual([
      { sessionId: 'fake-session-1', configId: 'model', value: 'other-model' },
      { sessionId: 'fake-session-1', configId: 'reasoning_effort', value: 'high' },
      { sessionId: 'fake-session-1', configId: 'model', value: 'fake-model' },
    ]);
    expect(handle).toMatchObject({ reported_model: reported });
    expect(acp.events.filter((event) => event.kind === 'session.started').at(-1)).toMatchObject({
      reported_model: reported,
    });
    expect(handle.requested_model).toBeUndefined();
  });

  it('probes the version from the binary', async () => {
    const acp = setup();
    // The binary here is node itself; the server script is only an argument.
    expect((await acp.adapter.probe()).version).toBe(process.version);
    expect(acp.adapter.report.runtime).toBe('scripted-acp');
  });
});

describe('agy user extensions', () => {
  function agy() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-agy-'));
    roots.push(root);
    const home = path.join(root, 'home');
    mkdirSync(home);
    const argv = path.join(root, 'argv.json');
    // Records the agent's arguments, then runs the fake server without them.
    const recorder = path.join(root, 'record-argv.mjs');
    writeFileSync(
      recorder,
      [
        "import { writeFileSync } from 'node:fs';",
        'writeFileSync(process.env.FAKE_ACP_ARGV, JSON.stringify(process.argv.slice(2)));',
        'process.argv.length = 2;',
        `await import(${JSON.stringify(pathToFileURL(server).href)});`,
      ].join('\n'),
    );
    const adapter = new AcpAdapter({
      name: 'agy',
      profile: { ...acpProfiles.agy!, binary: process.execPath, args: [recorder, 'acp'] },
      home,
    });
    const start = async (native_state_dir?: string) => {
      const spec: SessionSpec = {
        platform_session_id: 'agy-session',
        project_id: 'agy-project',
        runtime: 'agy',
        device_id: 'local',
        role: 'writer',
        cwd: root,
        env_allowlist: NATIVE_ENV_ALLOWLIST,
        env: { FAKE_ACP_LOG: path.join(root, 'frames.jsonl'), FAKE_ACP_ARGV: argv },
        skills: [],
        mcp_servers: [],
        budget: { max_turns: 1, wall_time_ms: 60000 },
        ...(native_state_dir ? { native_state_dir } : {}),
      };
      open.push({ adapter, handle: await adapter.start(spec, () => {}) });
      return JSON.parse(readFileSync(argv, 'utf8')) as string[];
    };
    return { root, home, adapter, start };
  }

  it('starts a managed agy session on its own Gemini folder and a legacy one without it', async () => {
    const { root, start } = agy();
    const managed = path.join(root, 'managed');
    expect(await start(managed)).toEqual(['acp', '--gemini-dir', managed]);
    expect(existsSync(path.join(managed, 'config', 'mcp_config.json'))).toBe(true);
    expect(await start()).toEqual(['acp']);
  });

  it('lists the user-level agy MCP servers and skills from the files without starting agy', async () => {
    const { home, adapter } = agy();
    const config = path.join(home, '.gemini', 'config');
    mkdirSync(path.join(config, 'skills', 'x'), { recursive: true });
    mkdirSync(path.join(home, '.agents', 'skills', 'y'), { recursive: true });
    writeFileSync(
      path.join(config, 'mcp_config.json'),
      JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }),
    );
    expect(await adapter.inventory!(home)).toEqual({
      runtime: 'agy',
      mcp_servers: [
        { name: 'a', enabled: true, user: true },
        { name: 'b', enabled: true, user: true },
      ],
      plugins: [],
      skills: [
        { id: 'x', name: 'x', enabled: true, user: true },
        { id: 'y', name: 'y', enabled: true, user: true },
      ],
      apps: false,
      connectors: [],
      hooks: [],
    });
  });
});

describe('grok user extensions', () => {
  function grok() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-grok-'));
    roots.push(root);
    const home = path.join(root, 'home');
    mkdirSync(home);
    const seen = path.join(root, 'seen.json');
    // Records the agent's arguments and grok variables, then runs the fake server without them.
    const recorder = path.join(root, 'record-env.mjs');
    writeFileSync(
      recorder,
      [
        "import { writeFileSync } from 'node:fs';",
        'writeFileSync(process.env.FAKE_ACP_SEEN, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GROK_"))) }));',
        'process.argv.length = 2;',
        `await import(${JSON.stringify(pathToFileURL(server).href)});`,
      ].join('\n'),
    );
    const adapter = new AcpAdapter({
      name: 'grok',
      profile: { ...acpProfiles.grok!, binary: process.execPath, args: [recorder, 'agent'] },
      home,
    });
    const start = async (native_state_dir?: string) => {
      const spec: SessionSpec = {
        platform_session_id: 'grok-session',
        project_id: 'grok-project',
        runtime: 'grok',
        device_id: 'local',
        role: 'writer',
        cwd: root,
        env_allowlist: NATIVE_ENV_ALLOWLIST,
        env: { FAKE_ACP_LOG: path.join(root, 'frames.jsonl'), FAKE_ACP_SEEN: seen },
        skills: [],
        mcp_servers: [],
        budget: { max_turns: 1, wall_time_ms: 60000 },
        ...(native_state_dir ? { native_state_dir } : {}),
      };
      open.push({ adapter, handle: await adapter.start(spec, () => {}) });
      return JSON.parse(readFileSync(seen, 'utf8')) as {
        argv: string[];
        env: Record<string, string>;
      };
    };
    return { root, home, start };
  }

  it('starts a managed grok session on its own grok home and a legacy one without it', async () => {
    const { root, home, start } = grok();
    const managed = path.join(root, 'managed');
    const started = await start(managed);
    expect(started.argv).toEqual(['agent']);
    expect(started.env).toMatchObject({
      GROK_HOME: managed,
      GROK_AUTH_PATH: path.join(home, '.grok', 'auth.json'),
    });
    expect(existsSync(path.join(managed, 'managed_config.toml'))).toBe(true);
    const legacy = await start();
    expect(legacy.env.GROK_HOME).toBeUndefined();
    expect(legacy.env.GROK_AUTH_PATH).toBeUndefined();
  });

  it('lists the MCP servers, skills and plugins grok inspect reports, marking the user-level ones', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-grok-'));
    roots.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    mkdirSync(cwd);
    const source = (type: string, file: string) => ({ type, path: file });
    // Fields as grok 1.0.77 prints them from `grok inspect --json`.
    const sample = {
      projectRoot: null,
      projectTrusted: false,
      mcpServers: [
        {
          name: 'claude-user',
          transport: 'stdio',
          target: 'a',
          source: source('claudeJson', path.join(home, '.claude.json')),
          compatibilityStatus: 'enabled',
          vendor: 'claude',
        },
        {
          name: 'grok-user',
          transport: 'stdio',
          target: 'b',
          source: source('config', path.join(home, '.grok', 'config.toml')),
        },
        {
          name: 'project-server',
          transport: 'stdio',
          target: 'c',
          source: source('mcpJson', path.join(cwd, '.mcp.json')),
          disabledReason: 'not in allowedMcpServers (managed_config.toml)',
        },
      ],
      skills: [
        {
          name: 'from-grok',
          description: 'd',
          source: source('user', path.join(home, '.grok', 'skills', 'from-grok', 'SKILL.md')),
          userInvocable: true,
        },
        {
          name: 'from-claude',
          description: 'd',
          source: source('user', path.join(home, '.claude', 'skills', 'claude-dir', 'SKILL.md')),
          userInvocable: true,
          vendor: 'claude',
          disabled: true,
          compatibilityStatus: 'disabled',
        },
        {
          name: 'from-agents',
          description: 'd',
          source: source('user', path.join(home, '.agents', 'skills', 'from-agents', 'SKILL.md')),
          userInvocable: true,
        },
      ],
      plugins: [
        {
          name: 'tools',
          scope: 'user',
          path: '/plugins/tools',
          enabled: true,
          provides: { skills: 1, agents: 0, hooks: true, mcpServers: 0 },
        },
      ],
      hooks: [],
    };
    const output = path.join(root, 'inspect.json');
    writeFileSync(output, JSON.stringify(sample));
    const called = path.join(root, 'called.txt');
    const binary = path.join(root, 'grok');
    writeFileSync(
      binary,
      `#!/bin/sh\nprintf '%s|%s' "$*" "$(pwd -P)" > '${called}'\ncat '${output}'\n`,
      { mode: 0o755 },
    );
    const adapter = new AcpAdapter({ name: 'grok', profile: acpProfiles.grok!, binary, home });
    expect(await adapter.inventory!(cwd)).toEqual({
      runtime: 'grok',
      mcp_servers: [
        { name: 'claude-user', enabled: true, user: true },
        { name: 'grok-user', enabled: true, user: true },
        { name: 'project-server', enabled: false },
      ],
      plugins: [{ id: 'tools', enabled: true }],
      skills: [
        { id: 'from-grok', name: 'from-grok', enabled: true, user: true },
        { id: 'claude-dir', name: 'from-claude', enabled: false, user: true },
        { id: 'from-agents', name: 'from-agents', enabled: true, user: true },
      ],
      apps: false,
      connectors: [],
      hooks: [],
    });
    expect(readFileSync(called, 'utf8')).toBe(`inspect --json|${realpathSync(cwd)}`);
  });
});
