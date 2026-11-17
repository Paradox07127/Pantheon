import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import {
  id,
  type Improvement,
  type Principal,
  type Project,
  type ProjectRead,
  type Retrospective,
  type Session,
  type WorkflowPolicy,
} from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { workbenchSessionSpec } from '../../packages/control/dist/workbench-session.js';
import { fixture, registerWorkspace, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const leaderboards = {
  fetched_at: '2026-11-09T08:00:00.000Z',
  sources: [{ source: 'terminal-bench', ok: true, fetched_at: '2026-11-09T08:00:02.000Z' }],
  rows: [
    {
      source: 'terminal-bench',
      board_name: 'GPT Fixture / Codex / high',
      score: 70,
      unit: 'accuracy_pct',
      alias: { runtime: 'codex', model: 'gpt-fixture', effort: 'high' },
    },
    {
      source: 'terminal-bench',
      board_name: 'Claude Fixture / Claude Code / high',
      score: 30,
      unit: 'accuracy_pct',
      alias: { runtime: 'claude', model: 'claude-fixture', effort: 'high' },
    },
  ],
};

async function setup(options: { leaderboards?: boolean } = {}) {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-lead-read-'));
  if (options.leaderboards)
    writeFileSync(path.join(configDir, 'leaderboards.json'), JSON.stringify(leaderboards));
  const f = await fixture({
    managedWorkspaces: true,
    controlOptions: {
      userConfigDir: configDir,
      issueSessionCredential: () => ({
        token_file: path.join(configDir, 'token'),
        daemon_url: 'http://127.0.0.1:4321',
      }),
    },
  });
  cleanups.push(async () => {
    await f.close();
    rmSync(configDir, { recursive: true, force: true });
  });
  return f;
}

function sessionOf(f: Fixture, task?: Session['task']): Session {
  const workspace = registerWorkspace(f.control, {
    project_id: f.project.id,
    kind: 'linked_worktree',
    source: f.store.must<Project>('projects', f.project.id).roots[0]!,
    base_ref: 'HEAD',
  });
  return f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    workspace_id: workspace.id,
    state: 'open',
    turn_count: 0,
    ...(task ? { task } : {}),
  });
}

const principalOf = (f: Fixture, session: Session, role: 'lead' | 'worker'): Principal => ({
  id: `session:${session.id}`,
  role,
  project_id: f.project.id,
  session_id: session.id,
  expires_at: f.store.now() + 60000,
});

const read = (f: Fixture, principal: Principal = user) =>
  f.call<ProjectRead>('project.read', { project_id: f.project.id }, null, principal);

function improvement(f: Fixture, fields: Partial<Improvement>): Improvement {
  return f.store.insert<Improvement>('improvements', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    source: 'lead',
    retrospective_ids: ['retrospective-a', 'retrospective-b'],
    status: 'active',
    change: { type: 'experience', procedure: 'Run the build before the tests' },
    proposed_at: 1,
    ...fields,
  });
}

function retrospective(f: Fixture, fields: Partial<Retrospective>): Retrospective {
  return f.store.insert<Retrospective>('retrospectives', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    lead_session_id: 'lead',
    task_id: 'task',
    session_ids: [],
    outcome: 'merged',
    recorded_at: 1,
    ...fields,
  });
}

it('gives a lead the current workflow policy and the new value after the user changes it', async () => {
  const f = await setup();
  const lead = principalOf(f, sessionOf(f), 'lead');
  expect(read(f, lead).lead?.workflow).toEqual({
    policy_version: 0,
    improvement_mode: 'auto',
    path: { t1: 'direct', t2: 'dispatch', t3: 'dispatch' },
    acceptance_wake: 'each_merge',
    max_parallel: 3,
    handback_limit: 3,
    pinned: [],
    plan_changes: 'auto',
    charter: {
      approve_worker_prompts: 'on',
      answer_worker_questions: 'on',
      plan_change: 'on',
      create_agent: 'ask',
      accept_milestone: 'on',
      merge_out_of_scope: 'on',
      start_external: 'off',
    },
    steps: { before_dispatch: [], before_merge: [], after_merge: [] },
  });
  f.call<WorkflowPolicy>('workflow.policy.set', { project_id: f.project.id, max_parallel: 2 });
  expect(read(f, lead).lead?.workflow).toMatchObject({ policy_version: 1, max_parallel: 2 });
  f.call<WorkflowPolicy>(
    'workflow.policy.set',
    { project_id: f.project.id, handback_limit: 0 },
    f.store.must<WorkflowPolicy>('workflow_policies', f.project.id).revision,
  );
  expect(read(f, lead).lead?.workflow).toMatchObject({ policy_version: 2, handback_limit: 0 });
});

