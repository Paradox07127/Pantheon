import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { AuthRegistry } from '../../apps/daemon/src/index.js';
import { FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import type {
  ProjectBaseline,
  Review,
  Role,
  Session,
  SessionSpec,
  SessionTurn,
  Visual,
  Workspace,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { inPlaceSessionSpec } from '../../packages/control/dist/in-place-session.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A baseline reads a committed project, and worktree sessions branch from it. */
function commitProjectRoot(root: string) {
  for (const file of ['README.md', 'index.ts', 'notes.md'])
    writeFileSync(path.join(root, file), `${file}\n`);
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Initial files');
}

/** A planner session is the project baseline session; a reviewer reviews a worktree session. */
async function sessionFixture(role: 'reviewer' | 'planner') {
  let now = Date.now();
  const auth = new AuthRegistry('user-credential', () => now);
  const adapter = new FixtureAdapter();
  const starts = vi.spyOn(adapter, 'resume');
  const issued = new Map<string, string>();
  // Stands for the daemon, which hands Control only the path of the session's token file.
  const issue = (sessionId: string, sessionRole: Role) => {
    const token = auth.issueSession(f.store.must<Session>('sessions', sessionId), sessionRole);
    issued.set(sessionId, token);
    const directory = path.join(f.root, 'session-tokens');
    mkdirSync(directory, { recursive: true });
    const token_file = path.join(directory, sessionId);
    writeFileSync(token_file, token, { mode: 0o600 });
    return { token_file, daemon_url: 'http://127.0.0.1:4321' };
  };
  vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const f = await fixture({
    adapter,
    now: () => now,
    managedWorkspaces: true,
    controlOptions: {
      readProcess: () => undefined,
      issueSessionCredential: issue,
      revokeSessionCredential: (sessionId) => auth.revokeSession(sessionId),
    },
  });
  cleanup.push(() => f.close());
  commitProjectRoot(f.projectRoot);
  let review: Review | undefined;
  if (role === 'planner') {
    await f.call<Promise<ProjectBaseline>>('project.baseline.start', { project_id: f.project.id });
  } else {
    // A session review needs a runtime other than the one that wrote the session.
    const writer = new FixtureAdapter();
    writer.name = 'session-writer';
    f.control.adapters.set(writer.name, writer);
    const written = await f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: writer.name,
      input: 'Write a verifiable sentence',
    });
    const workspace = await awaitWorkspaceReady(f.control, written.workspace_id!);
    await eventually(
      () =>
        f.store.list<SessionTurn>('session_turns')[0]!.state === 'completed' &&
        f.store.must<Session>('sessions', written.id).state === 'open',
      () => f.control.tick(),
    );
    writeFileSync(path.join(workspace.path, 'draft.txt'), 'A verifiable sentence.\n');
    git(workspace.path, 'add', 'draft.txt');
    git(workspace.path, 'commit', '--quiet', '-m', 'Add the draft');
    review = await f.call<Review>('review.request', {
      session_id: written.id,
      runtimes: [adapter.name],
    });
  }
  await eventually(
    () => starts.mock.calls.length > 0,
    () => f.control.tick(),
  );
  const spec = starts.mock.calls.at(-1)![0];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    try {
      const principal = auth.authenticate(request.headers.get('authorization'));
      if (url.pathname === '/v1/session-principal')
        return Response.json(f.control.sessionPrincipal(principal));
      if (url.pathname === '/v1/commands')
        return Response.json({ receipt: await f.control.execute(principal, await request.json()) });
      if (url.pathname === '/v1/extensions.inventory')
        return Response.json(
          await f.control.extensionsInventory(
            principal,
            url.searchParams.get('project_id')!,
            url.searchParams.get('runtime')!,
          ),
        );
      throw new Error(`Unexpected route ${url.pathname}`);
    } catch (error) {
      return Response.json(
        {
          error: (error as { code?: string }).code ?? 'invalid_request',
          message: (error as Error).message,
        },
        { status: 403 },
      );
    }
  });
  vi.stubGlobal('fetch', fetcher);
  return {
    ...f,
    auth,
    issue,
    issued,
    spec,
    review,
    starts,
    fetcher,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const sessionToken = (spec: SessionSpec) =>
  readFileSync(spec.pantheon_mcp!.env.PANTHEON_SESSION_TOKEN_FILE!, 'utf8');

async function connect(spec: SessionSpec, token?: string) {
  expect(
    spec.pantheon_mcp,
    'control must mount a session credential before starting the runtime',
  ).toBeDefined();
  const { createMcpServer } = await import('../../apps/cli/src/mcp.js');
  const server = await createMcpServer(
    spec.pantheon_mcp!.env.PANTHEON_DAEMON_URL!,
    token ?? sessionToken(spec),
  );
  const client = new Client({ name: 'session-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}
const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { text: string }[])[0]!.text;
const receipt = (result: Awaited<ReturnType<Client['callTool']>>) => {
  const refused = /^Refused [^:]+: (\S+)(?: — ([\s\S]*))?$/.exec(text(result));
  return refused ? { error: refused[1], message: refused[2] } : JSON.parse(text(result));
};

const CONDUCTOR_TEXT =
  "Pantheon gives this session five tools. request_review: another vendor reviews your committed changes; the result comes back to you as a message. report_ready: your committed changes go through the project's gate and land. spawn_session: another vendor's session starts in a new worktree from your current commit; you hear when its turn ends. read_state: this project's changes, checks, landing queue and items waiting for the user. draw: a chart or diagram the user sees in this session. Plan, split work and run subagents with your own tools.";
/** Each conductor tool with a valid input, and the command it sends. */
const conductorCalls = [
  ['request_review', 'conductor.review', { runtimes: ['codex'] }],
  ['report_ready', 'conductor.ready', {}],
  ['spawn_session', 'conductor.spawn', { runtime: 'codex', input: 'Write the docs' }],
  ['read_state', 'conductor.state', {}],
] as const;
const refusalCode = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error('Expected a refusal');
};

it('describes project_read facts without promising feedback', async () => {
  const client = await connect((await sessionFixture('planner')).spec);
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'project_read');
  expect(tool).toBeDefined();
  for (const fact of ['details', 'brief', "every lead's board plan"])
    expect(tool!.description).toContain(fact);
  expect(tool!.description).toContain("each task's state and sessions");
  expect(tool!.description).not.toMatch(/feedback/i);
});

it('binds baseline tools to the session baseline and explains a refused input', async () => {
  const f = await sessionFixture('planner');
  const baseline = f.store.list<ProjectBaseline>('project_baselines')[0]!;
  expect(baseline.session_id).toBe(f.spec.platform_session_id);
  writeFileSync(path.join(f.projectRoot, 'package.json'), '{"scripts":{"test":"vitest"}}');
  const client = await connect(f.spec);
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual(
    [
      'memory_context',
      'memory_search',
      'memory_related',
      'memory_get',
      'memory_propose',
      'draw',
      'project_baseline_submit',
      'project_baseline_submit_folder',
      'project_intro_submit',
      'project_extensions_inventory',
      'project_read',
    ].sort(),
  );
  for (const name of ['project_baseline_submit_folder', 'project_baseline_submit']) {
    const schema = tools.find((tool) => tool.name === name)!.inputSchema;
    expect(schema.type).toBe('object');
    expect(schema.properties).not.toHaveProperty('baseline_id');
    expect(schema.properties).not.toHaveProperty('expected_revision');
    expect(JSON.stringify(schema)).not.toMatch(/"type":"(number|integer)"/);
  }
  const folder = {
    root: f.project.roots[0]!,
    stage: 'active',
    gate: [{ name: 'test', argv: ['pnpm', 'test'], sources: ['file:package.json'] }],
  };
  const stored = await client.callTool({
    name: 'project_baseline_submit_folder',
    arguments: folder,
  });
  expect(stored.isError).not.toBe(true);
  expect(text(stored)).toMatch(`Accepted project.baseline.submit_folder: id=${baseline.id}`);
  expect(f.store.must<ProjectBaseline>('project_baselines', baseline.id)).toMatchObject({
    folders: [folder],
  });
  const sent = await new Request(...(f.fetcher.mock.calls.at(-1) as [string, RequestInit])).json();
  expect(sent).toMatchObject({
    type: 'project.baseline.submit_folder',
    expected_revision: null,
    input: { ...folder, baseline_id: baseline.id },
  });

  const refused = await client.callTool({
    name: 'project_baseline_submit_folder',
    arguments: { ...folder, stage: 'finished' },
  });
  expect(refused.isError).toBe(true);
  expect(receipt(refused)).toMatchObject({
    error: 'invalid_request',
    message: expect.stringContaining('stage'),
  });
  const bound = await client.callTool({
    name: 'project_baseline_submit_folder',
    arguments: { ...folder, baseline_id: 'another-assessment' },
  });
  expect(receipt(bound)).toMatchObject({
    error: 'invalid_request',
    message: expect.stringContaining('baseline_id'),
  });
});

it('lists enabled extensions to the baseline session only', async () => {
  const f = await sessionFixture('planner');
  Object.assign(f.adapter, {
    inventory: async () => ({
      runtime: f.adapter.name,
      mcp_servers: [
        { name: 'browser-automation', enabled: true, plugin: 'web-tools@market' },
        { name: 'retired-server', enabled: false },
      ],
      plugins: [{ id: 'web-tools@market', enabled: true }],
      skills: [{ id: '/skills/deploy/SKILL.md', name: 'deploy', enabled: true }],
      apps: false,
      hooks: [],
    }),
  });
  const session = f.store.must<Session>('sessions', f.spec.platform_session_id);
  f.store.update('sessions', { ...session, baseline: undefined }, session.revision);
  const plain = await connect(f.spec);
  expect((await plain.listTools()).tools.map((tool) => tool.name)).not.toContain(
    'project_extensions_inventory',
  );
  const refused = await plain.callTool({ name: 'project_extensions_inventory', arguments: {} });
  expect(refused.isError).toBe(true);
  expect(receipt(refused).error).toBe('permission_denied');

  const plainSession = f.store.must<Session>('sessions', session.id);
  f.store.update(
    'sessions',
    { ...plainSession, baseline: session.baseline },
    plainSession.revision,
  );
  const client = await connect(f.spec);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
    'project_extensions_inventory',
  );
  const listed = await client.callTool({ name: 'project_extensions_inventory', arguments: {} });
  expect(listed.isError).not.toBe(true);
  expect(text(listed)).toContain(f.adapter.name);
  expect(text(listed)).toContain('browser-automation (plugin web-tools@market)');
  expect(text(listed)).toContain('web-tools@market');
  expect(text(listed)).toContain('deploy');
  expect(text(listed)).toContain('/skills/deploy/SKILL.md');
  expect(text(listed)).not.toContain('retired-server');
  expect(text(listed)).not.toContain('{');
});

