import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';
import type { Project, Session } from '@pantheon/domain';
import { eventually } from '../helpers.js';

const transport = { fetch: undefined as any, sockets: undefined as any };

vi.mock('node:net', async (original) => {
  const actual = await original<
    typeof import('node:net') & { default: typeof import('node:net') }
  >();
  return {
    ...actual,
    default: {
      ...actual.default,
      createServer: () =>
        Object.assign(new EventEmitter(), {
          listen: (_path: string, ready: () => void) => ready(),
          close: (done: () => void) => done(),
        }),
    },
  };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: (file: string, mode: number) => {
      if (!file.endsWith('daemon.lock.sock')) actual.chmodSync(file, mode);
    },
  };
});
vi.mock('../../apps/daemon/node_modules/@hono/node-server/dist/index.mjs', () => ({
  serve: ({ fetch }: { fetch: unknown }) => {
    transport.fetch = fetch;
    return Object.assign(new EventEmitter(), {
      listening: true,
      address: () => ({ port: 1 }),
      close: (done: () => void) => done(),
    });
  },
}));
vi.mock('../../apps/daemon/node_modules/ws/wrapper.mjs', () => ({
  WebSocket: { OPEN: 1 },
  WebSocketServer: class extends EventEmitter {
    clients = new Set();
    constructor() {
      super();
      transport.sockets = this;
    }
    close(done: () => void) {
      done();
    }
  },
}));

class EventSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: any[] = [];
  ended: { code: number; reason: string } | undefined;
  send(bytes: string) {
    this.frames.push(JSON.parse(bytes));
  }
  close(code: number, reason = '') {
    if (this.ended) return;
    this.readyState = 3;
    this.ended = { code, reason };
    this.emit('close');
  }
  sequences(): number[] {
    return this.frames.filter((f) => f.type === 'event').map((f) => f.event.sequence);
  }
}

