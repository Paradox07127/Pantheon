import { expect, it, vi } from 'vitest';
import type { Principal, Retrospective, Session, SessionTurn } from '@pantheon/domain';
import { eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;

const MINUTE = 60_000;
const WEEK = 7 * 24 * 60 * MINUTE;

const lead = (f: Fixture, sessionId: string): Principal => ({
  id: `session:${sessionId}`,
  role: 'lead',
  project_id: f.project.id,
  session_id: sessionId,
  expires_at: f.store.now() + 60 * MINUTE,
});

const retrospective = (
  f: Fixture,
  leadId: string,
  taskId: string,
  outcome: Retrospective['outcome'],
  startedAt: number,
) =>
  f.store.insert<Retrospective>('retrospectives', {
    id: `${leadId}:${taskId}:1`,
    revision: 1,
    project_id: f.project.id,
    lead_session_id: leadId,
    task_id: taskId,
    session_ids: [],
    outcome,
    recorded_at: startedAt + 30 * MINUTE,
    started_at: startedAt,
  });

it("counts an agent's weeks: wakes by cause and outcome, its tasks, its sessions' tokens and the prompts approved for it", async () => {
  const f = await workbenchFixture({ delay: 3000 });
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(9, 0, 0, 0);
  let now = start.getTime();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const assistant = f.call<Session>('resident.open', {
    project_id: f.project.id,
    kind: 'assistant',
  });
  const as = <T = unknown>(type: Parameters<Fixture['call']>[0], input: Record<string, unknown>) =>
    f.call<T>(type, { project_id: f.project.id, ...input }, null, lead(f, assistant.id));
  as('agent.routine.set', {
    id: 'stalled',
    prompt: 'Look for stalled tasks',
    at: '18:00',
    enabled: true,
  });
  const agentId = assistant.resident!.agent_id!;
  const trackerTurns = () => f.turns(assistant.id).filter((turn) => turn.origin === 'tracker');
  const ended = () =>
    f.turns(assistant.id).every((turn) => turn.state !== 'queued' && turn.state !== 'running');
  const run = () => f.call('agent.routine.run', { agent_id: agentId, routine_id: 'stalled' });

  run();
  await eventually(
    () => trackerTurns()[0]?.state === 'running',
    () => f.control.tick(),
  );
  as('agent.tell_user', { text: 'Two tasks stalled overnight.', urgency: 'normal' });
  await eventually(ended, () => f.control.tick(), 20_000);
  now += 2 * MINUTE;
  run();
  await eventually(
    () => trackerTurns().length === 2 && ended(),
    () => f.control.tick(),
    20_000,
  );
  let tokens = 0;
  for (const [index, turn] of f.turns(assistant.id).entries()) {
    tokens += 100 * (index + 1);
    f.store.update<SessionTurn>(
      'session_turns',
      { ...turn, usage: { input_tokens: 100 * (index + 1), output_tokens: 5 } },
      turn.revision,
    );
  }

  retrospective(f, assistant.id, 'merged', 'merged', now - 60 * MINUTE);
  retrospective(f, assistant.id, 'failed', 'failed', now - 120 * MINUTE);
  retrospective(f, assistant.id, 'earlier', 'accepted', now - WEEK - 60 * MINUTE);
  retrospective(f, 'other-lead', 'theirs', 'merged', now - 60 * MINUTE);
  const used = (power: string, sessionId: string) =>
    f.store.event('charter.power_used', { id: 'approval-1', revision: 1 }, f.project.id, {
      power,
      mode: 'on',
      subject: 'approval-1',
      session_id: sessionId,
    });
  used('approve_worker_prompts', assistant.id);
  used('answer_worker_questions', assistant.id);
  used('approve_worker_prompts', 'other-lead');

  expect(f.control.agentLedger(user, agentId, 2)).toEqual([
    {
      from: now - WEEK,
      to: now,
      wakes: 2,
      causes: { routine: 2 },
      outcomes: { nothing: 1, acted: 0, told_user: 1, asked: 0 },
      tasks_started: 2,
      tasks_merged: 1,
      input_tokens: tokens,
      prompts_auto_approved: 1,
    },
    {
      from: now - 2 * WEEK,
      to: now - WEEK,
      wakes: 0,
      causes: {},
      outcomes: { nothing: 0, acted: 0, told_user: 0, asked: 0 },
      tasks_started: 1,
      tasks_merged: 1,
      input_tokens: 0,
      prompts_auto_approved: 0,
    },
  ]);
  expect(() => f.control.agentLedger(lead(f, assistant.id), agentId, 1)).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});