it.each([
  [
    'reviewer',
    [
      'memory_context',
      'memory_search',
      'memory_related',
      'memory_get',
      'memory_propose',
      'review_finding',
      'review_verdict',
    ],
  ],
  [
    'planner',
    [
      'memory_context',
      'memory_search',
      'memory_related',
      'memory_get',
      'memory_propose',
      'project_read',
      'draw',
      'project_baseline_submit_folder',
      'project_baseline_submit',
      'project_intro_submit',
      'project_extensions_inventory',
    ],
  ],
] as const)(
  'lists only the authenticated %s session tools and keeps credentials out of storage',
  async (role, names) => {
    const f = await sessionFixture(role);
    const client = await connect(f.spec);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(names);
    const token = sessionToken(f.spec);
    expect(f.auth.authenticate(`Bearer ${token}`)).toEqual({
      id: `session:${f.spec.platform_session_id}`,
      session_id: f.spec.platform_session_id,
      project_id: f.project.id,
      role,
      expires_at: expect.any(Number),
    });
    expect(f.spec.pantheon_mcp).toMatchObject({
      command: process.execPath,
      args: [path.join(process.cwd(), 'apps/cli/dist/index.js'), 'mcp'],
    });
    expect(f.spec.env_allowlist).not.toContain('PANTHEON_SESSION_TOKEN_FILE');
    expect(JSON.stringify(f.store.events())).not.toContain(token);
    expect(JSON.stringify(f.store.list('sessions'))).not.toContain(token);
    expect(JSON.stringify(f.store.pending())).not.toContain(token);
  },
);

