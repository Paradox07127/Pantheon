import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { FixtureAdapter } from '@pantheon/adapters';
import { startDaemon } from '@pantheon/daemon';
import type {
  AgentProfile,
  BoardPlan,
  ExternalEvent,
  Principal,
  Project,
  Session,
  SessionSpec,
  Timer,
} from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import { leadSessionTools, type ControlContext } from '../../packages/control/dist/context.js';
import { ensureAgents } from '../../packages/control/dist/agents.js';
import {
  AGENT_TEMPLATES,
  ASSISTANT_TEMPLATE,
  GOALS_TEMPLATE,
  residentProfile,
  TRIAGE_TEMPLATE,
} from '../../packages/control/dist/agent-templates.js';
import { residentInstructions, ROLE_PROMPTS } from '../../packages/control/dist/agent-prompts.js';
import { receiveExternalEvent } from '../../packages/control/dist/external-events.js';
import { eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
});

const lead = (projectId: string, sessionId: string, now: number): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: projectId,
  session_id: sessionId,
  expires_at: now + 60000,
});

const agents = (f: Fixture) => f.control.agentList(user, f.project.id);
const profileOf = (f: Fixture, template: AgentProfile['template']) =>
  agents(f).find((agent) => agent.template === template)!;
const current = (f: Fixture, sessionId: string) => f.store.must<Session>('sessions', sessionId);
const open = (f: Fixture) =>
  f.call<Session>('resident.open', { project_id: f.project.id, kind: 'assistant' });
const ensure = (f: Fixture) => {
  const ctx = f.control['ctx'] as ControlContext;
  ctx.store.transaction(() => ensureAgents(ctx, f.project.id));
};
const update = (f: Fixture, fields: Record<string, unknown>) => {
  const profile = profileOf(f, 'assistant');
  return f.call<AgentProfile>('agent.update', {
    agent_id: profile.id,
    revision: profile.revision,
    ...fields,
  });
};

const settleResident = (f: Fixture, sessionId: string) =>
  eventually(
    () =>
      current(f, sessionId).state === 'open' &&
      f.turns(sessionId).every((turn) => !['queued', 'running'].includes(turn.state)),
    () => f.control.tick(),
  );

async function send(f: Fixture, sessionId: string, input: string) {
  f.call('session.send', { session_id: sessionId, input }, current(f, sessionId).revision);
  await settleResident(f, sessionId);
}

/** The control instructions of the newest native start or resume of the fixture runtime. */
const lastInstructions = (f: Fixture) =>
  (f.resume.mock.calls.at(-1)![0] as SessionSpec).control_instructions;

it('gives a new project an assistant and a triage profile once, with their template defaults', async () => {
  const f = await workbenchFixture();
  const listed = agents(f);
  expect(listed.map((agent) => agent.template).sort()).toEqual(['assistant', 'triage']);
  for (const [template, defaults] of [
    ['assistant', ASSISTANT_TEMPLATE],
    ['triage', TRIAGE_TEMPLATE],
  ] as const) {
    expect(profileOf(f, template)).toMatchObject({
      project_id: f.project.id,
      name: defaults.name,
      role: defaults.role,
      role_prompt: ROLE_PROMPTS[template],
      routines: [],
      created_by: { kind: 'user' },
    });
    expect(profileOf(f, template)).not.toHaveProperty('instructions');
  }
  // A built-in profile stores no groups or sources, so it takes those its template gains later.
  for (const template of ['assistant', 'triage'] as const) {
    const profile = profileOf(f, template);
    expect(profile).not.toHaveProperty('tools');
    expect(profile).not.toHaveProperty('listens');
    expect(residentProfile(f.store, { kind: template, agent_id: profile.id })).toMatchObject({
      tools: AGENT_TEMPLATES[template].tools,
      listens: AGENT_TEMPLATES[template].listens,
    });
  }
  expect(
    residentProfile(f.store, { kind: 'triage', agent_id: profileOf(f, 'triage').id }).listens,
  ).toEqual([
    'github',
    'gate_failures',
    'flaky_tests',
    'app_errors',
    'session_failures',
    'trace_findings',
  ]);

  const opening = command(user.id, 'project.open', {
    name: 'Workbench project',
    roots: [f.source],
  });
  await f.control.execute(user, opening);
  await f.control.execute(user, opening);
  ensure(f);
  ensure(f);
  expect(
    agents(f)
      .map((agent) => agent.id)
      .sort(),
  ).toEqual(listed.map((agent) => agent.id).sort());
});