async function fixture() {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'event-stream-'));
  const { startDaemon } = await import('../../apps/daemon/src/index.js');
  const clients: EventSocket[] = [];
  let projects = 0;
  const start = async (options: { heartbeatMs?: number } = {}) => {
    const daemon = await startDaemon({
      directory: root,
      adapters: [],
      intervalMs: 600000,
      ...options,
    });
    return {
      daemon,
      async openProject() {
        const projectRoot = path.join(root, `project-${projects}`);
        mkdirSync(projectRoot);
        const response = await transport.fetch(
          new Request(daemon.url + '/v1/commands', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${daemon.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(
              command(USER_PRINCIPAL_ID, 'project.open', {
                name: `Streamed project ${projects++}`,
                roots: [projectRoot],
              }),
            ),
          }),
        );
        expect(response.status).toBe(200);
      },
      subscribe(cursor: number) {
        const client = new EventSocket();
        clients.push(client);
        transport.sockets.emit('connection', client);
        client.emit('message', JSON.stringify({ token: daemon.token, cursor }));
        return client;
      },
    };
  };
  return {
    start,
    async close(daemon: { close(): Promise<void> }) {
      for (const client of clients) client.close(1000);
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('replays the events written while the daemon restarted to a client that resubscribes from its cursor', async () => {
  const f = await fixture();
  const first = await f.start();
  await first.openProject();
  const client = first.subscribe(0);
  await eventually(() => client.sequences().length > 0);
  const delivered = client.sequences().at(-1)!;
  // The socket drops with the daemon; the client keeps the cursor it reached.
  client.close(1006);
  await first.openProject();
  await first.daemon.close();
  const second = await f.start();
  try {
    await second.openProject();
    const written = second.daemon.store.events(delivered);
    expect(written.length).toBeGreaterThanOrEqual(2);
    const resumed = second.subscribe(delivered);
    await eventually(() => resumed.sequences().at(-1) === written.at(-1)!.sequence);
    expect(resumed.frames).toEqual([
      { type: 'subscribed', cursor: delivered },
      ...written.map((event) => ({ type: 'event', event })),
    ]);
    expect([...client.sequences(), ...resumed.sequences()]).toEqual(
      second.daemon.store.events(0).map((e) => e.sequence),
    );
  } finally {
    await f.close(second.daemon);
  }
});

it('sends a heartbeat frame with the delivered cursor to an idle subscriber', async () => {
  const f = await fixture();
  const s = await f.start({ heartbeatMs: 20 });
  try {
    await s.openProject();
    await s.openProject();
    const client = s.subscribe(0);
    const last = s.daemon.store.cursor();
    await eventually(() => client.frames.some((frame) => frame.type === 'heartbeat'));
    expect(client.sequences().at(-1)).toBe(last);
    expect(client.frames.find((frame) => frame.type === 'heartbeat')).toEqual({
      type: 'heartbeat',
      cursor: last,
    });
    client.close(1000);
    const count = client.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(client.frames).toHaveLength(count);
  } finally {
    await f.close(s.daemon);
  }
});

it('closes a slow subscriber with 1013 and replays from its last delivered cursor without gaps', async () => {
  const f = await fixture();
  const s = await f.start();
  try {
    for (let i = 0; i < 3; i++) await s.openProject();
    const slow = s.subscribe(0);
    await eventually(() => slow.sequences().at(-1) === s.daemon.store.cursor());
    slow.bufferedAmount = 2 * 1024 * 1024;
    await s.openProject();
    await s.openProject();
    await eventually(() => slow.ended !== undefined);
    expect(slow.ended).toEqual({ code: 1013, reason: 'Replay from last cursor' });
    const delivered = slow.sequences().at(-1)!;
    expect(delivered).toBeLessThan(s.daemon.store.cursor());
    const resumed = s.subscribe(delivered);
    await eventually(() => resumed.sequences().at(-1) === s.daemon.store.cursor());
    expect(resumed.frames[0]).toEqual({ type: 'subscribed', cursor: delivered });
    expect([...slow.sequences(), ...resumed.sequences()]).toEqual(
      s.daemon.store.events(0).map((e) => e.sequence),
    );
  } finally {
    await f.close(s.daemon);
  }
});

it('streams pull state changes while a reconnect command reports the device failure', async () => {
  const f = await fixture();
  const s = await f.start();
  try {
    await s.openProject();
    const project = s.daemon.store.list<Project>('projects')[0]!;
    const session = s.daemon.store.insert<Session>('sessions', {
      id: 'remote-session',
      revision: 1,
      project_id: project.id,
      runtime: 'fixture',
      device_id: 'build-box',
      state: 'open',
      turn_count: 1,
      remote_pull: {
        status: 'failed',
        reason: 'Device disconnected',
        changed_at: new Date().toISOString(),
      },
    });
    const client = s.subscribe(s.daemon.store.cursor());
    await eventually(() => client.frames.some((frame) => frame.type === 'subscribed'));
    const response = await transport.fetch(
      new Request(s.daemon.url + '/v1/commands', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.daemon.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(
          command(USER_PRINCIPAL_ID, 'session.reconnect', { session_id: session.id }),
        ),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'remote_pull_failed',
      message: expect.stringContaining('offline'),
    });
    await eventually(() => client.frames.filter((frame) => frame.type === 'event').length === 2);
    expect(
      client.frames
        .filter((frame) => frame.type === 'event')
        .map((frame) => ({ kind: frame.event.kind, payload: frame.event.payload })),
    ).toEqual([
      {
        kind: 'session.remote_pull_changed',
        payload: { status: 'running', changed_at: expect.any(String) },
      },
      {
        kind: 'session.remote_pull_changed',
        payload: {
          status: 'failed',
          reason: expect.stringContaining('offline'),
          changed_at: expect.any(String),
        },
      },
    ]);
  } finally {
    await f.close(s.daemon);
  }
});