it.each(['reviewer', 'planner'] as const)(
  'hands the %s runtime the path of its token file and never the token itself',
  async (role) => {
    const f = await sessionFixture(role);
    const token = f.issued.get(f.spec.platform_session_id)!;
    expect(f.auth.authenticate(`Bearer ${token}`)).toMatchObject({
      session_id: f.spec.platform_session_id,
    });
    expect(JSON.stringify(f.spec)).not.toContain(token);
    expect(sessionToken(f.spec)).toBe(token);
  },
);

it('records evidence-bound findings only for the authenticated reviewer and reports rejection', async () => {
  const f = await sessionFixture('reviewer');
  const client = await connect(f.spec);
  const finding = {
    blocking: false,
    location: 'draft.txt:1',
    quote: 'A verifiable sentence.',
    evidence: 'The source is absent',
    impact: 'The claim cannot be checked',
  };
  const result = await client.callTool({ name: 'review_finding', arguments: finding });
  expect(result.isError).not.toBe(true);
  expect(receipt(result).receipt).toMatchObject({ review_id: f.review!.id, status: 'open' });
  const rejected = await client.callTool({
    name: 'review_finding',
    arguments: { ...finding, quote: 'Invented quote' },
  });
  expect(rejected.isError).toBe(true);
  expect(receipt(rejected).error).toBe('quote_not_in_artifact');
  const foreign = await client.callTool({
    name: 'review_finding',
    arguments: {
      ...finding,
      review_id: 'someone-elses-review',
      session_id: 'someone-elses-session',
    },
  });
  expect(foreign.isError).toBe(true);
  expect(f.store.must<Review>('reviews', f.review!.id).findings).toMatchObject([
    { ...finding, status: 'open' },
    { status: 'rejected' },
  ]);
});

