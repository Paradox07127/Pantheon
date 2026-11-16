import { expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createMcpServer } from '../../apps/cli/src/mcp.js';
import { FixtureAdapter } from '@pantheon/adapters';
import { startDaemon } from '@pantheon/daemon';
import { command } from '@pantheon/protocol';
import type { Project, Session, SessionTurn } from '@pantheon/domain';
import { eventually, user } from '../helpers.js';

it('connects the runtime analysis MCP with only the two evidence-bound tools', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'trace-analysis-mcp-'));
  const work = path.join(root, 'project');
  mkdirSync(work);
  const adapter = new FixtureAdapter();
  const starts = vi.spyOn(adapter, 'start');
  vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [adapter],
    intervalMs: 60_000,
  });
  const client = new Client({ name: 'trace-analysis-test', version: '1' });
  let server: Awaited<ReturnType<typeof createMcpServer>> | undefined;
  try {
    const project = daemon.control.execute(
      user,
      command(user.id, 'project.open', { name: 'Analysis project', roots: [work] }),
    ) as Project;
    const to = daemon.store.now();
    const analysis = daemon.control.execute(
      user,
      command(user.id, 'trace.reflect', { project_id: project.id, from: to - 5_000, to }),
    ) as { session_id: string };
    const analysisTurn = () =>
      daemon.store
        .list<SessionTurn>('session_turns')
        .find((turn) => turn.session_id === analysis.session_id)!;
    await eventually(
      () => ['running', 'failed'].includes(analysisTurn().state),
      () => daemon.control.tick(),
    );
    expect(analysisTurn()).toMatchObject({ state: 'running' });
    const spec = starts.mock.calls[0]![0];
    const token = readFileSync(spec.pantheon_mcp!.env.PANTHEON_SESSION_TOKEN_FILE!, 'utf8');
    server = await createMcpServer(daemon.url, token);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(['trace_evidence', 'trace_report']);
    for (const tool of tools) {
      expect(tool.inputSchema.properties).not.toHaveProperty('project_id');
      expect(tool.inputSchema.properties).not.toHaveProperty('expected_revision');
    }

    const evidence = await client.callTool({
      name: 'trace_evidence',
      arguments: { view: 'summary' },
    });
    expect(evidence.isError).not.toBe(true);
    expect(evidence.content).toEqual([
      expect.objectContaining({ text: expect.stringContaining('"findings":0') }),
    ]);
    const report = {
      name: 'trace_report',
      arguments: {
        summary: 'No bottleneck observed in the available window',
        disposition: 'none',
        finding_ids: [],
        change: '',
        baseline: '',
        metric: '',
        rollback: '',
      },
    };
    expect((await client.callTool(report)).isError).not.toBe(true);
    expect(
      daemon.store.must<Session>('sessions', analysis.session_id).runtime_review?.report,
    ).toMatchObject({ disposition: 'none', evidence_ids: [] });
    const turn = analysisTurn();
    daemon.store.update('session_turns', { ...turn, state: 'completed' }, turn.revision);
    expect((await client.callTool(report)).isError).toBe(true);
  } finally {
    await client.close();
    await server?.close();
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('serves the trace queries over HTTP and keeps the trace cache in the data directory', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'trace-queries-')),
    work = path.join(root, 'project'),
    state = path.join(root, 'state');
  mkdirSync(work);
  const daemon = await startDaemon({
    directory: state,
    adapters: [],
    intervalMs: 60000,
    protectionPaths: {
      dataDir: state,
      desktopUserDataDir: path.join(root, 'desktop'),
      backupDir: path.join(root, 'backups'),
      home: path.join(root, 'home'),
      codexHome: path.join(root, 'codex'),
    },
  });
  try {
    const project = daemon.control.execute(
      user,
      command(user.id, 'project.open', { name: 'Trace project', roots: [work] }),
    ) as Project;
    const session = daemon.store.insert<Session>('sessions', {
      id: 'trace-session',
      revision: 1,
      project_id: project.id,
      runtime: 'fixture',
      title: 'Trace session',
      state: 'open',
      turn_count: 0,
    });
    const turn = daemon.store.insert<SessionTurn>('session_turns', {
      id: 'trace-turn',
      revision: 1,
      project_id: project.id,
      session_id: session.id,
      input: 'Check the project',
      kind: 'send',
      delivery: 'delivered',
      state: 'running',
    });
    daemon.store.event('turn.running', turn, project.id, {});
    const headers = { Authorization: `Bearer ${daemon.token}` };
    const get = async (method: string, params: Record<string, string>) => {
      const url = new URL(`/v1/${method}`, daemon.url);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const response = await fetch(url, { headers });
      return { status: response.status, body: await response.json() };
    };

    const trace = await get('project.trace', { project_id: project.id, bucket_ms: '3600000' });
    expect(trace.status).toBe(200);
    expect(trace.body).toMatchObject({
      epoch: expect.any(String),
      indexing: { done_files: 0, total_files: 0 },
      lanes: [{ lane: { key: session.id, title: 'Trace session' } }],
    });
    const lane = await get('session.trace', { project_id: project.id, lane_key: session.id });
    expect(lane.status).toBe(200);
    expect(lane.body.spans.map((span: { id: string }) => span.id)).toEqual([turn.id]);
    const time = await get('trace.time', { project_id: project.id, lane_key: session.id });
    expect(time.status).toBe(200);
    expect(time.body).toMatchObject({
      live: true,
      wall_ms: expect.any(Number),
      work_ms: 0,
    });
    const calls = await get('tool.calls', { project_id: project.id, limit: '200' });
    expect(calls).toEqual({ status: 200, body: [] });
    expect((await get('tool.calls', { project_id: project.id, limit: '201' })).status).toBe(400);
    const stats = await get('project.trace.stats', {
      project_id: project.id,
      since: String(daemon.store.now() - 1000),
      until: String(daemon.store.now() + 1000),
    });
    expect(stats).toEqual({ status: 200, body: { failed_tool_calls: 0 } });
    const allTime = await get('trace.time', { project_id: project.id });
    expect(allTime.body.by_lane[session.id]).toMatchObject({ turns: 1 });
    const heatmap = await get('project.heatmap', { project_id: project.id, days: '7' });
    expect(heatmap.status).toBe(200);
    expect(heatmap.body.days).toHaveLength(7);
    expect(existsSync(path.join(state, 'trace-cache.sqlite'))).toBe(true);
    daemon.store.event('agent.tool.started', session, project.id, {
      turn_id: turn.id,
      tool_call_id: 'edit-file',
      name: 'Edit',
      input: { file_path: 'main.ts', old_string: 'before\n', new_string: 'after\n' },
    });
    const step = await get('session.step_diff', {
      session_id: session.id,
      turn_id: turn.id,
      span_id: 'edit-file',
    });
    expect(step.status).toBe(200);
    expect(step.body.files).toEqual([
      { path: 'main.ts', patch: expect.stringContaining('-before\n+after'), truncated: false },
    ]);
    expect(
      (await get('session.step_diff', { session_id: session.id, turn_id: turn.id })).status,
    ).toBe(400);
    const collab = await get('project.collab', {
      project_id: project.id,
      since: '0',
      until: String(daemon.store.now()),
    });
    expect(collab).toEqual({
      status: 200,
      body: { messages: [], in_flight: [], subagents: [], model_changes: [] },
    });
    expect(
      (await get('project.collab', { project_id: project.id, since: '2', until: '1' })).status,
    ).toBe(400);
  } finally {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  }
});
