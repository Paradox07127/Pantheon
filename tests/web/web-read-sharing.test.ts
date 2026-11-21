import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
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
import { useDevices } from '@/data/devices';
import { useRuntimeStatus } from '@/data/runtime-status';
import { useSessionDiff } from '@/data/workbench-sessions';

const values: Record<string, unknown> = {
  'runtime.status': [{ runtime: 'claude', enabled: true, installed: true, auth: { state: 'ok' } }],
  'device.list': [
    { id: 'local', name: 'workstation', online: true, load: { active_sessions: [] } },
  ],
  'session.diff': { files: [], truncated: false },
};

let reads: { method: string; params: Record<string, string> }[];
let held: ReturnType<typeof deferred<void>>[];

beforeEach(() => {
  reads = [];
  held = [];
  mock.board = {
    board: { sessions: [], session_turns: [] },
    events: [],
    status: { state: 'live' },
    cursor: 0,
    resync: 0,
  };
  vi.stubGlobal('window', {
    pantheon: {
      // Every answer waits until the test lets the reads out answer.
      query: vi.fn(async (method: string, params: Record<string, string>) => {
        reads.push({ method, params });
        const gate = deferred<void>();
        held.push(gate);
        await gate.promise;
        return { ok: true, value: values[method] } as BridgeResult<unknown>;
      }),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
});
afterEach(() => {
  for (const gate of held) gate.resolve();
  unmountAll();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Lets the reads asked so far reach the bridge, answers them and lets the answers land.
async function answer(...hosts: { flush: () => Promise<unknown> }[]) {
  for (const h of hosts) await h.flush();
  for (const gate of held.splice(0)) gate.resolve();
  for (const h of hosts) await h.flush();
  for (const h of hosts) await h.flush();
}

const readers: [string, () => boolean][] = [
  ['runtime.status', () => useRuntimeStatus().read.state === 'ready'],
  ['device.list', () => useDevices().read.state === 'ready'],
];

it.each(readers)(
  'sends one %s read for the readers that mount while it is out',
  async (method, read) => {
    const first = mount(read);
    const second = mount(read);
    await answer(first, second);
    expect(reads.filter((r) => r.method === method)).toHaveLength(1);
    expect([first.value, second.value]).toEqual([true, true]);
  },
);

it.each(readers)(
  'sends %s again for a reader that mounts after the read answered',
  async (method, read) => {
    const first = mount(read);
    await answer(first);
    const second = mount(read);
    await answer(first, second);
    expect(reads.filter((r) => r.method === method)).toHaveLength(2);
  },
);

// Sequences keep counting up across the tests, as the daemon's do.
let sequence = 0;
// A plan change of the lead naming its session, which each of eventReaders reads again after.
const planUpdated = () => ({
  sequence: ++sequence,
  kind: 'board.plan_updated',
  aggregate_id: 'lead-1',
  project_id: 'project-a',
  payload: { session_id: 'session-a' },
});

const eventReaders: [string, () => boolean][] = [
  ['session.diff', () => useSessionDiff('session-a').data !== null],
];

it.each(eventReaders)(
  'sends one %s read for a reader that mounts after an earlier event',
  async (method, read) => {
    vi.useFakeTimers();
    mock.board = { ...mock.board, events: [planUpdated()] };
    const h = mount(read);
    await answer(h);
    await vi.advanceTimersByTimeAsync(2_500);
    await answer(h);
    expect(reads.filter((r) => r.method === method)).toHaveLength(1);
    expect(h.value).toBe(true);
  },
);

it.each(eventReaders)(
  'sends %s again after an event that arrives once it is mounted',
  async (method, read) => {
    vi.useFakeTimers();
    mock.board = { ...mock.board, events: [planUpdated()] };
    const h = mount(read);
    await answer(h);
    mock.board = { ...mock.board, events: [...mock.board.events, planUpdated()] };
    h.render();
    await vi.advanceTimersByTimeAsync(2_500);
    await answer(h);
    expect(reads.filter((r) => r.method === method)).toHaveLength(2);
  },
);

it.each(eventReaders)(
  'sends %s for a reader that mounts after an event that came while a read was out',
  async (method, read) => {
    vi.useFakeTimers();
    const first = mount(read);
    await first.flush();
    mock.board = { ...mock.board, events: [planUpdated()] };
    first.render();
    const second = mount(read);
    await answer(first, second);
    await answer(first, second);
    expect(reads.filter((r) => r.method === method)).toHaveLength(2);
    expect(second.value).toBe(true);
  },
);

it('reads the runtime status again after a connection change, not taking a read sent before it', async () => {
  const first = mount(() => useRuntimeStatus().read.state);
  mock.board = {
    ...mock.board,
    events: [{ sequence: 4, kind: 'runtime.connection_changed', aggregate_id: 'claude' }],
  };
  first.render();
  const second = mount(() => useRuntimeStatus().read.state);
  await answer(first, second);
  expect(reads.map((r) => r.method)).toEqual(['runtime.status', 'runtime.status']);
});

it('sends a device reload while the read of a mount is out', async () => {
  const devices = mount(() => useDevices());
  void devices.value.reload(false);
  await answer(devices);
  expect(reads.map((r) => r.method)).toEqual(['device.list', 'device.list']);
  expect(devices.value.read.state).toBe('ready');
});
