import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentEvent,
  Approval,
  Principal,
  Session,
  SessionTurn,
  Workspace,
} from '@pantheon/domain';
import type { DecisionForUser } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { agentEvent } from '../../packages/control/dist/agent.js';
import { awaitWorkspaceReady, eventually, fixture, settle, user } from '../helpers.js';
import { git, workbenchFixture } from './workbench-fixture.js';

type Plain = Awaited<ReturnType<typeof fixture>>;
type Caller = Pick<Plain, 'call' | 'store' | 'project' | 'control'>;

const plains: Plain[] = [];
afterEach(async () => {
  for (const f of plains.splice(0)) await f.close();
});

async function plain() {
  const f = await fixture({ managedWorkspaces: true });
  plains.push(f);
  return f;
}

const ctxOf = (f: Caller) => (f.control as unknown as { ctx: ControlContext }).ctx;

/** A session running a turn; prompt feeds it a runtime permission request. */
async function promptFixture() {
  const f = await workbenchFixture();
  vi.spyOn(f.adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const session = await f.create('Build it');
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  const turn: SessionTurn = f.turns(session.id)[0]!;
  await eventually(
    () =>
      f.control.handles.has(turn.id) &&
      f.store.must<Session>('sessions', session.id).state === 'running',
    () => f.control.tick(),
  );
  const worktree = f.store.must<Workspace>('workspaces', session.workspace_id!).path;
  let sequence = 100;
  const prompt = async (name: string, extra: Partial<AgentEvent> = {}) => {
    sequence++;
    agentEvent(ctxOf(f), session.id, {
      key: `prompt-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: `request-${sequence}`,
      tool: 'Edit',
      detail: {
        input: { file_path: `${worktree}/src/${name}.ts`, old_string: 'a', new_string: 'b' },
      },
      ...extra,
    } as AgentEvent);
    await f.control.tick();
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  /** A prompt the stored project rule for Edit answers. */
  let ruleAdded = false;
  const ruled = async (name: string) => {
    if (!ruleAdded)
      f.call('permission.rule.add', {
        project_id: f.project.id,
        rule: 'Edit',
        session_id: session.id,
      });
    ruleAdded = true;
    return prompt(name, { project_rule_supported: true });
  };
  return { f, session, prompt, ruled };
}

/** One row's fields, or each row's newest first. */
type Act = () => Promise<{ f: Caller; match: Record<string, unknown> | Record<string, unknown>[] }>;

const personal: Principal = { id: 'personal:k1', role: 'personal' };

/** What by did in a project, with the personal key let to answer every kind. */
const answeredBy =
  (by: Principal, act: (f: Plain, by: Principal) => Record<string, unknown>): Act =>
  async () => {
    const userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-decisions-'));
    const f = await fixture({ managedWorkspaces: true, controlOptions: { userConfigDir } });
    plains.push({
      ...f,
      close: async () => {
        await f.close();
        rmSync(userConfigDir, { recursive: true, force: true });
      },
    });
    return { f, match: act(f, by) };
  };

const hang = `fixture-script\n${JSON.stringify([{ hang: true }])}`;

/** A main agent whose tools run as main; with running its first turn hangs, else it is idle. */
async function mainAgentFixture(running = false) {
  const f = await workbenchFixture();
  const conductor = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: running ? hang : 'Ship the export',
    purpose: 'conductor',
  });
  if (running) {
    await awaitWorkspaceReady(f.control, conductor.workspace_id!);
    await eventually(
      () => f.turns(conductor.id).at(-1)?.state === 'running',
      () => f.control.tick(),
    );
  } else await settle(f, conductor);
  const main: Principal = {
    id: `session:${conductor.id}`,
    role: 'conductor',
    project_id: f.project.id,
    session_id: conductor.id,
    expires_at: f.store.now() + 60_000,
  };
  const as = <T>(type: Parameters<Plain['call']>[0], input: Record<string, unknown>) =>
    f.call<T>(type, input, null, main);
  /** A session the main agent spawns; with running its first turn hangs, else it is idle. */
  const spawn = async (extra: Record<string, unknown> = {}, running = false) => {
    const { session_id } = await as<Promise<{ session_id: string }>>('conductor.spawn', {
      runtime: f.adapter.name,
      input: running ? hang : 'Write the docs',
      ...extra,
    });
    const spawned = f.store.must<Session>('sessions', session_id);
    if (running) {
      await awaitWorkspaceReady(f.control, spawned.workspace_id!);
      await eventually(
        () => f.turns(session_id).at(-1)?.state === 'running',
        () => f.control.tick(),
      );
    } else await settle(f, spawned);
    return session_id;
  };
  return { f, conductor, as, spawn };
}

/** The row of what the main agent did to the session; no session once it was deleted. */
const acted = (
  conductor: Session,
  action: string,
  sessionId: string | undefined,
  reason?: string,
): Record<string, unknown> => ({
  kind: 'main_agent_action',
  at: expect.any(Number),
  event_id: expect.any(String),
  ...(sessionId ? { session_id: sessionId } : {}),
  action,
  main_agent_session_id: conductor.id,
  ...(reason ? { reason } : {}),
});

it.each<[string, Act, DecisionForUser['kind'] | undefined]>([
  [
    'a prompt answered by a stored project rule',
    async () => {
      const { f, session, ruled } = await promptFixture();
      const approval = await ruled('a');
      return {
        f,
        match: { approval_id: approval.id, rule: 'Edit', session_id: session.id, tool: 'Edit' },
      };
    },
    'prompt_by_rule',
  ],
  [
    'a main agent starting a session',
    async () => {
      const { f, conductor, spawn } = await mainAgentFixture();
      const spawned = await spawn({ reason: 'The docs lag the flags' });
      return { f, match: acted(conductor, 'spawn', spawned, 'The docs lag the flags') };
    },
    'main_agent_action',
  ],
  [
    'a main agent starting a session on each of two runtimes',
    async () => {
      const { f, conductor, as } = await mainAgentFixture();
      const second = new FixtureAdapter();
      second.name = 'second-runtime';
      f.control.adapters.set(second.name, second);
      const { session_ids } = await as<Promise<{ session_ids: string[] }>>('conductor.spawn', {
        runtimes: [f.adapter.name, second.name],
        input: 'Port the parser',
        reason: 'Two tries pick the cleaner parser',
      });
      return {
        f,
        match: [...session_ids]
          .reverse()
          .map((id) => acted(conductor, 'spawn', id, 'Two tries pick the cleaner parser')),
      };
    },
    'main_agent_action',
  ],
  [
    'a main agent interrupting the turn of a session it started',
    async () => {
      const { f, conductor, as, spawn } = await mainAgentFixture();
      const spawned = await spawn({}, true);
      as('conductor.stop', { session_id: spawned, reason: 'It edits the wrong module' });
      return {
        f,
        match: [
          acted(conductor, 'interrupt', spawned, 'It edits the wrong module'),
          acted(conductor, 'spawn', spawned),
        ],
      };
    },
    'main_agent_action',
  ],
  [
    'a main agent closing a session it started',
    async () => {
      const { f, conductor, as, spawn } = await mainAgentFixture();
      const spawned = await spawn();
      as('conductor.stop', { session_id: spawned, close: true, reason: 'The other try landed' });
      return {
        f,
        match: [
          acted(conductor, 'close', spawned, 'The other try landed'),
          acted(conductor, 'spawn', spawned),
        ],
      };
    },
    'main_agent_action',
  ],
  [
    'a main agent landing a session it started',
    async () => {
      const { f, conductor, as, spawn } = await mainAgentFixture();
      git(f.source, 'config', 'user.name', 'Source User');
      git(f.source, 'config', 'user.email', 'source@example.invalid');
      const spawned = await spawn();
      const worktree = f.store.must<Workspace>(
        'workspaces',
        f.store.must<Session>('sessions', spawned).workspace_id!,
      ).path;
      writeFileSync(path.join(worktree, 'answer.txt'), 'ready\n');
      git(worktree, 'add', '--', 'answer.txt');
      git(worktree, 'commit', '--quiet', '-m', 'Update answer.txt');
      await as('conductor.ready', { session_id: spawned, reason: 'Its review found nothing' });
      return {
        f,
        match: [
          acted(conductor, 'ready', spawned, 'Its review found nothing'),
          acted(conductor, 'spawn', spawned),
        ],
      };
    },
    'main_agent_action',
  ],
  [
    'a main agent declaring its own work ready',
    async () => {
      const { f, conductor, as } = await mainAgentFixture(true);
      await as('conductor.ready', { reason: 'The export ships' });
      return { f, match: acted(conductor, 'ready', conductor.id, 'The export ships') };
    },
    'main_agent_action',
  ],
  [
    'the personal key marking the project seen',
    answeredBy(personal, (f, by) => {
      f.call('project.seen', { project_id: f.project.id }, null, by);
      return {};
    }),
    undefined,
  ],
])('lists what %s decided', async (_label, act, kind) => {
  const { f, match } = await act();
  const { items } = f.control.decisionsForUser(user, f.project.id);
  expect(items).toEqual(
    kind ? [match].flat().map((each) => expect.objectContaining({ kind, ...each })) : [],
  );
  if (kind) expect(items[0]!.at).toBeGreaterThan(0);
});

it('drops the decisions made before since and lists the rest newest first', async () => {
  const { f, ruled } = await promptFixture();
  const first = await ruled('a');
  // since is compared with the approval.approved event, which can be written after the approval row.
  const firstAt = f.control.decisionsForUser(user, f.project.id).items[0]!.at;
  await eventually(() => f.store.now() > firstAt);
  const since = f.store.now();
  const second = await ruled('b');
  const ids = (since?: number) =>
    f.control
      .decisionsForUser(user, f.project.id, since)
      .items.map((item) => (item as { approval_id: string }).approval_id);
  expect(ids()).toEqual([second.id, first.id]);
  expect(ids(since)).toEqual([second.id]);
});

it('refuses a principal of another project', async () => {
  const f = await plain();
  const stranger: Principal = {
    id: 'session:elsewhere',
    role: 'conductor',
    project_id: 'another-project',
    session_id: 'elsewhere',
    expires_at: f.store.now() + 60_000,
  };
  expect(() => f.control.decisionsForUser(stranger, f.project.id)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});

it('lists no row for a prompt the user approved', async () => {
  const { f, prompt } = await promptFixture();
  const approval = await prompt('a');
  expect(approval).toMatchObject({ state: 'pending', decider: 'user' });
  f.call('approval.respond', { approval_id: approval.id, decision: 'approve' }, approval.revision);
  await f.control.tick();
  expect(f.store.must<Approval>('approvals', approval.id).state).toBe('approved');
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([]);
});

it('lists what the main agent did without a reason when it gave none, and never its reason to the personal key', async () => {
  const { f, conductor, spawn } = await mainAgentFixture();
  const quiet = await spawn();
  const told = await spawn({ reason: 'The docs lag the flags' });
  const items = f.control.decisionsForUser(user, f.project.id).items;
  expect(items).toEqual([
    acted(conductor, 'spawn', told, 'The docs lag the flags'),
    acted(conductor, 'spawn', quiet),
  ]);
  expect(items[1]).not.toHaveProperty('reason');
  expect(f.control.decisionsForUser(personal, f.project.id).items).toEqual([
    acted(conductor, 'spawn', told),
    acted(conductor, 'spawn', quiet),
  ]);
});

it('lists no row for a stop the daemon refused', async () => {
  const { f, conductor, as, spawn } = await mainAgentFixture();
  const opened = await f.create('Plan the export');
  await settle(f, opened);
  const idle = await spawn();
  const code = (input: Record<string, unknown>) => {
    try {
      as('conductor.stop', { ...input, reason: 'It is stuck' });
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  };
  expect(code({ session_id: opened.id })).toBe('permission_denied');
  expect(code({ session_id: opened.id, close: true })).toBe('permission_denied');
  expect(code({ session_id: idle })).toBe('resource_busy');
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([
    acted(conductor, 'spawn', idle),
  ]);
});

it('keeps the row of what the main agent did to a session once that session was deleted', async () => {
  const { f, conductor, spawn } = await mainAgentFixture();
  const spawned = await spawn({ reason: 'The docs lag the flags' });
  f.call(
    'session.delete',
    { session_id: spawned },
    f.store.must<Session>('sessions', spawned).revision,
  );
  await eventually(
    () => !f.store.get<Session>('sessions', spawned),
    () => f.control.tick(),
  );
  const items = f.control.decisionsForUser(user, f.project.id).items;
  expect(items).toEqual([acted(conductor, 'spawn', undefined, 'The docs lag the flags')]);
  expect(items[0]).not.toHaveProperty('session_id');
});

/** A main agent and a session it spawned, whose running turn raises the requests ask gives it. */
async function spawnedFixture() {
  const f = await workbenchFixture();
  vi.spyOn(f.adapter, 'answerPermission').mockResolvedValue({ ok: true });
  const conductor = await f.call<Promise<Session>>('session.create', {
    project_id: f.project.id,
    runtime: f.adapter.name,
    input: 'Ship the export',
    purpose: 'conductor',
  });
  await settle(f, conductor);
  const main: Principal = {
    id: `session:${conductor.id}`,
    role: 'conductor',
    project_id: f.project.id,
    session_id: conductor.id,
    expires_at: f.store.now() + 60_000,
  };
  // Spawned by the user and marked, so no row of the spawn joins the answers.
  const { id: sessionId, workspace_id } = await f.create(hang);
  await awaitWorkspaceReady(f.control, workspace_id!);
  await eventually(
    () => f.turns(sessionId).at(-1)?.state === 'running',
    () => f.control.tick(),
  );
  const opened = f.store.must<Session>('sessions', sessionId);
  f.store.transaction(() =>
    f.store.update<Session>(
      'sessions',
      { ...opened, spawned_by: { session_id: conductor.id } },
      opened.revision,
    ),
  );
  const turn = f.turns(sessionId).at(-1)!;
  let sequence = 100;
  const ask = (tool: string, detail: unknown) => {
    sequence++;
    agentEvent(ctxOf(f), sessionId, {
      key: `ask-${sequence}`,
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: `request-${sequence}`,
      tool,
      detail,
    } as AgentEvent);
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  const answer = (approval: Approval, input: Record<string, unknown>) =>
    f.call(
      'conductor.answer',
      { session_id: sessionId, approval_id: approval.id, ...input },
      null,
      main,
    );
  /** A question of the spawned session with the one question text given. */
  const question = (text: string) => {
    const questions = [
      {
        question: text,
        header: 'Tooling',
        options: [{ label: 'pnpm', description: 'Workspace default' }],
        multiSelect: false,
      },
    ];
    return ask('AskUserQuestion', { input: { questions }, questions });
  };
  return { f, conductor, main, sessionId, ask, answer, question };
}

it('lists what the main agent answered for the user with its answers and reason, and not what the user answered', async () => {
  const { f, conductor, sessionId, ask, answer, question } = await spawnedFixture();
  const asked = question('Which package manager?');
  const declined = question('Which registry?');
  const theUsers = ask('Bash', { input: { command: 'pnpm test' } });

  answer(asked, {
    decision: 'approve',
    answers: { 'Which package manager?': 'pnpm' },
    reason: 'The workspace uses pnpm',
  });
  answer(declined, { decision: 'reject', reason: 'The user picks the registry' });
  f.call('approval.respond', { approval_id: theUsers.id, decision: 'approve' }, theUsers.revision);

  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([
    expect.objectContaining({
      kind: 'answered_by_main_agent',
      approval_id: declined.id,
      session_id: sessionId,
      tool: 'AskUserQuestion',
      question: 'Which registry?',
      decision: 'reject',
      reason: 'The user picks the registry',
      main_agent_session_id: conductor.id,
    }),
    expect.objectContaining({
      kind: 'answered_by_main_agent',
      approval_id: asked.id,
      session_id: sessionId,
      tool: 'AskUserQuestion',
      question: 'Which package manager?',
      answers: { 'Which package manager?': 'pnpm' },
      decision: 'approve',
      reason: 'The workspace uses pnpm',
      main_agent_session_id: conductor.id,
    }),
  ]);
});

it('lists what the main agent did among its answers newest first, from since on', async () => {
  const { f, conductor, main, sessionId, answer, question } = await spawnedFixture();
  const asked = question('Which package manager?');
  answer(asked, {
    decision: 'approve',
    answers: { 'Which package manager?': 'pnpm' },
    reason: 'The workspace uses pnpm',
  });
  const answeredAt = f.control.decisionsForUser(user, f.project.id).items[0]!.at;
  await eventually(() => f.store.now() > answeredAt);
  const since = f.store.now();
  f.call(
    'conductor.stop',
    { session_id: sessionId, reason: 'It edits the wrong module' },
    null,
    main,
  );
  const interrupted = acted(conductor, 'interrupt', sessionId, 'It edits the wrong module');
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([
    interrupted,
    expect.objectContaining({ kind: 'answered_by_main_agent', approval_id: asked.id }),
  ]);
  expect(f.control.decisionsForUser(user, f.project.id, since).items).toEqual([interrupted]);
});

it('drops the row of a question the main agent answered once its session was deleted', async () => {
  const { f, answer, question } = await spawnedFixture();
  const asked = question('Which package manager?');
  answer(asked, {
    decision: 'approve',
    answers: { 'Which package manager?': 'pnpm' },
    reason: 'The workspace uses pnpm',
  });
  expect(f.control.decisionsForUser(user, f.project.id).items).toHaveLength(1);
  const settled = f.store.must<Approval>('approvals', asked.id);
  f.store.remove('approvals', settled.id, settled.revision);
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([]);
});

it('lists one row for a question whose answer the runtime refused and reopened, for the answer that stands', async () => {
  const { f, answer, question } = await spawnedFixture();
  const refuse = () =>
    vi
      .mocked(f.adapter.answerPermission)
      .mockResolvedValueOnce({ ok: false, refused: true, reason: 'The runtime takes no answer' });
  const reopened = async (approval: Approval) =>
    eventually(
      () => f.store.must<Approval>('approvals', approval.id).state === 'pending',
      () => f.control.tick(),
    );
  const answers = { 'Which package manager?': 'pnpm' };
  const theUsers = question('Which package manager?');
  refuse();
  answer(theUsers, { decision: 'approve', answers, reason: 'The workspace uses pnpm' });
  await reopened(theUsers);
  f.call(
    'approval.respond',
    { approval_id: theUsers.id, decision: 'reject' },
    f.store.must<Approval>('approvals', theUsers.id).revision,
  );
  // The user's answer reaches the runtime before the next refusal is set up.
  await eventually(
    () => !f.store.pending().some((out) => out.kind === 'permission.answer'),
    () => f.control.tick(),
  );
  const again = question('Which registry?');
  refuse();
  answer(again, {
    decision: 'approve',
    answers: { 'Which registry?': 'pnpm' },
    reason: 'The first try',
  });
  await reopened(again);
  answer(again, { decision: 'reject', reason: 'The user picks the registry' });
  await f.control.tick();

  const stands = [
    expect.objectContaining({
      approval_id: again.id,
      decision: 'reject',
      reason: 'The user picks the registry',
    }),
  ];
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual(stands);
  // Once the session is deleted, the refused answer of the main agent still does not stand.
  const answered = f.store.must<Approval>('approvals', theUsers.id);
  f.store.remove('approvals', answered.id, answered.revision);
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual(stands);
});

it.each([
  [
    'the daemon replaced it with a decline',
    'approval.rejected',
    { state: 'rejected', reason: 'session_lost' },
  ],
  [
    'the runtime withdrew the request',
    'approval.resolved',
    { state: 'void', reason: 'session_lost' },
  ],
] as const)(
  'lists no row for an answer that never reached the session because %s',
  async (_, kind, change) => {
    const { f, answer, question } = await spawnedFixture();
    const asked = question('Which package manager?');
    answer(asked, {
      decision: 'approve',
      answers: { 'Which package manager?': 'pnpm' },
      reason: 'The workspace uses pnpm',
    });
    const settled = f.store.must<Approval>('approvals', asked.id);
    const lost = f.store.update<Approval>('approvals', { ...settled, ...change }, settled.revision);
    f.store.event(kind, lost, f.project.id, lost);
    expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([]);
  },
);

it.each([
  ['the runtime refused', 'approval.refused', {}],
  ['the runtime withdrew', 'approval.resolved', { state: 'void', reason: 'session_lost' }],
] as const)('lists no row for a stored-rule answer %s', async (_, kind, change) => {
  const { f, ruled } = await promptFixture();
  const approval = await ruled('a');
  const settled = f.store.must<Approval>('approvals', approval.id);
  f.store.event(kind, settled, f.project.id, { ...settled, ...change });
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([]);
});

it('keeps the row of a stored-rule answer the runtime received', async () => {
  const { f, ruled } = await promptFixture();
  const approval = await ruled('a');
  const settled = f.store.must<Approval>('approvals', approval.id);
  f.store.event('approval.resolved', settled, f.project.id, { ...settled, state: 'approved' });
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([
    expect.objectContaining({ kind: 'prompt_by_rule', approval_id: approval.id }),
  ]);
});

it('lists no row for an answer the runtime refused, also once its session was deleted', async () => {
  const { f, answer, question } = await spawnedFixture();
  vi.mocked(f.adapter.answerPermission).mockResolvedValueOnce({
    ok: false,
    refused: true,
    reason: 'The runtime takes no answer',
  });
  const asked = question('Which package manager?');
  answer(asked, {
    decision: 'approve',
    answers: { 'Which package manager?': 'pnpm' },
    reason: 'The workspace uses pnpm',
  });
  await eventually(
    () => f.store.must<Approval>('approvals', asked.id).state === 'pending',
    () => f.control.tick(),
  );
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([]);
  const reopened = f.store.must<Approval>('approvals', asked.id);
  f.store.remove('approvals', reopened.id, reopened.revision);
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([]);
});

it('keeps the row of a prompt whose approval left with its deleted session', async () => {
  const { f, ruled } = await promptFixture();
  const approval = await ruled('a');
  const settled = f.store.must<Approval>('approvals', approval.id);
  f.store.remove('approvals', settled.id, settled.revision);
  expect(f.control.decisionsForUser(user, f.project.id).items).toEqual([
    expect.objectContaining({ kind: 'prompt_by_rule', approval_id: approval.id }),
  ]);
});
