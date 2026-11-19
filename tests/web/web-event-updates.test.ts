import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BoardSnapshot, BridgeResult, EventFrame, WorkbenchSession } from '@pantheon/protocol';
import { type HookHost, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
}));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useBoardView } from '@/data/board-view';
import { useNeedsYou } from '@/data/needs-you';
import { TURN_END_HOLD_MS } from '@/data/notice-tiers';
import { useNotices } from '@/data/notifications';
import { useProjectQuery } from '@/data/project-read';
import { useSessionGates, useSessionPreflight } from '@/data/session-panel';
import { startSync, type DaemonEvent, type SyncView } from '@/data/sync';
import { buildTranscript, type SessionTurn } from '@/data/transcript';
import { useRepoWorkingDiff } from '@/data/repo-local';
import { useProjectHead } from '@/data/runtime-models';
import { useRunSpans, useSessionTrace, useTurnSteps } from '@/data/trace';
import {
  useRefetchTick,
  useSessionDiff,
  useSessionList,
  useTurnDiff,
} from '@/data/workbench-sessions';
import { useShell } from '@/store';

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'fixture',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const event = (
  sequence: number,
  kind: string,
  aggregate_id: string,
  payload: unknown = {},
): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: '',
  created_at: 1_000 + sequence,
  payload,
});
const turn = (id: string): SessionTurn => ({
  id,
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-a',
  input: `input of ${id}`,
  kind: 'send',
  delivery: 'delivered',
  state: 'running',
});

