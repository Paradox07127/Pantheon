import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnView } from '@/data/transcript';
import { HookHost, named } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: (select: (state: { board: null }) => unknown) => select({ board: null }),
}));
vi.mock('@/data/session-activity', () => ({
  useSessionActivity: () => ({ data: null, loading: false, error: null, reload() {} }),
}));
import { ThreadTrace, showThreadTurns } from '@/screens/sessions/trace';

const NOW = new Date(2026, 2, 8, 14, 20).getTime();

afterEach(() => {
  showThreadTurns(null);
  vi.useRealTimers();
});

describe('session inspector trace', () => {
  it('moves a running turn forward with the clock without new events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const running = { turn: { id: 'turn-a' }, started_at: NOW - 60_000, ended_at: null };
    showThreadTurns({ sessionId: 'session-a', turns: [running as unknown as TurnView] });
    const h = new HookHost(() => ThreadTrace({ sessionId: 'session-a' }));
    h.render();
    expect(named(h.value, 'TraceSection').props.now).toBe(NOW);
    vi.advanceTimersByTime(5_000);
    await h.flush();
    expect(named(h.value, 'TraceSection').props.now).toBe(NOW + 5_000);
    h.unmount();
  });
});
