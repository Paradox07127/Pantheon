import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpencodeAdapter, readProcessIdentity } from '@pantheon/adapters';
import {
  NATIVE_ENV_ALLOWLIST,
  SessionStartError,
  type AgentEvent,
  type SessionHandle,
  type SessionSpec,
} from '@pantheon/domain';

const server = fileURLToPath(new URL('./fake-opencode-server.mjs', import.meta.url));
const roots: string[] = [];
const open: { adapter: OpencodeAdapter; handle: SessionHandle }[] = [];

interface Entry {
  kind: 'launch' | 'request';
  argv?: string[];
  cwd?: string;
  port?: number;
  helper?: number;
  config?: string;
  method?: string;
  path?: string;
  body?: Record<string, unknown>;
  authorized?: boolean;
}

interface Rule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/** What OpenCode does with an action under the rules: the last matching rule wins. */
const effect = (rules: unknown, action: string) =>
  (rules as Rule[] | undefined)?.findLast(
    (rule) =>
      rule.action === action ||
      (rule.action.endsWith('*') && action.startsWith(rule.action.slice(0, -1))),
  )?.effect;

/** An `opencode` executable that runs the fake server, with the given version. */
function setup(options: { version?: string; env?: Record<string, string> } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-opencode-')));
  roots.push(root);
  const log = path.join(root, 'requests.jsonl');
  const binary = path.join(root, 'opencode');
  writeFileSync(
    binary,
    `#!/bin/sh\n${options.version ? `FAKE_OPENCODE_VERSION='${options.version}' ` : ''}exec '${process.execPath}' '${server}' "$@"\n`,
  );
  chmodSync(binary, 0o755);
  const spec: SessionSpec = {
    platform_session_id: 'opencode-session',
    project_id: 'opencode-project',
    runtime: 'opencode',
    device_id: 'local',
    role: 'writer',
    cwd: root,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    env: { FAKE_OPENCODE_LOG: log, ...options.env },
    skills: [],
    mcp_servers: [],
    pantheon_mcp: { command: '/bin/pantheon-mcp', args: ['--stdio'], env: { TOKEN: 'secret' } },
    budget: { max_turns: 1, wall_time_ms: 60000 },
  };
  const adapter = new OpencodeAdapter(binary, options.version ?? '2.3.2');
  const events: AgentEvent[] = [];
  const entries = (): Entry[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Entry)
      : [];
  const requests = (method: string, suffix: string) =>
    entries().filter(
      (entry) =>
        entry.kind === 'request' && entry.method === method && entry.path!.endsWith(suffix),
    );
  const start = async (resumeId?: string, overrides: Partial<SessionSpec> = {}) => {
    const handle =
      resumeId === undefined
        ? await adapter.start({ ...spec, ...overrides }, (event) => events.push(event))
        : await adapter.resume({ ...spec, ...overrides }, resumeId, (event) => events.push(event));
    open.push({ adapter, handle });
    return handle;
  };
  const ofKind = <K extends AgentEvent['kind']>(kind: K) =>
    events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind);
  const text = () =>
    ofKind('message.delta')
      .map((event) => event.text)
      .join('');
  const completed = async (turn_id: string) => {
    await vi.waitFor(() =>
      expect(ofKind('turn.completed').some((event) => event.turn_id === turn_id)).toBe(true),
    );
    return ofKind('turn.completed').filter((event) => event.turn_id === turn_id);
  };
  return { adapter, spec, events, entries, requests, start, ofKind, text, completed };
}

