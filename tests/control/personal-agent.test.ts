import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AgentProfile, PersonalKey, Principal, Project, Timer } from '@pantheon/domain';
import { personalHome } from '@pantheon/control';
import { fixture, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const personal: Principal = { id: 'personal:k1', role: 'personal' };
// Noon local time, so the next 09:00 is tomorrow's.
const NOON = new Date(2026, 10, 18, 12, 0, 0, 0).getTime();

let f: Fixture;
beforeEach(async () => {
  f = await fixture({
    now: () => NOON,
    controlOptions: {
      issuePersonalKey: (keyId) => ({ token_file: `/keys/${keyId}`, digest: `digest-${keyId}` }),
    },
  });
});
afterEach(() => f.close());

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
