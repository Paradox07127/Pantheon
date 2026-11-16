import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { HookHost } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: { events: [] as unknown[], status: { state: 'live' }, resync: 0 },
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
import type { DaemonEvent } from '@/data/sync';
import {
  contextShare,
  eventSummary,
  mergeEvents,
  readEventHistory,
  useEventHistory,
} from '@/data/logs';

const event = (sequence: number, kind: string, payload: unknown = {}): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: `aggregate-${sequence}`,
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000 + sequence,
  payload,
});

describe('context share', () => {
  it('relates occupancy to the window without capping it', () => {
    expect(contextShare({ context_tokens: 84000, context_window: 200000 })).toEqual({
      used: 84000,
      window: 200000,
      ratio: 0.42,
    });
    expect(contextShare({ context_tokens: 210000, context_window: 200000 })?.ratio).toBe(1.05);
  });

  it('keeps occupancy without a window and nothing without occupancy', () => {
    expect(contextShare({ context_tokens: 84000 })).toEqual({
      used: 84000,
      window: null,
      ratio: null,
    });
    expect(contextShare({ input_tokens: 10, context_window: 200000 })).toBeNull();
  });
});

describe('summaries', () => {
  it('summarises the agent and delivery events', () => {
    expect(eventSummary(event(1, 'agent.message.delta', { text: 'a\n b' }))).toBe('a b');
    expect(
      eventSummary(
        event(2, 'agent.usage.updated', {
          input_tokens: 1200,
          cost_usd: 0.5,
          cost_source: 'reported',
        }),
      ),
    ).toBe('输入 1,200，输出 —，上下文 —，费用 $0.50（reported）');
    expect(
      eventSummary(
        event(5, 'agent.usage.updated', { context_tokens: 84000, context_window: 200000 }),
      ),
    ).toBe('输入 —，输出 —，上下文 42%，费用 —');
    expect(
      eventSummary(
        event(7, 'agent.usage.updated', { input_tokens: 109271, cached_input_tokens: 86400 }),
      ),
    ).toBe('输入 109,271（缓存 86,400），输出 —，上下文 —，费用 —');
    expect(eventSummary(event(6, 'agent.usage.updated', { context_tokens: 84000 }))).toBe(
      '输入 —，输出 —，上下文 84,000，费用 —',
    );
    expect(eventSummary(event(3, 'session.turn.delivery', { delivery: 'pending' }))).toBe(
      'pending',
    );
    expect(eventSummary(event(4, 'turn.failed', { error: 'adapter refused' }))).toBe(
      'adapter refused',
    );
  });

  it('names a started tool call with its key argument', () => {
    expect(
      eventSummary(
        event(1, 'agent.tool.started', { name: 'Bash', input: { command: 'git status' } }),
      ),
    ).toBe('工具 Bash，git status');
    expect(
      eventSummary(
        event(2, 'agent.tool.started', { name: 'mcp__pantheon__project_read', input: {} }),
      ),
    ).toBe('工具 pantheon, project_read');
    expect(eventSummary(event(3, 'agent.tool.started', {}))).toBe('工具 未知工具');
  });

  it('leaves an unknown kind without a summary instead of listing its payload fields', () => {
    expect(eventSummary(event(1, 'mystery.kind', { alpha: 1, beta: 2 }))).toBe('');
    expect(eventSummary(event(2, 'mystery.kind', {}))).toBe('');
  });
});

describe('live events', () => {
  it('does not repeat an event the stream delivers again after a reconnect', () => {
    const before = [event(1, 'turn.running'), event(2, 'turn.failed')];
    const after = [event(2, 'turn.failed'), event(3, 'turn.cancelled')];
    expect(mergeEvents(before, after).map((e) => e.sequence)).toEqual([1, 2, 3]);
  });
});

