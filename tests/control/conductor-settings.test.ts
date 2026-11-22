import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import {
  id,
  type ExtensionInventory,
  type NeedsYouItem,
  type Principal,
  type Project,
  type ProposableSettingCommand,
  type Session,
  type SessionTurn,
  type SettingProposal,
  type WorkflowPolicy,
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
  /** The before needs-you shows, when it holds more than the value read. */
  shown?: Record<string, unknown>;
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
    shown: { session_defaults: null, inherited: null },
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
async function conductorFixture(options?: Parameters<typeof workbenchFixture>[0]) {
  const f = await workbenchFixture(options);
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
          before: setting.shown ?? setting.before,
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

/** Sets a budget of 100 input tokens and spends 150 of them in a turn of the session. */
function spendBudget(f: Fixture, sessionId: string) {
  let now = f.store.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  f.call('workflow.policy.set', {
    project_id: f.project.id,
    project_budget: { input_tokens: 100 },
  });
  now += 1000;
  const spent = f.store.insert<SessionTurn>('session_turns', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    session_id: sessionId,
    input: 'A message',
    kind: 'send',
    delivery: 'delivered',
    state: 'completed',
    usage: { input_tokens: 150, output_tokens: 0 },
  });
  f.store.event('turn.completed', spent, f.project.id, {});
  now += 1000;
}

it.each([
  { decision: 'approve', state: 'approved' },
  { decision: 'reject', state: 'rejected' },
] as const)(
  'tells the main agent once it takes notices again when the user answers $decision while the project is over its budget',
  async ({ decision, state }) => {
    const { f, conductor, propose, respond, notices, row } = await conductorFixture();
    const command = 'project.sessionDefaults.set';
    const { proposal_id } = propose(command, cases[command].input(f));
    spendBudget(f, conductor.id);

    await respond(proposal_id, decision);

    expect(row(proposal_id).state).toBe(state);
    expect(notices()).toEqual([]);
    expect(row(proposal_id).notified_at).toBeUndefined();

    f.call(
      'workflow.policy.set',
      { project_id: f.project.id, project_budget: { input_tokens: 1000000 } },
      policyRevision(f),
    );
    await f.control.tick();

    expect(notices()).toEqual([`[setting] [Pantheon] ${state}: ${command} — ${REASON}`]);
    expect(row(proposal_id).notified_at).toEqual(expect.any(Number));
  },
);

it('tells the main agent an answer it could not take once after a daemon restart', async () => {
  const { f, conductor, propose, respond, notices, row } = await conductorFixture();
  const command = 'project.sessionDefaults.set';
  const { proposal_id } = propose(command, cases[command].input(f));
  spendBudget(f, conductor.id);
  await respond(proposal_id, 'approve');

  await f.restart();
  await f.control.tick();

  expect(notices()).toEqual([]);
  expect(row(proposal_id).notified_at).toBeUndefined();

  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, project_budget: { input_tokens: 1000000 } },
    policyRevision(f),
  );
  await f.control.tick();
  await f.control.tick();
  await settle(f, f.store.must<Session>('sessions', conductor.id));
  await f.restart();
  await f.control.tick();

  expect(notices()).toEqual([`[setting] [Pantheon] approved: ${command} — ${REASON}`]);
  expect(row(proposal_id).notified_at).toEqual(expect.any(Number));
});

it.each([
  {
    what: 'a gate root outside the project',
    command: 'project.gate.set',
    input: (f: Fixture) => ({ root: path.dirname(root(f)), commands: [testCommand] }),
    named: 'not a project root',
  },
  {
    what: 'a gate command timeout',
    command: 'project.gate.set',
    input: (f: Fixture) => ({ root: root(f), commands: [{ ...testCommand, timeout_ms: 60000 }] }),
    named: 'timeout_ms',
  },
  ...['auto', 'full_access'].map((mode) => ({
    what: `the permission mode ${mode}`,
    command: 'project.sessionDefaults.set',
    input: (f: Fixture) => ({ runtime: f.adapter.name, permission_mode: mode }),
    named: mode,
  })),
])('refuses a proposal that sets $what as input that does not fit', async (unfit) => {
  const { f, propose } = await conductorFixture();

  const error = await refusal(() => propose(unfit.command, unfit.input(f)));

  expect(error).toMatchObject({
    code: 'invalid_input',
    message: expect.stringContaining(unfit.named),
  });
  expect(f.store.list<SettingProposal>('setting_change_proposals')).toEqual([]);
});

it('shows the global session defaults the project inherits before, and approves after they change', async () => {
  const { f, propose, items, respond, row } = await conductorFixture({ userConfig: true });
  const global = { runtime: f.adapter.name, permission_mode: 'ask', effort: 'high' };
  f.call('project.defaults.set', { key: 'session_defaults', value: global });
  const command = 'project.sessionDefaults.set';
  const { proposal_id } = propose(command, cases[command].input(f));

  expect(items()[0]?.setting?.before).toEqual({
    session_defaults: null,
    inherited: expect.objectContaining(global),
  });

  f.call('project.defaults.set', {
    key: 'session_defaults',
    value: { ...global, effort: 'low' },
  });
  await respond(proposal_id, 'approve');

  expect(row(proposal_id).state).toBe('approved');
  expect(project(f).session_defaults).toEqual(cases[command].after.session_defaults);
});