it('lists the tools and listens each profile works with, its template’s while it stores none', async () => {
  const f = await workbenchFixture();
  expect(profileOf(f, 'triage')).toMatchObject({
    effective_tools: TRIAGE_TEMPLATE.tools,
    effective_listens: TRIAGE_TEMPLATE.listens,
  });
  update(f, { tools: ['board', 'memory'] });
  const assistant = profileOf(f, 'assistant');
  expect(assistant).toMatchObject({
    tools: ['board', 'memory'],
    effective_tools: ['board', 'memory'],
    effective_listens: ASSISTANT_TEMPLATE.listens,
  });
  expect(assistant).not.toHaveProperty('listens');
  expect(f.store.must<AgentProfile>('agents', assistant.id)).not.toHaveProperty('effective_tools');
});

it('links a resident session stored without a profile to the profile of its kind', async () => {
  const f = await workbenchFixture();
  const stored = f.store.insert<Session>('sessions', {
    id: 'resident-before-profiles',
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
    title: 'Triage',
    resident: { kind: 'triage' },
  });
  ensure(f);
  expect(current(f, stored.id).resident).toEqual({
    kind: 'triage',
    agent_id: profileOf(f, 'triage').id,
  });
});

it("gives a resident turn its template's role prompt, then the user's instructions after it once set", async () => {
  const f = await workbenchFixture();
  const assistant = open(f);
  expect(assistant.resident).toEqual({
    kind: 'assistant',
    agent_id: profileOf(f, 'assistant').id,
  });
  await send(f, assistant.id, 'What does the answer file hold?');
  const first = lastInstructions(f)!;
  expect(first).toContain(ROLE_PROMPTS.assistant);
  expect(first).toContain('start sub-agents');
  expect(first).not.toContain('Instructions from the user for this agent:');

  const own = 'You only answer questions about the answer file.';
  update(f, { instructions: own });
  // The idle process closes once the change commits, and the next input starts a new one.
  await eventually(
    () => ![...f.control.handles.values()].some((h) => h.platform_session_id === assistant.id),
    () => f.control.tick(),
  );
  await send(f, assistant.id, 'And now?');
  const next = lastInstructions(f)!;
  const order = [
    ROLE_PROMPTS.assistant,
    "follow the user's instructions; platform rules, tool limits and approvals still apply.",
    'Instructions from the user for this agent:',
    own,
  ].map((text) => next.indexOf(text));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));

  const stored = f.store.must<AgentProfile>('agents', profileOf(f, 'assistant').id);
  const builtIn = ROLE_PROMPTS.assistant;
  try {
    ROLE_PROMPTS.assistant = 'You are the newer main agent.';
    const changed = residentInstructions({
      ...residentProfile(f.store, assistant.resident!),
      template: 'assistant',
    });
    expect(changed).toContain('You are the newer main agent.');
    expect(changed).not.toContain(builtIn);
    expect(changed).toContain(own);
  } finally {
    ROLE_PROMPTS.assistant = builtIn;
  }
  expect(f.store.must<AgentProfile>('agents', stored.id)).toEqual(stored);
});

it('changes the model of the profile and of its open resident on the same runtime', async () => {
  const f = await workbenchFixture();
  const assistant = open(f);
  await send(f, assistant.id, 'Hello');
  const next = update(f, { model: 'fixture-large', effort: 'high' });
  expect(next).toMatchObject({ model: 'fixture-large', effort: 'high' });
  expect(current(f, assistant.id)).toMatchObject({
    state: 'open',
    requested_model: 'fixture-large',
    requested_effort: 'high',
  });
});

