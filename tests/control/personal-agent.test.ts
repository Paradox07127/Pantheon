import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type {
  AgentProfile,
  BoardPlan,
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
import { eventually, fixture, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const personal: Principal = { id: 'personal:k1', role: 'personal' };
// Noon local time, so the next 09:00 is tomorrow's.
const NOON = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();

let f: Fixture;
let starts: MockInstance<FixtureAdapter['start']>;
beforeEach(async () => {
  const adapter = new FixtureAdapter();
  starts = vi.spyOn(adapter, 'start');
  f = await fixture({
    adapter,
    now: () => NOON,
    managedWorkspaces: true,
    controlOptions: {
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
