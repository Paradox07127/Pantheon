import { expect, it, onTestFinished, vi } from 'vitest';
import type { Approval, Landing, LandingRecord, Session, SessionTurn } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

async function statusFixture() {
  const now = vi.fn(() => 300);
  const f = await fixture({ now });
  onTestFinished(() => f.close());
  const project_id = f.project.id;
  const read = (from = 100, to = 200) =>
    f.control.projectStatusRead(user, { project_id, from, to });
  const event = (at: number, kind: string, id: string, payload: object = {}) => {
    now.mockReturnValueOnce(at);
    f.store.event(kind, { id, revision: 1 }, project_id, payload);
  };
  const request = (session_id: string, at: number, project = project_id) => {
    const approval = f.store.insert<Approval>('approvals', {
      id: `approval-${session_id}`,
      revision: 1,
      project_id: project,
      session_id,
      kind: 'permission',
      input_hash: 'hash',
      decider: 'user',
      state: 'pending',
      created_at: at,
    });
    now.mockReturnValueOnce(at);
    f.store.event('approval.requested', approval, project, approval);
    return approval;
  };
  const finish = (
    approval: Approval,
    at: number,
    fields: Partial<Approval> = { state: 'approved', decided_by: user.id },
  ) => {
    const ended = f.store.update('approvals', { ...approval, ...fields }, approval.revision);
    now.mockReturnValueOnce(at);
    f.store.event(`approval.${ended.state}`, ended, ended.project_id, ended);
    return ended;
  };
  return { ...f, project_id, read, event, request, finish };
}

it('summarizes landed attempts and ranks the five longest user waits inside the window', async () => {
  const { store, project_id, read, request, finish } = await statusFixture();
  const landing = (ended_at: number, state: LandingRecord['state'], gated: boolean) =>
    store.insert<LandingRecord>('landing_records', {
      id: String(ended_at),
      revision: 1,
      project_id,
      ended_at,
      state,
      reason: null,
      landed_sha: state === 'landed' ? 'tip' : null,
      gate_runs: Number(gated),
      first_gate_passed: gated ? true : null,
      review_rounds: gated ? 2 : 0,
      turns: 1,
      input_tokens: 0,
      output_tokens: 0,
      wall_ms: gated ? 80 : 20,
    });
  const first = landing(100, 'landed', true);
  const second = landing(199, 'blocked', false);
  landing(200, 'no_changes', false);
  request('open', 50);
  finish(request('answered-later', 130), 220);
  finish(request('across-start', 20), 160);
  finish(request('fourth', 101), 140);
  finish(request('fifth', 125), 150);
  finish(request('sixth', 150), 160);
  finish(request('agent', 0), 199, { state: 'approved', decided_by: 'session:conductor' });
  finish(request('rule', 0), 199, { state: 'approved', answered_by_rule: 'read' });
  finish(request('withdrawn', 0), 150, { state: 'void' });
  request('foreign', 50, 'another-project');
  finish(request('ended-at-start', 50), 100);
  request('opened-at-end', 200);

  const { landings, waiting } = read();
  expect(landings).toEqual({
    records: [second, first],
    landed: 1,
    blocked: 1,
    no_changes: 0,
    first_gate_pass_rate: 1,
    mean_review_rounds: 1,
    median_wall_ms: 50,
  });
  expect(waiting).toEqual({
    count: 6,
    total_ms: 304,
    longest: [
      { session_id: 'open', kind: 'permission', wait_ms: 100, open: true },
      { session_id: 'answered-later', kind: 'permission', wait_ms: 70, open: true },
      { session_id: 'across-start', kind: 'permission', wait_ms: 60, open: false },
      { session_id: 'fourth', kind: 'permission', wait_ms: 39, open: false },
      { session_id: 'fifth', kind: 'permission', wait_ms: 25, open: false },
    ],
  });
  expect(read(200, 201).landings).toMatchObject({ no_changes: 1, first_gate_pass_rate: null });
});

it('ends a user wait at the decision even when the adapter acknowledges it later', async () => {
  const { store, read, request, finish, event } = await statusFixture();
  const answered = finish(request('delayed-ack', 110), 140);
  const resolved = store.update('approvals', { ...answered, resolved_at: 190 }, answered.revision);
  event(190, 'approval.resolved', resolved.id, resolved);

  expect(read().waiting.total_ms).toBe(30);
});