it('leaves the lead section out for a task session and for the user', async () => {
  const f = await setup();
  const leadSession = sessionOf(f);
  const worker = sessionOf(f, { lead_session_id: leadSession.id, id: 'api' });
  expect(read(f, principalOf(f, leadSession, 'lead'))).toHaveProperty('lead');
  expect(read(f, principalOf(f, worker, 'worker'))).not.toHaveProperty('lead');
  expect(read(f)).not.toHaveProperty('lead');
});

it('lists the routing cells that have a first choice with only their picks', async () => {
  const f = await setup({ leaderboards: true });
  for (const name of ['codex', 'claude']) {
    const adapter = new FixtureAdapter();
    adapter.name = name;
    f.control.adapters.set(name, adapter);
  }
  const lead = principalOf(f, sessionOf(f), 'lead');
  const cells = f.control.routingTable(user, f.project.id).cells;
  const routing = read(f, lead).lead!.routing;
  expect(routing.length).toBeGreaterThan(0);
  expect(routing).toEqual(
    cells
      .filter((cell) => cell.first)
      .map(({ domain, tier, first, alternate }) => ({
        domain,
        tier,
        first,
        ...(alternate ? { alternate } : {}),
      })),
  );
  expect(routing.find((cell) => cell.domain === 'backend-logic' && cell.tier === 't1')).toEqual({
    domain: 'backend-logic',
    tier: 't1',
    first: { runtime: 'codex', model: 'gpt-fixture', effort: 'high' },
    alternate: { runtime: 'claude', model: 'claude-fixture', effort: 'high' },
  });
});

it('lists no routing cell when no cell has a first choice', async () => {
  const f = await setup();
  expect(read(f, principalOf(f, sessionOf(f), 'lead')).lead!.routing).toEqual([]);
});

it('lists only the experiences on trial or in force, newest first', async () => {
  const f = await setup();
  const lead = principalOf(f, sessionOf(f), 'lead');
  const older = improvement(f, {
    status: 'active',
    proposed_at: 10,
    change: {
      type: 'experience',
      domain: 'backend-logic',
      tier: 't2',
      runtime: 'codex',
      procedure: 'Build the protocol package before the control tests',
      countercondition: 'The change does not touch the protocol',
    },
  });
  const newer = improvement(f, { status: 'trial', proposed_at: 20 });
  improvement(f, { status: 'candidate', proposed_at: 30 });
  improvement(f, { status: 'rejected', proposed_at: 40 });
  improvement(f, { status: 'reverted', proposed_at: 50 });
  improvement(f, {
    status: 'active',
    proposed_at: 60,
    change: { type: 'policy_change', param: 'max_parallel', from: 3, to: 2 },
  });
  improvement(f, { project_id: 'other-project', status: 'active', proposed_at: 70 });

  expect(read(f, lead).lead!.experiences).toEqual([
    { id: newer.id, status: 'trial', procedure: 'Run the build before the tests' },
    {
      id: older.id,
      status: 'active',
      procedure: 'Build the protocol package before the control tests',
      countercondition: 'The change does not touch the protocol',
      domain: 'backend-logic',
      tier: 't2',
      runtime: 'codex',
    },
  ]);
});

it("lists at most ten of the lead's own retrospectives, newest first, with their outcome facts", async () => {
  const f = await setup();
  const leadSession = sessionOf(f);
  const lead = principalOf(f, leadSession, 'lead');
  for (let i = 1; i <= 12; i++)
    retrospective(f, {
      id: `retrospective-${i}`,
      lead_session_id: leadSession.id,
      task_id: `task-${i}`,
      recorded_at: i,
    });
  retrospective(f, { id: 'retrospective-other', lead_session_id: 'other', recorded_at: 100 });
  retrospective(f, {
    id: 'retrospective-latest',
    lead_session_id: leadSession.id,
    task_id: 'api',
    outcome: 'failed',
    recorded_at: 50,
    measured_kind: { domain: 'backend-logic', tier: 't2' },
    runtime: 'codex',
    model: 'gpt-fixture',
    handbacks: [{ reason: 'gate failed' }, { reason: 'gate failed' }],
    gate_passed_on_attempt: 3,
    gate_failures: ['code', 'code'],
    turn_failure_codes: ['modelNotFound'],
    lead_wakes: 4,
  });

  const rows = read(f, lead).lead!.retrospectives;
  expect(rows.map((row) => row.id)).toEqual([
    'retrospective-latest',
    ...Array.from({ length: 9 }, (_, i) => `retrospective-${12 - i}`),
  ]);
  expect(rows[0]).toEqual({
    id: 'retrospective-latest',
    task_id: 'api',
    outcome: 'failed',
    measured_kind: { domain: 'backend-logic', tier: 't2' },
    model: 'gpt-fixture',
    handbacks: 2,
    gate_passed_on_attempt: 3,
    turn_failure_codes: ['modelNotFound'],
  });
  expect(rows[1]).toEqual({
    id: 'retrospective-12',
    task_id: 'task-12',
    outcome: 'merged',
    handbacks: 0,
  });
});

