import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createMcpServer } from '../../apps/cli/dist/mcp.js';

afterEach(() => vi.unstubAllGlobals());

async function inventory(failing: string[]) {
  const runtimes: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = new URL(input.toString());
    if (url.pathname === '/v1/session-principal')
      return Response.json({
        principal: {
          id: 'session:baseline',
          role: 'worker',
          session_id: 'baseline',
          project_id: 'project',
          expires_at: Date.now() + 60_000,
        },
        baseline_id: 'baseline',
        extension_runtimes: ['codex', 'claude'],
      });
    const runtime = url.searchParams.get('runtime')!;
    runtimes.push(runtime);
    if (failing.includes(runtime))
      return Response.json(
        { error: 'invalid_request', message: 'Protocol transport closed' },
        { status: 400 },
      );
    return Response.json({
      runtime,
      mcp_servers: [{ name: 'docs', enabled: true }],
      plugins: [{ id: 'plugin', enabled: true }],
      skills: [{ id: 'skill', name: 'Skill', enabled: true }],
    });
  });
  const server = await createMcpServer('http://127.0.0.1:4321', 'session-token');
  const client = new Client({ name: 'inventory-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return {
      result: await client.callTool({ name: 'project_extensions_inventory', arguments: {} }),
      runtimes,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

it('keeps the available runtime inventory when another runtime fails discovery', async () => {
  const { result, runtimes } = await inventory(['codex']);
  expect(result.isError).not.toBe(true);
  expect(runtimes).toEqual(['codex', 'claude']);
  expect(result.content).toEqual([
    {
      type: 'text',
      text: expect.stringMatching(
        /codex[\s\S]*invalid_request[\s\S]*Protocol transport closed[\s\S]*# Runtime claude[\s\S]*- docs[\s\S]*- plugin[\s\S]*- skill \(Skill\)/,
      ),
    },
  ]);
});

it('reports an error when no runtime could list its inventory', async () => {
  const { result } = await inventory(['codex', 'claude']);
  expect(result.isError).toBe(true);
});