it.each(['reviewer', 'planner'] as const)(
  'gives every %s tool an object input schema without top-level alternatives',
  async (role) => {
    const client = await connect((await sessionFixture(role)).spec);
    for (const tool of (await client.listTools()).tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      for (const key of ['anyOf', 'oneOf', 'allOf'])
        expect(tool.inputSchema, `${tool.name} ${key}`).not.toHaveProperty(key);
    }
  },
);

it.each(['expired', 'closed', 'revoked', 'restarted'] as const)(
  'refuses an already connected MCP client after its credential is %s',
  async (ending) => {
    const f = await sessionFixture('planner');
    const client = await connect(f.spec);
    const token = sessionToken(f.spec);
    if (ending === 'expired') f.advance(24 * 60 * 60 * 1000);
    else if (ending === 'closed') await f.control.shutdown();
    else if (ending === 'revoked') f.auth.revokeSession(f.spec.platform_session_id);
    else
      vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
        const fresh = new AuthRegistry('new-user-credential');
        try {
          fresh.authenticate(new Headers(init.headers).get('authorization'));
        } catch {
          return Response.json({ error: 'permission_denied' }, { status: 403 });
        }
        throw new Error('Old credential survived restart');
      });
    await expect(client.listTools()).rejects.toThrow(/permission_denied/);
    const result = await client.callTool({ name: 'project_read', arguments: {} });
    expect(result.isError).toBe(true);
    expect(receipt(result).error).toBe('permission_denied');
    if (ending === 'closed') expect(() => f.auth.authenticate(`Bearer ${token}`)).toThrow();
  },
);

it('never accepts a user or sessionless credential as an MCP session credential', async () => {
  const f = await sessionFixture('planner');
  f.auth.add('unbound-credential', {
    id: 'unbound-planner',
    role: 'planner',
    project_id: f.project.id,
  });
  for (const token of ['user-credential', 'unbound-credential'])
    await expect(connect(f.spec, token)).rejects.toThrow(/permission_denied/);
});

it('rotates session credentials when a native session resumes', async () => {
  const f = await sessionFixture('planner');
  await connect(f.spec);
  const first = sessionToken(f.spec);
  await f.control.shutdown();
  const session = f.store.must<Session>('sessions', f.spec.platform_session_id);
  // A new control instance represents the dispatcher after a disconnected process.
  const { Control } = await import('@pantheon/control');
  const control = new Control(f.store, f.files, [f.adapter], undefined, {
    readProcess: () => undefined,
    issueSessionCredential: f.issue,
    revokeSessionCredential: (sessionId) => f.auth.revokeSession(sessionId),
  });
  cleanup.push(() => control.shutdown());
  // A baseline session takes no user input; resolving its reconciliation resumes it.
  const reconciling = f.store.update(
    'sessions',
    {
      ...session,
      state: 'reconciling',
      process_identity: { pid: 41001, start_time_us: 1700000000000000 },
    },
    session.revision,
  );
  f.adapter.report.capabilities.resume = { status: 'supported', evidence: 'Fixture native resume' };
  control.execute(
    user,
    command(
      user.id,
      'session.resolve',
      { session_id: session.id, choice: 'resume_session' },
      reconciling.revision,
    ),
  );
  await control.tick();
  const resumed = f.starts.mock.calls.at(-1)![0];
  expect(sessionToken(resumed)).not.toBe(first);
  expect(() => f.auth.authenticate(`Bearer ${first}`)).toThrow();
  expect(f.auth.authenticate(`Bearer ${sessionToken(resumed)}`)).toMatchObject({
    session_id: session.id,
    role: 'planner',
  });
});

