import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentProfile,
  Approval,
  BoardPlan,
  LeadNote,
  PersonalKey,
  Principal,
  Project,
  Session,
  SessionSpec,
  SessionTurn,
  Timer,
} from '@pantheon/domain';
import { personalHome } from '@pantheon/control';
import { residentPlan } from '../../packages/control/dist/agent-always-on.js';
import { needsYou } from '../../packages/control/dist/needs-you.js';
import { MEMORY_INSTRUCTIONS } from '../../packages/control/dist/memory.js';
import { afterResidentTurn } from '../../packages/control/dist/resident.js';
import { eventually, fixture, user } from '../helpers.js';

vi.mock('../../packages/control/dist/needs-you.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/control/dist/needs-you.js')>();
  return { ...actual, needsYou: vi.fn(actual.needsYou) };
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

const personal: Principal = { id: 'personal:k1', role: 'personal' };
// Noon local time, so the next 09:00 is tomorrow's.
const NOON = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();
const MINUTE = 60_000;

let f: Fixture;
let starts: MockInstance<FixtureAdapter['start']>;
let clock: number;
let userConfigDir: string;
beforeEach(async () => {
  const adapter = new FixtureAdapter();
  starts = vi.spyOn(adapter, 'start');
  clock = NOON;
  userConfigDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-personal-agent-'));
  f = await fixture({
    adapter,
    now: () => clock,
    managedWorkspaces: true,
    controlOptions: {
      userConfigDir,
      readProcess: () => undefined,
      issuePersonalKey: (keyId) => ({ token_file: `/keys/${keyId}`, digest: `digest-${keyId}` }),
      personalKeyFile: (keyId) => ({
        token_file: `/keys/${keyId}`,
        daemon_url: 'http://127.0.0.1:4321',
      }),
    },
  });
});
afterEach(async () => {
  await f.close();
  rmSync(userConfigDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const home = () => f.store.transaction(() => personalHome(f.control['ctx'], 'personal-agent-test'));

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  return undefined;
};

it('creates one home row, one profile and one key however often it is asked', () => {
  const first = home(),
    second = home();
  expect(second).toEqual(first);
  expect(first.project).toMatchObject({ name: 'Personal', roots: [], kind: 'personal' });
  expect(first.profile).toMatchObject({
    project_id: first.project.id,
    template: 'personal',
    name: 'Personal',
    role: 'Me',
  });
  expect(
    f.store.list<Project>('projects').filter((project) => project.kind === 'personal'),
  ).toHaveLength(1);
  expect(
    f.store.list<AgentProfile>('agents').filter((agent) => agent.project_id === first.project.id),
  ).toHaveLength(1);
  expect(f.store.list<PersonalKey>('personal_keys').map((key) => key.id)).toEqual([
    first.profile.personal_key_id,
  ]);
});

it.each([
  ['the user', user],
  ['a personal principal', personal],
])('leaves the home out of projects.summary for %s', (_name, principal) => {
  const { project } = home();
  expect(f.control.projectsSummary(principal).projects.map((each) => each.project_id)).toEqual([
    f.project.id,
  ]);
  expect(project.id).not.toBe(f.project.id);
});

it('gives the home no Assistant or Triage when Control starts', async () => {
  const { project, profile } = home();
  await f.control.recover();
  expect(
    f.store.list<AgentProfile>('agents').filter((agent) => agent.project_id === project.id),
  ).toEqual([profile]);
});

it.each([
  ['request.send', { input: 'Hello' }],
  ['session.create', { input: 'Hello' }],
] as const)('refuses %s aimed at the home', (type, input) => {
  const { project } = home();
  expect(refusal(() => f.call(type, { project_id: project.id, ...input }))).toMatchObject({
    code: 'invalid_input',
    message: "The personal agent's home takes no project commands",
  });
});

it('schedules the daily routine for the next 09:00', () => {
  const { profile } = home();
  const nine = new Date(NOON);
  nine.setDate(nine.getDate() + 1);
  nine.setHours(9, 0, 0, 0);
  expect(profile.routines).toEqual([
    {
      id: 'daily',
      prompt: 'Check every project and tell me what waits for me.',
      at: '09:00',
      enabled: true,
    },
  ]);
  expect(
    f.store
      .list<Timer>('timers')
      .filter((timer) => timer.kind === 'agent-routine')
      .map((timer) => [timer.project_id, timer.subject_id, timer.due_at]),
  ).toEqual([[profile.project_id, `${profile.id}:daily`, nine.getTime()]]);
});

it('lists the built-in key with its label', () => {
  const { profile } = home();
  expect(f.control.personalKeyList(user)).toEqual([
    expect.objectContaining({ id: profile.personal_key_id, label: 'Built-in personal agent' }),
  ]);
});

const openPersonal = (principal = user) =>
  f.call<Session>('resident.open', { kind: 'personal' }, null, principal);

/** The spec of the session's first turn, started by a message from the user. */
async function firstTurnSpec(session: Session): Promise<SessionSpec> {
  f.call('session.send', { session_id: session.id, input: 'What waits for me?' }, session.revision);
  const spec = () =>
    starts.mock.calls.map(([each]) => each).find((each) => each.platform_session_id === session.id);
  await eventually(
    () => spec() !== undefined,
    () => f.control.tick(),
  );
  return spec()!;
}

it('opens one conversation in the home, made on the first open', () => {
  const first = openPersonal(),
    second = openPersonal();
  const home = f.store.list<Project>('projects').find((project) => project.kind === 'personal')!;
  const profile = f.store
    .list<AgentProfile>('agents')
    .find((agent) => agent.project_id === home.id)!;
  expect(second.id).toBe(first.id);
  expect(first).toMatchObject({
    project_id: home.id,
    resident: { kind: 'personal', agent_id: profile.id },
  });
});

it('leaves the home out of the projects the settings list', () => {
  openPersonal();
  const home = f.store.list<Project>('projects').find((project) => project.kind === 'personal')!;
  const listed = f.control.projectDefaults(user).projects.map((project) => project.project_id);
  expect(listed).toContain(f.project.id);
  expect(listed).not.toContain(home.id);
});

it('runs the personal tools on the built-in key in an empty folder of its own', async () => {
  const session = openPersonal();
  const { profile } = home();
  const spec = await firstTurnSpec(session);
  expect(spec.pantheon_mcp!.args.slice(-2)).toEqual(['mcp', '--personal']);
  expect(spec.pantheon_mcp!.env).toEqual({
    PANTHEON_DAEMON_URL: 'http://127.0.0.1:4321',
    PANTHEON_PERSONAL_TOKEN_FILE: `/keys/${profile.personal_key_id}`,
  });
  expect(spec.pantheon_mcp!.ask_tools).toBeUndefined();
  const folder = path.join(f.controlOptions!.workspaceRoot!, 'personal-agent');
  expect(spec.cwd).toBe(folder);
  expect(statSync(folder).mode & 0o777).toBe(0o700);
  expect(readdirSync(folder)).toEqual([]);
  expect(spec.control_instructions).not.toContain(MEMORY_INSTRUCTIONS);
});

it('refuses resident.open of the personal agent from a personal principal', () => {
  expect(refusal(() => openPersonal(personal))).toMatchObject({ code: 'permission_denied' });
  expect(f.store.list<Project>('projects').some((project) => project.kind === 'personal')).toBe(
    false,
  );
});

it('moves the inbox to the next session of the personal agent without a takeover turn', () => {
  const session = openPersonal();
  const { profile } = home();
  f.store.transaction(() => residentPlan(f.control['ctx'], session));
  const other = new FixtureAdapter();
  other.name = 'other-runtime';
  f.control.adapters.set(other.name, other);
  f.call('agent.update', {
    agent_id: profile.id,
    revision: profile.revision,
    runtime: other.name,
  });
  const next = openPersonal();
  expect(next.id).not.toBe(session.id);
  expect(f.store.get<BoardPlan>('board_plans', next.id)).toBeDefined();
  expect(
    f.store.list<SessionTurn>('session_turns').filter((turn) => turn.session_id === next.id),
  ).toEqual([]);
});

/** A pending permission request of the project, recorded as a runtime's request is. */
function request(projectId: string, approvalId: string): Approval {
  return f.store.transaction(() => {
    const approval = f.store.insert<Approval>('approvals', {
      id: approvalId,
      revision: 1,
      project_id: projectId,
      kind: 'permission',
      session_id: 'asker',
      tool: 'Bash',
      input_hash: approvalId,
      decider: 'user',
      state: 'pending',
      created_at: f.store.now(),
    });
    f.store.event('approval.requested', approval, projectId, {}, 'personal-agent-test');
    return approval;
  });
}

/** An event of the project that adds no waiting item. */
const unrelated = (projectId: string) =>
  f.store.transaction(() =>
    f.store.event('note.unrelated', { id: 'unrelated', revision: 1 }, projectId, {}, ''),
  );

async function secondProject(): Promise<Project> {
  const root = path.join(f.root, 'second');
  mkdirSync(root);
  return await f.call<Promise<Project>>('project.open', { name: 'second', roots: [root] });
}

const homeProject = () =>
  f.store.list<Project>('projects').find((each) => each.kind === 'personal');
const homeNotes = (kind: LeadNote['kind']) => {
  const project = homeProject();
  return project
    ? f.store
        .events(0, project.id, 1000, ['lead.note_added'])
        .map((event) => event.payload as LeadNote)
        .filter((note) => note.kind === kind)
    : [];
};
const homeTrackerTurns = () => {
  const project = homeProject()!;
  return f.store
    .list<SessionTurn>('session_turns')
    .filter(
      (turn) =>
        turn.origin === 'tracker' &&
        f.store.must<Session>('sessions', turn.session_id).project_id === project.id,
    );
};
const personalItemReads = () =>
  vi.mocked(needsYou).mock.calls.filter(([, principal]) => principal.role === 'personal').length;

it('wakes once for new waiting items in two projects', async () => {
  openPersonal();
  const second = await secondProject();
  request(f.project.id, 'first');
  request(second.id, 'second');
  await f.control.tick();
  await f.control.tick();
  expect(homeNotes('personal_attention').map((note) => note.text)).toEqual([
    '2 new items wait for the user. In "fixture": permission (1). In "second": permission (1).',
  ]);
  const turns = homeTrackerTurns();
  expect(turns).toHaveLength(1);
  expect(turns[0]!.wake?.causes).toContain('personal_attention');
  expect(turns[0]!.input).toContain('read needs_you');
});

it('writes no note when the waiting items are the ones it already woke for', async () => {
  openPersonal();
  const approval = request(f.project.id, 'first');
  await f.control.tick();
  clock += 31 * MINUTE;
  unrelated(f.project.id);
  await f.control.tick();
  f.store.transaction(() => {
    const next = f.store.update<Approval>(
      'approvals',
      { ...approval, input_summary: 'ls' },
      approval.revision,
    );
    f.store.event('approval.updated', next, f.project.id, {}, '');
  });
  await f.control.tick();
  expect(homeNotes('personal_attention')).toHaveLength(1);
});

it('holds a new item that comes within 30 minutes of a wake until the gap ends', async () => {
  openPersonal();
  request(f.project.id, 'first');
  await f.control.tick();
  clock += 10 * MINUTE;
  request(f.project.id, 'second');
  await f.control.tick();
  expect(homeNotes('personal_attention')).toHaveLength(1);
  clock += 20 * MINUTE;
  await f.control.tick();
  expect(homeNotes('personal_attention').map((note) => note.text)).toEqual([
    '1 new item waits for the user. In "fixture": permission (1).',
    '1 new item waits for the user. In "fixture": permission (1).',
  ]);
});

it("writes no note in the app's quiet hours, and one with every new item after them", async () => {
  f.call('app.settings.set', { quiet_hours: { from: '12:00', to: '13:00' } });
  openPersonal();
  request(f.project.id, 'first');
  await f.control.tick();
  clock += 30 * MINUTE;
  request(f.project.id, 'second');
  await f.control.tick();
  expect(homeNotes('personal_attention')).toEqual([]);
  clock += 31 * MINUTE;
  await f.control.tick();
  expect(homeNotes('personal_attention').map((note) => note.text)).toEqual([
    '2 new items wait for the user. In "fixture": permission (2).',
  ]);
});

it('writes no note once its weekly input tokens are spent', async () => {
  const session = openPersonal();
  await firstTurnSpec(session);
  await eventually(
    () =>
      f.store
        .list<SessionTurn>('session_turns')
        .some((turn) => turn.session_id === session.id && turn.state === 'completed'),
    () => f.control.tick(),
  );
  const turn = f.store
    .list<SessionTurn>('session_turns')
    .find((each) => each.session_id === session.id)!;
  f.store.update<SessionTurn>(
    'session_turns',
    { ...turn, usage: { input_tokens: 150, output_tokens: 0 } },
    turn.revision,
  );
  const { profile } = home();
  f.call('agent.update', {
    agent_id: profile.id,
    revision: profile.revision,
    contract: { weekly_input_tokens: 100 },
  });
  clock += MINUTE;
  request(f.project.id, 'first');
  await f.control.tick();
  expect(homeNotes('personal_attention')).toEqual([]);
  const capped = f.store.must<AgentProfile>('agents', profile.id);
  f.call('agent.update', {
    agent_id: capped.id,
    revision: capped.revision,
    contract: { weekly_input_tokens: 1000 },
  });
  await f.control.tick();
  expect(homeNotes('personal_attention')).toHaveLength(1);
});

it('is not woken by the waiting items of its own home', async () => {
  openPersonal();
  request(homeProject()!.id, 'own');
  await f.control.tick();
  expect(homeNotes('personal_attention')).toEqual([]);
  clock += MINUTE;
  request(f.project.id, 'first');
  await f.control.tick();
  expect(homeNotes('personal_attention').map((note) => note.text)).toEqual([
    '1 new item waits for the user. In "fixture": permission (1).',
  ]);
});

it('reads no waiting items on ticks while nothing has happened', async () => {
  openPersonal();
  await f.control.tick();
  const reads = personalItemReads();
  expect(reads).toBeGreaterThan(0);
  await f.control.tick();
  await f.control.tick();
  await f.control.tick();
  expect(personalItemReads()).toBe(reads);
  clock += MINUTE;
  request(f.project.id, 'first');
  await f.control.tick();
  expect(personalItemReads()).toBe(reads + 1);
});

it('reads the waiting items at most once a minute while events keep coming', async () => {
  openPersonal();
  await f.control.tick();
  const reads = personalItemReads();
  for (let i = 0; i < 3; i++) {
    unrelated(f.project.id);
    await f.control.tick();
  }
  expect(personalItemReads()).toBe(reads);
  clock += MINUTE;
  unrelated(f.project.id);
  await f.control.tick();
  expect(personalItemReads()).toBe(reads + 1);
});

it('is not woken once its built-in key is revoked', async () => {
  const session = openPersonal();
  const profile = f.store.must<AgentProfile>('agents', session.resident!.agent_id!);
  const key = f.store.must<PersonalKey>('personal_keys', profile.personal_key_id!);
  f.call('personal.key.revoke', { key_id: key.id }, key.revision);
  const reads = personalItemReads();
  request(f.project.id, 'first');
  await f.control.tick();
  expect(homeNotes('personal_attention')).toEqual([]);
  expect(personalItemReads()).toBe(reads);
});

/** Revokes the built-in key of the open personal agent and returns its profile. */
function revokeBuiltIn(session: Session): AgentProfile {
  const profile = f.store.must<AgentProfile>('agents', session.resident!.agent_id!);
  const key = f.store.must<PersonalKey>('personal_keys', profile.personal_key_id!);
  f.call('personal.key.revoke', { key_id: key.id }, key.revision);
  return profile;
}

it('gets a new built-in key when the user opens it after the key was revoked', () => {
  const profile = revokeBuiltIn(openPersonal());
  openPersonal();
  const keyId = f.store.must<AgentProfile>('agents', profile.id).personal_key_id!;
  expect(keyId).not.toBe(profile.personal_key_id);
  expect(f.control.personalKeyList(user)).toEqual([
    expect.objectContaining({ id: profile.personal_key_id, revoked_at: expect.any(Number) }),
    { id: keyId, label: 'Built-in personal agent', created_at: expect.any(Number) },
  ]);
  expect(
    f.control
      .projectsSummary({ id: `personal:${keyId}`, role: 'personal' })
      .projects.map((each) => each.project_id),
  ).toEqual([f.project.id]);
});

it('runs the next turn of its open conversation on the new key', async () => {
  const resumes = vi.spyOn(FixtureAdapter.prototype, 'resume');
  const session = openPersonal();
  await firstTurnSpec(session);
  await eventually(
    () => f.control['ctx'].idleConversations.has(session.id),
    () => f.control.tick(),
  );
  const profile = revokeBuiltIn(session);
  const reopened = openPersonal();
  expect(reopened.id).toBe(session.id);
  const keyId = f.store.must<AgentProfile>('agents', profile.id).personal_key_id!;
  expect(keyId).not.toBe(profile.personal_key_id);
  await eventually(() => !f.control['ctx'].idleConversations.has(session.id));
  const before = resumes.mock.calls.length;
  f.call(
    'session.send',
    { session_id: session.id, input: 'And now?' },
    f.store.must<Session>('sessions', session.id).revision,
  );
  await eventually(
    () =>
      resumes.mock.calls
        .slice(before)
        .some(
          ([spec]) =>
            spec.platform_session_id === session.id &&
            spec.pantheon_mcp?.env.PANTHEON_PERSONAL_TOKEN_FILE === `/keys/${keyId}`,
        ),
    () => f.control.tick(),
  );
});

it('neither wakes nor gets a new key on ticks after the built-in key is revoked', async () => {
  const profile = revokeBuiltIn(openPersonal());
  request(f.project.id, 'first');
  await f.control.tick();
  clock += 31 * MINUTE;
  request(f.project.id, 'second');
  await f.control.tick();
  expect(homeNotes('personal_attention')).toEqual([]);
  expect(f.store.must<AgentProfile>('agents', profile.id).personal_key_id).toBe(
    profile.personal_key_id,
  );
  expect(f.store.list<PersonalKey>('personal_keys')).toHaveLength(1);
});

it('keeps its built-in key when it is opened again while the key is live', () => {
  const session = openPersonal();
  const { profile } = home();
  openPersonal();
  expect(f.store.must<AgentProfile>('agents', session.resident!.agent_id!).personal_key_id).toBe(
    profile.personal_key_id,
  );
  expect(f.store.list<PersonalKey>('personal_keys')).toHaveLength(1);
});

it('keeps its built-in key when another personal key is revoked', () => {
  const session = openPersonal();
  const { profile } = home();
  const other = f.call<{ key_id: string }>('personal.key.create', { label: 'Phone' });
  const key = f.store.must<PersonalKey>('personal_keys', other.key_id);
  f.call('personal.key.revoke', { key_id: key.id }, key.revision);
  openPersonal();
  expect(f.store.must<AgentProfile>('agents', session.resident!.agent_id!).personal_key_id).toBe(
    profile.personal_key_id,
  );
  expect(f.store.list<PersonalKey>('personal_keys').map((each) => each.id)).toEqual([
    profile.personal_key_id,
    key.id,
  ]);
});

it('runs its daily routine at 09:00 without a memory key to write back', async () => {
  openPersonal();
  const nine = new Date(NOON);
  nine.setDate(nine.getDate() + 1);
  nine.setHours(9, 0, 0, 0);
  clock = nine.getTime();
  await f.control.tick();
  expect(homeNotes('routine')).toHaveLength(1);
  const turns = homeTrackerTurns();
  expect(turns.map((turn) => turn.wake)).toEqual([{ causes: ['routine'], routine_ids: ['daily'] }]);
  expect(turns[0]!.input).not.toContain('under the same key');
});

it('reopens a full session with its inbox and no handoff turn', () => {
  const session = openPersonal();
  const { profile } = home();
  f.store.transaction(() => {
    const plan = residentPlan(f.control['ctx'], session);
    f.store.update<BoardPlan>(
      'board_plans',
      { ...plan, personal_seen: { keys: ['kept'], at: NOON } },
      plan.revision,
    );
  });
  const current = f.store.must<Session>('sessions', session.id);
  f.store.update<Session>(
    'sessions',
    {
      ...current,
      usage: { input_tokens: 0, output_tokens: 0, context_tokens: 900, context_window: 1000 },
    },
    current.revision,
  );
  afterResidentTurn(f.control['ctx'], session.id, 'ended-turn');
  const next = openPersonal();
  expect(next.id).not.toBe(session.id);
  expect(f.store.must<Session>('sessions', session.id).state).toBe('closed');
  expect(f.store.get<BoardPlan>('board_plans', next.id)?.personal_seen).toEqual({
    keys: ['kept'],
    at: NOON,
  });
  expect(
    f.store
      .list<SessionTurn>('session_turns')
      .filter((turn) => turn.session_id === session.id || turn.session_id === next.id),
  ).toEqual([]);
  expect(next.resident?.agent_id).toBe(profile.id);
});

it('does nothing on a tick while there is no home', async () => {
  request(f.project.id, 'first');
  await f.control.tick();
  expect(homeProject()).toBeUndefined();
  expect(personalItemReads()).toBe(0);
});
