import { expect, it } from 'vitest';
import type { Session, SessionTurn, Workspace } from '@pantheon/domain';
import { fixture, user } from '../helpers.js';

it('lists the goal, last turn, context and compactions as the turns and their events record them', async () => {
  const f = await fixture({ now: () => 1_800_000_000_000 });
  try {
    const project = f.project.id;
    const workspace = f.store.insert<Workspace>('workspaces', {
      id: 'listed-worktree',
      revision: 1,
      project_id: project,
      kind: 'linked_worktree',
      path: f.projectRoot,
      owner: 'listed-session',
      ownership_epoch: 1,
    });
    const session = f.store.insert<Session>('sessions', {
      id: 'listed-session',
      revision: 1,
      project_id: project,
      runtime: 'fixture',
      state: 'open',
      workspace_id: workspace.id,
      turn_count: 4,
    });
    // A lone surrogate survives only a JSON read of the text.
    const input = `first \ud800 ${'x'.repeat(300)}`,
      error = 'exit \udfff code';
    const turn = (id: string, extra: Partial<SessionTurn>) => {
      const value = f.store.insert<SessionTurn>('session_turns', {
        id,
        revision: 1,
        project_id: project,
        session_id: session.id,
        input: id,
        kind: 'send',
        delivery: 'delivered',
        state: 'completed',
        ...extra,
      });
      f.store.event('turn.queued', value, project, value);
      return value;
    };
    turn('listed-first', { input, usage: { input_tokens: 1, output_tokens: 1 } });
    turn('listed-context', {
      usage: { input_tokens: 2, output_tokens: 1, context_tokens: 120, context_window: 1000 },
    });
    const failed = turn('listed-failed', { state: 'failed', delivery_reason: 'not delivered' });
    turn('listed-rolled-back', { rolled_back: true });
    turn('listed-steer', { kind: 'steer', state: 'failed' });
    f.store.event('turn.failed', failed, project, { error, error_code: 7 });
    f.store.event('agent.turn.completed', session, project, {
      turn_id: failed.id,
      error_code: 'runtime_exit',
      error: 'not read from a completion',
    });
    f.store.event('agent.turn.completed', session, project, { turn_id: 3, error_code: 'other' });
    f.store.event('agent.context.compacted', session, project, {});
    f.store.event('agent.context.compacted', session, project, {});

    const [listed] = f.control.sessionList(user, project);
    expect(listed).toMatchObject({
      goal: { text: input.slice(0, 200) },
      last_turn: { id: failed.id, state: 'failed', error, error_code: 'runtime_exit' },
      context: { used_tokens: 120, window_tokens: 1000 },
      compaction_count: 2,
    });
  } finally {
    await f.close();
  }
});

it('gives the last turn the time it started running, and no start while it waits in the queue', async () => {
  let clock = 1_800_000_000_000;
  const f = await fixture({ now: () => clock });
  try {
    const project = f.project.id;
    const open = (id: string, state: SessionTurn['state']) => {
      const workspace = f.store.insert<Workspace>('workspaces', {
        id: `${id}-worktree`,
        revision: 1,
        project_id: project,
        kind: 'linked_worktree',
        path: `${f.projectRoot}/${id}`,
        owner: id,
        ownership_epoch: 1,
      });
      const session = f.store.insert<Session>('sessions', {
        id,
        revision: 1,
        project_id: project,
        runtime: 'fixture',
        state: 'open',
        workspace_id: workspace.id,
        turn_count: 1,
      });
      return f.store.insert<SessionTurn>('session_turns', {
        id: `${id}-turn`,
        revision: 1,
        project_id: project,
        session_id: session.id,
        input: id,
        kind: 'send',
        delivery: 'delivered',
        state,
      });
    };
    const running = open('running-session', 'running'),
      queued = open('queued-session', 'queued');
    f.store.event('turn.running', running, project, running);
    // A turn put back in the queue after it ran has no start until it runs again.
    f.store.event('turn.running', queued, project, queued);
    clock += 60_000;
    f.store.event('turn.running', running, project, running);
    clock += 60_000;

    const listed = new Map(f.control.sessionList(user, project).map((s) => [s.id, s]));
    expect(listed.get('running-session')!.last_turn).toEqual({
      id: running.id,
      state: 'running',
      started_at: new Date(1_800_000_060_000).toISOString(),
    });
    expect(listed.get('queued-session')!.last_turn).toEqual({ id: queued.id, state: 'queued' });
  } finally {
    await f.close();
  }
});
