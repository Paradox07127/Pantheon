import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoardSnapshot, BridgeResult, EventFrame } from '@pantheon/protocol';
import { deferred, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useFactsRead } from '@/data/facts-read';
import { useProjectQuery } from '@/data/project-read';
import { useProjectHead } from '@/data/runtime-models';
import { useSessionReviews } from '@/data/session-panel';
import { startSync, type DaemonEvent } from '@/data/sync';

const SNAPSHOT_KEY = 'pantheon.boardSnapshot.v1';
const board = (cursor: number): BoardSnapshot => ({
  cursor,
  projects: [],
  sessions: [],
  session_turns: [],
  workspaces: [],
});
const event = (sequence: number, kind: string, project_id = 'project-a'): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id: 'session-a',
  aggregate_revision: 1,
  project_id,
  causation_id: '',
  created_at: 0,
  payload: null,
});
const isFacts = (value: unknown) => value !== undefined;

let stored: Map<string, string>;
let reads: { method: string; answer: (result: BridgeResult<unknown>) => void }[];
let snapshotReads: number;
beforeEach(() => {
  vi.useFakeTimers();
  stored = new Map();
  snapshotReads = 0;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      if (key === SNAPSHOT_KEY) snapshotReads++;
      return stored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  reads = [];
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn((method: string) => {
        const answer = deferred<BridgeResult<unknown>>();
        reads.push({ method, answer: answer.resolve });
        return answer.promise;
      }),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  mock.board = {
    board: board(1),
    events: [],
    cursor: 1,
    changed: 1,
    status: { state: 'live' },
    resync: 0,
    trace_revision: 0,
  };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// A board sync whose board reads answer with the cursor `at` holds, and whose views feed the board hook.
function liveSync(at: { cursor: number }) {
  let push!: (frame: EventFrame) => void;
  const sync = startSync(
    {
      query: async () => ({ ok: true, value: board(at.cursor) }),
      subscribe: (_options, listener) => {
        push = listener;
        return () => {};
      },
    },
    {},
    (view) => {
      mock.board = view;
    },
  );
  return { sync, push: (frame: EventFrame) => push(frame) };
}

it('reads a stored-state query again after an event that changes the board, not after streamed text', async () => {
  const at = { cursor: 5 };
  const { sync, push } = liveSync(at);
  await vi.advanceTimersByTimeAsync(0);
  push({ type: 'subscribed', cursor: 5 });
  await vi.advanceTimersByTimeAsync(0);
  const h = mount(() =>
    useProjectQuery('workflow.policy', 'project-stream', isFacts, undefined, { events: true }),
  );
  await h.flush();
  expect(reads.map((r) => r.method)).toEqual(['workflow.policy']);
  reads[0]!.answer({ ok: true, value: {} });
  await h.flush();

  at.cursor = 6;
  push({ type: 'event', event: event(6, 'agent.message.delta', 'project-stream') });
  await vi.advanceTimersByTimeAsync(2_500);
  expect(mock.board.board.cursor).toBe(6);
  h.render();
  await h.flush();
  expect(reads.map((r) => r.method)).toEqual(['workflow.policy']);

  at.cursor = 7;
  push({ type: 'event', event: event(7, 'session.renamed', 'project-stream') });
  await vi.advanceTimersByTimeAsync(200);
  expect(mock.board.board.cursor).toBe(7);
  h.render();
  await h.flush();
  expect(reads.map((r) => r.method)).toEqual(['workflow.policy', 'workflow.policy']);
  sync.stop();
});

it('sends one read for two project queries of the same method and input', async () => {
  const first = mount(() => useProjectQuery('project.facts.read', 'project-shared', isFacts));
  const second = mount(() => useProjectQuery('project.facts.read', 'project-shared', isFacts));
  await first.flush();
  await second.flush();
  expect(reads).toHaveLength(1);
  reads[0]!.answer({ ok: true, value: { facts: ['one'] } });
  await first.flush();
  await second.flush();
  expect(first.value.read).toEqual({ facts: ['one'] });
  expect(second.value.read).toEqual({ facts: ['one'] });
});

it('does not join a read sent before the board changed', async () => {
  const first = mount(() => useProjectQuery('project.facts.read', 'project-moved', isFacts));
  await first.flush();
  mock.board = { ...mock.board, board: board(2), cursor: 2, changed: 2 };
  const second = mount(() => useProjectQuery('project.facts.read', 'project-moved', isFacts));
  await second.flush();
  expect(reads).toHaveLength(1);
  reads[0]!.answer({ ok: true, value: { facts: ['before'] } });
  await first.flush();
  await second.flush();
  expect(reads).toHaveLength(2);
  reads[1]!.answer({ ok: true, value: { facts: ['after'] } });
  await second.flush();
  expect(second.value.read).toEqual({ facts: ['after'] });
});

it('parses the stored boards once and keeps the other scopes when it stores its board', async () => {
  stored.set(SNAPSHOT_KEY, JSON.stringify({ 'project-other': board(3) }));
  const at = { cursor: 5 };
  const { sync, push } = liveSync(at);
  await vi.advanceTimersByTimeAsync(0);
  push({ type: 'subscribed', cursor: 5 });
  await vi.advanceTimersByTimeAsync(1_000);
  at.cursor = 6;
  push({ type: 'event', event: event(6, 'session.renamed') });
  await vi.advanceTimersByTimeAsync(1_200);
  sync.stop();
  expect(snapshotReads).toBe(1);
  const boards = JSON.parse(stored.get(SNAPSHOT_KEY)!);
  expect(Object.keys(boards).sort()).toEqual(['', 'project-other']);
  expect(boards[''].cursor).toBe(6);
});

// A live sync connected at cursor 5 with its board read applied.
async function connected() {
  const at = { cursor: 5 };
  const live = liveSync(at);
  await vi.advanceTimersByTimeAsync(0);
  live.push({ type: 'subscribed', cursor: 5 });
  await vi.advanceTimersByTimeAsync(0);
  return { at, ...live };
}

it('reads a project query once for a burst of events that one board read covers', async () => {
  const { at, sync, push } = await connected();
  const h = mount(() => useProjectQuery('project.facts.read', 'project-burst', isFacts));
  await h.flush();
  reads[0]!.answer({ ok: true, value: { facts: [] } });
  await h.flush();

  at.cursor = 8;
  for (const sequence of [6, 7, 8]) {
    push({ type: 'event', event: event(sequence, 'session.renamed', 'project-burst') });
    await vi.advanceTimersByTimeAsync(20);
    h.render();
    await h.flush();
  }
  await vi.advanceTimersByTimeAsync(200);
  expect(mock.board.board.cursor).toBe(8);
  h.render();
  await h.flush();
  expect(reads.map((r) => r.method)).toEqual(['project.facts.read', 'project.facts.read']);
  sync.stop();
});

it.each([
  ['after events that change the board', { events: true }],
  ['after board reads', undefined],
] as const)(
  'reads a project query %s only once its own project or every project is read',
  async (_, options) => {
    const { at, sync, push } = await connected();
    const a = mount(() =>
      useProjectQuery('workflow.policy', 'project-a', isFacts, undefined, options),
    );
    const b = mount(() =>
      useProjectQuery('workflow.policy', 'project-b', isFacts, undefined, options),
    );
    const step = async (sequence: number, project_id: string) => {
      at.cursor = sequence;
      push({ type: 'event', event: event(sequence, 'session.renamed', project_id) });
      await vi.advanceTimersByTimeAsync(200);
      a.render();
      b.render();
      await a.flush();
      await b.flush();
      for (const r of reads) r.answer({ ok: true, value: {} });
      await a.flush();
      await b.flush();
    };
    const asked = () =>
      vi
        .mocked(window.pantheon!.query)
        .mock.calls.map(([, params]) => (params as { project_id: string }).project_id);
    await a.flush();
    await b.flush();
    expect(asked()).toEqual(['project-a', 'project-b']);
    for (const r of reads) r.answer({ ok: true, value: {} });
    await a.flush();
    await b.flush();

    await step(6, 'project-b');
    expect(asked()).toEqual(['project-a', 'project-b', 'project-b']);
    await step(7, 'project-a');
    expect(asked()).toEqual(['project-a', 'project-b', 'project-b', 'project-a']);
    await step(8, '');
    expect(asked().slice(4).sort()).toEqual(['project-a', 'project-b']);
    sync.stop();
  },
);

it('reads again once the board lands after a remount joined a read sent before an event', async () => {
  const { at, sync, push } = await connected();
  const first = mount(() => useSessionReviews('session-remount'));
  await first.flush();
  expect(reads.map((r) => r.method)).toEqual(['session.reviews']);

  at.cursor = 6;
  push({ type: 'event', event: event(6, 'session.renamed') });
  await vi.advanceTimersByTimeAsync(0);
  first.unmount();
  const second = mount(() => useSessionReviews('session-remount'));
  await second.flush();
  expect(reads).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(200);
  expect(mock.board.board.cursor).toBe(6);
  second.render();
  await second.flush();
  expect(reads).toHaveLength(1);
  reads[0]!.answer({ ok: true, value: [] });
  await second.flush();
  expect(reads.map((r) => r.method)).toEqual(['session.reviews', 'session.reviews']);
  sync.stop();
});

const gitAnswer = { files: [], branch: 'main', sha: 'abc', subject: 'first' };
it.each([
  [
    'project.head',
    'workspace.repository_changed',
    gitAnswer,
    (project: string) => useProjectHead(project),
  ],
  [
    'project.facts.read',
    'project.facts_collected',
    { facts: null, workstreams: [] },
    (project: string) => useFactsRead(project),
  ],
])(
  'reads %s again after %s, not when unrelated events move the board',
  async (method, kind, value, read) => {
    const { at, sync, push } = await connected();
    const project = `project-${method}-${kind}`;
    const h = mount(() => read(project));
    await h.flush();
    expect(reads.map((r) => r.method)).toEqual([method]);
    reads[0]!.answer({ ok: true, value });
    await h.flush();

    at.cursor = 7;
    push({ type: 'event', event: event(6, 'agent.message.delta', project) });
    push({ type: 'event', event: event(7, 'session.renamed', project) });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(mock.board.board.cursor).toBe(7);
    h.render();
    await h.flush();
    expect(reads.map((r) => r.method)).toEqual([method]);

    at.cursor = 8;
    push({ type: 'event', event: event(8, kind, project) });
    await vi.advanceTimersByTimeAsync(200);
    h.render();
    await h.flush();
    expect(reads.map((r) => r.method)).toEqual([method, method]);
    sync.stop();
  },
);

it.each([['project.head', 1, (project: string) => useProjectHead(project)]])(
  'reads %s %i times when a tool call finishes',
  async (method, count, read) => {
    const { at, sync, push } = await connected();
    const project = `project-tool-${method}`;
    const h = mount(() => read(project));
    await h.flush();
    reads[0]!.answer({
      ok: true,
      value: { files: [], branch: 'main', sha: 'abc', subject: 'first' },
    });
    await h.flush();

    at.cursor = 6;
    push({ type: 'event', event: event(6, 'agent.tool.completed', project) });
    await vi.advanceTimersByTimeAsync(200);
    h.render();
    await h.flush();
    expect(reads.map((r) => r.method)).toEqual(Array(count).fill(method));
    sync.stop();
  },
);

it('asks the daemon again on reload once the read out answers instead of joining it', async () => {
  const first = mount(() => useProjectQuery('project.facts.read', 'project-reload', isFacts));
  const second = mount(() => useProjectQuery('project.facts.read', 'project-reload', isFacts));
  await first.flush();
  await second.flush();
  reads[0]!.answer({ ok: true, value: { facts: ['first'] } });
  await first.flush();
  await second.flush();

  first.value.reload();
  await first.flush();
  second.value.reload();
  await second.flush();
  expect(reads).toHaveLength(2);
  reads[1]!.answer({ ok: true, value: { facts: ['before'] } });
  await first.flush();
  await second.flush();
  expect(reads).toHaveLength(3);
  reads[2]!.answer({ ok: true, value: { facts: ['after'] } });
  await second.flush();
  expect(second.value.read).toEqual({ facts: ['after'] });
});

it('shows no answer of the previous input while a read of the new one is out or failed', async () => {
  let path = 'a';
  const h = mount(() => useProjectQuery('repo.blame', 'project-inputs', isFacts, { path }));
  await h.flush();
  reads[0]!.answer({ ok: true, value: { path: 'a' } });
  await h.flush();
  expect(h.value.read).toEqual({ path: 'a' });

  path = 'b';
  h.render();
  await h.flush();
  expect(reads).toHaveLength(2);
  expect(h.value.read).toBeNull();
  expect(h.value.loading).toBe(true);
  reads[1]!.answer({ ok: false, error: { code: 'git_failed', message: 'no such path' } });
  await h.flush();
  expect(h.value.read).toBeNull();
  expect(h.value.error).not.toBeNull();
});

it('sends one read for two queries of the same input when the board moves', async () => {
  const a = mount(() => useSessionReviews('session-twin'));
  const b = mount(() => useSessionReviews('session-twin'));
  await a.flush();
  await b.flush();
  expect(reads.map((r) => r.method)).toEqual(['session.reviews']);

  mock.board = { ...mock.board, board: board(2), cursor: 2, changed: 2 };
  a.render();
  b.render();
  await a.flush();
  await b.flush();
  reads[0]!.answer({ ok: true, value: [] });
  await a.flush();
  await b.flush();
  expect(reads.map((r) => r.method)).toEqual(['session.reviews', 'session.reviews']);
});
