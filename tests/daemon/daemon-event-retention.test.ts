import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { command, USER_PRINCIPAL_ID } from '@pantheon/protocol';

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
    this.readyState = 3;
    this.ended = { code, reason };
    this.emit('close');
  }
}

async function fixture() {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'event-handlers-'));
  const { startDaemon } = await import('../../apps/daemon/src/index.js');
  const daemon = await startDaemon({ directory: root, adapters: [], intervalMs: 600000 });
  const request = (route: string, body?: unknown) =>
    transport.fetch(
      new Request(daemon.url + route, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  for (let i = 0; i < 3; i++) {
    const projectRoot = path.join(root, `project-${i}`);
    mkdirSync(projectRoot);
    const response = await request(
      '/v1/commands',
      command(USER_PRINCIPAL_ID, 'project.open', {
        name: `Retained project ${i}`,
        roots: [projectRoot],
      }),
    );
    expect(response.status).toBe(200);
  }
  daemon.store.pruneEvents(3);
  const clients: EventSocket[] = [];
  return {
    daemon,
    async read(after: number, project?: string) {
      const query = new URLSearchParams({ after: String(after) });
      if (project) query.set('project_id', project);
      return (await request(`/v1/events?${query}`)).json();
    },
    subscribe(cursor: number, project_id?: string) {
      const client = new EventSocket();
      clients.push(client);
      transport.sockets.emit('connection', client);
      client.emit('message', JSON.stringify({ token: daemon.token, cursor, project_id }));
      return client;
    },
    async close() {
      for (const client of clients) client.close(1000);
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('checks the retained horizon in the HTTP handler before replay or project filtering', async () => {
  const f = await fixture();
  try {
    const retained = f.daemon.store.events();
    for (const after of [0, 1, 4])
      expect(await f.read(after)).toEqual({ snapshot_required: true, cursor: 3, events: [] });
    expect(await f.read(2)).toEqual({ cursor: 3, events: retained });
    expect(await f.read(3)).toEqual({ cursor: 3, events: [] });
    expect(await f.read(2, retained[0]!.project_id)).toEqual({ cursor: 3, events: retained });
    expect(await f.read(2, 'other-project')).toEqual({ cursor: 3, events: [] });
    expect(await f.read(1, 'other-project')).toEqual({
      snapshot_required: true,
      cursor: 3,
      events: [],
    });
    f.daemon.store.pruneEvents(100);
    expect(await f.read(2)).toEqual({ snapshot_required: true, cursor: 3, events: [] });
    expect(await f.read(3)).toEqual({ cursor: 3, events: [] });
  } finally {
    await f.close();
  }
});

it('checks the retained horizon in the WebSocket handler before subscribing', async () => {
  const f = await fixture();
  try {
    const retained = f.daemon.store.events()[0];
    for (const cursor of [0, 1, 4]) {
      const client = f.subscribe(cursor);
      expect(client.frames).toEqual([{ type: 'snapshot_required', cursor: 3 }]);
      expect(client.ended).toEqual({ code: 1000, reason: '' });
    }
    const boundary = f.subscribe(2);
    expect(boundary.frames).toEqual([
      { type: 'subscribed', cursor: 2 },
      { type: 'event', event: retained },
    ]);
    expect(f.subscribe(3).frames).toEqual([{ type: 'subscribed', cursor: 3 }]);
    expect(f.subscribe(2, 'other-project').frames).toEqual([{ type: 'subscribed', cursor: 2 }]);
    expect(f.subscribe(1, 'other-project').frames).toEqual([
      { type: 'snapshot_required', cursor: 3 },
    ]);
    f.daemon.store.pruneEvents(100);
    expect(f.subscribe(2).frames).toEqual([{ type: 'snapshot_required', cursor: 3 }]);
    expect(f.subscribe(3).frames).toEqual([{ type: 'subscribed', cursor: 3 }]);
  } finally {
    await f.close();
  }
});
