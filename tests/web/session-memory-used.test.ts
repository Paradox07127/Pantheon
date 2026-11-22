import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Session, SessionTurn } from '@pantheon/domain';
import { type HookHost, mount as host, named, nodes, text, unmountAll } from './web-hook-host.js';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) =>
  (await import('./web-hook-host.js')).reactMock(actual, { layoutEffect: true }),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
}));
vi.mock('@/data/facts-read', async (actual) => ({
  ...(await actual<object>()),
  useFactsRead: () => ({ read: null, error: null, loading: false, reload() {} }),
}));
vi.mock('@/data/logs', async (actual) => ({
  ...(await actual<object>()),
  useEventHistory: () => ({ events: [], error: null, reload() {} }),
}));
import { buildTranscript } from '@/data/transcript';
import { useMemoryView } from '@/data/memory-view';
import { t } from '@/i18n';
import { MemoryDelivery, MemoryUsed } from '@/screens/sessions/MemoryUsed';
import { SessionHeader, ThreadTurn } from '@/screens/sessions/SessionsScreen';
import { Thread } from '@/screens/sessions/Thread';

let answers: Record<string, unknown>;
let asked: { method: string; params: Record<string, string> }[];
async function mount<T>(body: () => T) {
  const h = host(body);
  await h.flush();
  return h;
}