it.each(['reviewer', 'planner'] as const)(
  'authenticates MCP during the %s resume handshake before the native handle is saved',
  async (role) => {
    const f = await sessionFixture(role);
    const session = f.store.must<Session>('sessions', f.spec.platform_session_id);
    const reconciling = f.store.update(
      'sessions',
      {
        ...session,
        state: 'reconciling',
        process_identity: { pid: 41001, start_time_us: 1700000000000000 },
      },
      session.revision,
    );
    f.adapter.report.capabilities.resume = {
      status: 'supported',
      evidence: 'Fixture native resume',
    };
    let listed = false;
    let handshakeError: unknown;
    f.starts.mockImplementationOnce(async (spec, nativeId, sink) => {
      try {
        const client = await connect(spec);
        listed = (await client.listTools()).tools.length > 0;
      } catch (error) {
        handshakeError = error;
        throw error;
      }
      return FixtureAdapter.prototype.resume.call(f.adapter, spec, nativeId, sink);
    });
    f.call(
      'session.resolve',
      { session_id: session.id, choice: 'resume_session' },
      reconciling.revision,
    );
    await f.control.tick();
    expect(handshakeError).toBeUndefined();
    expect(listed).toBe(true);
  },
);

it('starts planner sessions without inherited extensions and writers with the project overrides', async () => {
  const planner = await sessionFixture('planner');
  expect(planner.spec.extensions).toEqual({ mode: 'none' });
  const written = await planner.call<Session>('session.create', {
    project_id: planner.project.id,
    runtime: planner.adapter.name,
    input: 'Write with the project overrides',
  });
  await awaitWorkspaceReady(planner.control, written.workspace_id!);
  await eventually(
    () => planner.starts.mock.calls.some(([spec]) => spec.platform_session_id === written.id),
    () => planner.control.tick(),
  );
  const writer = planner.starts.mock.calls.find(
    ([spec]) => spec.platform_session_id === written.id,
  )!;
  expect(writer[0].extensions).toMatchObject({ mode: 'inherit' });
});

it('refuses a credential role that does not match the session', async () => {
  const f = await sessionFixture('planner');
  const planner = f.store.must<Session>('sessions', f.spec.platform_session_id);
  const workbench = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Write a sentence',
  });
  expect(() => f.auth.issueSession(workbench, 'planner')).toThrow('Active session required');
  expect(() => f.auth.issueSession(planner, 'lead')).toThrow('Active session required');
});

it('mounts only the five conductor tools and their instructions on a conductor worktree session', async () => {
  const f = await sessionFixture('planner');
  const draft = f.call<{ id: string; revision: number }>('memory.propose', {
    project_id: f.project.id,
    key: 'language',
    kind: 'decision',
    text: 'Use precise terminology',
  });
  f.call('memory.commit', { memory_id: draft.id }, draft.revision);
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    purpose: 'conductor',
  });
  expect(session).toMatchObject({ conductor: true });
  expect(session).not.toHaveProperty('lead');
  const workspace = await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.starts.mock.calls.some(([spec]) => spec.platform_session_id === session.id),
    () => f.control.tick(),
  );
  const spec = f.starts.mock.calls.find(([spec]) => spec.platform_session_id === session.id)![0];
  expect(spec.pantheon_mcp).toBeDefined();
  expect(spec.pantheon_mcp).not.toHaveProperty('ask_tools');
  expect(spec.control_instructions).toBe(
    `You are working for the user in the git worktree at ${workspace.path}. When your changes are complete, commit them there with git. Do not write files outside this worktree.\n\n${CONDUCTOR_TEXT}`,
  );
  const send = vi.mocked(f.adapter.send);
  await eventually(
    () => send.mock.calls.some(([, turn]) => turn.input.includes('Ship the export')),
    () => f.control.tick(),
  );
  expect(
    send.mock.calls.find(([, turn]) => turn.input.includes('Ship the export'))![1].input,
  ).not.toContain('[Pantheon current project memory]');
  const principal = f.auth.authenticate(`Bearer ${sessionToken(spec)}`)!;
  expect(principal).toMatchObject({ session_id: session.id, role: 'conductor' });
  expect(f.control.sessionPrincipal(principal).allowed_tool_names).toBeUndefined();
  const client = await connect(spec);
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {})])).toEqual([
    ['request_review', ['runtimes', 'session_id']],
    ['report_ready', ['session_id']],
    ['spawn_session', ['runtime', 'input', 'model', 'effort']],
    ['read_state', []],
    ['draw', ['title', 'kind', 'spec', 'source', 'size', 'replaces', 'pin']],
  ]);
  for (const [, type, input] of conductorCalls)
    expect(
      refusalCode(() => f.call(type, input)),
      type,
    ).toBe('permission_denied');
});