it('moves an idle resident to a new runtime in a new session that owns the plan, and refuses mid-turn', async () => {
  const f = await workbenchFixture();
  const other = new FixtureAdapter(0);
  other.name = 'fixture-other';
  f.control.adapters.set(other.name, other);
  const assistant = open(f);
  await send(f, assistant.id, 'Plan the export feature');
  f.call(
    'board.plan.update',
    {
      project_id: f.project.id,
      base_version: 0,
      headline: 'Export ships this week',
      lanes: [{ id: 'core', title: 'Core' }],
      tasks: [
        {
          id: 'a',
          title: 'Task a',
          goal: 'Finish task a',
          lane: 'core',
          depends_on: [],
          source: ['Plan the export feature'],
          scope: ['src/a.ts'],
          acceptance: ['pnpm test'],
          kind: { domain: 'backend-logic', tier: 't1' },
        },
      ],
      milestones: [],
      risks: [],
      assumptions: [],
    },
    null,
    lead(f.project.id, assistant.id, f.store.now()),
  );

  f.call(
    'session.send',
    { session_id: assistant.id, input: 'Go on' },
    current(f, assistant.id).revision,
  );
  expect(() => update(f, { runtime: other.name })).toThrow(
    expect.objectContaining({ code: 'invalid_state' }),
  );
  await settleResident(f, assistant.id);

  const moved = update(f, { runtime: other.name });
  expect(moved.runtime).toBe(other.name);
  expect(current(f, assistant.id).state).toBe('closed');
  const successor = open(f);
  expect(successor.id).not.toBe(assistant.id);
  expect(successor.runtime).toBe(other.name);
  expect(successor.resident).toEqual({ kind: 'assistant', agent_id: moved.id });
  expect(f.store.must<BoardPlan>('board_plans', successor.id).tasks.map((t) => t.id)).toEqual([
    'a',
  ]);
  expect(f.turns(successor.id)[0]!.input).toContain('take over');
  await settleResident(f, successor.id);
  await eventually(
    () => ![...f.control.handles.values()].some((h) => h.platform_session_id === assistant.id),
    () => f.control.tick(),
  );
  expect(current(f, assistant.id).state).toBe('closed');
});

/** A daemon with a project whose assistant resident runs with the tools of profile. */
async function residentTools(tools?: AgentProfile['tools']) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-agent-tools-'));
  mkdirSync(path.join(root, 'project'));
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    intervalMs: 60_000,
  });
  cleanup.push(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = (await daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'agents', roots: [path.join(root, 'project')] }),
  )) as Project;
  const profile = daemon.control
    .agentList(user, project.id)
    .find((agent) => agent.template === 'assistant')!;
  if (tools) daemon.store.update<AgentProfile>('agents', { ...profile, tools }, profile.revision);
  const session = daemon.store.insert<Session>('sessions', {
    id: 'assistant-session',
    revision: 1,
    project_id: project.id,
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
    resident: { kind: 'assistant', agent_id: profile.id },
  });
  const ctx = (daemon.control as unknown as { ctx: ControlContext }).ctx;
  const credential = ctx.issueSessionCredential!(session.id, 'lead');
  const client = new Client({ name: 'agent-tools-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), 'apps/cli/dist/index.js'), 'mcp'],
      env: {
        ...(process.env as Record<string, string>),
        PANTHEON_DAEMON_URL: credential.daemon_url,
        PANTHEON_SESSION_TOKEN_FILE: credential.token_file,
      },
    }),
  );
  cleanup.push(() => client.close());
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  return { daemon, project, session, names };
}

