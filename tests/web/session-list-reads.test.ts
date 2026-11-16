import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeResult, WorkbenchSession } from '@pantheon/protocol';
import { deferred, type HookHost, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useSessionGates, useSessionPreflight } from '@/data/session-panel';
import type { DaemonEvent } from '@/data/sync';
import { listedSessions, useSessionList } from '@/data/workbench-sessions';

const listed = (id: string, state: WorkbenchSession['state']): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'fixture',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
});
const event = (
  sequence: number,
  kind: string,
  aggregate_id: string,
  project_id: string,
): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id,
  causation_id: '',
  created_at: 1_000 + sequence,
  payload: {},
});

let reads: { method: string; answer: (result: BridgeResult<unknown>) => void }[];
let listeners: Record<string, (() => void)[]>;
beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  listeners = {};
  mock.board = {
    board: { sessions: [], session_turns: [] },
    events: [],
    status: { state: 'live' },
    cursor: 0,
    resync: 0,
    trace_revision: 0,
  };
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn((method: string) => {
        const answer = deferred<BridgeResult<unknown>>();
        reads.push({ method, answer: answer.resolve });
        return answer.promise;
      }),
    },
    addEventListener: (type: string, listener: () => void) =>
      (listeners[type] ??= []).push(listener),
    removeEventListener: (type: string, listener: () => void) =>
      (listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener)),
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const sessionLists = () => reads.filter((r) => r.method === 'session.list');
const states = (h: HookHost<any>) =>
  h.value.data?.map((session: WorkbenchSession) => session.state);

async function settle(...hosts: HookHost<any>[]) {
  for (const h of hosts) h.render();
  for (const h of hosts) await h.flush();
}
async function focus(...hosts: HookHost<any>[]) {
  for (const listener of listeners.focus ?? []) listener();
  await settle(...hosts);
}
// Adds the event to the board and lets the debounced read go out.
async function deliver(e: DaemonEvent, ...hosts: HookHost<any>[]) {
  mock.board = { ...mock.board, events: [...mock.board.events, e] };
  await settle(...hosts);
  await vi.advanceTimersByTimeAsync(2_500);
  await settle(...hosts);
}

it('keeps the event read when a whole read sent before it lands after it', async () => {
  const h = mount(() => useSessionList('project-order'));
  await h.flush();
  reads[0]!.answer({ ok: true, value: [listed('session-a', 'running')] });
  await h.flush();

  await focus(h);
  await deliver(event(1, 'turn.completed', 'session-a', 'project-order'), h);
  expect(sessionLists()).toHaveLength(3);
  reads[2]!.answer({ ok: true, value: [listed('session-a', 'done')] });
  await h.flush();
  expect(states(h)).toEqual(['done']);
  reads[1]!.answer({ ok: true, value: [listed('session-a', 'running')] });
  await h.flush();
  expect(states(h)).toEqual(['done']);
});

it('stores the event read and clears the error of the whole read before it', async () => {
  const h = mount(() => useSessionList('project-store'));
  await h.flush();
  reads[0]!.answer({ ok: true, value: [listed('session-a', 'running')] });
  await h.flush();

  await focus(h);
  reads[1]!.answer({ ok: false, error: { code: 'internal', message: 'boom' } });
  await h.flush();
  expect(h.value.error).not.toBeNull();
  await deliver(event(1, 'turn.completed', 'session-a', 'project-store'), h);
  reads[2]!.answer({ ok: true, value: [listed('session-a', 'done')] });
  await h.flush();
  expect(states(h)).toEqual(['done']);
  expect(h.value.error).toBeNull();
  expect(listedSessions('project-store')?.map((session) => session.state)).toEqual(['done']);
});

it('sends one read for two lists of one project after one event', async () => {
  const a = mount(() => useSessionList('project-twin'));
  const b = mount(() => useSessionList('project-twin'));
  await settle(a, b);
  expect(sessionLists()).toHaveLength(1);
  reads[0]!.answer({ ok: true, value: [listed('session-a', 'running')] });
  await settle(a, b);

  await deliver(event(1, 'turn.completed', 'session-a', 'project-twin'), a, b);
  expect(sessionLists()).toHaveLength(2);
  reads[1]!.answer({ ok: true, value: [listed('session-a', 'done')] });
  await settle(a, b);
  expect(states(a)).toEqual(['done']);
  expect(states(b)).toEqual(['done']);
});

it("keeps a list's newer whole read in the cache when another list takes an older read they shared", async () => {
  const a = mount(() => useSessionList('project-shared-whole'));
  const b = mount(() => useSessionList('project-shared-whole'));
  await settle(a, b);
  expect(sessionLists()).toHaveLength(1);
  a.value.reload();
  await settle(a, b);
  expect(sessionLists()).toHaveLength(2);
  reads[1]!.answer({ ok: true, value: [listed('session-a', 'done')] });
  await settle(a, b);
  reads[0]!.answer({ ok: true, value: [listed('session-a', 'running')] });
  await settle(a, b);
  expect(listedSessions('project-shared-whole')?.map((session) => session.state)).toEqual(['done']);
});

it("keeps a list's newer whole read in the cache when another list takes an older event read they shared", async () => {
  const a = mount(() => useSessionList('project-shared-event'));
  const b = mount(() => useSessionList('project-shared-event'));
  await settle(a, b);
  reads[0]!.answer({ ok: true, value: [listed('session-a', 'running')] });
  await settle(a, b);
  await deliver(event(1, 'turn.completed', 'session-a', 'project-shared-event'), a, b);
  expect(sessionLists()).toHaveLength(2);
  a.value.reload();
  await settle(a, b);
  expect(sessionLists()).toHaveLength(3);
  reads[2]!.answer({ ok: true, value: [listed('session-a', 'done')] });
  await settle(a, b);
  reads[1]!.answer({ ok: true, value: [listed('session-a', 'waiting')] });
  await settle(a, b);
  expect(listedSessions('project-shared-event')?.map((session) => session.state)).toEqual(['done']);
});

it('reports the list stale after its read timed out twice', async () => {
  const h = mount(() => useSessionList('project-slow'));
  await h.flush();
  reads[0]!.answer({ ok: true, value: [listed('session-a', 'running')] });
  await h.flush();
  expect(h.value.stale).toBe(false);

  await focus(h);
  reads[1]!.answer({ ok: false, error: { code: 'query_timeout', message: 'slow' } });
  await h.flush();
  await vi.advanceTimersByTimeAsync(2_500);
  await h.flush();
  expect(sessionLists()).toHaveLength(3);
  reads[2]!.answer({ ok: false, error: { code: 'query_timeout', message: 'slow' } });
  await h.flush();
  expect(h.value).toMatchObject({ error: null, refreshing: false, stale: true });
});

it("reads a worker's gates and preflight again after its lead's plan changes", async () => {
  mock.board = {
    ...mock.board,
    board: {
      sessions: [{ id: 'session-worker', task: { lead_session_id: 'session-lead', id: 'task-1' } }],
      session_turns: [],
    },
  };
  const gates = mount(() => useSessionGates('session-worker'));
  const preflight = mount(() => useSessionPreflight('session-worker'));
  await settle(gates, preflight);
  expect(reads.map((r) => r.method).sort()).toEqual(['session.gates', 'session.preflight']);

  await deliver(event(1, 'board.plan_updated', 'session-lead', 'project-plan'), gates, preflight);
  expect(reads.map((r) => r.method).sort()).toEqual([
    'session.gates',
    'session.gates',
    'session.preflight',
    'session.preflight',
  ]);
});