let reads: string[];
let answers: Record<string, unknown>;
let listeners: Record<string, (() => void)[]>;
// Delivers events through the board store and lets every debounce and read settle.
async function deliver(h: HookHost<any>, ...events: DaemonEvent[]) {
  mock.board = { ...mock.board, events: [...mock.board.events, ...events] };
  h.render();
  await vi.advanceTimersByTimeAsync(2_500);
  await h.flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  reads = [];
  answers = {
    'session.list': [listed('session-a'), listed('session-b')],
    'board.view': { tasks: [] },
  };
  mock.board = {
    board: { sessions: [], session_turns: [] },
    events: [],
    status: { state: 'live' },
    cursor: 0,
    resync: 0,
    trace_revision: 0,
  };
  listeners = {};
  vi.stubGlobal('window', {
    pantheon: {
      query: vi.fn(async (method: string) => {
        reads.push(method);
        return { ok: true, value: answers[method] };
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

it('does not read the session list again after an event no session owns', async () => {
  const h = mount(() => useSessionList('project-a'));
  await h.flush();
  expect(reads).toEqual(['session.list']);
  await deliver(h, event(1, 'project.board_updated', 'project-a'));
  await deliver(h, event(2, 'milestone.revised', 'milestone-1'));
  expect(reads).toEqual(['session.list']);
});

it('keeps the rows the new read did not change and takes the changed ones', async () => {
  answers['session.list'] = [listed('session-a'), listed('session-b'), listed('session-c')];
  const h = mount(() => useSessionList('project-a'));
  await h.flush();
  const before = h.value.data as WorkbenchSession[];
  answers['session.list'] = [
    listed('session-a', { title: 'renamed' }),
    listed('session-b', { title: 'changed elsewhere' }),
    listed('session-c'),
  ];
  await deliver(h, event(1, 'session.renamed', 'session-a', { title: 'renamed' }));
  expect(reads).toEqual(['session.list', 'session.list']);
  const after = h.value.data as WorkbenchSession[];
  expect(after.map((s) => s.title)).toEqual(['renamed', 'changed elsewhere', 'title of session-c']);
  expect(after[2]).toBe(before[2]);
});

it('shows a worktree edited outside the app once another session has an event', async () => {
  answers['session.list'] = [listed('session-a'), listed('session-b', { state: 'running' })];
  const h = mount(() => useSessionList('project-a'));
  await h.flush();
  answers['session.list'] = [
    listed('session-a', { state: 'ready', changes: { files: 1, additions: 3, deletions: 0 } }),
    listed('session-b', { state: 'running' }),
  ];
  await deliver(h, event(1, 'agent.tool.completed', 'session-b', { session_id: 'session-b' }));
  expect((h.value.data as WorkbenchSession[])[0]).toMatchObject({
    state: 'ready',
    changes: { files: 1, additions: 3, deletions: 0 },
  });
});

it('reads the session gates and the needs-you list again once the sync reports missed events', async () => {
  answers['session.gates'] = { configured: true, running: false };
  answers['needs_you.list'] = { items: [] };
  const gates = mount(() => useSessionGates('session-a'));
  const needs = mount(() => useNeedsYou('project-a'));
  await gates.flush();
  await needs.flush();
  expect([...reads].sort()).toEqual(['needs_you.list', 'session.gates']);
  mock.board = { ...mock.board, resync: 1 };
  gates.render();
  needs.render();
  await gates.flush();
  await needs.flush();
  expect([...reads].sort()).toEqual([
    'needs_you.list',
    'needs_you.list',
    'session.gates',
    'session.gates',
  ]);
});

it('reads the session gates again after the project gate commands change', async () => {
  answers['session.gates'] = { configured: false, running: false };
  const h = mount(() => useSessionGates('session-a'));
  await h.flush();
  await deliver(h, event(1, 'project.gate_set', 'project-a', { gate: { commands: [] } }));
  expect(reads).toEqual(['session.gates', 'session.gates']);
});

it('reads the merge preflight again after the session turn ends', async () => {
  answers['session.preflight'] = { can_merge: true, gate: { configured_total: 0, last: 'none' } };
  mock.board = {
    ...mock.board,
    board: { sessions: [], session_turns: [turn('turn-a')], workspaces: [] },
  };
  const h = mount(() => useSessionPreflight('session-a'));
  await h.flush();
  await deliver(h, event(1, 'turn.completed', 'turn-a'));
  expect(reads).toEqual(['session.preflight', 'session.preflight']);
});

it('reads the board view again when the window regains focus', async () => {
  const h = mount(() => useBoardView('project-a', 7));
  await h.flush();
  for (const listener of listeners.focus ?? []) listener();
  h.render();
  await h.flush();
  expect(reads).toEqual(['board.view', 'board.view']);
});

it('reads the merge preflight again when the window regains focus', async () => {
  answers['session.preflight'] = { can_merge: true, gate: { configured_total: 0, last: 'none' } };
  const h = mount(() => useSessionPreflight('session-a'));
  await h.flush();
  for (const listener of listeners.focus ?? []) listener();
  h.render();
  await h.flush();
  expect(reads).toEqual(['session.preflight', 'session.preflight']);
});

it('reads the whole session list again once the sync reports missed events', async () => {
  const h = mount(() => useSessionList('project-a'));
  await h.flush();
  answers['session.list'] = [
    listed('session-a', { state: 'running' }),
    listed('session-b', { state: 'running' }),
  ];
  mock.board = { ...mock.board, resync: 1 };
  h.render();
  await h.flush();
  expect(reads).toEqual(['session.list', 'session.list']);
  expect((h.value.data as WorkbenchSession[]).map((s) => s.state)).toEqual(['running', 'running']);
});

it('marks a skipped event sequence for one whole read and reads the board at once', async () => {
  const queries: string[] = [];
  const subs: ((frame: EventFrame) => void)[] = [];
  const views: SyncView[] = [];
  const boardAt = (cursor: number) => ({ cursor }) as BoardSnapshot;
  const bridge = {
    query: async (method: string): Promise<BridgeResult<unknown>> => {
      queries.push(method);
      return { ok: true, value: boardAt(5) };
    },
    subscribe: (_options: unknown, listener: (frame: EventFrame) => void) => {
      subs.push(listener);
      return () => {};
    },
  };
  const sync = startSync(bridge, {}, (view) => views.push(view));
  await vi.advanceTimersByTimeAsync(0);
  subs[0]!({ type: 'subscribed', cursor: 5 });
  subs[0]!({ type: 'event', event: event(6, 'agent.message.delta', 'session-a') });
  await vi.advanceTimersByTimeAsync(0);
  expect(views.at(-1)!.resync).toBe(0);
  subs[0]!({ type: 'event', event: event(9, 'agent.message.delta', 'session-a') });
  await vi.advanceTimersByTimeAsync(0);
  expect(views.at(-1)!.resync).toBe(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(queries).toEqual(['board', 'board']);
  sync.stop();
});

it('reads the board view again only after events that change what it shows', async () => {
  const h = mount(() => useBoardView('project-a', 7));
  await h.flush();
  expect(reads).toEqual(['board.view']);
  await deliver(h, event(2, 'agent.message.delta', 'session-a', { text: 'x' }));
  expect(reads).toEqual(['board.view']);
  await deliver(h, event(3, 'session.merged', 'session-a'));
  expect(reads).toEqual(['board.view', 'board.view']);
  await deliver(h, event(4, 'review.finding_recorded', 'review-1'));
  expect(reads).toEqual(['board.view', 'board.view', 'board.view']);
});

it('reads the board view again after a tool starts, a task is accepted or asked to start, and a lead note', async () => {
  const h = mount(() => useBoardView('project-a', 7));
  await h.flush();
  const kinds = ['agent.tool.started', 'task.accepted', 'task.start_requested', 'lead.note_added'];
  for (const [i, kind] of kinds.entries()) await deliver(h, event(i + 1, kind, 'aggregate-x'));
  expect(reads).toEqual(Array(kinds.length + 1).fill('board.view'));
});

it('refreshes the health of a silent running task and stops once its turn ends', async () => {
  answers['board.view'] = {
    tasks: [{ id: 'task-a', turn_running: true, activity: { health: 'fresh' } }],
  };
  const h = mount(() => useBoardView('project-a', 7));
  await h.flush();
  answers['board.view'] = {
    tasks: [{ id: 'task-a', turn_running: true, activity: { health: 'quiet' } }],
  };
  await vi.advanceTimersByTimeAsync(30_000);
  await h.flush();
  expect(reads).toEqual(['board.view', 'board.view']);
  expect(h.value.data?.tasks[0]?.activity?.health).toBe('quiet');
  answers['board.view'] = { tasks: [{ id: 'task-a', turn_running: false }] };
  await deliver(h, event(1, 'turn.completed', 'turn-a'));
  const afterEnd = reads.length;
  await vi.advanceTimersByTimeAsync(60_000);
  await h.flush();
  expect(reads).toHaveLength(afterEnd);
});

it('pauses running-board refreshes while disconnected', async () => {
  answers['board.view'] = { tasks: [], leads: [{ state: 'running' }] };
  const h = mount(() => useBoardView('project-a', 7));
  await h.flush();
  mock.board = { ...mock.board, status: { state: 'offline', reason: 'gone' } };
  h.render();
  await vi.advanceTimersByTimeAsync(60_000);
  await h.flush();
  expect(reads).toEqual(['board.view']);
});

it('recovers a silent running board after one periodic read fails', async () => {
  answers['board.view'] = { tasks: [{ turn_running: true }] };
  const h = mount(() => useBoardView('project-a', 7));
  await h.flush();
  answers['board.view'] = undefined;
  await vi.advanceTimersByTimeAsync(30_000);
  await h.flush();
  expect(h.value.error).not.toBeNull();
  answers['board.view'] = { tasks: [{ turn_running: false }] };
  await vi.advanceTimersByTimeAsync(30_000);
  await h.flush();
  expect(reads).toEqual(Array(3).fill('board.view'));
  expect(h.value.error).toBeNull();
});

it('reads the session and turn diffs again after one of its turns ends', async () => {
  answers['session.diff'] = { files: [], truncated: false };
  answers['session.turn_diff'] = { files: [], truncated: false };
  mock.board = {
    ...mock.board,
    board: { sessions: [], session_turns: [turn('turn-a')], workspaces: [] },
  };
  const diff = mount(() => useSessionDiff('session-a'));
  const turnDiff = mount(() => useTurnDiff('session-a', 'turn-a'));
  await diff.flush();
  await turnDiff.flush();
  mock.board = { ...mock.board, events: [event(1, 'turn.completed', 'turn-a')] };
  diff.render();
  turnDiff.render();
  await vi.advanceTimersByTimeAsync(2_500);
  await diff.flush();
  await turnDiff.flush();
  expect([...reads].sort()).toEqual([
    'session.diff',
    'session.diff',
    'session.turn_diff',
    'session.turn_diff',
  ]);
});

it('reads the session diff again once a new board lists the turn of an earlier event', async () => {
  answers['session.diff'] = { files: [], truncated: false };
  const h = mount(() => useSessionDiff('session-a'));
  await h.flush();
  await deliver(h, event(1, 'turn.completed', 'turn-a'));
  expect(reads).toEqual(['session.diff']);
  mock.board = {
    ...mock.board,
    board: { sessions: [], session_turns: [turn('turn-a')], workspaces: [] },
  };
  h.render();
  await vi.advanceTimersByTimeAsync(2_500);
  await h.flush();
  expect(reads).toEqual(['session.diff', 'session.diff']);
});

it('follows the newest event of the session after the oldest events are trimmed', async () => {
  answers['session.diff'] = { files: [], truncated: false };
  const h = mount(() => useSessionDiff('session-a'));
  await h.flush();
  const own = event(2, 'session.renamed', 'session-a');
  const other = event(3, 'session.renamed', 'session-b');
  await deliver(h, event(1, 'session.renamed', 'session-b'), own, other);
  expect(reads).toEqual(['session.diff', 'session.diff']);
  mock.board = { ...mock.board, events: [own, other, event(4, 'session.renamed', 'session-b')] };
  h.render();
  await vi.advanceTimersByTimeAsync(2_500);
  await h.flush();
  expect(reads).toEqual(['session.diff', 'session.diff']);
  await deliver(h, event(5, 'session.renamed', 'session-a'));
  expect(reads).toEqual(['session.diff', 'session.diff', 'session.diff']);
});

it('reads nothing when the event stream drops and reads again once it is back', async () => {
  answers['session.diff'] = { files: [], truncated: false };
  const h = mount(() => useSessionDiff('session-a'));
  await h.flush();
  mock.board = { ...mock.board, status: { state: 'offline', reason: 'gone' } };
  h.render();
  await h.flush();
  expect(reads).toEqual(['session.diff']);
  expect(h.value.data).toEqual({ files: [], truncated: false });
  mock.board = { ...mock.board, status: { state: 'live' } };
  h.render();
  await h.flush();
  expect(reads).toEqual(['session.diff', 'session.diff']);
});

it('reads the whole session list again after a baseline is confirmed or the gate commands change', async () => {
  const h = mount(() => useSessionList('project-a'));
  await h.flush();
  await deliver(h, event(1, 'project.baseline_confirmed', 'project-a'));
  expect(reads).toEqual(['session.list', 'session.list']);
  await deliver(h, event(2, 'project.gate_set', 'project-a', { commands: [] }));
  expect(reads).toEqual(['session.list', 'session.list', 'session.list']);
});

it('reads the diffs, the session list, the project head and the local changes again when the window regains focus', async () => {
  answers['session.diff'] = { files: [], truncated: false };
  answers['session.turn_diff'] = { files: [], truncated: false };
  answers['project.head'] = { branch: 'main', sha: 'abc', subject: 'first' };
  answers['repo.working_diff'] = { files: [] };
  mock.board = { ...mock.board, board: { cursor: 0, sessions: [], session_turns: [] } };
  const views = [
    mount(() => useSessionDiff('session-a')),
    mount(() => useTurnDiff('session-a', 'turn-a')),
    mount(() => useSessionList('project-a')),
    mount(() => useProjectHead('project-a')),
    mount(() => useRepoWorkingDiff('project-a')),
  ];
  for (const h of views) await h.flush();
  const before = [...reads].sort();
  expect(before).toEqual([
    'project.head',
    'repo.working_diff',
    'session.diff',
    'session.list',
    'session.turn_diff',
  ]);
  for (const listener of listeners.focus ?? []) listener();
  for (const h of views) {
    h.render();
    await h.flush();
  }
  expect([...reads].sort()).toEqual(before.flatMap((method) => [method, method]));
});

it('keeps reading again while events arrive faster than the refresh delay', async () => {
  let sequence = 0;
  const h = mount(() => useRefetchTick(sequence, false));
  for (let elapsed = 0; elapsed < 2_000; elapsed += 50) {
    sequence++;
    h.render();
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(h.render()).toBeGreaterThanOrEqual(3);
});

/** Runs every effect's cleanup and then the effects again, as StrictMode does on mount. */
function remountEffects<T>(h: HookHost<T>) {
  h.unmount();
  for (const slot of h.slots)
    if (slot && typeof slot === 'object' && 'deps' in slot && !('value' in slot))
      Object.assign(slot, { deps: undefined, cleanup: undefined });
  h.render();
}

it('keeps reading after StrictMode cleans up the mount effects and runs them again', async () => {
  let sequence = 1;
  const h = mount(() => useRefetchTick(sequence, false));
  remountEffects(h);
  await vi.advanceTimersByTimeAsync(2_500);
  expect(h.render()).toBe(0);
  sequence = 2;
  h.render();
  await vi.advanceTimersByTimeAsync(2_500);
  expect(h.render()).toBe(1);
});

it('appends new session events to the transcript without rebuilding earlier turns', () => {
  const turns = [turn('turn-1'), turn('turn-2')];
  const first = [
    event(1, 'turn.queued', 'turn-1'),
    event(2, 'agent.tool.started', 'session-a', { turn_id: 'turn-1', tool_call_id: 'call-1' }),
    event(3, 'agent.message.delta', 'session-a', { turn_id: 'turn-2', text: 'Hel' }),
  ];
  const before = buildTranscript(turns, first);
  const more = [
    ...first,
    event(4, 'agent.message.delta', 'session-a', { turn_id: 'turn-2', text: 'lo' }),
  ];
  const after = buildTranscript(turns, more);
  expect(after.turns[0]).toBe(before.turns[0]);
  expect(after.turns[1]!.text).toBe('Hello');
  expect(before.turns[1]!.text).toBe('Hel');
  expect(after).toEqual(
    buildTranscript(
      turns,
      more.map((e) => ({ ...e })),
    ),
  );
});

it("never shows the previous project's needs-you items after switching projects", async () => {
  answers['needs_you.list'] = { items: [{ id: 'item-of-a' }] };
  let project = 'project-a';
  const h = mount(() => useNeedsYou(project));
  await h.flush();
  expect(h.value.items).toEqual([{ id: 'item-of-a' }]);
  project = 'project-b';
  h.render();
  expect(h.value).toMatchObject({ items: null, loading: true });
});

it('drops a session the new read no longer lists after another session has an event', async () => {
  answers['session.list'] = [listed('session-a'), listed('session-b'), listed('session-c')];
  const h = mount(() => useSessionList('project-a'));
  await h.flush();
  answers['session.list'] = [listed('session-a', { title: 'renamed' }), listed('session-b')];
  await deliver(h, event(1, 'session.renamed', 'session-a', { title: 'renamed' }));
  expect((h.value.data as WorkbenchSession[]).map((s) => s.id)).toEqual(['session-a', 'session-b']);
});

it('reads the session list during a long burst of session events', async () => {
  const h = mount(() => useSessionList('project-a'));
  await h.flush();
  for (let sequence = 1; sequence <= 40; sequence++) {
    mock.board = {
      ...mock.board,
      events: [
        ...mock.board.events,
        event(sequence, 'agent.tool.completed', 'session-a', { session_id: 'session-a' }),
      ],
    };
    h.render();
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(reads.length).toBeGreaterThanOrEqual(4);
});

/** Makes every query wait until the test answers it, in any order. */
function holdQueries() {
  const pending: ((result: BridgeResult<unknown>) => void)[] = [];
  (window as any).pantheon.query = vi.fn((method: string) => {
    reads.push(method);
    return new Promise<BridgeResult<unknown>>((resolve) => pending.push(resolve));
  });
  return pending;
}

it('reads the session diff again after an event only once the read out answered', async () => {
  const pending = holdQueries();
  const h = mount(() => useSessionDiff('session-a'));
  await h.flush();
  await deliver(h, event(1, 'session.renamed', 'session-a'));
  expect(reads).toEqual(['session.diff']);
  pending[0]!({ ok: true, value: { files: [], truncated: false } });
  await h.flush();
  expect(h.value).toMatchObject({ data: { truncated: false }, loading: false });
  await vi.advanceTimersByTimeAsync(500);
  await h.flush();
  expect(reads).toEqual(['session.diff', 'session.diff']);
  expect(h.value).toMatchObject({ data: { truncated: false }, refreshing: true });
  pending[1]!({ ok: true, value: { files: [], truncated: true } });
  await h.flush();
  expect(h.value).toMatchObject({ data: { truncated: true }, loading: false });
});

it('counts the gap between two session diff reads from when the first one answered', async () => {
  const start = Date.now();
  const sent: number[] = [];
  (window as any).pantheon.query = vi.fn((method: string) => {
    reads.push(method);
    sent.push(Date.now() - start);
    return new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, value: { files: [], truncated: false } }), 1_000),
    );
  });
  const h = mount(() => useSessionDiff('session-gap'));
  await h.flush();
  mock.board = { ...mock.board, events: [event(1, 'session.renamed', 'session-gap')] };
  h.render();
  for (let elapsed = 50; elapsed <= 4_000; elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
    if (elapsed === 2_600)
      mock.board = {
        ...mock.board,
        events: [...mock.board.events, event(2, 'session.renamed', 'session-gap')],
      };
    h.render();
    await h.flush();
  }
  expect(sent).toEqual([0, 1_500, 3_000]);
});

it('reads the project head again after a repository event, once the read out answered', async () => {
  const pending = holdQueries();
  mock.board = {
    ...mock.board,
    board: { cursor: 1, sessions: [], session_turns: [] },
    changed: 1,
  };
  const h = mount(() => useProjectHead('project-a'));
  await h.flush();
  mock.board = {
    ...mock.board,
    board: { ...mock.board.board, cursor: 2 },
    changed: 2,
    events: [event(2, 'session.merged', 'session-a')],
  };
  h.render();
  await h.flush();
  expect(reads).toEqual(['project.head']);
  pending[0]!({ ok: true, value: { branch: 'main', sha: 'abc', subject: 'first' } });
  await h.flush();
  expect(h.value.read).toEqual({ branch: 'main', sha: 'abc', subject: 'first' });
  expect(reads).toEqual(['project.head', 'project.head']);
});

it('is not loading the project head while no project is open', async () => {
  mock.board = { ...mock.board, board: { cursor: 1, sessions: [], session_turns: [] } };
  const h = mount(() => useProjectHead(null));
  await h.flush();
  expect(h.value).toMatchObject({ read: null, loading: false });
  expect(reads).toEqual([]);
});

it('tells a failed run span read apart from one still running', async () => {
  const h = mount(() => useRunSpans('project-a', ['session-a']));
  await h.flush();
  expect(h.value.has('session-a')).toBe(false);
  expect([...h.value.failed]).toEqual(['session-a']);
  expect(h.value.loading).toBe(false);
  expect(h.value.stale).toBe(false);
  answers['session.trace'] = { spans: [] };
  h.value.reload();
  h.render();
  await h.flush();
  expect(h.value.get('session-a')).toEqual([]);
  expect([...h.value.failed]).toEqual([]);
  expect(h.value.readAt.get('session-a')).toBeTypeOf('number');
});

it('keeps trace evidence with its original timestamp after a failed refresh and clears staleness on retry', async () => {
  answers['session.trace'] = { spans: [{ id: 'recorded-call' }] };
  const h = mount(() => useRunSpans('project-a', ['session-a']));
  await h.flush();
  const at = h.value.readAt.get('session-a');
  answers['session.trace'] = undefined;
  h.value.reload();
  h.render();
  await h.flush();
  expect(h.value.get('session-a')).toEqual([{ id: 'recorded-call' }]);
  expect(h.value).toMatchObject({ loading: false, stale: true });
  expect(h.value.readAt.get('session-a')).toBe(at);
  answers['session.trace'] = { spans: [] };
  h.value.reload();
  h.render();
  await h.flush();
  expect(h.value.stale).toBe(false);
  expect([...h.value.failed]).toEqual([]);
});

it('marks kept run spans stale after a failed read, not while a fresher read is in flight', async () => {
  answers['session.trace'] = { spans: [{ id: 'recorded-call' }] };
  const h = mount(() => useRunSpans('project-a', ['session-a']));
  await h.flush();
  h.value.reload();
  h.render();
  h.render();
  expect(h.value).toMatchObject({ loading: true, stale: false });
  answers['session.trace'] = undefined;
  await h.flush();
  h.value.reload();
  h.render();
  await h.flush();
  h.value.reload();
  h.render();
  h.render();
  expect(h.value).toMatchObject({ loading: true, stale: true });
});

it('does not mark a live board stale while a fresher read is in flight', async () => {
  const h = mount(() => useBoardView('project-a', 7));
  await h.flush();
  h.value.reload();
  h.render();
  expect(h.value).toMatchObject({ loading: false, refreshing: true });
  expect(h.value.stale).toBe(false);
  await h.flush();
  expect(h.value).toMatchObject({ loading: false, stale: false });
});

it('retains a failed board read as stale, marks disconnection immediately, and never shows it in another project', async () => {
  let project = 'project-a';
  const h = mount(() => useBoardView(project, 7));
  await h.flush();
  const model = h.value.data;
  const at = h.value.readAt;
  answers['board.view'] = undefined;
  h.value.reload();
  h.render();
  await h.flush();
  expect(h.value).toMatchObject({ data: model, readAt: at, stale: true, loading: false });
  expect(h.value.error).toBeTruthy();
  answers['board.view'] = { tasks: [] };
  h.value.reload();
  h.render();
  await h.flush();
  expect(h.value.stale).toBe(false);
  mock.board = { ...mock.board, status: { state: 'offline' } };
  h.render();
  expect(h.value.stale).toBe(true);
  project = 'project-b';
  h.render();
  expect(h.value.data).toBeNull();
});

it('ignores a trace response from a scope that was replaced and then reopened', async () => {
  const pending: ((value: unknown) => void)[] = [];
  window.pantheon!.query = vi.fn(() => new Promise((resolve) => pending.push(resolve))) as any;
  let project = 'project-a';
  const h = mount(() => useRunSpans(project, ['session-a']));
  project = 'project-b';
  h.render();
  project = 'project-a';
  h.render();
  pending[0]!({ ok: true, value: { spans: [{ id: 'obsolete' }] } });
  await h.flush();
  expect(h.value.has('session-a')).toBe(false);
  pending[2]!({ ok: true, value: { spans: [] } });
  await h.flush();
  expect(h.value.get('session-a')).toEqual([]);
});

it('reads the session traces again after a tool of the project ends', async () => {
  answers['session.trace'] = { spans: [] };
  const views = [
    mount(() => useRunSpans('project-a', ['session-a'])),
    mount(() => useSessionTrace('project-a', 'session-a')),
    mount(() => useTurnSteps('project-a', 'session-a', 'turn-a')),
  ];
  for (const h of views) await h.flush();
  expect(reads).toEqual(Array(3).fill('session.trace'));
  mock.board = {
    ...mock.board,
    events: [event(1, 'agent.tool.completed', 'session-a', { session_id: 'session-a' })],
  };
  for (const h of views) h.render();
  await vi.advanceTimersByTimeAsync(2_500);
  for (const h of views) await h.flush();
  expect(reads).toEqual(Array(6).fill('session.trace'));
});

it('reads the session gates again after one of its turns ends', async () => {
  answers['session.gates'] = { configured: true, running: false };
  mock.board = {
    ...mock.board,
    board: { sessions: [], session_turns: [turn('turn-a')], workspaces: [] },
  };
  const h = mount(() => useSessionGates('session-a'));
  await h.flush();
  await deliver(h, event(1, 'turn.completed', 'turn-a'));
  expect(reads).toEqual(['session.gates', 'session.gates']);
});

it('shows a slow needs-you read that a later read overtook in time', async () => {
  const pending = holdQueries();
  const h = mount(() => useNeedsYou('project-a'));
  await h.flush();
  await deliver(h, event(1, 'approval.requested', 'approval-1'));
  expect(reads).toEqual(['needs_you.list', 'needs_you.list']);
  pending[0]!({ ok: true, value: { items: [{ id: 'first' }] } });
  await h.flush();
  expect(h.value).toMatchObject({ items: [{ id: 'first' }], loading: false });
  pending[1]!({ ok: true, value: { items: [{ id: 'second' }] } });
  await h.flush();
  expect(h.value).toMatchObject({ items: [{ id: 'second' }], loading: false });
});

it('reads no needs-you list when the event stream drops and reads it once the stream is back', async () => {
  answers['needs_you.list'] = { items: [] };
  const h = mount(() => useNeedsYou('project-a'));
  await h.flush();
  mock.board = { ...mock.board, status: { state: 'offline', reason: 'gone' } };
  h.render();
  await h.flush();
  expect(reads).toEqual(['needs_you.list']);
  mock.board = { ...mock.board, status: { state: 'live' } };
  h.render();
  await h.flush();
  expect(reads).toEqual(['needs_you.list', 'needs_you.list']);
});

it('reads a failed project query again once the event stream is back or the sync resyncs', async () => {
  mock.board = { ...mock.board, board: { cursor: 1, sessions: [], session_turns: [] } };
  const h = mount(() =>
    useProjectQuery<{ facts: string[] }>('project.facts.read', 'project-a', (v) => v !== undefined),
  );
  await h.flush();
  expect(h.value.error).not.toBeNull();
  answers['project.facts.read'] = { facts: [] };
  mock.board = { ...mock.board, status: { state: 'offline', reason: 'gone' } };
  h.render();
  await h.flush();
  expect(reads).toEqual(['project.facts.read']);
  mock.board = { ...mock.board, status: { state: 'live' } };
  h.render();
  await h.flush();
  expect(reads).toEqual(['project.facts.read', 'project.facts.read']);
  expect(h.value).toMatchObject({ read: { facts: [] }, error: null });
  mock.board = { ...mock.board, resync: 1 };
  h.render();
  await h.flush();
  expect(reads).toEqual(Array(3).fill('project.facts.read'));
});

it('reads failed run spans again once the event stream is back', async () => {
  const h = mount(() => useRunSpans('project-a', ['session-a']));
  await h.flush();
  expect([...h.value.failed]).toEqual(['session-a']);
  answers['session.trace'] = { spans: [] };
  mock.board = { ...mock.board, status: { state: 'offline', reason: 'gone' } };
  h.render();
  await h.flush();
  mock.board = { ...mock.board, status: { state: 'live' } };
  h.render();
  await h.flush();
  expect(reads).toEqual(['session.trace', 'session.trace']);
  expect(h.value.get('session-a')).toEqual([]);
});

it('gives the turn-end notice of the session the sessions screen follows only while the app is in the background', async () => {
  const notify = vi.fn(async () => {});
  Object.assign((window as any).pantheon, { notify, onNotificationClick: () => () => {} });
  let focused = false;
  vi.stubGlobal('document', { hasFocus: () => focused });
  useShell.setState({ screen: 'sessions', sessionId: null, followed: 'session-a' });
  mock.board = {
    ...mock.board,
    board: {
      cursor: 0,
      projects: [{ id: 'project-a', name: 'Alpha' }],
      sessions: [],
      session_turns: [turn('turn-a'), { ...turn('turn-b'), session_id: 'session-b' }],
    },
  };
  const sessions = [listed('session-a', { state: 'running' }), listed('session-b')];
  const h = mount(() => useNotices('project-a', sessions));
  await h.flush();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  mock.board = { ...mock.board, events: [event(1, 'turn.completed', 'turn-a')] };
  h.render();
  vi.advanceTimersByTime(TURN_END_HOLD_MS);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({ target: { project_id: 'project-a', session_id: 'session-a' } }),
  );
  focused = true;
  mock.board = {
    ...mock.board,
    events: [...mock.board.events, event(2, 'turn.completed', 'turn-a')],
  };
  h.render();
  vi.advanceTimersByTime(TURN_END_HOLD_MS);
  expect(notify).toHaveBeenCalledTimes(1);
});