it('mounts the conductor tools on a conductor session in the project folder', async () => {
  const f = await workbenchFixture();
  const auth = new AuthRegistry('user-credential', () => f.store.now());
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  Object.assign(ctx, {
    issueSessionCredential: (sessionId: string, role: Role) => {
      const token_file = path.join(f.root, `token-${sessionId}`);
      writeFileSync(
        token_file,
        auth.issueSession(f.store.must<Session>('sessions', sessionId), role),
        {
          mode: 0o600,
        },
      );
      return { token_file, daemon_url: 'http://127.0.0.1:4321' };
    },
  });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    try {
      const principal = auth.authenticate(request.headers.get('authorization'));
      if (new URL(request.url).pathname === '/v1/session-principal')
        return Response.json(f.control.sessionPrincipal(principal));
      return Response.json({ receipt: await f.control.execute(principal, await request.json()) });
    } catch (error) {
      return Response.json(
        { error: (error as { code?: string }).code, message: (error as Error).message },
        { status: 403 },
      );
    }
  });
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the parser fix',
    workspace: 'in_place',
    purpose: 'conductor',
  });
  expect(session).toMatchObject({ conductor: true, in_place: {} });
  const spec = await inPlaceSessionSpec(ctx, session);
  const folder = f.store.must<import('@pantheon/domain').Workspace>(
    'workspaces',
    session.workspace_id!,
  ).path;
  expect(spec.control_instructions).toBe(
    `You are working in the project folder at ${folder}, on its current branch. Commit your changes there; Pantheon runs the gates in this folder, and the session lands once they pass on the commit you leave. Do not write files outside the project folder.\n\n${CONDUCTOR_TEXT}`,
  );
  const client = await connect(spec);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
    ...conductorCalls.map(([name]) => name),
    'draw',
  ]);
  expect(
    receipt(await client.callTool({ name: 'read_state', arguments: {} })).receipt,
  ).toMatchObject({ changes: expect.any(Array), todo: expect.any(Array) });
});

/** The spec without the Pantheon server and instructions, with each value that names a session or its workspace replaced. */
function comparable(spec: SessionSpec, own: Workspace, other: Workspace) {
  const { pantheon_mcp: _server, control_instructions: _instructions, ...rest } = spec;
  let text = JSON.stringify(rest);
  for (const [value, name] of [
    [spec.env!.TMPDIR!, '<own temporary directory>'],
    [own.path, '<own workspace>'],
    [other.path, '<other workspace>'],
    [path.basename(own.path), '<own workspace name>'],
    [path.basename(other.path), '<other workspace name>'],
    [own.id, '<own workspace id>'],
    [other.id, '<other workspace id>'],
    [spec.platform_session_id, '<session id>'],
  ] as const)
    text = text.replaceAll(value, name);
  return JSON.parse(text) as Record<string, unknown>;
}

/** A workbench whose Control hands a session the path of a credential file. */
async function credentialedWorkbench() {
  const f = await workbenchFixture();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  Object.assign(ctx, {
    issueSessionCredential: (sessionId: string) => ({
      token_file: path.join(f.root, `token-${sessionId}`),
      daemon_url: 'http://127.0.0.1:4321',
    }),
  });
  return { f, ctx };
}

it('runs a conductor worktree session as the session the user opens, with the Pantheon server added', async () => {
  const { f, ctx } = await credentialedWorkbench();
  const open = (purpose?: 'conductor') =>
    f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Ship the export',
      ...(purpose ? { purpose } : {}),
    });
  const plain = await open();
  const conductor = await open('conductor');
  const plainWorkspace = await awaitWorkspaceReady(f.control, plain.workspace_id!);
  const conductorWorkspace = await awaitWorkspaceReady(f.control, conductor.workspace_id!);
  const plainSpec = workbenchSessionSpec(ctx, f.store.must<Session>('sessions', plain.id));
  const conductorSpec = workbenchSessionSpec(ctx, f.store.must<Session>('sessions', conductor.id));
  expect(plainSpec.pantheon_mcp).toBeUndefined();
  expect(conductorSpec.pantheon_mcp).toBeDefined();
  expect(comparable(conductorSpec, conductorWorkspace, plainWorkspace)).toEqual(
    comparable(plainSpec, plainWorkspace, conductorWorkspace),
  );
  expect(conductorSpec.user_session).toBe(true);
});

