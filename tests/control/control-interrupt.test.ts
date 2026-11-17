import { describe, expect, it, vi } from 'vitest';
import type { Session, SessionTurn } from '@pantheon/domain';
import { awaitWorkspaceReady, eventually } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

async function interruptFixture(delay = 30000) {
  // By default turns outlast the test unless they are interrupted.
  const f = await workbenchFixture({ delay });
  const session = (id: string) => f.store.must<Session>('sessions', id);
  /** Creates a session and waits until its first turn runs. */
  const open = async () => {
    const created = await f.create('Long work');
    await awaitWorkspaceReady(f.control, created.workspace_id!);
    const first = f.turns(created.id)[0]!;
    await eventually(
      () => row(first).state !== 'queued',
      () => f.control.tick(),
    );
    return { opened: session(created.id), first };
  };
  const input = (id: string, kind: 'send' | 'steer', text: string) =>
    f.call<SessionTurn>(`session.${kind}`, { session_id: id, input: text }, session(id).revision);
  const interrupt = (id: string) =>
    f.call<Session>('session.interrupt', { session_id: id }, session(id).revision);
  const row = (turn: SessionTurn) => f.store.must<SessionTurn>('session_turns', turn.id);
  const completions = (turn: SessionTurn) =>
    f.store
      .events()
      .filter(
        (event) =>
          event.kind === 'agent.turn.completed' &&
          (event.payload as { turn_id?: string }).turn_id === turn.id,
      )
      .map((event) => (event.payload as { status: string }).status);
  return { f, session, open, input, interrupt, row, completions };
}

describe('session interrupt', () => {
  it('ends the running turn, cancels queued input and keeps the session for the next send', async () => {
    const s = await interruptFixture();
    const { opened, first } = await s.open();
    await eventually(() => s.row(first).state === 'running');
    const queued = s.input(opened.id, 'steer', 'Queued correction');
    await s.f.control.tick();
    expect(s.row(queued)).toMatchObject({ state: 'queued' });
    expect(s.interrupt(opened.id)).toMatchObject({ id: opened.id, state: 'running' });
    expect(s.f.store.events().map((event) => event.kind)).toContain('session.interrupt_requested');
    await eventually(() => s.session(opened.id).state === 'open');
    expect(s.f.control.handles.size).toBe(1);
    expect(s.completions(first)).toEqual(['interrupted']);
    expect(s.row(first).state).toBe('cancelled');
    expect(s.row(queued)).toMatchObject({ state: 'cancelled', delivery_reason: 'interrupted' });
    expect(s.f.store.events().map((event) => event.kind)).not.toContain('session.interrupt_failed');
    const next = s.input(opened.id, 'send', 'Continue');
    await s.f.control.tick();
    await eventually(() => s.row(next).state === 'running');
    expect(s.row(next).delivery).toBe('delivered');
    s.interrupt(opened.id);
    await eventually(() => s.session(opened.id).state === 'open');
    expect(s.completions(next)).toEqual(['interrupted']);
  });

  it('keeps queued input when the runtime refuses the interrupt', async () => {
    const s = await interruptFixture();
    const { opened, first } = await s.open();
    await eventually(() => s.row(first).state === 'running');
    const queued = s.input(opened.id, 'steer', 'Queued correction');
    await s.f.control.tick();
    vi.spyOn(s.f.adapter, 'interrupt').mockResolvedValueOnce({ ok: false, reason: 'refused' });
    s.interrupt(opened.id);
    await eventually(() =>
      s.f.store.events().some((event) => event.kind === 'session.interrupt_failed'),
    );
    expect(s.row(queued).state).toBe('queued');
  });

  it('refuses a session without a running turn', async () => {
    const s = await interruptFixture(0);
    const { opened, first } = await s.open();
    await eventually(
      () => s.row(first).state === 'completed' && s.session(opened.id).state === 'open',
    );
    expect(() => s.interrupt(opened.id)).toThrow(
      expect.objectContaining({ code: 'resource_busy' }),
    );
  });
});