beforeEach(() => {
  answers = {};
  asked = [];
  mock.board = {
    board: { sessions: [], session_turns: [], projects: [], workspaces: [], cursor: 1 },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.shell = { setMemoryTab: vi.fn(), setScreen: vi.fn() };
  useMemoryView.getState().select(null);
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string, params: Record<string, string>) => {
        asked.push({ method, params });
        return { ok: true, value: answers[method] };
      }),
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

const entry = (id: string, kind: string, title: string, version?: number) => ({
  id,
  key: `key-${id}`,
  title,
  kind,
  state: 'active',
  ...(version !== undefined && { version }),
});

const rows = (tree: unknown) =>
  nodes(tree as any).filter((n) => n.type === 'button') as ReactElement<any>[];

const open = async (h: HookHost<any>) => {
  nodes(h.value)
    .find((n) => typeof n.props.onOpenChange === 'function')!
    .props.onOpenChange(true);
  await h.flush();
};

describe('memory used in a turn', () => {
  // The query cache outlives a test, so each test reads its own turn.
  it('folds to the count it is given and reads the entries only once opened', async () => {
    answers['memory.turn'] = {
      items: [
        entry('memory-a', 'decision', 'Verify callbacks on the raw body', 3),
        entry('memory-b', 'decision', 'Five minute timestamp tolerance', 1),
        entry('memory-c', 'note', 'Signature header format', 1),
      ],
    };
    const h = await mount(() =>
      MemoryUsed({ sessionId: 'session-a', turnId: 'turn-three', count: 3 }),
    );
    expect(asked).toEqual([]);
    const trigger = nodes(h.value).find((n) => n.props.className === 'ss-trow')!;
    expect(text(trigger)).toBe(
      t(
        {
          id: 'sessions.memory.used',
          defaultMessage: 'Used {count, plural, one {# memory} other {# memories}}',
        },
        { count: 3 },
      ),
    );
    expect(rows(h.value)).toEqual([]);
    await open(h);
    expect(asked).toEqual([
      { method: 'memory.turn', params: { session_id: 'session-a', turn_id: 'turn-three' } },
    ]);
    const listed = rows(h.value);
    const version = (n: number) =>
      t({ id: 'sessions.memory.version', defaultMessage: 'Version {n}' }, { n });
    expect(listed.map(text)).toEqual([
      `Verify callbacks on the raw body${version(3)}`,
      `Five minute timestamp tolerance${version(1)}`,
      `Signature header format${version(1)}`,
    ]);
    expect(listed.map((row) => nodes(row)[1]!.props['aria-label'])).toEqual(
      ['decision', 'decision', 'note'].map((kind) => zh(`memory.kind.${kind}`)),
    );
  });

  it('opens the memory entries with the clicked entry selected', async () => {
    answers['memory.turn'] = { items: [entry('memory-d', 'report', 'Load test results', 2)] };
    const h = await mount(() =>
      MemoryUsed({ sessionId: 'session-a', turnId: 'turn-open', count: 1 }),
    );
    await open(h);
    rows(h.value)[0]!.props.onClick();
    expect(mock.shell.setMemoryTab).toHaveBeenCalledWith('entries');
    expect(useMemoryView.getState().selectedId).toBe('memory-d');
    expect(mock.shell.setScreen).toHaveBeenCalledWith('memory');
  });

  const turn = (state: string) =>
    ({
      id: `turn-${state}`,
      project_id: 'project-a',
      session_id: 'session-a',
      revision: 1,
      created_at: 1,
      updated_at: 1,
      input: 'Check the callback signature',
      state,
    }) as unknown as SessionTurn;
  const threadTurn = (state: string, memoryCount?: number) =>
    mount(() =>
      ThreadTurn({
        view: buildTranscript([turn(state)], []).turns[0]!,
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set(),
        request: () => null,
        listed: null,
        ...(memoryCount !== undefined && { memoryCount }),
      }),
    );
  const hasLine = (tree: unknown) =>
    nodes(tree as any).some((n) => typeof n.type === 'function' && n.type.name === 'MemoryUsed');

  it('shows the memory line on a finished turn that used memory and none otherwise', async () => {
    expect(named((await threadTurn('completed', 2)).value, 'MemoryUsed').props).toEqual({
      sessionId: 'session-a',
      turnId: 'turn-completed',
      count: 2,
    });
    expect(hasLine((await threadTurn('completed', 0)).value)).toBe(false);
    expect(hasLine((await threadTurn('completed')).value)).toBe(false);
    expect(hasLine((await threadTurn('running', 2)).value)).toBe(false);
  });

  it('reads the counts once for the session and again when a turn ends', async () => {
    const session = {
      id: 'session-counts',
      revision: 1,
      project_id: 'project-a',
      runtime: 'claude',
      state: 'open',
      turn_count: 2,
    };
    const counted = (id: string, state: string) => ({
      ...turn(state),
      id,
      session_id: 'session-counts',
    });
    const board = (turns: unknown[]) => ({
      cursor: 1,
      projects: [],
      workspaces: [],
      sessions: [session],
      session_turns: turns,
    });
    mock.board.board = board([counted('turn-a', 'completed'), counted('turn-b', 'completed')]);
    answers['memory.session_turns'] = { turns: [{ turn_id: 'turn-a', count: 2 }] };
    const h = await mount(() =>
      Thread({
        board: mock.board.board,
        sessionId: 'session-counts',
        listed: null,
        needs: { items: [] } as any,
        parent: null,
        panels: [],
        onPanel() {},
        overview: false,
        onDiscarded() {},
      }),
    );
    const memoryReads = () => asked.filter((a) => a.method.startsWith('memory.'));
    const counts = () =>
      nodes(h.value)
        .filter((n) => 'view' in n.props && 'status' in n.props)
        .map((n) => n.props.memoryCount);
    expect(memoryReads()).toEqual([
      { method: 'memory.session_turns', params: { session_id: 'session-counts' } },
    ]);
    expect(counts()).toEqual([2, undefined]);
    h.render();
    await h.flush();
    expect(memoryReads()).toHaveLength(1);
    mock.board.board = board([
      counted('turn-a', 'completed'),
      counted('turn-b', 'completed'),
      counted('turn-c', 'completed'),
    ]);
    answers['memory.session_turns'] = {
      turns: [
        { turn_id: 'turn-a', count: 2 },
        { turn_id: 'turn-c', count: 1 },
      ],
    };
    h.render();
    await h.flush();
    expect(memoryReads()).toHaveLength(2);
    expect(counts()).toEqual([2, undefined, 1]);
  });
});

describe('memory delivery in the session header', () => {
  const directory = (delivery: { delivered: boolean; stale: boolean }, active = 2) => ({
    epoch: 1,
    records: [],
    signature: 's',
    total: active,
    index_pending: 0,
    facets: { tags: [] },
    budget: { used_bytes: 0, limit_bytes: 1 },
    counts: { active, draft: 0, archived: 0 },
    jobs: [],
    sessions: [
      { id: 'session-a', prepared: false, memory_tool: true, ...delivery },
      { id: 'session-b', delivered: false, prepared: false, memory_tool: true, stale: false },
    ],
    document_ready: false,
  });
  const chip = async (projectId: string) =>
    (await mount(() => MemoryDelivery({ projectId, sessionId: 'session-a' }))).value;

  it('marks a session that has the current memory as delivered', async () => {
    answers['memory.read'] = directory({ delivered: true, stale: false });
    const button = await chip('project-ok');
    expect(text(button)).toBe(zh('sessions.memory.delivered'));
    expect(nodes(button)[1]!.props['data-state']).toBe('ok');
    button!.props.onClick();
    expect(mock.shell.setMemoryTab).toHaveBeenCalledWith('entries');
    expect(mock.shell.setScreen).toHaveBeenCalledWith('memory');
  });

  it('marks a session whose memory changed since its last delivery as waiting', async () => {
    answers['memory.read'] = directory({ delivered: false, stale: true });
    const button = await chip('project-wait');
    expect(text(button)).toBe(zh('sessions.memory.stale'));
    expect(nodes(button)[1]!.props['data-state']).toBe('wait');
  });

  it('draws nothing in a project without memory', async () => {
    answers['memory.read'] = directory({ delivered: true, stale: false }, 0);
    expect(await chip('project-none')).toBeNull();
  });

  it('sits in the header of the session', async () => {
    const h = await mount(() =>
      SessionHeader({
        session: {
          id: 'session-a',
          revision: 1,
          project_id: 'project-a',
          runtime: 'claude',
          state: 'open',
          turn_count: 1,
        } as Session,
        listed: null,
        title: 'Callback signature',
        panels: [],
        onPanel() {},
        overview: false,
      }),
    );
    expect(named(h.value, 'MemoryDelivery').props).toEqual({
      projectId: 'project-a',
      sessionId: 'session-a',
    });
  });
});