it('runs a conductor session in the project folder as the session the user opens there, with the Pantheon server added', async () => {
  const { f, ctx } = await credentialedWorkbench();
  const open = (purpose?: 'conductor') =>
    f.call<Promise<Session>>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      input: 'Ship the parser fix',
      workspace: 'in_place',
      ...(purpose ? { purpose } : {}),
    });
  const plain = await open();
  const plainSpec = await inPlaceSessionSpec(ctx, plain);
  // One session at a time writes in the project folder.
  const opened = f.store.must<Session>('sessions', plain.id);
  f.store.update(
    'sessions',
    { ...opened, archived_at: new Date(f.store.now()).toISOString() },
    opened.revision,
  );
  const conductor = await open('conductor');
  const conductorSpec = await inPlaceSessionSpec(ctx, conductor);
  const workspace = (session: Session) =>
    f.store.must<Workspace>('workspaces', session.workspace_id!);
  expect(plainSpec.pantheon_mcp).toBeUndefined();
  expect(conductorSpec.pantheon_mcp).toBeDefined();
  expect(comparable(conductorSpec, workspace(conductor), workspace(plain))).toEqual(
    comparable(plainSpec, workspace(plain), workspace(conductor)),
  );
  expect(conductorSpec.user_session).toBe(true);
});

it('gives a session another session spawned no Pantheon tools', async () => {
  const f = await sessionFixture('planner');
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Write the docs',
  });
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const spawned = f.store.update(
    'sessions',
    { ...f.store.must<Session>('sessions', session.id), spawned_by: { session_id: 'conductor' } },
    f.store.must<Session>('sessions', session.id).revision,
  );
  const spec = workbenchSessionSpec(ctx, spawned);
  expect(spec.pantheon_mcp).toBeUndefined();
  expect(spec.user_session).toBe(true);
  expect(spec.control_instructions).toBe('');
});

it('exposes draw without credential fields and returns field errors and redraw receipts', async () => {
  const f = await sessionFixture('planner');
  // A baseline session hands its charts to the board, so a change interpreter session draws here.
  const session = f.store.must<Session>('sessions', f.spec.platform_session_id);
  f.store.update(
    'sessions',
    { ...session, baseline: undefined, change_story: { story_id: 'story' } },
    session.revision,
  );
  const client = await connect(f.spec);
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'draw')!;
  expect(tool).toBeDefined();
  const fields = tool.inputSchema.properties as Record<string, { description?: string }>;
  expect(fields.source?.description).toContain('Optional single line');
  expect(fields.size?.description).toContain('card height');
  expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([
    'title',
    'kind',
    'spec',
    'source',
    'size',
    'replaces',
    'pin',
  ]);
  const drawn = await client.callTool({
    name: 'draw',
    arguments: {
      title: 'Chart',
      kind: 'mermaid',
      spec: { source: 'graph LR; a-->b' },
      source: 'data/results.csv',
      size: 'S',
    },
  });
  expect(drawn.isError, text(drawn)).toBeFalsy();
  const first = receipt(drawn).receipt as { visual_id: string; revision: number };
  expect(first).toEqual({ visual_id: expect.any(String), revision: 1 });
  expect(f.store.must<Visual>('visuals', first.visual_id)).toMatchObject({
    source: 'data/results.csv',
    size: 'S',
  });
  const invalid = await client.callTool({
    name: 'draw',
    arguments: {
      title: 'Chart',
      kind: 'kline',
      spec: { candles: [2, 1].map((time) => ({ time, open: 1, high: 2, low: 0, close: 1 })) },
    },
  });
  expect(invalid.isError).toBe(true);
  expect(text(invalid)).toMatch(/candles.*1.*time.*increasing/s);
  const failed = f.store.list<Visual>('visuals').find((visual) => visual.id !== first.visual_id)!;
  expect(failed.error).toEqual([
    { message: 'time must be strictly increasing', path: ['candles', 1, 'time'] },
  ]);
  const redrawn = await client.callTool({
    name: 'draw',
    arguments: {
      title: 'Updated',
      kind: 'html',
      spec: { html: '<html>Chart</html>' },
      replaces: first.visual_id,
    },
  });
  expect(redrawn.isError, text(redrawn)).toBeFalsy();
  expect(receipt(redrawn).receipt).toEqual({ visual_id: first.visual_id, revision: 2 });
  const repaired = await client.callTool({
    name: 'draw',
    arguments: {
      title: 'Repaired',
      kind: 'mermaid',
      spec: { source: 'graph LR; a-->b' },
      replaces: failed.id,
    },
  });
  expect(repaired.isError, text(repaired)).toBeFalsy();
  expect(receipt(repaired).receipt).toEqual({ visual_id: failed.id, revision: 2 });
  expect(f.store.must<Visual>('visuals', failed.id)).not.toHaveProperty('error');
});