it('keeps fixed task session and hand-back counts out of the lead instructions', async () => {
  const f = await setup();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const instructions = workbenchSessionSpec(ctx, sessionOf(f)).control_instructions!;
  expect(instructions).toContain('lead session');
  expect(instructions).toContain('max_parallel');
  expect(instructions).not.toMatch(/\b(three|3) (task sessions|times)\b/i);
});

it('tells a lead to read before it plans, ask only what reading cannot settle, state its assumptions and reproduce bugs', async () => {
  const f = await setup();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const instructions = workbenchSessionSpec(ctx, sessionOf(f)).control_instructions!;
  for (const text of [
    'Before you plan a request, call project_read',
    'at most 3 questions',
    'call ask_user',
    "the plan's assumptions",
    'a test that reproduces the bug',
  ])
    expect(instructions).toContain(text);
});

it('tells a lead that needs may name a system, an architecture and device labels', async () => {
  const f = await setup();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const instructions = workbenchSessionSpec(ctx, sessionOf(f)).control_instructions!;
  for (const text of ['os=<system>', 'arch=<architecture>', 'labels'])
    expect(instructions).toContain(text);
});

it('mounts the Pantheon tools on a lead and says which board panel each tool updates', async () => {
  const f = await setup();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const spec = workbenchSessionSpec(ctx, sessionOf(f));
  expect(spec.pantheon_mcp?.args.at(-1)).toBe('mcp');
  for (const text of [
    'update_board and edit_board write the plan panels',
    'draw with pin',
    'rerun_baseline refreshes the baseline, introduction and repository panels',
  ])
    expect(spec.control_instructions).toContain(text);
});

it('lists the devices for a lead only once a device or this machine is configured', async () => {
  const f = await setup();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const lead = principalOf(f, sessionOf(f), 'lead');
  expect(read(f, lead).lead).not.toHaveProperty('devices');

  writeFileSync(
    path.join(ctx.userConfigDir!, 'config.json'),
    JSON.stringify({ version: 1, local_device: { resources: { display: 1 } } }),
  );
  expect(read(f, lead).lead!.devices).toEqual([
    expect.objectContaining({ id: 'local', online: true, resources: { display: 1 }, sessions: 0 }),
  ]);
  expect(read(f, lead).lead!.devices![0]).not.toHaveProperty('max_sessions');

  writeFileSync(
    path.join(ctx.userConfigDir!, 'config.json'),
    JSON.stringify({
      version: 1,
      devices: { 'gpu-box': { ssh: 'gpu-box', labels: ['cuda'], resources: { gpu: 1 } } },
    }),
  );
  ctx.devices!.set('gpu-box', {
    id: 'gpu-box',
    name: 'GPU box',
    ssh: 'gpu-box',
    labels: ['cuda', 'os=linux'],
    resources: { gpu: 1 },
    max_sessions: 2,
    online: true,
    checked_at: new Date().toISOString(),
    runtimes: {
      claude: { binary: '/bin/claude', version: '2', logged_in: true },
      codex: { binary: '/bin/codex', version: '1', logged_in: false },
    },
    tools: {},
  });
  const devices = read(f, lead).lead!.devices!;
  expect(devices.map((device) => device.id)).toEqual(['local', 'gpu-box']);
  expect(devices[1]).toEqual({
    id: 'gpu-box',
    name: 'GPU box',
    online: true,
    labels: ['cuda', 'os=linux'],
    resources: { gpu: 1 },
    max_sessions: 2,
    runtimes: ['claude'],
    sessions: 0,
  });
});
