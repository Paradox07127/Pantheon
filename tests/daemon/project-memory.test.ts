import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { Session } from '@pantheon/domain';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { startFixtureDaemon } from '../acceptance/lib/daemon.mjs';
import { git } from '../control/workbench-fixture.js';
import { eventually } from '../helpers.js';

it('runs HTTP decisions through real MCP child processes, two adapter sessions, maintenance and a daemon restart', async () => {
  const root = mkdtempSync(path.join(process.cwd(), 'node_modules/.cache/memory-e2e-'));
  const source = path.join(root, 'source'),
    managed = path.join(root, 'managed');
  mkdirSync(source);
  mkdirSync(managed);
  writeFileSync(path.join(source, 'README.md'), '# Memory integration fixture\n');
  git(source, 'init', '--quiet', '--initial-branch=main');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Fixture');
  const adapter = new FixtureAdapter(10),
    send = vi.spyOn(adapter, 'send');
  const options = {
    workspaceRoot: managed,
    protectionPaths: {
      dataDir: path.join(root, 'state'),
      desktopUserDataDir: path.join(root, 'desktop'),
      backupDir: path.join(root, 'backups'),
      home: path.join(root, 'home'),
      codexHome: path.join(root, 'codex'),
    },
  };
  let f = await startFixtureDaemon(root, [adapter], options);
  const clients: Client[] = [];
  const receipt = (result: Awaited<ReturnType<Client['callTool']>>) => {
    const text = (result.content as { text: string }[])[0]!.text;
    expect(result.isError, text).toBeFalsy();
    return JSON.parse(text).receipt;
  };
  try {
    const project = await f.call('project.open', { name: 'Memory E2E', roots: [source] });
    const save = async (text: string) => {
      const draft = await f.call('memory.propose', {
        project_id: project.id,
        key: 'storage',
        kind: 'decision',
        text,
        tags: ['storage', 'local'],
      });
      return f.call('memory.commit', { memory_id: draft.id }, draft.revision);
    };
    const old = await save('Use obsolete-engine-unique');
    const sessions: Session[] = [];
    for (let n = 0; n < 2; n++) {
      const s = await f.call('session.create', {
        project_id: project.id,
        runtime: 'fixture',
        input: 'Read current project memory',
      });
      sessions.push(s);
      await eventually(
        () =>
          f.daemon.store.must<Session>('sessions', s.id).state === 'open' &&
          send.mock.calls.some(([h]) => h.platform_session_id === s.id),
        () => f.daemon.control.tick(),
      );
      const token = f.daemon.auth.issueSession(
        f.daemon.store.must<Session>('sessions', s.id),
        'lead',
      );
      const tokenFile = path.join(root, `mcp-token-${n}`);
      writeFileSync(tokenFile, token, { mode: 0o600 });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve('apps/cli/dist/index.js'), 'mcp'],
        // The parent's env carries settings a sandboxed node needs, such as OPENSSL_CONF in a gate.
        env: {
          ...(process.env as Record<string, string>),
          PANTHEON_DAEMON_URL: f.daemon.url,
          PANTHEON_SESSION_TOKEN_FILE: tokenFile,
        },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'memory-e2e', version: '1' });
      await client.connect(transport);
      clients.push(client);
      const tools = (await client.listTools()).tools;
      expect(tools.find((t) => t.name === 'memory_propose')?.description).toContain('draft');
      expect(tools.some((t) => t.name === 'memory_related')).toBe(true);
      expect(tools.some((t) => t.name === 'memory_history' || t.name === 'memory_commit')).toBe(
        false,
      );
      expect(
        receipt(await client.callTool({ name: 'memory_context', arguments: {} })).items[0].text,
      ).toContain('obsolete-engine');
    }
    const ctx = receipt(await clients[0]!.callTool({ name: 'memory_context', arguments: {} }));
    const proposal = receipt(
      await clients[0]!.callTool({
        name: 'memory_propose',
        arguments: {
          key: 'analysis',
          kind: 'report',
          text: 'The old storage analysis',
          dependencies: [old.id],
          based_on: ctx.signature,
        },
      }),
    );
    expect(proposal.authority).toBe('agent_reported');
    expect(
      receipt(
        await clients[1]!.callTool({ name: 'memory_search', arguments: { q: 'analysis' } }),
      ).items.map((item: { id: string }) => item.id),
    ).toEqual([proposal.id]);
    const current = await save('Use SQLite with versioned local text');
    const summary = receipt(
      await clients[0]!.callTool({
        name: 'memory_search',
        arguments: { q: 'SQLite', kind: 'decision' },
      }),
    );
    expect(summary.items[0]).not.toHaveProperty('text');
    expect(summary.items[0].reasons.length).toBeGreaterThan(0);
    expect(
      receipt(
        await clients[0]!.callTool({
          name: 'memory_related',
          arguments: { memory_id: current.id },
        }),
      ).items,
    ).toEqual([]);
    expect(
      (
        await clients[0]!.callTool({
          name: 'memory_related',
          arguments: { memory_id: current.id, state: 'all' },
        })
      ).isError,
    ).toBe(true);
    for (let n = 0; n < clients.length; n++) {
      const client = clients[n]!;
      expect(
        receipt(
          await client.callTool({
            name: 'memory_search',
            arguments: { q: 'obsolete-engine-unique' },
          }),
        ).items,
      ).toEqual([]);
      expect(
        (await client.callTool({ name: 'memory_get', arguments: { memory_id: proposal.id } }))
          .isError,
      ).toBe(true);
      expect(
        receipt(await client.callTool({ name: 'memory_context', arguments: {} })).items.map(
          (r: any) => r.id,
        ),
      ).toEqual([current.id]);
      const s = f.daemon.store.must<Session>('sessions', sessions[n]!.id);
      await f.call(
        'session.send',
        { session_id: s.id, input: 'Continue using the latest decision' },
        s.revision as any,
      );
    }
    await eventually(
      () =>
        send.mock.calls.filter(([, t]) => t.input.includes('Continue using the latest decision'))
          .length === 2,
      () => f.daemon.control.tick(),
    );
    for (const [, turn] of send.mock.calls.filter(([, t]) =>
      t.input.includes('Continue using the latest decision'),
    )) {
      expect(turn.input).toContain('Use SQLite');
      expect(turn.input).not.toContain('obsolete-engine');
    }
    await eventually(
      () => !!f.daemon.control.memoryDocument({ id: 'local-user', role: 'user' }, project.id).text,
      () => f.daemon.control.tick(),
    );
    const view = await fetch(f.daemon.url + '/v1/memory.read?project_id=' + project.id, {
      headers: { Authorization: `Bearer ${f.daemon.token}` },
    });
    expect(view.status).toBe(200);
    const read = await view.json();
    expect(JSON.stringify(read)).toContain('Use SQLite');
    expect(read.records[0]).not.toHaveProperty('text');
    const get = async (method: string, params: Record<string, string>) => {
      const response = await fetch(
        f.daemon.url +
          '/v1/' +
          method +
          '?' +
          new URLSearchParams({ project_id: project.id, ...params }),
        { headers: { Authorization: `Bearer ${f.daemon.token}` } },
      );
      expect(response.status).toBe(200);
      return response.json();
    };
    expect((await get('memory.item', { memory_id: current.id })).text).toContain('Use SQLite');
    const wholeGraph = await get('memory.graph', {});
    expect(wholeGraph.total).toBe(1);
    expect(wholeGraph.nodes[0].memory_id).toBe(current.id);
    for (const method of ['memory.read', 'memory.graph']) {
      const response = await fetch(
        f.daemon.url +
          '/v1/' +
          method +
          '?' +
          new URLSearchParams([
            ['project_id', project.id],
            ['tag', 'storage'],
            ['tag', 'missing'],
          ]),
        { headers: { Authorization: `Bearer ${f.daemon.token}` } },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).total).toBe(0);
    }
    const recent = await get('memory.recent', { limit: '2' });
    expect(recent.items.map((event: any) => event.kind)).toEqual(['committed', 'proposed']);
    expect(JSON.stringify(recent)).not.toContain('Use SQLite with versioned local text');
    const delivered = f.daemon.store.must<Session>('sessions', sessions[0]!.id).memory_delivery!;
    const turnResponse = await fetch(
      f.daemon.url +
        '/v1/memory.turn?' +
        new URLSearchParams({ session_id: sessions[0]!.id, turn_id: delivered.turn_id }),
      { headers: { Authorization: `Bearer ${f.daemon.token}` } },
    );
    expect(turnResponse.status).toBe(200);
    expect((await turnResponse.json()).items.map((item: any) => item.id)).toEqual([current.id]);
    const sessionTurnsResponse = await fetch(
      f.daemon.url +
        '/v1/memory.session_turns?' +
        new URLSearchParams({ session_id: sessions[0]!.id }),
      { headers: { Authorization: `Bearer ${f.daemon.token}` } },
    );
    expect(sessionTurnsResponse.status).toBe(200);
    expect((await sessionTurnsResponse.json()).turns).toEqual([
      {
        turn_id: send.mock.calls.find(([h]) => h.platform_session_id === sessions[0]!.id)![1]
          .turn_id,
        count: 1,
      },
      { turn_id: delivered.turn_id, count: 1 },
    ]);
    expect(read.budget).toMatchObject({ limit_bytes: 12000 });

    const graph = await get('memory.graph', {
      memory_id: current.id,
      state: 'all',
      depth: '2',
      include_tags: 'true',
    });
    expect(graph.edges.some((e: any) => e.kind === 'supersedes' && e.to === old.id)).toBe(true);
    const directory = await get('memory.read', { state: 'all', limit: '1' });
    const next = await get('memory.read', {
      state: 'all',
      limit: '1',
      cursor: directory.next_cursor,
    });
    expect(next.records[0].id).not.toBe(directory.records[0].id);
    for (const c of clients.splice(0)) await c.close();
    await f.close();
    f = await startFixtureDaemon(root, [adapter], options);
    const restored = await f.call('memory.context', { project_id: project.id });
    expect(restored.items.map((r: any) => r.text)).toEqual([
      'Use SQLite with versioned local text',
    ]);
    expect(
      (await f.call('memory.history', { project_id: project.id })).items.some(
        (r: any) => r.id === old.id && r.state === 'archived',
      ),
    ).toBe(true);
  } finally {
    for (const c of clients) await c.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