it("lists and permits only the lead tools of the resident profile's groups", async () => {
  const narrow = await residentTools(['board', 'memory']);
  expect(narrow.names).toContain('update_board');
  expect(narrow.names).toContain('memory_search');
  expect(narrow.names).not.toContain('start_task');
  expect(narrow.names).not.toContain('browser_open');
  expect(() =>
    narrow.daemon.control.execute(
      lead(narrow.project.id, narrow.session.id, Date.now()),
      command(`session:${narrow.session.id}`, 'task.start', {
        project_id: narrow.project.id,
        task_ids: ['a'],
      }),
    ),
  ).toThrow(expect.objectContaining({ code: 'permission_denied' }));

  const assistant = await residentTools();
  expect(assistant.names).toContain('start_task');
  expect(assistant.names).toContain('browser_open');
  expect(assistant.names).not.toContain('app_errors');
});

const MINUTE = 60_000;
const create = (f: Fixture, fields: Record<string, unknown>) =>
  f.call<AgentProfile>('agent.create', {
    project_id: f.project.id,
    template: 'custom',
    role: 'Helper',
    instructions: 'You help with one kind of request.',
    ...fields,
  });
const openAgent = (f: Fixture, agentId: string) =>
  f.call<Session>('resident.open', { agent_id: agentId });
const routineTimers = (f: Fixture, agentId: string) =>
  f.store
    .list<Timer>('timers')
    .filter(
      (timer) => timer.kind === 'agent-routine' && timer.subject_id.startsWith(`${agentId}:`),
    );
const pendingRoutines = (f: Fixture, agentId: string) =>
  routineTimers(f, agentId)
    .filter((timer) => timer.state === 'pending')
    .map((timer) => timer.subject_id.slice(agentId.length + 1))
    .sort();
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'accepted';
};
const residentsOf = (f: Fixture, agentId: string) =>
  f.store.list<Session>('sessions').filter((session) => session.resident?.agent_id === agentId);

it('creates a goals agent with its weekly routine pending and no session, and refuses a taken name or a built-in template', async () => {
  const f = await workbenchFixture();
  const goals = create(f, {
    template: 'goals',
    name: 'Milestones',
    role: 'Goals',
    instructions: 'Report what slipped in one line each.',
  });
  expect(f.store.must<AgentProfile>('agents', goals.id)).toMatchObject({
    project_id: f.project.id,
    template: 'goals',
    name: 'Milestones',
    role: 'Goals',
    instructions: 'Report what slipped in one line each.',
    routines: GOALS_TEMPLATE.routines,
    created_by: { kind: 'user' },
  });
  expect(pendingRoutines(f, goals.id)).toEqual(GOALS_TEMPLATE.routines!.map((r) => r.id));
  expect(residentsOf(f, goals.id)).toEqual([]);
  expect(
    f.store
      .events(0, f.project.id, 1000, ['agent_profile.created'])
      .map((event) => event.aggregate_id),
  ).toEqual([goals.id]);

  expect(refusal(() => create(f, { name: 'Milestones' }))).toBe('invalid_input');
  expect(refusal(() => create(f, { template: 'assistant', name: 'Second assistant' }))).toBe(
    'invalid_input',
  );
  expect(agents(f).filter((agent) => agent.name === 'Milestones')).toHaveLength(1);
});

it('lists the defaults of the templates a new agent starts from, to the user only', async () => {
  const f = await workbenchFixture();
  const listed = f.control.agentTemplates(user);
  expect(listed.map((each) => each.template)).toEqual(['ideas', 'goals', 'custom']);
  for (const each of listed) {
    const { routines = [], ...defaults } = AGENT_TEMPLATES[each.template];
    expect(each).toEqual({
      template: each.template,
      ...defaults,
      routines,
      role_prompt: ROLE_PROMPTS[each.template],
    });
  }
  expect(listed.find((each) => each.template === 'goals')!.routines).toEqual([
    expect.objectContaining({ every_ms: 7 * 24 * 60 * 60_000, enabled: true }),
  ]);
  expect(refusal(() => f.control.agentTemplates(lead(f.project.id, 'session-a', Date.now())))).toBe(
    'permission_denied',
  );
});