afterEach(async () => {
  for (const { adapter, handle } of open.splice(0)) await adapter.close(handle, Date.now() + 5000);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OpenCode adapter', () => {
  it('starts one authenticated loopback server per session in its working folder', async () => {
    const oc = setup();
    const handle = await oc.start();
    const launch = oc.entries().find((entry) => entry.kind === 'launch')!;
    expect(launch.argv).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0']);
    expect(launch.cwd).toBe(oc.spec.cwd);
    expect(JSON.parse(launch.config!)).toEqual({
      mcp: {
        servers: {
          pantheon: {
            type: 'local',
            command: ['/bin/pantheon-mcp', '--stdio'],
            environment: { TOKEN: 'secret' },
          },
        },
      },
    });
    const created = oc.requests('POST', '/api/session')[0]!;
    expect(created.authorized).toBe(true);
    expect(created.body).toMatchObject({ location: { directory: oc.spec.cwd } });
    expect(handle.native_session_id).toMatch(/^ses_/);
    expect(oc.ofKind('session.started')).toEqual([
      expect.objectContaining({
        native_session_id: handle.native_session_id,
        reported_model: 'fake/fake-model',
      }),
    ]);
    const anonymous = await fetch(`http://127.0.0.1:${launch.port}/api/session`);
    expect(anonymous.status).toBe(401);
  });

  it('fails the start with the stop receipt when the server refuses the password', async () => {
    const oc = setup({ env: { FAKE_OPENCODE_SERVER_PASSWORD: 'another-password' } });
    const failure = await oc.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionStartError);
    expect((failure as SessionStartError).message).toBe('OpenCode rejected the server password');
    expect((failure as SessionStartError).stop.stopped).toBe(true);
  });

  it('streams reasoning, text and usage and ends the turn once', async () => {
    const oc = setup();
    const handle = await oc.start();
    expect(await oc.adapter.send(handle, { turn_id: 'hello-turn', input: 'say hello' })).toEqual({
      turn_id: 'hello-turn',
      status: 'delivered',
    });
    expect(await oc.completed('hello-turn')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(oc.ofKind('reasoning').map((event) => event.text)).toEqual(['Thinking']);
    expect(oc.ofKind('message.delta').map((event) => event.text)).toEqual(['Hel', 'lo']);
    expect(oc.ofKind('usage.updated')).toEqual([
      expect.objectContaining({
        turn_id: 'hello-turn',
        input_tokens: 14,
        cached_input_tokens: 3,
        cache_write_input_tokens: 1,
        output_tokens: 7,
        reasoning_output_tokens: 2,
        cost_usd: 0.01,
        cost_source: 'provider_reported',
      }),
    ]);
    expect(oc.requests('POST', '/prompt')[0]!.body).toEqual({ text: 'say hello' });
    expect(oc.events.at(-1)).toMatchObject({ kind: 'turn.completed', turn_id: 'hello-turn' });
  });

  it('steers the running turn with a steer delivery', async () => {
    const oc = setup();
    const handle = await oc.start();
    await oc.adapter.send(handle, { turn_id: 'steer-turn', input: 'steer me' });
    await vi.waitFor(() => expect(oc.text()).toBe('Waiting'));
    expect(await oc.adapter.steer(handle, { turn_id: 'steer-input', input: 'go left' })).toEqual({
      turn_id: 'steer-input',
      status: 'delivered',
    });
    expect(await oc.completed('steer-turn')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(oc.text()).toBe('WaitingSteered: go left');
    expect(oc.requests('POST', '/prompt')[1]!.body).toEqual({ text: 'go left', delivery: 'steer' });
  });

  it('ends an interrupted turn with status interrupted and keeps the session', async () => {
    const oc = setup();
    const handle = await oc.start();
    await oc.adapter.send(handle, { turn_id: 'hold-turn', input: 'hold on' });
    await vi.waitFor(() => expect(oc.text()).toBe('Working'));
    expect(await oc.adapter.interrupt(handle)).toEqual({ ok: true });
    expect(await oc.completed('hold-turn')).toEqual([
      expect.objectContaining({ status: 'interrupted' }),
    ]);
    expect(oc.requests('POST', '/interrupt')).toHaveLength(1);
    expect((await oc.adapter.inspect(handle)).state).toBe('idle');
    await oc.adapter.send(handle, { turn_id: 'after-turn', input: 'say hello' });
    expect(await oc.completed('after-turn')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
  });

  it.each(['allow', 'allow_session'] as const)(
    'answers a permission request %s with a one-time grant',
    async (decision) => {
      const oc = setup();
      const handle = await oc.start();
      await oc.adapter.send(handle, { turn_id: 'ask-turn', input: 'permission please' });
      await vi.waitFor(() => expect(oc.ofKind('permission.requested')).toHaveLength(1));
      const request = oc.ofKind('permission.requested')[0]!;
      expect(request).toMatchObject({
        turn_id: 'ask-turn',
        tool: 'bash',
        detail: { tool_call_id: 'call_bash', input: { resources: ['ls -la'] } },
      });
      expect(await oc.adapter.answerPermission(handle, request.request_id, decision)).toEqual({
        ok: true,
      });
      expect(await oc.completed('ask-turn')).toEqual([
        expect.objectContaining({ status: 'completed' }),
      ]);
      expect(oc.requests('POST', '/reply')[0]!.body).toEqual({ decision: 'once' });
      expect(oc.ofKind('permission.resolved')).toEqual([
        expect.objectContaining({ request_id: request.request_id, decision }),
      ]);
      expect(oc.text()).toBe('once');
    },
  );

  it('rejects a denied permission request with the reason', async () => {
    const oc = setup();
    const handle = await oc.start();
    await oc.adapter.send(handle, { turn_id: 'deny-turn', input: 'permission please' });
    await vi.waitFor(() => expect(oc.ofKind('permission.requested')).toHaveLength(1));
    const { request_id } = oc.ofKind('permission.requested')[0]!;
    await oc.adapter.answerPermission(handle, request_id, 'deny', undefined, 'Not this folder');
    expect(await oc.completed('deny-turn')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(oc.requests('POST', '/reply')[0]!.body).toEqual({
      decision: 'reject',
      message: 'Not this folder',
    });
    expect(oc.text()).toBe('reject: Not this folder');
  });

  it('creates the session with rules that ask before edits and commands and allow reads', async () => {
    const oc = setup();
    const handle = await oc.start();
    const rules = oc.requests('POST', '/api/session')[0]!.body!.permissions;
    for (const action of ['edit', 'bash', 'webfetch', 'websearch', 'external_directory'])
      expect([action, effect(rules, action)]).toEqual([action, 'ask']);
    for (const action of ['read', 'glob', 'grep', 'question', 'task', 'pantheon_update_board'])
      expect([action, effect(rules, action)]).toEqual([action, 'allow']);
    await oc.adapter.send(handle, { turn_id: 'edit-turn', input: 'permission edit' });
    await vi.waitFor(() => expect(oc.ofKind('permission.requested')).toHaveLength(1));
    expect(oc.ofKind('permission.requested')[0]).toMatchObject({
      tool: 'edit',
      rule: 'edit(probe.txt)',
      detail: { input: { resources: ['probe.txt'] } },
    });
  });

  it.each([
    [
      'plan',
      {
        edit: 'deny',
        bash: 'deny',
        read: 'allow',
        external_directory: 'ask',
        pantheon_update_board: 'allow',
      },
      'deny',
    ],
    [
      'auto_edit',
      { edit: 'allow', bash: 'ask', read: 'allow', external_directory: 'ask' },
      'allow',
    ],
    [
      'full_access',
      { edit: 'allow', bash: 'allow', read: 'allow', external_directory: 'allow' },
      'allow',
    ],
  ] as const)('creates a %s session with its rules', async (mode, effects, edit) => {
    const oc = setup();
    const handle = await oc.start(undefined, { permission_mode: mode });
    const rules = oc.requests('POST', '/api/session')[0]!.body!.permissions;
    for (const [action, expected] of Object.entries(effects))
      expect([action, effect(rules, action)]).toEqual([action, expected]);
    await oc.adapter.send(handle, { turn_id: 'mode-turn', input: 'permission edit' });
    await oc.completed('mode-turn');
    expect(oc.text()).toBe(`${edit} by rule`);
    expect(oc.ofKind('permission.requested')).toHaveLength(0);
  });

  it('reports the permission modes the rules carry out', async () => {
    const oc = setup();
    expect((await oc.adapter.models(oc.spec.cwd))[0]!.permission_modes).toEqual([
      'plan',
      'ask',
      'auto_edit',
      'full_access',
    ]);
  });

  it('rewrites the rules of a resumed session', async () => {
    const oc = setup();
    const handle = await oc.start('ses_saved_rules', { permission_mode: 'plan' });
    const patched = oc.requests('PATCH', '/api/session/ses_saved_rules');
    expect(patched).toHaveLength(1);
    expect(effect(patched[0]!.body!.permissions, 'edit')).toBe('deny');
    await oc.adapter.send(handle, { turn_id: 'resumed-turn', input: 'permission edit' });
    await oc.completed('resumed-turn');
    expect(oc.text()).toBe('deny by rule');
  });

  it('switches the rules of the live session with the permission mode', async () => {
    const oc = setup();
    const handle = await oc.start();
    expect(await oc.adapter.setPermissionMode(handle, 'full_access')).toEqual({ ok: true });
    const patched = oc.requests('PATCH', `/api/session/${handle.native_session_id}`);
    expect(patched).toHaveLength(1);
    expect(effect(patched[0]!.body!.permissions, 'bash')).toBe('allow');
    await oc.adapter.send(handle, { turn_id: 'switched-turn', input: 'permission please' });
    await oc.completed('switched-turn');
    expect(oc.text()).toBe('allow by rule');
  });

  it('writes the session rules to a subagent session', async () => {
    const oc = setup();
    const handle = await oc.start(undefined, { permission_mode: 'auto_edit' });
    await oc.adapter.send(handle, { turn_id: 'child-turn', input: 'start a child' });
    await oc.completed('child-turn');
    const child = oc.ofKind('task.started')[0]!.task.id;
    await vi.waitFor(() => expect(oc.requests('PATCH', `/api/session/${child}`)).toHaveLength(1));
    expect(oc.requests('PATCH', `/api/session/${child}`)[0]!.body!.permissions).toEqual(
      oc.requests('POST', '/api/session')[0]!.body!.permissions,
    );
  });

  it('refuses edits in a read-only turn of a full access session and restores the rules after it', async () => {
    const oc = setup();
    const handle = await oc.start(undefined, { permission_mode: 'full_access' });
    const full = oc.requests('POST', '/api/session')[0]!.body!.permissions;
    await oc.adapter.send(handle, {
      turn_id: 'read-only-turn',
      input: 'permission edit',
      read_only: true,
    });
    await oc.completed('read-only-turn');
    expect(oc.text()).toBe('reject: This turn may only read files.');
    expect(oc.ofKind('permission.requested')).toHaveLength(0);
    await vi.waitFor(() =>
      expect(
        oc.requests('PATCH', `/api/session/${handle.native_session_id}`).at(-1)?.body?.permissions,
      ).toEqual(full),
    );
  });

  it('grants a request an allowed rule covers without asking', async () => {
    const oc = setup();
    const handle = await oc.start(undefined, { allowed_rules: ['bash(ls -la)'] });
    await oc.adapter.send(handle, { turn_id: 'rule-turn', input: 'permission please' });
    await oc.completed('rule-turn');
    expect(oc.text()).toBe('once');
    expect(oc.ofKind('permission.requested')).toHaveLength(0);
  });

  it('asks a form as questions and replies with the field values', async () => {
    const oc = setup();
    const handle = await oc.start();
    await oc.adapter.send(handle, { turn_id: 'form-turn', input: 'form please' });
    await vi.waitFor(() => expect(oc.ofKind('permission.requested')).toHaveLength(1));
    const request = oc.ofKind('permission.requested')[0]!;
    expect(request).toMatchObject({
      tool: 'AskUserQuestion',
      detail: {
        questions: [
          expect.objectContaining({
            question: 'Which color?',
            options: [
              { label: 'Red', description: '' },
              { label: 'Blue', description: '' },
            ],
          }),
          expect.objectContaining({ question: 'Sure?' }),
        ],
      },
    });
    await oc.adapter.answerPermission(handle, request.request_id, 'allow', {
      'Which color?': 'Blue',
      'Sure?': 'Yes',
    });
    await oc.completed('form-turn');
    expect(oc.text()).toBe('{"color":"b","sure":true}');
  });

  it('resumes a saved session id on a new server', async () => {
    const oc = setup();
    const handle = await oc.start('ses_saved_1');
    expect(handle.native_session_id).toBe('ses_saved_1');
    expect(oc.requests('GET', '/api/session/ses_saved_1')).toHaveLength(1);
    expect(oc.requests('POST', '/api/session')).toHaveLength(0);
    await oc.adapter.send(handle, { turn_id: 'resumed-turn', input: 'say hello' });
    expect(await oc.completed('resumed-turn')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(oc.requests('POST', '/api/session/ses_saved_1/prompt')).toHaveLength(1);
    const missing = await oc.start('ses_missing').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(SessionStartError);
  });

  it('rebuilds a turn from the message history after the event stream drops, without repeats', async () => {
    const oc = setup();
    const handle = await oc.start();
    await oc.adapter.send(handle, { turn_id: 'drop-turn', input: 'drop the stream' });
    expect(await oc.completed('drop-turn')).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(oc.text()).toBe('Part one and part two');
    expect(oc.ofKind('tool.started')).toEqual([
      expect.objectContaining({ tool_call_id: 'call_read', name: 'read' }),
    ]);
    expect(oc.ofKind('tool.completed')).toEqual([
      expect.objectContaining({ tool_call_id: 'call_read', ok: true }),
    ]);
    expect(oc.ofKind('usage.updated')).toHaveLength(1);
    expect(oc.requests('GET', '/message').length).toBeGreaterThan(0);
    expect(oc.requests('GET', '/api/event')).toHaveLength(2);
  });

  it('reports the title OpenCode gives a session it names and its subagent sessions', async () => {
    const oc = setup();
    const handle = await oc.start(undefined, { auto_title: true });
    await oc.adapter.send(handle, { turn_id: 'title-turn', input: 'title and child' });
    await oc.completed('title-turn');
    expect(oc.ofKind('title.generated')).toEqual([
      expect.objectContaining({ title: 'Fake title' }),
    ]);
    expect(oc.ofKind('task.started')).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({
          kind: 'agent',
          description: 'Explore the code',
          agent_type: 'explore',
        }),
      }),
    ]);
    expect(oc.ofKind('task.ended')).toEqual([expect.objectContaining({ state: 'completed' })]);
  });

  it('fails the turn with the error OpenCode reports', async () => {
    const oc = setup();
    const handle = await oc.start();
    await oc.adapter.send(handle, { turn_id: 'fail-turn', input: 'fail now' });
    expect(await oc.completed('fail-turn')).toEqual([
      expect.objectContaining({ status: 'failed', error: 'Provider refused the request' }),
    ]);
  });

  it('reports OpenCode 2 as available and any other major version as unavailable', async () => {
    const current = setup();
    expect(await current.adapter.preflight()).toMatchObject({
      installed: true,
      version: '2.3.2',
      version_ok: true,
      auth: { state: 'unknown' },
    });
    expect((await current.adapter.preflight()).error).toBeUndefined();
    const older = setup({ version: '1.19.6' });
    const status = await older.adapter.preflight();
    expect(status).toMatchObject({ installed: true, version: '1.19.6', version_ok: false });
    expect(status.error).toBe(
      'OpenCode 1.19.6 is not a 2.x release; Pantheon drives only the HTTP server of OpenCode 2',
    );
    expect((await older.adapter.probe()).capabilities.text_execution).toEqual({
      status: 'unsupported',
      evidence: status.error,
    });
  });

  it('reports no write or read isolation', () => {
    const { capabilities } = setup().adapter.report;
    expect(capabilities.write_isolation?.status).toBe('unsupported');
    expect(capabilities.read_isolation?.status).toBe('unsupported');
  });

  it('lists the models of the server in the folder', async () => {
    const oc = setup();
    expect(await oc.adapter.models(oc.spec.cwd)).toEqual([
      expect.objectContaining({
        id: 'fake/fake-model',
        label: 'Fake model',
        efforts: ['low', 'high'],
        default: true,
      }),
      expect.objectContaining({ id: 'fake/other-model', efforts: [], default: false }),
    ]);
  });

  it('switches the model of the live session', async () => {
    const oc = setup();
    const handle = await oc.start();
    expect(await oc.adapter.setModel(handle, 'fake/other-model', 'high')).toEqual({ ok: true });
    expect(oc.requests('POST', '/model')[0]!.body).toEqual({
      model: { providerID: 'fake', id: 'other-model', variant: 'high' },
    });
    expect(handle.reported_model).toBe('fake/other-model');
  });

  it('empties the process group of the server on close', async () => {
    const oc = setup();
    const handle = await oc.start();
    const pid = handle.process_identity!.pid;
    const helper = oc.entries().find((entry) => entry.kind === 'launch')!.helper!;
    expect(readProcessIdentity(helper)).toBeDefined();
    open.splice(0);
    const receipt = await oc.adapter.close(handle, Date.now() + 5000);
    expect(receipt.stopped).toBe(true);
    expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(readProcessIdentity(helper)).toBeUndefined();
    expect((await oc.adapter.inspect(handle)).state).toBe('exited');
  });
});
