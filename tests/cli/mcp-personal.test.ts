import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import type { Command } from '@pantheon/protocol';
import { createMcpServer } from '../../apps/cli/dist/mcp.js';
import { createPersonalMcpServer } from '../../apps/cli/dist/personal-tools.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
  vi.unstubAllGlobals();
});

type Seen = { method: string; url: URL; authorization: string | null; body?: Command };

function stubDaemon(answer: (seen: Seen) => unknown) {
  const seen: Seen[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const entry: Seen = {
      method: request.method,
      url: new URL(request.url),
      authorization: request.headers.get('authorization'),
      ...(request.method === 'POST' ? { body: (await request.json()) as Command } : {}),
    };
    seen.push(entry);
    return Response.json(answer(entry));
  });
  return seen;
}

async function connect(server: Awaited<ReturnType<typeof createMcpServer>>) {
  const client = new Client({ name: 'personal-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

it('lists the five personal tools for a personal key', async () => {
  stubDaemon(() => ({}));
  const client = await connect(
    await createPersonalMcpServer('http://127.0.0.1:4321', 'personal-token', 'key'),
  );
  expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
    'answer_decision',
    'needs_you',
    'project_brief',
    'project_decisions',
    'projects_overview',
  ]);
});

it('sends needs_you to the daemon with the personal key and returns its answer', async () => {
  const seen = stubDaemon(() => ({ items: [{ kind: 'lead.question', project_id: 'project' }] }));
  const client = await connect(
    await createPersonalMcpServer('http://127.0.0.1:4321', 'personal-token', 'key'),
  );
  const listed = await client.callTool({
    name: 'needs_you',
    arguments: { project_id: 'project' },
  });
  expect(listed.isError).not.toBe(true);
  expect(listed.content).toEqual([
    {
      type: 'text',
      text: JSON.stringify({ items: [{ kind: 'lead.question', project_id: 'project' }] }),
    },
  ]);
  expect(seen).toMatchObject([
    {
      method: 'GET',
      authorization: 'Bearer personal-token',
      url: { pathname: '/v1/needs_you.list', search: '?project_id=project' },
    },
  ]);
});

it('still serves the session tools to a session token', async () => {
  stubDaemon(() => ({
    principal: {
      id: 'session:lead',
      role: 'lead',
      session_id: 'lead',
      project_id: 'project',
      expires_at: Date.now() + 60_000,
    },
  }));
  const client = await connect(await createMcpServer('http://127.0.0.1:4321', 'session-token'));
  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('propose_board');
});

it('refuses mcp --personal without a personal token file', () => {
  const env = { ...process.env };
  delete env.PANTHEON_PERSONAL_TOKEN_FILE;
  delete env.PANTHEON_SESSION_TOKEN_FILE;
  const result = spawnSync('node', [path.resolve('apps/cli/dist/index.js'), 'mcp', '--personal'], {
    encoding: 'utf8',
    env,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('permission_denied: PANTHEON_PERSONAL_TOKEN_FILE required');
});
