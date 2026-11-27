import { expect, it } from 'vitest';
import type { Approval, Review, Session, SessionTurn } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

it('folds a spawned session’s records in time order and withholds private text from personal readers', async () => {
  let clock = 1000;
  const f = await fixture({ now: () => clock });
  try {
    const project_id = f.project.id;
    const session = f.store.insert<Session>('sessions', {
      id: 'child',
      revision: 1,
      project_id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 1,
      spawned_by: { session_id: 'parent' },
    });
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: 'asked-turn',
      revision: 1,
      project_id,
      session_id: session.id,
      kind: 'send',
      delivery: 'delivered',
      state: 'failed',
      input: '[Pantheon] From the main agent "Lead":\nprivate message\nsecond line',
    });
    const review = f.store.insert<Review>('reviews', {
      id: 'changes-review',
      revision: 1,
      project_id,
      session_id: session.id,
      round: 1,
      runtimes: ['fixture'],
      session_ids: [],
      state: 'completed',
      verdicts: [{ runtime: 'fixture', verdict: 'fail', summary: 'private summary', at: clock }],
      findings: [
        {
          id: 'finding',
          review_id: 'changes-review',
          round: 1,
          runtime: 'fixture',
          location: 'answer.ts:3',
          impact: 'private impact\nsecond line',
          evidence: '',
          quote: '',
          status: 'open',
          blocking: true,
        },
      ],
    });
    const event = (kind: string, record: Session | SessionTurn | Review, payload: object) => {
      clock++;
      f.store.event(kind, record, project_id, payload);
    };
    event('session.opened', session, {});
    event('session.main_agent_decided', session, {
      action: 'spawn',
      main_agent_session_id: 'parent',
      reason: 'private goal',
    });
    event('session.conductor_messaged', session, { turn_id: turn.id, session_id: 'parent' });
    event('turn.failed', turn, { error: 'private error\nsecond line' });
    const steer = f.store.insert<SessionTurn>('session_turns', {
      ...turn,
      id: 'delivered-steer',
      kind: 'steer',
      state: 'completed',
    });
    event('session.turn.delivery', steer, { delivery: 'delivered' });
    event('session.spawner_notified', session, { turn_id: turn.id, session_id: 'parent' });
    f.store.insert<Approval>('approvals', {
      id: 'question',
      revision: 1,
      project_id,
      session_id: session.id,
      kind: 'permission',
      input_hash: 'input',
      decider: 'user',
      state: 'approved',
      decided_by: 'session:parent',
      created_at: ++clock,
      conductor_reason: 'private reason',
      questions: [{ question: 'private question', header: '', options: [], multiSelect: false }],
      answers: { 'private question': 'private answer' },
    });
    event('review.completed', review, {});
    event('session.gate_checked', session, {
      results: [{ name: 'build', state: 'failed', exit_code: 1 }],
    });
    event('session.merge_blocked', session, { reason: 'gate_failed' });
    event('session.main_agent_decided', session, {
      action: 'ready',
      main_agent_session_id: 'parent',
    });
    event('session.merged', session, { to_sha: 'landed-commit' });

    const { entries } = f.control.sessionThread(user, session.id);
    expect(entries).toMatchObject([
      { kind: 'started', by: 'main_agent', reason: 'private goal' },
      { kind: 'message', text: 'private message\nsecond line' },
      { kind: 'turn_ended', state: 'failed', error: 'private error' },
      { kind: 'turn_ended', state: 'completed', turn_id: steer.id },
      { kind: 'spawner_notified', turn_id: turn.id },
      { kind: 'question', answered_by: 'main_agent', questions: ['private question'] },
      {
        kind: 'review',
        verdicts: [{ verdict: 'fail' }],
        blocking: [{ location: 'answer.ts:3', impact: 'private impact' }],
      },
      { kind: 'gate', state: 'failed', failed_steps: ['build'] },
      { kind: 'landing', state: 'blocked', reason: 'gate_failed' },
      { kind: 'main_agent_action', action: 'ready' },
      { kind: 'landing', state: 'landed', commit: 'landed-commit' },
    ]);
    const personal = f.control.sessionThread({ id: 'personal:key', role: 'personal' }, session.id);
    expect(JSON.stringify(personal)).not.toContain('private');
    expect(personal.entries.map(({ id, at, kind }) => ({ id, at, kind }))).toEqual(
      entries.map(({ id, at, kind }) => ({ id, at, kind })),
    );
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  } finally {
    await f.close();
  }
});

it('identifies who requested each reviewer session', async () => {
  const f = await fixture();
  try {
    for (const caller of ['main-agent', undefined]) {
      const review = f.store.insert<Review>('reviews', {
        id: caller ? 'agent-review' : 'cli-review',
        revision: 1,
        project_id: f.project.id,
        session_id: 'reviewed-writer',
        notify_session_id: caller,
        round: 1,
        runtimes: ['fixture'],
        session_ids: ['reviewer-' + (caller ?? 'user')],
        findings: [],
        state: 'running',
      });
      const session = f.store.insert<Session>('sessions', {
        id: review.session_ids[0]!,
        revision: 1,
        project_id: f.project.id,
        review_id: review.id,
        runtime: 'fixture',
        state: 'running',
        turn_count: 1,
      });
      const opened = f.store.event('session.opened', session, f.project.id, session);
      expect(f.control.sessionThread(user, session.id).entries).toEqual([
        {
          id: opened.event_id,
          at: opened.created_at,
          kind: 'started',
          ...(caller ? { by: 'main_agent', main_agent_session_id: caller } : { by: 'user' }),
        },
      ]);
    }
  } finally {
    await f.close();
  }
});