it("opens an agent's session by its id with its role prompt, and keeps the plans of two custom agents apart", async () => {
  const f = await workbenchFixture();
  let now = Date.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const goals = create(f, {
    template: 'goals',
    name: 'Milestones',
    role: 'Goals',
    instructions: undefined,
  });
  const session = openAgent(f, goals.id);
  expect(session).toMatchObject({
    title: 'Milestones',
    resident: { kind: 'goals', agent_id: goals.id },
  });
  expect(openAgent(f, goals.id).id).toBe(session.id);
  // It writes and reads the handoff note when its context fills.
  expect(leadSessionTools(f.control['ctx'] as ControlContext, current(f, session.id))).toEqual(
    expect.arrayContaining(['memory.propose', 'memory.context']),
  );
  await send(f, session.id, 'Where do the milestones stand?');
  expect(lastInstructions(f)).toContain(ROLE_PROMPTS.goals);

  const first = create(f, { name: 'Docs' }),
    second = create(f, { name: 'Releases' });
  const plan = async (agentId: string, taskId: string) => {
    const resident = openAgent(f, agentId);
    await send(f, resident.id, 'Plan it');
    f.call(
      'board.plan.update',
      {
        project_id: f.project.id,
        base_version: 0,
        headline: `Plan of ${agentId}`,
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [
          {
            id: taskId,
            title: `Task ${taskId}`,
            goal: `Finish task ${taskId}`,
            lane: 'core',
            depends_on: [],
            source: ['Plan it'],
            scope: [`src/${taskId}.ts`],
            acceptance: ['pnpm test'],
            kind: { domain: 'backend-logic', tier: 't1' },
          },
        ],
        milestones: [],
        risks: [],
        assumptions: [],
      },
      null,
      lead(f.project.id, resident.id, f.store.now()),
    );
    return resident;
  };
  const archive = (agentId: string) => f.call('agent.archive', { agent_id: agentId });
  const firstSession = await plan(first.id, 'docs');
  archive(first.id);
  now += MINUTE;
  await plan(second.id, 'release');
  archive(second.id);
  f.call('agent.unarchive', { agent_id: first.id });
  const reopened = openAgent(f, first.id);
  expect(reopened.id).not.toBe(firstSession.id);
  expect(f.store.must<BoardPlan>('board_plans', reopened.id).tasks.map((t) => t.id)).toEqual([
    'docs',
  ]);
});

it('refuses update_board to a goals resident, which proposes plan changes only', async () => {
  const f = await workbenchFixture();
  const goals = create(f, { template: 'goals', name: 'Milestones', role: 'Goals' });
  const session = openAgent(f, goals.id);
  expect(
    refusal(() =>
      f.call(
        'board.plan.update',
        {
          project_id: f.project.id,
          base_version: 0,
          headline: 'Milestones',
          lanes: [{ id: 'core', title: 'Core' }],
          tasks: [],
          milestones: [],
          risks: [],
          assumptions: [],
        },
        null,
        lead(f.project.id, session.id, f.store.now()),
      ),
    ),
  ).toBe('permission_denied');
});

it('cancels the timer of a routine an update removes, and refuses the agents group off the assistant', async () => {
  const f = await workbenchFixture();
  const helper = create(f, {
    name: 'Checker',
    routines: [
      { id: 'hourly', prompt: 'Check the gates', every_minutes: 60, enabled: true },
      { id: 'evening', prompt: 'Sum up the day', at: '18:00', enabled: true },
    ],
  });
  expect(pendingRoutines(f, helper.id)).toEqual(['evening', 'hourly']);
  const evening = routineTimers(f, helper.id).find((t) => t.subject_id.endsWith(':evening'))!;
  const updated = f.call<AgentProfile>('agent.update', {
    agent_id: helper.id,
    revision: helper.revision,
    routines: [{ id: 'hourly', prompt: 'Check the gates', every_minutes: 60, enabled: true }],
  });
  expect(updated.routines.map((routine) => routine.id)).toEqual(['hourly']);
  expect(f.store.must<Timer>('timers', evening.id).state).toBe('cancelled');
  expect(pendingRoutines(f, helper.id)).toEqual(['hourly']);
  expect(
    refusal(() =>
      f.call('agent.update', {
        agent_id: helper.id,
        revision: updated.revision,
        tools: ['board', 'agents'],
      }),
    ),
  ).toBe('invalid_input');
});

