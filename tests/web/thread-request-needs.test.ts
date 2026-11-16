import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
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
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => ({ read: null, error: null, loading: false, reload() {} }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
import { Thread } from '@/screens/sessions/Thread';

beforeEach(() => {
  mock.board = {
    board: {
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
          turn_count: 1,
        },
      ],
      session_turns: [
        {
          id: 'turn-a',
          project_id: 'project-a',
          session_id: 'session-a',
          revision: 1,
          created_at: 1,
          updated_at: 1,
          input: 'Run the migration',
          state: 'running',
        },
      ],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async () => ({ ok: true, value: {} })),
      command: vi.fn(async () => ({ ok: true, value: {} })),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('document', { activeElement: null });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('requests inside a turn', () => {
  it('hand their cards the failure of the needs-you read, also when its approvals stay the same', async () => {
    const approval = {
      id: 'needs-approval',
      kind: 'approval.pending',
      source: { table: 'approvals', id: 'approval-a', revision: 1 },
      actions: [],
    };
    let needs: any = { items: [approval], loading: false, error: null, reload() {} };
    const h = mount(() =>
      Thread({
        board: mock.board.board,
        sessionId: 'session-a',
        listed: null,
        needs,
        parent: null,
        panels: [],
        onPanel() {},
        overview: false,
        onDiscarded() {},
      }),
    );
    await h.flush();
    const slotNeeds = () => {
      const turn = nodes(h.value).find((n) => 'view' in n.props && 'request' in n.props)!;
      const slot = turn.props.request({ id: 'request-a' }, 'enter') as ReactElement<any>;
      return slot.props.needs;
    };
    expect(slotNeeds().error).toBeNull();
    needs = { ...needs, error: 'The daemon is not answering' };
    h.render();
    expect(slotNeeds().error).toBe('The daemon is not answering');
    needs = { ...needs, error: null };
    h.render();
    expect(slotNeeds().error).toBeNull();
  });
});