it('offers sortable tables through draw and returns table cell errors', async () => {
  const f = await sessionFixture('planner');
  // A baseline session hands its charts to the board, so a change interpreter session draws here.
  const session = f.store.must<Session>('sessions', f.spec.platform_session_id);
  f.store.update(
    'sessions',
    { ...session, baseline: undefined, change_story: { story_id: 'story' } },
    session.revision,
  );
  const client = await connect(f.spec);
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'draw')!;
  expect(tool.inputSchema.properties?.kind).toMatchObject({
    enum: expect.arrayContaining(['table']),
  });
  expect(
    (tool.inputSchema.properties as Record<string, { description?: string }>).spec?.description,
  ).toContain('sort?: { key, direction }');
  const spec = {
    columns: [{ key: 'value', title: 'Value', type: 'number' }],
    rows: [{ value: 2 }, {}],
    sort: { key: 'value', direction: 'asc' },
  };
  const drawn = await client.callTool({
    name: 'draw',
    arguments: { title: 'Values', kind: 'table', spec },
  });
  expect(drawn.isError, text(drawn)).toBeFalsy();
  const { visual_id } = receipt(drawn).receipt as { visual_id: string };
  expect(f.store.must('visuals', visual_id)).toMatchObject({ kind: 'table', spec });
  const invalid = await client.callTool({
    name: 'draw',
    arguments: { title: 'Values', kind: 'table', spec: { ...spec, rows: [{ value: 'two' }] } },
  });
  expect(invalid.isError).toBe(true);
  expect(text(invalid)).toMatch(/rows.*0.*value/s);
});

it('exposes introduction submission only to its purpose sessions with no bound or measured input fields', async () => {
  const f = await sessionFixture('planner');
  const baselineClient = await connect(f.spec);
  expect((await baselineClient.listTools()).tools.map((tool) => tool.name)).toContain(
    'project_intro_submit',
  );
  const session = f.store.must<Session>('sessions', f.spec.platform_session_id);
  f.store.update('sessions', { ...session, baseline: undefined, intro: true }, session.revision);
  const client = await connect(f.spec);
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name)).toEqual([
    'memory_context',
    'memory_search',
    'memory_related',
    'memory_get',
    'memory_propose',
    'project_read',
    'project_intro_submit',
  ]);
  const tool = tools.find((tool) => tool.name === 'project_intro_submit')!;
  expect(tool.inputSchema.properties).not.toHaveProperty('project_id');
  expect(tool.inputSchema.properties).not.toHaveProperty('expected_revision');
  expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"type":"(number|integer)"/);
  expect(tool.description).toContain('Pantheon measures');
  const result = await client.callTool({
    name: 'project_intro_submit',
    arguments: { summary: 'Reads notes.', sources: ['file:README.md'], features: [], modules: [] },
  });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(text(result))).toEqual({ written: true });
  const invalid = await client.callTool({
    name: 'project_intro_submit',
    arguments: { summary: 'x'.repeat(281), sources: ['file:README.md'], features: [], modules: [] },
  });
  expect(invalid.isError).toBe(true);
  expect(text(invalid)).toContain('summary');
  const current = f.store.must<Session>('sessions', session.id);
  f.store.update(
    'sessions',
    { ...current, intro: undefined, change_story: { story_id: 'story' } },
    current.revision,
  );
  expect((await (await connect(f.spec)).listTools()).tools.map((tool) => tool.name)).not.toContain(
    'project_intro_submit',
  );
});
