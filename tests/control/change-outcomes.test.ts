import { afterEach, expect, it } from 'vitest';
import type { AgentProfile, Retrospective } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});

async function setup() {
  const clock = { now: 1_000_000 };
  const f = await fixture({ now: () => clock.now });
  fixtures.push(f);
  let rows = 0;
  /** Inserts a plan task's retrospective at the clock, then moves the clock on. */
  const retro = (inputTokens: number, fields: Partial<Retrospective> = {}) => {
    rows++;
    f.store.insert<Retrospective>('retrospectives', {
      id: `retrospective-${rows}`,
      revision: 1,
      project_id: f.project.id,
      lead_session_id: 'lead',
      task_id: `task-${rows}`,
      session_ids: [],
      outcome: 'merged',
      recorded_at: clock.now,
      gate_passed_on_attempt: 1,
      task_usage: { input_tokens: inputTokens, output_tokens: 10 },
      ...fields,
    });
    clock.now += 1_000;
  };
  /** Turns improvements off as the user and returns the event id of that setting change. */
  const changePolicy = () => {
    f.call('workflow.policy.set', { project_id: f.project.id, improvement_mode: 'off' }, null);
    clock.now += 1_000;
    return f.store.kindEvents(f.project.id, ['workflow.policy_changed']).at(-1)!.event_id;
  };
  return { f, clock, retro, changePolicy };
}

it('reads not enough evidence with n after a setting change followed by three tasks', async () => {
  const { f, retro, changePolicy } = await setup();
  for (let i = 0; i < 10; i++) retro(1000);
  const eventId = changePolicy();
  for (let i = 0; i < 3; i++) retro(1000);
  expect(f.control.changeOutcome(user, f.project.id, eventId)).toMatchObject({
    event_id: eventId,
    kind: 'policy_changed',
    param: 'improvement_mode',
    verdict: 'not_enough_evidence',
    n: 3,
    tasks_required: 10,
    before: { tasks: 3 },
    after: { tasks: 3 },
  });
});

it('reads better when the cost per accepted task falls with no fewer first passes', async () => {
  const { f, retro, changePolicy } = await setup();
  for (let i = 0; i < 10; i++) retro(1000);
  const eventId = changePolicy();
  for (let i = 0; i < 10; i++) retro(500);
  expect(f.control.changeOutcome(user, f.project.id, eventId)).toMatchObject({
    verdict: 'better',
    n: 10,
    before: {
      tasks: 10,
      first_pass: 10,
      cost_per_accepted_task: { input_tokens: 1000, n: 10 },
      user_interventions: 0,
    },
    after: { cost_per_accepted_task: { input_tokens: 500, n: 10 }, user_interventions: 0 },
  });
});

it('reads worse when the user stops more tasks after the change', async () => {
  const { f, retro, changePolicy } = await setup();
  for (let i = 0; i < 10; i++) retro(1000);
  const eventId = changePolicy();
  for (let i = 0; i < 8; i++) retro(800);
  for (let i = 0; i < 2; i++)
    retro(0, { outcome: 'failed', stopped_by: 'user', gate_passed_on_attempt: undefined });
  expect(f.control.changeOutcome(user, f.project.id, eventId)).toMatchObject({
    verdict: 'worse',
    after: { first_pass: 8, cost_per_accepted_task: { input_tokens: 800, n: 8 } },
  });
  expect(f.control.changeOutcome(user, f.project.id, eventId).after.user_interventions).toBe(2);
});

it('gives a setting change the values before and after it, and leaves them out when its event lacks them', async () => {
  const { f, changePolicy } = await setup();
  const eventId = changePolicy();
  f.store.event('workflow.policy_changed', { id: 'policy', revision: 1 }, f.project.id, {
    param: 'max_parallel',
    by: 'user',
  });
  const [bare, changed] = f.control.changeOutcomes(user, f.project.id);
  expect(changed).toMatchObject({ event_id: eventId, from: 'auto', to: 'off' });
  expect(bare).toMatchObject({ param: 'max_parallel' });
  expect(bare).not.toHaveProperty('from');
  expect(bare).not.toHaveProperty('to');
});

it('lists the setting change, agent creation and routine enable newest first', async () => {
  const { f, clock } = await setup();
  f.call('workflow.policy.set', { project_id: f.project.id, improvement_mode: 'off' }, null);
  clock.now += 1_000;
  const agent = f.call<AgentProfile>('agent.create', {
    project_id: f.project.id,
    template: 'custom',
    name: 'Helper',
    role: 'Helper',
    instructions: 'You help with one kind of request.',
  });
  clock.now += 1_000;
  f.call('agent.update', {
    agent_id: agent.id,
    revision: agent.revision,
    routines: [{ id: 'daily', prompt: 'Look for stalled tasks', every_minutes: 60, enabled: true }],
  });
  const outcomes = f.control.changeOutcomes(user, f.project.id);
  expect(outcomes.slice(0, 3)).toMatchObject([
    { kind: 'routine_enabled', agent_id: agent.id, routine_ids: ['daily'], n: 0 },
    { kind: 'agent_created', agent_id: agent.id },
    { kind: 'policy_changed', param: 'improvement_mode' },
  ]);
  expect(() => f.control.changeOutcome(user, f.project.id, 'no-such-event')).toThrow(
    'events/no-such-event',
  );
});
