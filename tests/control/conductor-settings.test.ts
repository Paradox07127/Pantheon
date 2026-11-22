import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import type {
  ExtensionInventory,
  NeedsYouItem,
  Principal,
  Project,
  ProposableSettingCommand,
  Session,
  SettingProposal,
  WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { awaitWorkspaceReady, settle, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
  vi.unstubAllGlobals();
});

const principalOf = (f: Fixture, sessionId: string, role: Principal['role']): Principal => ({
  id: `session:${sessionId}`,
  role,
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60000,
});

async function openConductor(f: Fixture) {
  const session = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    purpose: 'conductor',
  });
  await settle(f, session);
  return session;
}

/** The error a command throws, whether it runs at once or after reading git. */
async function refusal(run: () => unknown): Promise<{ code?: string; message?: string }> {
  try {
    await run();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('Expected the command to fail');
}

const project = (f: Fixture) => f.store.must<Project>('projects', f.project.id);
const policyRevision = (f: Fixture) =>
  f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.revision ?? null;
const root = (f: Fixture) => f.project.roots[0]!;

const testCommand = { name: 'test', argv: ['node', '-e', '0'] };
const overrides = {
  disabled_mcp_servers: ['docs-server'],
  disabled_plugins: [],
  disabled_skills: [],
  disable_apps: false,
  disable_hooks: false,
};
const inventory: ExtensionInventory = {
  runtime: 'fixture',
  mcp_servers: [{ name: 'docs-server', enabled: true }],
  plugins: [],
  skills: [],
  apps: true,
  connectors: [],
  hooks: [],
};

/** What one proposable command changes, how it reads now, and the user's own change of it. */
interface SettingCase {
  input: (f: Fixture) => Record<string, unknown>;
  read: (f: Fixture) => Record<string, unknown>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  change: (f: Fixture) => unknown;
}

const cases: Record<ProposableSettingCommand, SettingCase> = {
  'project.gate.set': {
    input: (f) => ({ root: root(f), commands: [testCommand], protected_paths: ['config/**'] }),
    read: (f) => ({
      commands: project(f).gates?.[root(f)] ?? [],
      protected_paths: project(f).protected_paths?.[root(f)] ?? [],
    }),
    before: { commands: [], protected_paths: [] },
    after: { commands: [testCommand], protected_paths: ['config/**'] },
    change: (f) =>
      f.call(
        'project.gate.set',
        {
          project_id: f.project.id,
          root: root(f),
          commands: [{ name: 'lint', argv: ['node', '-e', '1'] }],
        },
        project(f).revision,
      ),
  },
  'workflow.policy.set': {
    input: () => ({ project_budget: { input_tokens: 500000 } }),
    read: (f) => {
      const budget = f.store.get<WorkflowPolicy>('workflow_policies', f.project.id)?.project_budget;
      return { project_budget: budget ? { input_tokens: budget.input_tokens } : null };
    },
    before: { project_budget: null },
    after: { project_budget: { input_tokens: 500000 } },
    change: (f) =>
      f.call(
        'workflow.policy.set',
        { project_id: f.project.id, project_budget: { input_tokens: 900000 } },
        policyRevision(f),
      ),
  },
  'project.sessionDefaults.set': {
    input: (f) => ({ runtime: f.adapter.name, permission_mode: 'auto_edit' }),
    read: (f) => ({ session_defaults: project(f).session_defaults ?? null }),
    before: { session_defaults: null },
    after: { session_defaults: { runtime: 'fixture', permission_mode: 'auto_edit' } },
    change: (f) =>
      f.call(
        'project.sessionDefaults.set',
        { project_id: f.project.id, runtime: f.adapter.name, permission_mode: 'ask' },
        project(f).revision,
      ),
  },
  'project.extensions.set': {
    input: (f) => ({ runtime: f.adapter.name, overrides }),
    read: (f) => ({ overrides: project(f).extension_overrides?.[f.adapter.name] ?? null }),
    before: { overrides: null },
    after: { overrides },
    change: (f) =>
      f.call(
        'project.extensions.set',
        {
          project_id: f.project.id,
          runtime: f.adapter.name,
          overrides: { ...overrides, disable_hooks: true },
        },
        project(f).revision,
      ),
  },
};
const commands = Object.keys(cases) as ProposableSettingCommand[];

const REASON = 'The release needs it';

/** A conductor of a fresh fixture whose runtime lists its extensions. */
async function conductorFixture() {
  const f = await workbenchFixture();
  const conductor = await openConductor(f);
  Object.assign(f.adapter, { inventory: vi.fn(async (_cwd: string) => inventory) });
  const propose = (command: string, input: Record<string, unknown>, reason = REASON) =>
    f.call<{ proposal_id: string }>(
      'conductor.propose_setting',
      { command, input, reason },
      null,
      principalOf(f, conductor.id, 'conductor'),
    );
  const items = () =>
    f.control
      .needsYou(user, f.project.id)
      .items.filter((item: NeedsYouItem) => item.kind === 'setting.proposed');
  const respond = (proposalId: string, decision: 'approve' | 'reject') =>
    f.call(
      'setting.proposal.respond',
      { proposal_id: proposalId, decision },
      f.store.must<SettingProposal>('setting_change_proposals', proposalId).revision,
    );
  const notices = () =>
    f
      .turns(conductor.id)
      .filter((turn) => turn.origin === 'tracker')
      .map((turn) => turn.input);
  const row = (proposalId: string) =>
    f.store.must<SettingProposal>('setting_change_proposals', proposalId);
  return { f, conductor, propose, items, respond, notices, row };
}

it.each(commands)(
  'waits in needs-you with %s before and after, changes nothing until approved, then applies it and tells the main agent',
  async (command) => {
    const { f, conductor, propose, items, respond, notices, row } = await conductorFixture();
    const setting = cases[command];

    const { proposal_id } = propose(command, setting.input(f));

    expect(items()).toEqual([
      expect.objectContaining({
        source: { table: 'setting_change_proposals', id: proposal_id, revision: 1 },
        kind: 'setting.proposed',
        decision: 'other',
        reason: 'setting_proposed',
        session_id: conductor.id,
        primary: 'setting.proposal.respond',
        actions: [
          { command: 'setting.proposal.respond', allowed: true, decision: 'approve' },
          { command: 'setting.proposal.respond', allowed: true, decision: 'reject' },
        ],
        setting: expect.objectContaining({
          command,
          before: setting.before,
          after: setting.after,
          reason: REASON,
        }),
      }),
    ]);
    expect(setting.read(f)).toEqual(setting.before);
    expect(notices()).toEqual([]);

    await respond(proposal_id, 'approve');

    expect(setting.read(f)).toEqual(setting.after);
    expect(row(proposal_id)).toMatchObject({ state: 'approved', decided_at: expect.any(Number) });
    expect(items()).toEqual([]);
    expect(notices()).toEqual([`[setting] [Pantheon] approved: ${command} — ${REASON}`]);
  },
);

it.each(commands)(
  'leaves %s as it was when the user rejects the proposal and tells the main agent',
  async (command) => {
    const { f, propose, items, respond, notices, row } = await conductorFixture();
    const setting = cases[command];
    const { proposal_id } = propose(command, setting.input(f));

    await respond(proposal_id, 'reject');

    expect(setting.read(f)).toEqual(setting.before);
    expect(row(proposal_id).state).toBe('rejected');
    expect(items()).toEqual([]);
    expect(notices()).toEqual([`[setting] [Pantheon] rejected: ${command} — ${REASON}`]);
  },
);

it.each(commands)(
  'refuses to approve %s once the user changed it after the proposal and marks the proposal failed',
  async (command) => {
    const { f, propose, items, respond, notices, row } = await conductorFixture();
    const setting = cases[command];
    const { proposal_id } = propose(command, setting.input(f));
    await setting.change(f);
    const changed = setting.read(f);

    const error = await refusal(() => respond(proposal_id, 'approve'));

    expect(error).toMatchObject({
      code: 'invalid_state',
      message: 'The setting changed since it was proposed',
    });
    expect(setting.read(f)).toEqual(changed);
    expect(row(proposal_id)).toMatchObject({
      state: 'failed',
      error: 'The setting changed since it was proposed',
    });
    expect(items()).toEqual([]);
    expect(notices()).toEqual([
      `[setting] [Pantheon] failed: ${command} — The setting changed since it was proposed`,
    ]);
  },
);

it('marks the proposal failed with the refusal of the command it runs', async () => {
  const { f, propose, respond, notices, row } = await conductorFixture();
  delete (f.adapter as { inventory?: unknown }).inventory;
  const { proposal_id } = propose(
    'project.extensions.set',
    cases['project.extensions.set'].input(f),
  );

  const error = await refusal(() => respond(proposal_id, 'approve'));

  expect(error).toMatchObject({ code: 'unsupported_capability' });
  expect(row(proposal_id)).toMatchObject({ state: 'failed', error: error.message });
  expect(project(f).extension_overrides?.[f.adapter.name]).toBeUndefined();
  expect(notices()).toEqual([
    `[setting] [Pantheon] failed: project.extensions.set — ${error.message}`,
  ]);
});

it('refuses a second pending proposal of the same command and input that does not fit the command', async () => {
  const { f, propose } = await conductorFixture();
  const { proposal_id } = propose('workflow.policy.set', {
    project_budget: { input_tokens: 5000 },
  });

  const busy = await refusal(() =>
    propose('workflow.policy.set', { project_budget: { input_tokens: 9000 } }),
  );
  const unfit = await refusal(() => propose('project.gate.set', { root: root(f) }));
  const policy = await refusal(() =>
    propose('workflow.policy.set', {
      project_budget: { input_tokens: 9000 },
      gate_on_fail: 'retry',
    }),
  );

  expect(busy).toMatchObject({
    code: 'resource_busy',
    message: expect.stringContaining(proposal_id),
  });
  expect(unfit).toMatchObject({
    code: 'invalid_input',
    message: expect.stringContaining('commands'),
  });
  expect(policy).toMatchObject({
    code: 'invalid_input',
    message: expect.stringContaining('gate_on_fail'),
  });
  expect(f.store.list<SettingProposal>('setting_change_proposals')).toHaveLength(1);
});

async function listTools(role: string) {
  vi.stubGlobal('fetch', async () =>
    Response.json({
      principal: {
        id: `session:${role}`,
        role,
        session_id: role,
        project_id: 'project',
        expires_at: Date.now() + 60_000,
      },
    }),
  );
  const { createMcpServer } = await import('../../apps/cli/src/mcp.js');
  const server = await createMcpServer('http://127.0.0.1:4321', 'session-token');
  const client = new Client({ name: 'setting-proposal-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return (await client.listTools()).tools.map((tool) => tool.name);
}

it('offers propose_setting to a conductor session only', async () => {
  expect(await listTools('conductor')).toContain('propose_setting');
  for (const role of ['reviewer', 'planner'])
    expect(await listTools(role), role).not.toContain('propose_setting');
  const f = await workbenchFixture();
  const plain = await f.create('Write the docs');
  await awaitWorkspaceReady(f.control, plain.workspace_id!);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  expect(
    workbenchSessionSpec(ctx, f.store.must<Session>('sessions', plain.id)).pantheon_mcp,
  ).toBeUndefined();
  const error = await refusal(() =>
    f.call(
      'conductor.propose_setting',
      { command: 'workflow.policy.set', input: { project_budget: null }, reason: REASON },
      null,
      principalOf(f, plain.id, 'conductor'),
    ),
  );
  expect(error.code).toBe('permission_denied');
});