describe('history read', () => {
  const pages = (all: DaemonEvent[], cursor: number, limit: number) => {
    const calls: Record<string, string>[] = [];
    const query = async (
      _method: string,
      params?: Record<string, string>,
    ): Promise<BridgeResult<unknown>> => {
      calls.push(params ?? {});
      const after = Number(params?.after ?? 0);
      const events = all.filter((e) => e.sequence > after).slice(0, limit);
      return { ok: true, value: { events, cursor } };
    };
    return { calls, bridge: { query } };
  };

  it('reads page by page up to the cursor of the first page', async () => {
    const all = Array.from({ length: 7 }, (_, i) => event(i + 1, 'turn.running'));
    const { calls, bridge } = pages(all, 5, 2);
    const result = await readEventHistory(bridge, { project_id: 'project-a', after: 0 });
    expect(result).toEqual({ ok: true, value: { events: all.slice(0, 5), cursor: 5 } });
    expect(calls.map((c) => c.after)).toEqual(['0', '2', '4']);
    expect(calls.every((c) => c.project_id === 'project-a')).toBe(true);
  });

  it('keeps only the events the caller accepts', async () => {
    const all = [
      event(1, 'turn.running'),
      event(2, 'agent.message.delta'),
      event(3, 'turn.failed'),
    ];
    const { bridge } = pages(all, 3, 10);
    const result = await readEventHistory(bridge, {
      after: 0,
      keep: (e) => e.kind.startsWith('agent.'),
    });
    expect(result.ok && result.value.events.map((e) => e.sequence)).toEqual([2]);
  });

  describe('after missed events', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      mock.board = { events: [], status: { state: 'live' }, resync: 0 };
    });

    it('reads the history again from the start and replaces what it had', async () => {
      let all = [1, 2, 3].map((n) => event(n, 'turn.running'));
      const afters: string[] = [];
      vi.stubGlobal('window', {
        pantheon: {
          query: async (_method: string, params?: Record<string, string>) => {
            afters.push(params?.after ?? '');
            const after = Number(params?.after ?? 0);
            return {
              ok: true,
              value: { events: all.filter((e) => e.sequence > after), cursor: all.length },
            };
          },
        },
      });
      const h = new HookHost(() => useEventHistory({ key: 'logs', project_id: null, after: 0 }));
      h.render();
      await h.flush();
      expect(h.value.events?.map((e) => e.event_id)).toEqual(['event-1', 'event-2', 'event-3']);
      // The daemon restarted: its sequence starts over with other events.
      all = [{ ...event(1, 'turn.failed'), event_id: 'restarted-1' }];
      mock.board = { ...mock.board, resync: 1 };
      h.render();
      await h.flush();
      h.unmount();
      expect(afters).toEqual(['0', '0']);
      expect(h.value.events?.map((e) => e.event_id)).toEqual(['restarted-1']);
    });
  });

  it('passes the daemon error through', async () => {
    const bridge = {
      query: async (): Promise<BridgeResult<unknown>> => ({
        ok: false,
        error: { code: 'permission_denied', message: 'no' },
      }),
    };
    expect(await readEventHistory(bridge, { after: 0 })).toEqual({
      ok: false,
      error: { code: 'permission_denied', message: 'no' },
    });
  });
});

describe('history hook', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mock.board = { events: [], status: { state: 'live' }, resync: 0 };
  });

  const sequences = (events: DaemonEvent[] | null | undefined) => events?.map((e) => e.sequence);
  const history = (all: DaemonEvent[], cursor: number) => {
    const afters: string[] = [];
    const query = async (_method: string, params?: Record<string, string>) => {
      afters.push(params?.after ?? '');
      const after = Number(params?.after ?? 0);
      return { ok: true, value: { events: all.filter((e) => e.sequence > after), cursor } };
    };
    return { afters, query };
  };

  it('reads again when the stream comes back, not when it drops', async () => {
    const { afters, query } = history([event(1, 'turn.running')], 1);
    vi.stubGlobal('window', { pantheon: { query } });
    const h = new HookHost(() => useEventHistory({ key: 'logs', project_id: null, after: 0 }));
    h.render();
    await h.flush();
    mock.board = { ...mock.board, status: { state: 'offline' } };
    h.render();
    await h.flush();
    expect(afters).toEqual(['0']);
    mock.board = { ...mock.board, status: { state: 'live' } };
    h.render();
    await h.flush();
    h.unmount();
    expect(afters).toEqual(['0', '1']);
  });

  it('continues a key from its cursor after another key took its place', async () => {
    const project = history([event(1, 'turn.running'), event(2, 'turn.failed')], 2);
    vi.stubGlobal('window', {
      pantheon: {
        // The read for every project never answers.
        query: (method: string, params?: Record<string, string>) =>
          params?.project_id ? project.query(method, params) : new Promise(() => {}),
      },
    });
    mock.board = { ...mock.board, events: [event(3, 'turn.running')] };
    let options = { key: 'project-log', project_id: 'project-a' as string | null };
    const h = new HookHost(() => useEventHistory({ ...options, after: 0 }));
    h.render();
    await h.flush();
    expect(sequences(h.value.events)).toEqual([1, 2, 3]);
    options = { key: 'all-log', project_id: null };
    h.render();
    await h.flush();
    options = { key: 'project-log', project_id: 'project-a' };
    h.render();
    await h.flush();
    h.unmount();
    expect(project.afters).toEqual(['0', '2']);
    expect(sequences(h.value.events)).toEqual([1, 2, 3]);
  });

  it('keeps the live events newer than a history the daemon replaced during the read', async () => {
    let replaced = false;
    vi.stubGlobal('window', {
      pantheon: {
        query: async () => {
          if (replaced)
            return { ok: true, value: { events: [event(1, 'turn.running')], cursor: 1 } };
          replaced = true;
          return { ok: true, value: { events: [], cursor: 0, snapshot_required: true } };
        },
      },
    });
    mock.board = { ...mock.board, events: [event(2, 'turn.failed')] };
    const h = new HookHost(() => useEventHistory({ key: 'logs', project_id: null, after: 0 }));
    h.render();
    await h.flush();
    h.unmount();
    expect(sequences(h.value.events)).toEqual([1, 2]);
  });

  it('holds only the events the caller keeps', async () => {
    const { query } = history([event(1, 'turn.running'), event(2, 'agent.message.delta')], 2);
    vi.stubGlobal('window', { pantheon: { query } });
    mock.board = { ...mock.board, events: [event(3, 'agent.native')] };
    const h = new HookHost(() =>
      useEventHistory({
        key: 'turns',
        project_id: null,
        after: 0,
        keep: (e) => e.kind.startsWith('turn.'),
      }),
    );
    h.render();
    await h.flush();
    h.unmount();
    expect(sequences(h.value.events)).toEqual([1]);
    const held = h.slots.find(
      (slot): slot is { events: DaemonEvent[] } =>
        !!slot && typeof slot === 'object' && 'key' in slot && 'events' in slot,
    );
    expect(sequences(held?.events)).toEqual([1]);
  });
});

