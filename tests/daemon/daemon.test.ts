import { it, expect, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { AuthRegistry, startDaemon, type DaemonOptions } from '@pantheon/daemon';
import { FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import { eventually, user } from '../helpers.js';
import type { Project, Session, SessionTurn } from '@pantheon/domain';
import type { Approval } from '@pantheon/domain';
import { startFixtureDaemon } from '../acceptance/lib/daemon.mjs';
import { createVirtualClock } from '../acceptance/lib/clock.mjs';

async function serverFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-http-'));
  mkdirSync(path.join(root, 'project'));
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [new FixtureAdapter()],
  });
  const headers = { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' };
  return {
    root,
    daemon,
    headers,
    async close() {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it('authenticates HTTP commands, rejects browser origins and does not accept actor impersonation', async () => {
  const f = await serverFixture();
  try {
    expect((await fetch(f.daemon.url + '/v1/board')).status).toBe(403);
    expect(
      (
        await fetch(f.daemon.url + '/v1/board', {
          headers: { ...f.headers, Origin: 'https://untrusted.example' },
        })
      ).status,
    ).toBe(403);
    const c = command(user.id, 'project.open', {
      name: 'http',
      roots: [path.join(f.root, 'project')],
    });
    const result = await fetch(f.daemon.url + '/v1/commands', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(c),
    });
    expect(result.status).toBe(200);
    expect(
      (
        await fetch(f.daemon.url + '/v1/commands', {
          method: 'POST',
          headers: f.headers,
          body: JSON.stringify({ ...c, actor: 'spoof' }),
        })
      ).status,
    ).toBe(403);
    expect(statSync(path.join(f.root, 'state/user.token')).mode & 0o777).toBe(0o600);
  } finally {
    await f.close();
  }
});
it('rejects a second daemon for the same data directory', async () => {
  const f = await serverFixture();
  try {
    await expect(
      startDaemon({ directory: path.join(f.root, 'state'), adapters: [] }),
    ).rejects.toThrow(/active daemon/);
  } finally {
    await f.close();
  }
});
it('validates query params before answering, and answers unknown routes with JSON 404', async () => {
  const f = await serverFixture();
  try {
    const get = async (route: string, init: RequestInit = { headers: f.headers }) => {
      const response = await fetch(f.daemon.url + route, init);
      return { status: response.status, body: await response.json() };
    };
    expect((await get('/v1/session.reviews?session_id=w')).body.error).toBe('not_found');
    expect((await get('/v1/session.reviews')).body.error).toBe('invalid_input');
    expect((await get('/v1/session.reviews?session_id=w&extra=1')).body.error).toBe(
      'invalid_input',
    );
    expect((await get('/v1/session.reviews?session_id=w', {})).status).toBe(403);
    expect(await get('/v1/nothing')).toEqual({
      status: 404,
      body: { error: 'unknown_route', message: 'GET /v1/nothing' },
    });
    expect(await get('/v1/nothing', { method: 'POST', headers: f.headers })).toEqual({
      status: 404,
      body: { error: 'unknown_route', message: 'POST /v1/nothing' },
    });
    expect((await get('/v1/board')).status).toBe(200);
  } finally {
    await f.close();
  }
});
it('answers input the schema refuses with invalid_input and one readable line per issue', async () => {
  const f = await serverFixture();
  try {
    const response = await fetch(f.daemon.url + '/v1/commands', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(
        command(user.id, 'change_story.revert_patch', {
          story_id: 'x'.repeat(16385),
          card: 0,
          extra: true,
        }),
      ),
    });
    const body = (await response.json()) as { error: string; message: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_input');
    expect(body.message).not.toContain('[');
    expect(body.message.split('\n')).toEqual([
      expect.stringMatching(/^story_id: .*16384/),
      expect.stringContaining('extra'),
    ]);
  } finally {
    await f.close();
  }
});
it.each([
  {
    name: 'an unexpected exception in a command as invalid_request with its stack, logged with the stack',
    request: 'command',
    expected: {
      status: 400,
      error: 'invalid_request',
      stack: true,
      frame: /\.ts:\d+:\d+\)?$/,
      loggedStack: true,
    },
  },
  {
    name: 'a domain error with its code and stack',
    request: '/v1/session.reviews?session_id=w',
    expected: {
      status: 400,
      error: 'not_found',
      stack: true,
      frame: /^\s+at /,
      loggedStack: false,
    },
  },
  {
    name: 'refused input without a stack',
    request: '/v1/session.reviews',
    expected: {
      status: 400,
      error: 'invalid_input',
      stack: false,
      frame: null,
      loggedStack: false,
    },
  },
])('answers $name', async ({ request, expected }) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-errors-'));
  mkdirSync(path.join(root, 'project'));
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await startFixtureDaemon(root, [], {
    failpoint: (name: string) => {
      if (name === 'before_transaction_commit') (null as unknown as { project: string }).project;
    },
  });
  try {
    const { status, data } =
      request === 'command'
        ? await f.submit(
            command(user.id, 'project.open', {
              name: 'errors',
              roots: [path.join(root, 'project')],
            }),
          )
        : await fetch(f.daemon.url + request, {
            headers: { Authorization: `Bearer ${f.daemon.token}` },
          }).then(async (response) => ({ status: response.status, data: await response.json() }));
    expect(status).toBe(expected.status);
    expect(data.error).toBe(expected.error);
    expect(data.details?.stack).toBeUndefined();
    const line = logged.mock.calls
      .map(([text]) => String(text))
      .find((text) => text.includes(' failed: '));
    expect(line).toMatch(new RegExp(`^(GET|POST) /v1/[a-z.]+ failed: ${expected.error}: `));
    if (expected.stack) {
      const frames = (data.stack as string).split('\n');
      expect(frames.length).toBeLessThanOrEqual(15);
      expect(frames[1]).toMatch(expected.frame!);
      expect(line!.includes(frames[1]!)).toBe(expected.loggedStack);
    } else expect(data).not.toHaveProperty('stack');
  } finally {
    logged.mockRestore();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('answers a command of another protocol version with 409 protocol_mismatch', async () => {
  const f = await serverFixture();
  try {
    const response = await fetch(f.daemon.url + '/v1/commands', {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({
        ...command(user.id, 'project.open', { name: 'p', roots: [path.join(f.root, 'project')] }),
        protocol_version: 2,
      }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe('protocol_mismatch');
  } finally {
    await f.close();
  }
});
it('keeps a session credential in its project and drops it when revoked', async () => {
  const f = await serverFixture();
  try {
    const p = (await f.daemon.control.execute(
      user,
      command(user.id, 'project.open', {
        name: 'http',
        roots: [path.join(f.root, 'project')],
      }),
    )) as Project;
    const session = f.daemon.store.insert<Session>('sessions', {
      id: 'board-reader',
      revision: 1,
      project_id: p.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    });
    const headers = { Authorization: `Bearer ${f.daemon.auth.issueSession(session, 'planner')}` };
    expect((await fetch(f.daemon.url + '/v1/board', { headers })).status).toBe(403);
    expect((await fetch(f.daemon.url + '/v1/board?project_id=' + p.id, { headers })).status).toBe(
      200,
    );
    f.daemon.auth.revokeSession(session.id);
    expect((await fetch(f.daemon.url + '/v1/board?project_id=' + p.id, { headers })).status).toBe(
      403,
    );
  } finally {
    await f.close();
  }
});
it('streams durable events after authentication and replays from a cursor', async () => {
  const f = await serverFixture();
  try {
    const ws = new WebSocket(f.daemon.url.replace('http:', 'ws:') + '/v1/events/ws');
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const incoming: unknown[] = [];
    ws.addEventListener('message', (e) => incoming.push(JSON.parse(String(e.data))));
    ws.send(JSON.stringify({ token: f.daemon.token, cursor: 0 }));
    await f.daemon.control.execute(
      user,
      command(user.id, 'project.open', {
        name: 'ws',
        roots: [path.join(f.root, 'project')],
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No event')), 3000);
      const check = setInterval(() => {
        if (incoming.some((x: any) => x.type === 'event')) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    ws.close();
    const events = (
      (await (
        await fetch(f.daemon.url + '/v1/events?after=0', { headers: f.headers })
      ).json()) as any
    ).events;
    expect(events.length).toBe(1);
    const next = (await (
      await fetch(f.daemon.url + '/v1/events?after=' + events[0].sequence, { headers: f.headers })
    ).json()) as any;
    expect(next.events).toEqual([]);
    expect(f.daemon.store.list('projects')).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it('drops an unauthenticated event socket that sends a malformed frame and keeps serving', async () => {
  const f = await serverFixture();
  try {
    const { port } = new URL(f.daemon.url);
    const socket = net.connect(Number(port), '127.0.0.1');
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.on('error', () => {});
    let reply = '';
    await new Promise<void>((resolve) => {
      socket.on('data', (chunk) => {
        reply += chunk.toString('latin1');
        if (reply.includes('\r\n\r\n')) resolve();
      });
      socket.write(
        [
          'GET /v1/events/ws HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 101/);
    // Masked frame with the reserved opcode 3.
    socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    await closed;
    expect((await fetch(f.daemon.url + '/health')).status).toBe(200);
  } finally {
    await f.close();
  }
});
it('closes an event subscription once its session credential is revoked', async () => {
  const f = await serverFixture();
  try {
    const p = (await f.daemon.control.execute(
      user,
      command(user.id, 'project.open', {
        name: 'revoked-subscription',
        roots: [path.join(f.root, 'project')],
      }),
    )) as Project;
    const session = f.daemon.store.insert<Session>('sessions', {
      id: 'subscribed-reader',
      revision: 1,
      project_id: p.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    });
    const credential = f.daemon.auth.issueSession(session, 'planner');
    const ws = new WebSocket(f.daemon.url.replace('http:', 'ws:') + '/v1/events/ws');
    const incoming: { type: string }[] = [];
    ws.addEventListener('message', (e) => incoming.push(JSON.parse(String(e.data))));
    const closed = new Promise<number>((resolve) =>
      ws.addEventListener('close', (e) => resolve(e.code), { once: true }),
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    ws.send(JSON.stringify({ token: credential, project_id: p.id }));
    await eventually(
      () => incoming.some((x) => x.type === 'subscribed'),
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );
    f.daemon.auth.revokeSession(session.id);
    expect(await closed).toBe(1008);
  } finally {
    await f.close();
  }
});

it('uses the injected clock for session credential expiry', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-auth-')),
    clock = createVirtualClock(1700000000000);
  mkdirSync(path.join(root, 'project'));
  const f = await startFixtureDaemon(root, [], { now: clock.now });
  try {
    const project = await f.call('project.open', {
      name: 'clock project',
      roots: [path.join(root, 'project')],
    });
    const session = f.daemon.store.insert<Session>('sessions', {
      id: 'clock-session',
      revision: 1,
      project_id: project.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    });
    const headers = { Authorization: `Bearer ${f.daemon.auth.issueSession(session, 'planner')}` };
    expect(f.daemon.store.now()).toBe(clock.now());
    expect((await fetch(f.daemon.url + '/v1/capabilities', { headers })).status).toBe(200);
    clock.advance(24 * 60 * 60 * 1000 - 1);
    expect((await fetch(f.daemon.url + '/v1/capabilities', { headers })).status).toBe(200);
    clock.advance(24 * 60 * 60 * 1000);
    expect((await fetch(f.daemon.url + '/v1/capabilities', { headers })).status).toBe(403);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('exposes the post-commit failpoint through the fixture entry with a durable unsent command', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-fault-')),
    cache = path.join(process.cwd(), 'node_modules/.cache'),
    adapter = new FixtureAdapter(),
    send = vi.spyOn(adapter, 'send');
  mkdirSync(path.join(root, 'project'));
  mkdirSync(cache, { recursive: true });
  // Worktree sessions need a managed workspace root outside temporary directories.
  const workspaceRoot = mkdtempSync(path.join(cache, 'pantheon-fault-'));
  let fail = false;
  const f = await startFixtureDaemon(root, [adapter], {
    workspaceRoot,
    failpoint: (name: string) => {
      if (fail && name === 'after_commit_before_send') throw new Error('Delivery interrupted');
    },
  });
  try {
    const project = await f.call('project.open', {
      name: 'delivery project',
      roots: [path.join(root, 'project')],
    });
    const created = await f.call('session.create', {
      project_id: project.id,
      runtime: adapter.name,
      input: 'A first message',
    });
    await eventually(
      () =>
        f.daemon.store.list<SessionTurn>('session_turns').every((t) => t.state === 'completed') &&
        f.daemon.store.must<Session>('sessions', created.id).state === 'open',
      () => f.daemon.control.tick(),
      10000,
    );
    const session = f.daemon.store.must<Session>('sessions', created.id),
      earlier = f.daemon.store.list<SessionTurn>('session_turns'),
      queued = f.daemon.store.events().filter((event) => event.kind === 'turn.queued').length;
    send.mockClear();
    const input = command(
      user.id,
      'session.send',
      { session_id: session.id, input: 'A durable message' },
      session.revision,
    );
    fail = true;
    const result = await f.submit(input);
    expect(result.status).toBe(400);
    expect(result.data.message).toBe('Delivery interrupted');
    const turns = f.daemon.store
        .list<SessionTurn>('session_turns')
        .filter((turn) => !earlier.some((e) => e.id === turn.id)),
      pending = f.daemon.store.pending(),
      cursor = f.daemon.store.cursor();
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ state: 'queued', input: 'A durable message' });
    expect(pending).toEqual([
      expect.objectContaining({
        kind: 'session.turn',
        state: 'pending',
        payload: JSON.stringify({ turn_id: turns[0]!.id }),
      }),
    ]);
    expect(f.daemon.store.must<Session>('sessions', session.id)).toMatchObject({
      state: 'running',
      turn_count: session.turn_count + 1,
      revision: session.revision + 1,
    });
    expect(f.daemon.store.events().filter((event) => event.kind === 'turn.queued')).toHaveLength(
      queued + 1,
    );
    expect(send).not.toHaveBeenCalled();
    fail = false;
    const replay = await f.submit(input);
    expect(replay.status).toBe(200);
    expect(replay.data.receipt).toEqual(turns[0]);
    expect(f.daemon.store.cursor()).toBe(cursor);
    expect(f.daemon.store.pending()).toEqual(pending);
    expect(send).not.toHaveBeenCalled();
  } finally {
    await f.close();
    send.mockRestore();
    rmSync(root, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

it('exposes the artifact failpoint after a durable rename and before put returns', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-files-')),
    bytes = Buffer.from('Durable artifact content'),
    hash = createHash('sha256').update(bytes).digest('hex'),
    uri = path.join(root, 'state/artifacts', hash);
  let fail = true;
  const failpoint = vi.fn((name: string) => {
    if (name === 'after_artifact_rename_before_db') {
      expect(readFileSync(uri)).toEqual(bytes);
      if (fail) throw new Error('Artifact persistence interrupted');
    }
  });
  const f = await startFixtureDaemon(root, [], { failpoint });
  try {
    expect(() => f.daemon.control.files.put(bytes)).toThrow('Artifact persistence interrupted');
    expect(failpoint.mock.calls).toEqual([
      ['before_artifact_rename'],
      ['after_artifact_rename_before_db'],
    ]);
    expect(readFileSync(uri)).toEqual(bytes);
    fail = false;
    expect(f.daemon.control.files.put(bytes)).toEqual({ hash, uri });
    expect(failpoint).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('starts the production entry with the real clock and no-op failpoints', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-entry-')),
    argv = process.argv,
    signals = ['SIGTERM', 'SIGINT'] as const,
    listeners = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
  mkdirSync(path.join(root, 'project'));
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const start = vi.fn(async (options: DaemonOptions) => {
    daemon = await startDaemon(options);
    return daemon;
  });
  vi.doMock('../../apps/daemon/src/index.js', () => ({ startDaemon: start }));
  vi.doMock('../../apps/daemon/src/runtime-registry.js', () => ({
    createRuntimeAdapter: async () => new FixtureAdapter(),
  }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  process.argv = ['node', 'daemon', '--data-dir', path.join(root, 'state')];
  try {
    await import('../../apps/daemon/src/main.js');
    expect(start).toHaveBeenCalledTimes(1);
    await expect(
      daemon!.control.execute(
        user,
        command(user.id, 'project.open', {
          name: 'production project',
          roots: [path.join(root, 'project')],
        }),
      ),
    ).resolves.toBeDefined();
    expect(start.mock.calls[0]![0]).not.toHaveProperty('failpoint');
    expect(start.mock.calls[0]![0]).not.toHaveProperty('now');
    expect(daemon!.store.now).toBe(Date.now);
    for (const name of [
      'before_transaction_commit',
      'after_commit_before_send',
      'after_artifact_rename_before_db',
    ])
      expect(() => daemon!.control.failpoint(name)).not.toThrow();
    expect(() => daemon!.control.files.put(Buffer.from('Production artifact'))).not.toThrow();
  } finally {
    process.argv = argv;
    for (const signal of signals)
      for (const listener of process.listeners(signal))
        if (!listeners.get(signal)!.includes(listener)) process.off(signal, listener);
    vi.doUnmock('../../apps/daemon/src/index.js');
    vi.doUnmock('../../apps/daemon/src/runtime-registry.js');
    log.mockRestore();
    await daemon?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('serves needs-you queries with strict params and only the user deciding approvals', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-needs-you-')),
    clock = createVirtualClock(1700000000000),
    adapter = new FixtureAdapter();
  mkdirSync(path.join(root, 'project'));
  const f = await startFixtureDaemon(root, [adapter], { now: clock.now });
  try {
    const project = await f.call('project.open', {
      name: 'Approval query project',
      roots: [path.join(root, 'project')],
    });
    const session: Session = {
      id: 'query-session',
      revision: 1,
      project_id: project.id,
      runtime: adapter.name,
      state: 'running',
      turn_count: 1,
    };
    f.daemon.store.insert('sessions', session);
    const approval: Approval = {
      id: 'query-approval',
      revision: 1,
      project_id: project.id,
      kind: 'permission',
      session_id: session.id,
      request_id: 'query-request',
      tool: 'tool.read',
      input_hash: 'ab'.repeat(32),
      decider: 'user',
      state: 'pending',
      created_at: clock.now(),
    };
    f.daemon.store.insert('approvals', approval);
    f.daemon.store.insert<Approval>('approvals', {
      ...approval,
      id: 'query-user-approval',
      request_id: 'user-request',
    });
    f.daemon.store.insert<Approval>('approvals', {
      ...approval,
      id: 'query-outside-approval',
      request_id: 'outside-request',
      tool: 'tool.write',
    });
    const plannerToken = f.daemon.auth.issueSession(session, 'planner');
    f.daemon.auth.add('query-writer-token', {
      id: 'query-writer',
      role: 'writer',
      project_id: project.id,
    });
    const get = async (query = '', token = f.daemon.token) => {
      const response = await fetch(f.daemon.url + '/v1/needs_you.list' + query, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    };
    expect((await get()).body.items).toHaveLength(3);
    expect((await get('?project_id=' + project.id)).body.items).toHaveLength(3);
    expect((await get('?project_id=another-project')).body).toEqual({ items: [] });
    const planner = await get('', plannerToken);
    expect(planner.status).toBe(200);
    expect(planner.body.items).toEqual([]);
    expect((await get('?project_id=another-project', plannerToken)).status).toBe(403);
    expect((await get('', 'query-writer-token')).status).toBe(403);
    expect((await get('', '')).status).toBe(403);
    expect((await get('?extra=field')).body.error).toBe('invalid_input');
    expect((await get('?project_id=')).body.error).toBe('invalid_input');
    f.daemon.auth.revokeSession(session.id);
    expect((await get('', plannerToken)).status).toBe(403);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('prefetches the worktree reads before it answers the board view', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-board-view-')),
    clock = createVirtualClock(1700000000000);
  mkdirSync(path.join(root, 'project'));
  const f = await startFixtureDaemon(root, [new FixtureAdapter()], { now: clock.now });
  try {
    const project = await f.call('project.open', {
      name: 'Board query project',
      roots: [path.join(root, 'project')],
    });
    const prefetch = vi.spyOn(f.daemon.control, 'prefetchWorktreeReads');
    const response = await fetch(`${f.daemon.url}/v1/board.view?project_id=${project.id}&days=14`, {
      headers: { Authorization: `Bearer ${f.daemon.token}` },
    });
    expect(response.status).toBe(200);
    expect(prefetch).toHaveBeenCalledWith(expect.objectContaining({ id: user.id }), project.id);
    expect(await response.json()).toEqual(f.daemon.control.boardView(user, project.id, 14));
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('routes longer and past board ranges and range-filtered project gates', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-board-ranges-')),
    clock = createVirtualClock(new Date(2027, 2, 16, 12).getTime());
  mkdirSync(path.join(root, 'project'));
  const f = await startFixtureDaemon(root, [new FixtureAdapter()], { now: clock.now });
  try {
    const project = await f.call('project.open', {
      name: 'Board range project',
      roots: [path.join(root, 'project')],
    });
    const get = async (method: string, params: string) => {
      const response = await fetch(
        `${f.daemon.url}/v1/${method}?project_id=${project.id}&${params}`,
        {
          headers: { Authorization: `Bearer ${f.daemon.token}` },
        },
      );
      return { status: response.status, body: await response.json() };
    };
    for (const [days, until] of [
      [30, undefined],
      ['all', undefined],
      [7, '2027-03-13'],
    ] as const) {
      const response = await get('board.view', `days=${days}${until ? `&until=${until}` : ''}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(f.daemon.control.boardView(user, project.id, days, until));
    }
    for (const params of [
      'days=all&until=2027-03-13',
      'days=7&until=2027-03-17',
      'days=7&until=2027-02-30',
    ])
      expect((await get('board.view', params)).body.error).toBe('invalid_input');
    const history = vi.spyOn(f.daemon.control, 'projectGatesHistory');
    expect((await get('project.gates.history', 'since=123&limit=500')).body).toEqual({ runs: [] });
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({ id: user.id }),
      project.id,
      500,
      123,
    );
    expect((await get('project.gates.history', 'limit=101')).body.error).toBe('invalid_input');
    expect((await get('project.gates.history', 'since=123&limit=501')).body.error).toBe(
      'invalid_input',
    );
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('extends a session credential on each use and lets an unused one expire', () => {
  const hour = 60 * 60 * 1000;
  let now = 1800000000000;
  const auth = new AuthRegistry('user-credential', () => now);
  const session = (id: string) =>
    ({ id, project_id: 'project', state: 'open', workspace_id: 'workspace' }) as Session;
  const used = `Bearer ${auth.issueSession(session('long-running'), 'lead')}`;
  const unused = `Bearer ${auth.issueSession(session('idle'), 'lead')}`;
  now += 23 * hour;
  expect(auth.authenticate(used)).toMatchObject({ session_id: 'long-running' });
  now += 23 * hour;
  expect(auth.authenticate(used)).toMatchObject({ session_id: 'long-running' });
  expect(() => auth.authenticate(unused)).toThrow('Valid connection credentials required');
});

it('checks runtimes after startup and on its interval, serves runtime.status and stops once closed', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-runtime-status-'));
  class CheckedAdapter extends FixtureAdapter {
    name = 'checked';
    preflight = vi.fn(async () => ({
      installed: true,
      version: '2.0.0',
      min_version: '1.0.0',
      version_ok: true,
      auth: { state: 'ok' as const },
    }));
  }
  const checked = new CheckedAdapter();
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [new FixtureAdapter(), checked],
    runtimeStatusMs: 20,
  });
  try {
    const headers = { Authorization: `Bearer ${daemon.token}` };
    await eventually(() => checked.preflight.mock.calls.length >= 3);
    const response = await fetch(daemon.url + '/v1/runtime.status', { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      expect.objectContaining({ runtime: 'fixture' }),
      expect.objectContaining({ runtime: 'checked', version: '2.0.0', auth: { state: 'ok' } }),
      expect.objectContaining({ runtime: 'grok', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'agy', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'dsh', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'muse', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'opencode', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'cursor', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'copilot', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'gemini', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'kilo', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'cline', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'qwen', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'kimi', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'goose', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'openhands', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'auggie', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'kiro', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'junie', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'devin', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'vibe', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'hermes', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'omp', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'codebuddy', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'droid', enabled: true, installed: false }),
      expect.objectContaining({ runtime: 'qoder', enabled: true, installed: false }),
    ]);
    const before = checked.preflight.mock.calls.length;
    expect((await fetch(daemon.url + '/v1/runtime.status?refresh=true', { headers })).status).toBe(
      200,
    );
    expect(checked.preflight.mock.calls.length).toBeGreaterThan(before);
  } finally {
    await daemon.close();
  }
  const closed = checked.preflight.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(checked.preflight.mock.calls.length).toBe(closed);
  rmSync(root, { recursive: true, force: true });
});

it('serves project permission rules, local branches and stale workspace settings through HTTP', async () => {
  const f = await serverFixture();
  try {
    const project = (await f.daemon.control.execute(
      user,
      command(user.id, 'project.open', {
        name: 'Workbench settings',
        roots: [path.join(f.root, 'project')],
      }),
    )) as Project;
    const get = (method: string, extra = '') =>
      fetch(`${f.daemon.url}/v1/${method}?project_id=${project.id}${extra}`, {
        headers: f.headers,
      });
    for (const method of ['permission.rules', 'project.branches', 'workspace.stale']) {
      const response = await get(method);
      expect(response.status).toBe(200);
      const body = await response.json();
      if (method === 'permission.rules') expect(body).toEqual([]);
      if (method === 'project.branches')
        expect(body).toEqual([
          expect.objectContaining({
            name: expect.any(String),
            sha: expect.any(String),
            checked_out: true,
          }),
        ]);
      if (method === 'workspace.stale') expect(body).toEqual({ count: 0, size_bytes: 0 });
      expect((await get(method, '&unexpected=yes')).status).toBe(400);
    }
    const response = await fetch(`${f.daemon.url}/v1/commands`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify(command(user.id, 'workspace.prune_stale', { project_id: project.id })),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipt: { removed: 0 } });
  } finally {
    await f.close();
  }
});
