import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
import {
  applySessionDisplay,
  DEFAULT_SESSION_DISPLAY,
  setSessionDisplay,
} from '@/data/session-display';
import { Thread } from '@/screens/sessions/Thread';

beforeEach(() => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { activeElement: null });
});
afterEach(() => {
  unmountAll();
  setSessionDisplay(DEFAULT_SESSION_DISPLAY);
  vi.unstubAllGlobals();
});

describe('status animation', () => {
  it('puts the choice on the body as a data attribute', () => {
    const body: Record<string, string> = {};
    applySessionDisplay(DEFAULT_SESSION_DISPLAY, body);
    expect(body.stateMotion).toBe('all');
    applySessionDisplay({ ...DEFAULT_SESSION_DISPLAY, state_motion: 'off' }, body);
    expect(body.stateMotion).toBe('off');
  });
});

describe('timeline', () => {
  function thread(panels: string[] = []) {
    const board = {
      cursor: 1,
      projects: [],
      workspaces: [],
      sessions: [
        {
          id: 'session-a',
          revision: 1,
          project_id: 'project-a',
          runtime: 'claude',
          state: 'open',
          turn_count: 0,
        },
      ],
      session_turns: [],
    };
    mock.board = { board, events: [], resync: 0, status: { state: 'live' }, refresh() {} };
    const h = mount(() =>
      Thread({
        board: board as any,
        sessionId: 'session-a',
        listed: null,
        needs: { items: [] } as any,
        parent: null,
        panels: panels as any,
        onPanel() {},
        overview: true,
        onDiscarded() {},
      }),
    );
    return nodes(h.value).find((n) => 'goal' in n.props && 'waits' in n.props);
  }

  it('shows the timeline with its labels by default and narrows it while panels are open', () => {
    expect(thread()!.props.slim).toBe(false);
    expect(thread(['changes'])!.props.slim).toBe(true);
  });

  it('keeps only the marks, or leaves the timeline out', () => {
    setSessionDisplay({ timeline: 'marks' });
    expect(thread()!.props.slim).toBe(true);
    setSessionDisplay({ timeline: 'off' });
    expect(thread()).toBeUndefined();
  });
});
