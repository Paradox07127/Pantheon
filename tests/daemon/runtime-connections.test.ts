import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import { startDaemon } from '@pantheon/daemon';
import { command } from '@pantheon/protocol';
import type { AgentEventSink, Project, Session, SessionTurn } from '@pantheon/domain';
import { eventually, user } from '../helpers.js';

it('routes runtime, MCP and GitHub requests and streams runtime loss to a project subscriber', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-connections-http-'));
  const projectRoot = path.join(root, 'project');
  mkdirSync(projectRoot);
  const adapter = new FixtureAdapter();
  const reconnect = vi.fn(async () => {}).mockRejectedValueOnce(new Error('fresh startup refused'));
  Object.assign(adapter, {
    reconnect,
    mcpStatus: async () => [{ name: 'files', state: 'connected' }],
  });
  let sink!: AgentEventSink;
  const start = adapter.start.bind(adapter);
  vi.spyOn(adapter, 'start').mockImplementation(async (spec, emit) => {
    sink = emit;
    return start(spec, emit);
  });
  vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [adapter],
    userConfigDir: path.join(root, 'config'),
  });
  const headers = { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' };
  const ws = new WebSocket(daemon.url.replace('http:', 'ws:') + '/v1/events/ws');
  try {
    const project = daemon.control.execute(
      user,
      command(user.id, 'project.open', { name: 'Connections', roots: [projectRoot] }),
    ) as Project;
    const session = daemon.store.insert<Session>('sessions', {
      id: 'runtime-conversation',
      revision: 1,
      project_id: project.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    });
    daemon.control.execute(
      user,
      command(user.id, 'session.send', { session_id: session.id, input: 'Work' }, session.revision),
    );
    await daemon.control.tick();
    await eventually(() => daemon.control.handles.size > 0);
    const messages: { type: string; event?: { kind: string; payload: unknown } }[] = [];
    ws.addEventListener('message', (event) => messages.push(JSON.parse(String(event.data))));
    if (ws.readyState !== WebSocket.OPEN)
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', reject, { once: true });
      });
    ws.send(
      JSON.stringify({
        token: daemon.token,
        project_id: project.id,
        cursor: daemon.store.cursor(),
      }),
    );
    await eventually(() => messages.some((message) => message.type === 'subscribed'));
    sink({
      key: 'connection-lost',
      provider_sequence: 100,
      kind: 'runtime.disconnected',
      reason: 'fixture runtime closed',
    });
    sink({
      key: 'turn-lost',
      provider_sequence: 101,
      kind: 'turn.completed',
      turn_id: daemon.store.list<SessionTurn>('session_turns')[0]!.id,
      status: 'failed',
      error: 'fixture runtime closed',
    });
    await eventually(() =>
      messages.some((message) => message.event?.kind === 'runtime.connection_changed'),
    );
    expect(
      messages.find((message) => message.event?.kind === 'runtime.connection_changed')?.event
        ?.payload,
    ).toMatchObject({
      runtime: 'fixture',
      connected: false,
      reason: 'fresh startup refused',
      held_session_ids: [session.id],
    });
    const post = async (
      type: 'runtime.reconnect' | 'mcp.reconnect' | 'github.pr.create',
      input: Record<string, unknown>,
    ) =>
      fetch(daemon.url + '/v1/commands', {
        method: 'POST',
        headers,
        body: JSON.stringify(command(user.id, type, input)),
      });
    const reconnected = await post('runtime.reconnect', { runtime: 'fixture' });
    expect(await reconnected.json()).toEqual({ receipt: { runtime: 'fixture', connected: true } });
    const unsupported = await post('mcp.reconnect', { session_id: session.id, server: 'files' });
    expect(await unsupported.json()).toMatchObject({
      error: 'unsupported_capability',
      message: 'fixture does not support reconnecting MCP servers',
    });
    expect(
      await (
        await fetch(daemon.url + `/v1/mcp.status?project_id=${project.id}&runtime=fixture`, {
          headers,
        })
      ).json(),
    ).toEqual({
      runtime: 'fixture',
      reconnect_available: false,
      servers: [{ name: 'files', state: 'connected' }],
    });
    expect(
      await (
        await fetch(daemon.url + `/v1/github.items?project_id=${project.id}&kind=issue`, {
          headers,
        })
      ).json(),
    ).toEqual({ repo: null, items: [] });
    expect(await (await post('github.pr.create', { session_id: session.id })).json()).toMatchObject(
      { error: 'invalid_input' },
    );
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    vi.stubEnv('PATH', bin);
    expect(await (await fetch(daemon.url + '/v1/connections.status', { headers })).json()).toEqual({
      github: { state: 'missing', installed: false, signed_in: false },
      huggingface: { state: 'missing', installed: false, signed_in: false },
      cloudflare: { state: 'missing', installed: false, signed_in: false },
    });
  } finally {
    vi.unstubAllEnvs();
    ws.close();
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