describe('history cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    mock.board = { events: [], status: { state: 'live' }, resync: 0 };
  });

  const sequences = (events: DaemonEvent[] | null | undefined) => events?.map((e) => e.sequence);
  const daemon = (project_id: string) => {
    const reads: Record<string, string>[] = [];
    const state = { all: [] as DaemonEvent[], replaced: false };
    const query = async (_method: string, params?: Record<string, string>) => {
      reads.push(params ?? {});
      const after = Number(params?.after ?? 0);
      const cursor = state.all.at(-1)?.sequence ?? 0;
      if (state.replaced && after > 0) {
        state.replaced = false;
        return { ok: true, value: { events: [], cursor, snapshot_required: true } };
      }
      return { ok: true, value: { events: state.all.filter((e) => e.sequence > after), cursor } };
    };
    const at = (n: number, kind = 'turn.running') => ({ ...event(n, kind), project_id });
    return { reads, state, query, at };
  };
  const visit = (project_id: string, keep?: (e: DaemonEvent) => boolean) =>
    new HookHost(() => useEventHistory({ key: project_id, project_id, after: 0, keep }));

  it('shows a revisited history at once and reads only what came after it', async () => {
    const d = daemon('project-revisited');
    d.state.all = [d.at(1), d.at(2)];
    vi.stubGlobal('window', { pantheon: { query: d.query } });
    const first = visit('project-revisited');
    first.render();
    await first.flush();
    first.unmount();
    d.state.all = [d.at(1), d.at(2), d.at(3)];
    const again = visit('project-revisited');
    expect(sequences(again.render().events)).toEqual([1, 2]);
    await again.flush();
    again.unmount();
    expect(sequences(again.value.events)).toEqual([1, 2, 3]);
    expect(d.reads).toEqual([
      { after: '0', limit: '2000', project_id: 'project-revisited' },
      { after: '2', limit: '2000', project_id: 'project-revisited' },
    ]);
  });

  it('gives each caller of a project what it keeps from the same history', async () => {
    const d = daemon('project-shared');
    d.state.all = [d.at(1), d.at(2, 'agent.message.delta')];
    vi.stubGlobal('window', { pantheon: { query: d.query } });
    const turns = visit('project-shared', (e) => e.kind.startsWith('turn.'));
    turns.render();
    await turns.flush();
    turns.unmount();
    const agent = visit('project-shared', (e) => e.kind.startsWith('agent.'));
    expect(sequences(agent.render().events)).toEqual([2]);
    await agent.flush();
    agent.unmount();
    expect(d.reads.map((r) => r.after)).toEqual(['0', '2']);
  });

  it('returns the same events while nothing new arrives', async () => {
    const d = daemon('project-steady');
    d.state.all = [d.at(1), d.at(2)];
    vi.stubGlobal('window', { pantheon: { query: d.query } });
    const h = visit('project-steady', (e) => e.sequence > 0);
    h.render();
    await h.flush();
    const shown = h.value.events;
    h.render();
    mock.board = { ...mock.board, status: { state: 'offline' } };
    h.render();
    mock.board = { ...mock.board, status: { state: 'live' } };
    h.render();
    await h.flush();
    h.unmount();
    expect(d.reads.map((r) => r.after)).toEqual(['0', '2']);
    expect(h.value.events).toBe(shown);
  });

  it('reads the history from the start when the daemon asks for a snapshot on a revisit', async () => {
    const d = daemon('project-replaced');
    d.state.all = [d.at(1), d.at(2)];
    vi.stubGlobal('window', { pantheon: { query: d.query } });
    const first = visit('project-replaced');
    first.render();
    await first.flush();
    first.unmount();
    d.state.all = [{ ...d.at(1, 'turn.failed'), event_id: 'restarted-1' }];
    d.state.replaced = true;
    const again = visit('project-replaced');
    again.render();
    await again.flush();
    again.unmount();
    expect(again.value.events?.map((e) => e.event_id)).toEqual(['restarted-1']);
    const third = visit('project-replaced');
    expect(third.render().events?.map((e) => e.event_id)).toEqual(['restarted-1']);
    await third.flush();
    third.unmount();
    expect(d.reads.map((r) => r.after)).toEqual(['0', '2', '0', '1']);
  });
});
