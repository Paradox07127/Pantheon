import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transcript, TurnView } from '@/data/transcript';
import { mount, nodes, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  view: null as Transcript | null,
  transcript: 'folded' as string,
}));
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
vi.mock('@/data/layout', async (actual) => ({
  ...(await actual<object>()),
  useLook: () => ({ transcript: mock.transcript }),
}));
vi.mock('@/data/transcript', async (actual) => ({
  ...(await actual<object>()),
  buildTranscript: () => mock.view,
}));
import { Thread } from '@/screens/sessions/Thread';

const turn = (id: string, extra: Partial<TurnView> = {}, rolledBack = false): TurnView => ({
  turn: {
    id,
    project_id: 'project-a',
    session_id: 'session-a',
    revision: 1,
    created_at: 1,
    updated_at: 1,
    input: `input of ${id}`,
    state: 'completed',
    ...(rolledBack ? { rolled_back: true } : {}),
  } as unknown as TurnView['turn'],
  at: 1,
  started_at: 1,
  ended_at: 2,
  text: '',
  usage: null,
  end: null,
  items: [],
  ...extra,
});
const todoWrite = (id: string, status: string) => ({
  kind: 'tool' as const,
  id,
  name: 'TodoWrite',
  input: { todos: [{ content: 'step', status }] },
  ok: true,
});
const quiet = {
  kind: 'event' as const,
  event: {
    sequence: 3,
    kind: 'agent.session.started',
    aggregate_id: 'session-a',
    created_at: 3,
    payload: { session_id: 'session-a' },
  } as any,
};

beforeEach(() => {
  mock.transcript = 'folded';
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
          turn_count: 2,
        },
      ],
      session_turns: [],
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

async function thread() {
  const h = mount(() =>
    Thread({
      board: mock.board.board,
      sessionId: 'session-a',
      listed: null,
      needs: { items: [] } as any,
      parent: null,
      panels: [],
      onPanel() {},
      overview: false,
      onDiscarded() {},
    }),
  );
  await h.flush();
  return h;
}
const prop = (tree: unknown, name: string) =>
  nodes(tree as any).find((n) => typeof n.type !== 'string' && name in n.props)!.props[name];

describe('a thread after a rollback', () => {
  it('takes the plan and the context usage from the turns kept', async () => {
    mock.view = {
      turns: [
        turn('turn-a', {
          items: [todoWrite('todo-a', 'completed')],
          usage: { input_tokens: 100 },
        }),
        turn(
          'turn-b',
          { items: [todoWrite('todo-b', 'in_progress')], usage: { input_tokens: 900 } },
          true,
        ),
      ],
      loose: { text: '', usage: null, items: [] },
    };
    const h = await thread();
    expect(prop(h.value, 'plan')).toEqual(['completed']);
    expect(prop(h.value, 'usage')).toEqual({ input_tokens: 100 });
  });
});

describe('items outside any turn', () => {
  const owners = (tree: unknown) =>
    nodes(tree as any)
      .filter((n) => n.props.owner === 'loose')
      .map((n) => n.props.items);

  it('show quiet events when the transcript is expanded, and hide them when folded', async () => {
    mock.view = { turns: [turn('turn-a')], loose: { text: '', usage: null, items: [quiet] } };
    expect(owners((await thread()).value)).toEqual([]);
    unmountAll();
    mock.transcript = 'expanded';
    expect(owners((await thread()).value)).toEqual([[quiet]]);
  });

  it('shows the expanded thread loading before its history is read', async () => {
    mock.view = null;
    mock.transcript = 'expanded';
    expect(owners((await thread()).value)).toEqual([]);
  });
});