it('archives an agent between turns, closing its session and its routine timers, and reschedules them once unarchived', async () => {
  const f = await workbenchFixture();
  const helper = create(f, {
    name: 'Checker',
    routines: [{ id: 'hourly', prompt: 'Check the gates', every_minutes: 60, enabled: true }],
  });
  const session = openAgent(f, helper.id);
  const archived = f.call<AgentProfile>('agent.archive', { agent_id: helper.id });
  expect(archived.archived_at).toBeDefined();
  expect(current(f, session.id).state).toBe('closed');
  expect(pendingRoutines(f, helper.id)).toEqual([]);
  expect(agents(f).find((agent) => agent.id === helper.id)!.archived_at).toBe(archived.archived_at);
  expect(refusal(() => f.call('agent.archive', { agent_id: profileOf(f, 'assistant').id }))).toBe(
    'invalid_input',
  );

  const restored = f.call<AgentProfile>('agent.unarchive', { agent_id: helper.id });
  expect(restored).not.toHaveProperty('archived_at');
  expect(pendingRoutines(f, helper.id)).toEqual(['hourly']);
});

it('lists propose_agent and list_agents to the default assistant and not to a lead that is not a resident', async () => {
  const assistant = await residentTools();
  expect(assistant.names).toEqual(expect.arrayContaining(['propose_agent', 'list_agents']));
  const f = await workbenchFixture();
  const direct = await f.create('Explain the answer file');
  const tools = leadSessionTools(f.control['ctx'] as ControlContext, current(f, direct.id));
  expect(tools).toContain('board.plan.update');
  expect(tools).not.toContain('agent.propose');
  expect(tools).not.toContain('agent.agents');
});

it('hands a GitHub event to the oldest agent that listens to GitHub, and fails it when none does and triage is archived', async () => {
  const f = await workbenchFixture({
    externalSources: [{ id: 'stub', poll: async () => MINUTE }],
  });
  const ctx = f.control['ctx'] as ControlContext;
  f.call(
    'project.externalEvents.set',
    { project_id: f.project.id, mode: 'auto' },
    f.store.must<Project>('projects', f.project.id).revision,
  );
  let reported = 0;
  const report = (subject: string) => {
    const event = receiveExternalEvent(ctx, {
      project_id: f.project.id,
      source: 'github',
      subject_key: subject,
      dedup_key: `github:7:${reported++}`,
      kind: 'issue_assigned',
      actor: 'taylor',
      actor_trust: 'self',
      title: 'Totals are wrong',
      url: 'https://github.com/acme/reports/issues/12',
      texts: [{ author: 'taylor', own: true, text: 'The weekly total counts refunds twice.' }],
    });
    f.store.update<ExternalEvent>(
      'external_events',
      { ...event, received_at: event.received_at - 3 * MINUTE },
      event.revision,
    );
    return event.id;
  };
  const triage = profileOf(f, 'triage');
  f.call('agent.update', { agent_id: triage.id, revision: triage.revision, listens: [] });
  const watcher = create(f, { name: 'Watcher', listens: ['github'] });
  const routed = report('github:acme/reports#12');
  await f.control.tick();
  const [resident] = residentsOf(f, watcher.id);
  expect(f.store.must<ExternalEvent>('external_events', routed)).toMatchObject({
    state: 'handled',
    session_id: resident!.id,
  });
  expect(residentsOf(f, triage.id)).toEqual([]);

  await settleResident(f, resident!.id);
  f.call('agent.archive', { agent_id: watcher.id });
  f.call('agent.archive', { agent_id: triage.id });
  const failed = report('github:acme/reports#13');
  await f.control.tick();
  expect(f.store.must<ExternalEvent>('external_events', failed)).toMatchObject({
    state: 'failed',
    error: 'No agent listens to GitHub',
  });
});