it('shows the personal agent a gate proposal without its commands', async () => {
  const { f, propose } = await conductorFixture();
  propose('project.gate.set', cases['project.gate.set'].input(f));

  const shown = f.control
    .needsYou({ id: 'personal:agent', role: 'personal' } as Principal, f.project.id)
    .items.filter((item: NeedsYouItem) => item.kind === 'setting.proposed');

  expect(shown).toEqual([
    expect.objectContaining({
      setting: { command: 'project.gate.set', root: root(f), reason: REASON },
    }),
  ]);
});

it.each(['conductor', 'writer', 'personal'] as const)(
  'refuses setting.proposal.respond from a %s principal and leaves the proposal pending',
  async (role) => {
    const { f, conductor, propose, row } = await conductorFixture();
    const { proposal_id } = propose('workflow.policy.set', cases['workflow.policy.set'].input(f));
    const principal: Principal =
      role === 'personal'
        ? ({ id: 'personal:agent', role } as Principal)
        : principalOf(
            f,
            role === 'conductor' ? conductor.id : (await f.create('Write the docs')).id,
            role,
          );

    const error = await refusal(() =>
      f.call(
        'setting.proposal.respond',
        { proposal_id, decision: 'approve' },
        row(proposal_id).revision,
        principal,
      ),
    );

    expect(error.code).toBe('permission_denied');
    expect(row(proposal_id).state).toBe('pending');
    expect(cases['workflow.policy.set'].read(f)).toEqual({ project_budget: null });
  },
);

it('keeps the protected paths as they are now when a gate proposal names none', async () => {
  const { f, propose, items, respond, row } = await conductorFixture();
  const setGate = (protected_paths: string[]) =>
    f.call(
      'project.gate.set',
      { project_id: f.project.id, root: root(f), commands: [], protected_paths },
      project(f).revision,
    );
  await setGate(['keep/**']);
  const { proposal_id } = propose('project.gate.set', { root: root(f), commands: [testCommand] });

  expect(items()[0]?.setting).toMatchObject({
    before: { commands: [] },
    after: { commands: [testCommand] },
  });
  expect(items()[0]?.setting?.before).toEqual({ commands: [] });

  await setGate(['other/**']);
  await respond(proposal_id, 'approve');

  expect(row(proposal_id).state).toBe('approved');
  expect(project(f).gates?.[root(f)]).toEqual([testCommand]);
  expect(project(f).protected_paths?.[root(f)]).toEqual(['other/**']);
});

it('keeps the timeout the user gave a gate command the agent lists again', async () => {
  const { f, propose, items, respond, row } = await conductorFixture();
  const timed = { ...testCommand, timeout_ms: 60000 };
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: root(f), commands: [timed] },
    project(f).revision,
  );
  const lint = { name: 'lint', argv: ['node', '-e', '1'] };
  const { proposal_id } = propose('project.gate.set', {
    root: root(f),
    commands: [testCommand, lint],
  });

  expect(items()[0]?.setting?.after).toEqual({ commands: [timed, lint] });
  await respond(proposal_id, 'approve');

  expect(row(proposal_id).state).toBe('approved');
  expect(project(f).gates?.[root(f)]).toEqual([timed, lint]);
});

it('keeps the timeout of each named gate command when two run the same argv', async () => {
  const { f, propose, items } = await conductorFixture();
  const quick = { name: 'quick', argv: testCommand.argv, timeout_ms: 1000 };
  const slow = { name: 'slow', argv: testCommand.argv, timeout_ms: 900000 };
  await f.call(
    'project.gate.set',
    { project_id: f.project.id, root: root(f), commands: [quick, slow] },
    project(f).revision,
  );

  propose('project.gate.set', {
    root: root(f),
    commands: [
      { name: 'quick', argv: testCommand.argv },
      { name: 'slow', argv: testCommand.argv },
    ],
  });

  expect(items()[0]?.setting?.after).toEqual({ commands: [quick, slow] });
});

it('reads the budget and the session defaults in effect in project_read of a conductor', async () => {
  const { f, conductor } = await conductorFixture({ userConfig: true });
  const read = () =>
    f.control.projectRead(principalOf(f, conductor.id, 'conductor'), f.project.id) as {
      budget?: { input_tokens: number; used_input_tokens: number; left: number } | null;
      session_defaults?: unknown;
    };
  expect(read()).toMatchObject({ budget: null, session_defaults: null });

  const global = { runtime: f.adapter.name, permission_mode: 'ask', effort: 'high' };
  f.call('project.defaults.set', { key: 'session_defaults', value: global });
  f.call(
    'workflow.policy.set',
    { project_id: f.project.id, project_budget: { input_tokens: 7000 } },
    policyRevision(f),
  );

  const { budget, session_defaults } = read();
  expect(budget).toEqual({
    input_tokens: 7000,
    used_input_tokens: expect.any(Number),
    left: 7000 - budget!.used_input_tokens,
  });
  expect(session_defaults).toEqual(expect.objectContaining(global));
  expect(f.control.projectRead(user, f.project.id)).not.toHaveProperty('budget');
  expect(f.control.projectRead(user, f.project.id)).not.toHaveProperty('session_defaults');
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