it('keeps the historical user wait after its session is deleted', async () => {
  const { call, store, project_id, read, request, finish } = await statusFixture();
  const session = store.insert<Session>('sessions', {
    id: 'intro',
    revision: 1,
    project_id,
    runtime: 'fixture',
    state: 'closed',
    turn_count: 0,
    intro: true,
  });
  const rejected = finish(request(session.id, 110), 160, {
    state: 'rejected',
    decided_by: user.id,
  });
  const before = read().waiting;
  expect(before).toEqual({
    count: 1,
    total_ms: 50,
    longest: [{ session_id: session.id, kind: 'permission', wait_ms: 50, open: false }],
  });
  call('session.delete', { session_id: session.id }, session.revision);
  expect(store.get('approvals', rejected.id)).toBeUndefined();
  expect(read().waiting).toEqual(before);
});

it('counts open waits only through now and skips requests that start in the future', async () => {
  const { read, request } = await statusFixture();
  request('open', 270);
  request('future', 320);

  expect(read(250, 350).waiting).toEqual({
    count: 1,
    total_ms: 30,
    longest: [{ session_id: 'open', kind: 'permission', wait_ms: 30, open: true }],
  });
});

it('clips turn and gate intervals independently of usage attribution and includes review time once', async () => {
  const { store, project_id, read, event } = await statusFixture();
  const turn = (
    id: string,
    tags: Partial<Session> = {},
    state: SessionTurn['state'] = 'completed',
  ) => {
    const session = store.insert<Session>('sessions', {
      id: id + '-session',
      revision: 1,
      project_id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 1,
      ...tags,
    });
    store.insert<SessionTurn>('session_turns', {
      id,
      revision: 1,
      project_id,
      session_id: session.id,
      kind: 'send',
      input: 'Work',
      state,
      delivery: 'delivered',
      usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 },
    });
    return session;
  };
  const writer = turn('writer');
  const reviewer = turn('review', { review_id: 'review' });
  turn('ongoing', { conductor: true }, 'running');
  event(10, 'turn.running', 'ongoing');
  turn('spanning');
  event(20, 'turn.running', 'spanning');
  event(30, 'session.gate_started', writer.id);
  event(50, 'turn.running', 'writer');
  event(105, 'session.gate_checked', writer.id);
  event(110, 'session.gate_started', reviewer.id);
  event(115, 'session.gate_run_cancelled', reviewer.id);
  event(120, 'turn.completed', 'writer');
  event(175, 'turn.running', 'review');
  event(200, 'turn.completed', 'review');
  event(220, 'turn.completed', 'spanning');
  store.insert<Landing>('landings', {
    id: 'branch',
    revision: 1,
    project_id,
    state: 'landed',
    root: '/repo',
    workspace_id: 'branch-workspace',
    branch: 'topic',
    target_branch: 'main',
    gate_started_at: 185,
    gate_finished_at: 205,
    finished_at: 220,
  });

  event(220, 'session.gate_checked', 'legacy-gate', { results: [{ duration_ms: 30 }] });

  const { time, usage } = read();
  expect(time.roles.map((row) => [row.role, row.turn_ms])).toEqual([
    ['baseline', 0],
    ['conductor', 100],
    ['reviewer', 25],
    ['spawned', 0],
    ['story', 0],
    ['user', 120],
  ]);
  expect(time).toMatchObject({ gate_ms: 35, review_ms: 25 });
  expect(usage).toHaveLength(6);
  expect(usage.find((row) => row.role === 'conductor')).toMatchObject({
    turns: 0,
    input_tokens: 0,
  });
  expect(usage.find((row) => row.role === 'user')).toEqual({
    role: 'user',
    turns: 1,
    input_tokens: 10,
    cached_input_tokens: 4,
    output_tokens: 2,
  });
  expect(usage.find((row) => row.role === 'reviewer')).toMatchObject({ turns: 0, input_tokens: 0 });
});

it.each([
  [100, 100, /after from/i],
  [100, 99, /after from/i],
  [0, 93 * 86400000, /92 days/i],
] as const)('refuses the status window from %i to %i', async (from, to, message) => {
  const { read } = await statusFixture();
  expect(() => read(from, to)).toThrow(
    expect.objectContaining({ code: 'invalid_input', message: expect.stringMatching(message) }),
  );
});

it('allows a project reader to read only its own project status', async () => {
  const { project, project_id, store, control } = await statusFixture();
  const other = store.insert('projects', { ...project, id: 'another-project' });
  const session = store.insert<Session>('sessions', {
    id: 'reader',
    revision: 1,
    project_id: other.id,
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
    project_setup: true,
  });
  const reader = {
    id: `session:${session.id}`,
    role: 'planner' as const,
    session_id: session.id,
    project_id: other.id,
    expires_at: store.now() + 60000,
  };
  const window = { from: 0, to: 92 * 86400000 };
  expect(
    control.projectStatusRead(reader, { project_id: other.id, ...window }).landings.records,
  ).toEqual([]);
  expect(() => control.projectStatusRead(reader, { project_id, ...window })).toThrow(
    expect.objectContaining({ code: 'permission_denied' }),
  );
});
