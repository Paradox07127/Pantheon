import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { AuthRegistry } from '../../apps/daemon/src/index.js';
import { FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import type {
  BoardPlan,
  ProjectBaseline,
  Review,
  Role,
  Session,
  SessionSpec,
  SessionTurn,
  Visual,
} from '@pantheon/domain';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { git } from './workbench-fixture.js';

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
  const f = fixture({
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
    f.call<ProjectBaseline>('project.baseline.start', { project_id: f.project.id });
  } else {
    // A session review needs a runtime other than the one that wrote the session.
    const writer = new FixtureAdapter();
    writer.name = 'session-writer';
    f.control.adapters.set(writer.name, writer);
    const written = f.call<Session>('session.create', {
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
    review = f.call<Review>('review.request', {
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
        return Response.json({ receipt: f.control.execute(principal, await request.json()) });
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

it('describes project_read facts without promising feedback', async () => {
  const client = await connect((await sessionFixture('planner')).spec);
  const tool = (await client.listTools()).tools.find((tool) => tool.name === 'project_read');
  expect(tool).toBeDefined();
  for (const fact of [
    'project details',
    'brief',
    'milestones',
    'cursor',
    "every lead's board plan",
  ])
    expect(tool!.description).toContain(fact);
  expect(tool!.description).toContain("each task's sessions and state");
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
  const written = planner.call<Session>('session.create', {
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

it('mounts a lead credential on a workbench session and a worker credential on a session opened from its task', async () => {
  const f = await sessionFixture('planner');
  const opened = async (input: Record<string, unknown>) => {
    const session = f.call<Session>('session.create', {
      project_id: f.project.id,
      runtime: f.adapter.name,
      ...input,
    });
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    await eventually(
      () => f.starts.mock.calls.some(([spec]) => spec.platform_session_id === session.id),
      () => f.control.tick(),
    );
    const spec = f.starts.mock.calls.find(([spec]) => spec.platform_session_id === session.id)![0];
    return { session, spec };
  };
  const lead = await opened({ input: 'Plan the export feature' });
  expect(lead.spec.pantheon_mcp).toBeDefined();
  expect(lead.spec.pantheon_mcp!.ask_tools).toEqual(['rerun_baseline']);
  expect(f.auth.authenticate(`Bearer ${sessionToken(lead.spec)}`)).toMatchObject({
    session_id: lead.session.id,
    role: 'lead',
  });
  const leadClient = await connect(lead.spec);
  expect((await leadClient.listTools()).tools.map((tool) => tool.name)).toEqual([
    'memory_context',
    'memory_search',
    'memory_related',
    'memory_get',
    'memory_propose',
    'project_read',
    'update_board',
    'edit_board',
    'propose_board',
    'withdraw_board_proposal',
    'milestone_accept',
    'start_task',
    'message_task',
    'accept_task',
    'read_note',
    'ask_user',
    'stop_task',
    'report',
    'interrupt_task',
    'stop_background',
    'propose_improvement',
    'sync_board',
    'rerun_baseline',
    'request_review',
    'merge_task',
    'draw',
    'theme',
    'browser_open',
    'browser_read',
    'browser_screenshot',
  ]);
  const plan = {
    base_version: 0,
    headline: 'Export',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'api',
        title: 'Export API',
        goal: 'Serve exports over HTTP',
        lane: 'core',
        milestone: 'm1',
        depends_on: [],
        source: ['Plan the export feature'],
        scope: ['src/export'],
        acceptance: ['pnpm test'],
      },
    ],
    milestones: [
      { id: 'm1', title: 'First export', criteria: ['Exports download'], tasks: ['api'] },
    ],
    risks: [],
    assumptions: [],
  };
  const written = await leadClient.callTool({ name: 'update_board', arguments: plan });
  expect(written.isError, text(written)).toBeFalsy();

  const worker = await opened({ input: 'Build the export API', task_id: `${lead.session.id}:api` });
  expect(f.auth.authenticate(`Bearer ${sessionToken(worker.spec)}`)).toMatchObject({
    session_id: worker.session.id,
    role: 'worker',
  });
  expect(worker.spec.pantheon_mcp).not.toHaveProperty('ask_tools');
  const workerClient = await connect(worker.spec);
  expect((await workerClient.listTools()).tools.map((tool) => tool.name)).toEqual([
    'memory_context',
    'memory_search',
    'memory_related',
    'memory_get',
    'memory_propose',
    'project_read',
    'report',
    'draw',
    'theme',
    'browser_open',
    'browser_read',
    'browser_screenshot',
  ]);
  expect(text(await workerClient.callTool({ name: 'update_board', arguments: plan }))).toBe(
    'Refused update_board: permission_denied',
  );

  const otherReviewer = new FixtureAdapter();
  otherReviewer.name = 'cross-reviewer';
  f.control.adapters.set(otherReviewer.name, otherReviewer);
  const workerPath = f.store.must<import('@pantheon/domain').Workspace>(
    'workspaces',
    worker.session.workspace_id!,
  ).path;
  mkdirSync(path.join(workerPath, 'src/export'), { recursive: true });
  writeFileSync(path.join(workerPath, 'src/export/answer.txt'), 'export ready\n');
  git(workerPath, 'add', '--', 'src/export/answer.txt');
  git(workerPath, 'commit', '--quiet', '-m', 'Write export answer');
  const requestedReview = await leadClient.callTool({
    name: 'request_review',
    arguments: { session_id: worker.session.id, runtimes: [otherReviewer.name] },
  });
  expect(requestedReview.isError, text(requestedReview)).toBeFalsy();
  expect(JSON.parse(text(requestedReview)).receipt).toMatchObject({
    session_id: worker.session.id,
    requester: { lead_session_id: lead.session.id, task_id: 'api', generation: 1 },
  });
  expect(
    text(
      await workerClient.callTool({
        name: 'request_review',
        arguments: { session_id: worker.session.id, runtimes: [otherReviewer.name] },
      }),
    ),
  ).toBe('Refused request_review: permission_denied');

  const reported = await workerClient.callTool({
    name: 'report',
    arguments: { kind: 'risk', text: 'The export format may change' },
  });
  expect(reported.isError, text(reported)).toBeFalsy();
  const inbox = f.store.must<BoardPlan>('board_plans', lead.session.id).inbox;
  // The first note tells the lead the user opened the worker from the board.
  expect(inbox.map((each) => each.kind)).toEqual(['user_edit', 'risk']);
  const note = inbox[1];
  const read = await leadClient.callTool({ name: 'read_note', arguments: { note_id: note!.id } });
  expect(read.isError, text(read)).toBeFalsy();
  expect(text(read)).toContain('The export format may change');
  const stop = { task_id: 'api', reason: 'The export moves to another service' };
  expect(text(await workerClient.callTool({ name: 'stop_task', arguments: stop }))).toBe(
    'Refused stop_task: permission_denied',
  );
});

it('tells a lead to plan a small change as one direct task before it changes the repository', async () => {
  const f = await sessionFixture('planner');
  const lead = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Add an optional phone field to createContact',
  });
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.starts.mock.calls.some(([spec]) => spec.platform_session_id === lead.id),
    () => f.control.tick(),
  );
  const instructions = f.starts.mock.calls.find(
    ([spec]) => spec.platform_session_id === lead.id,
  )![0].control_instructions!;
  expect(instructions).not.toContain('leave the board alone');
  expect(instructions).not.toContain('Use update_board only when');
  for (const phrase of [
    'every request that changes the repository',
    'as one task whose scope names the one or two files it changes',
    'claim it with start_task',
    'only answers a question and changes nothing needs no task',
  ])
    expect(instructions).toContain(phrase);
});

it('lets a lead stop a task of its plan through stop_task, without a project id', async () => {
  const f = await sessionFixture('planner');
  const lead = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Plan the export feature',
  });
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.starts.mock.calls.some(([spec]) => spec.platform_session_id === lead.id),
    () => f.control.tick(),
  );
  const client = await connect(
    f.starts.mock.calls.find(([spec]) => spec.platform_session_id === lead.id)![0],
  );
  const tool = (await client.listTools()).tools.find((each) => each.name === 'stop_task')!;
  expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['task_id', 'reason']);
  const written = await client.callTool({
    name: 'update_board',
    arguments: {
      base_version: 0,
      headline: 'Export',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'api',
          title: 'Export API',
          goal: 'Serve exports over HTTP',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
          path: 'dispatch',
          flow_reason: 'The export needs a session of its own',
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
  });
  expect(written.isError, text(written)).toBeFalsy();
  const started = await client.callTool({ name: 'start_task', arguments: { task_ids: ['api'] } });
  expect(started.isError, text(started)).toBeFalsy();
  const stopped = await client.callTool({
    name: 'stop_task',
    arguments: { task_id: 'api', reason: 'The export moves to another service' },
  });
  expect(stopped.isError, text(stopped)).toBeFalsy();
  expect(receipt(stopped).receipt).toEqual({
    task_id: 'api',
    dequeued: true,
    sessions: [],
    task_state: 'todo',
  });
});

it('hands a lead that calls sync_board its plan and the recent commits of the project', async () => {
  const f = await sessionFixture('planner');
  const lead = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Plan the export feature',
  });
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () => f.starts.mock.calls.some(([spec]) => spec.platform_session_id === lead.id),
    () => f.control.tick(),
  );
  const client = await connect(
    f.starts.mock.calls.find(([spec]) => spec.platform_session_id === lead.id)![0],
  );
  const written = await client.callTool({
    name: 'update_board',
    arguments: {
      base_version: 0,
      headline: 'Export',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'export-api',
          title: 'Export API',
          goal: 'Serve exports over HTTP',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/export'],
          acceptance: ['pnpm test'],
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
  });
  expect(written.isError, text(written)).toBeFalsy();
  const synced = await client.callTool({ name: 'sync_board', arguments: {} });
  expect(synced.isError, text(synced)).toBeFalsy();
  const { brief } = receipt(synced).receipt as { brief: string };
  expect(brief).toContain('Sync the board with the project as it is now.');
  expect(brief).toContain('- export-api "Export API": todo; sessions: none');
  expect(brief).toContain('Initial files');
});

it('refuses a credential role that does not match the session', async () => {
  const f = await sessionFixture('planner');
  const planner = f.store.must<Session>('sessions', f.spec.platform_session_id);
  const workbench = f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Write a sentence',
  });
  expect(() => f.auth.issueSession(workbench, 'planner')).toThrow('Active session required');
  expect(() => f.auth.issueSession(planner, 'lead')).toThrow('Active session required');
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
  expect(tool.description).toContain('Optional source');
  expect(tool.description).toContain('Optional size');
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
  expect(tool.description).toContain('sort or scan');
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
