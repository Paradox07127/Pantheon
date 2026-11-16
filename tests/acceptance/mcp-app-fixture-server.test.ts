import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const resourceUri = 'ui://pantheon-fixture/counter.html';

describe('MCP App fixture server', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: 'mcp-app-fixture-test', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve('tests/acceptance/fixtures/mcp-app-server/server.mjs')],
        // The parent's env carries settings a sandboxed node needs, such as OPENSSL_CONF in a gate.
        env: { ...(process.env as Record<string, string>) },
        stderr: 'pipe',
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
  });

  it('lists three tools with their UI metadata', async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(['bump', 'secret', 'show_counter']);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.show_counter!._meta).toEqual({
      ui: { resourceUri, visibility: ['model', 'app'] },
      'ui/resourceUri': resourceUri,
    });
    expect(byName.bump!._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(byName.secret!._meta).toEqual({ ui: { visibility: ['model'] } });
  });

  it('returns the start value as text and structured content', async () => {
    const result = await client.callTool({ name: 'show_counter', arguments: { start: 3 } });
    expect(result.content).toEqual([{ type: 'text', text: 'Counter starts at 3' }]);
    expect(result.structuredContent).toEqual({ start: 3 });
  });

  it('lists and reads the counter page as an MCP App resource', async () => {
    const listed = (await client.listResources()).resources;
    expect(listed).toEqual([
      expect.objectContaining({ uri: resourceUri, mimeType: 'text/html;profile=mcp-app' }),
    ]);
    const { contents } = await client.readResource({ uri: resourceUri });
    expect(contents).toHaveLength(1);
    const page = contents[0]!;
    expect(page.mimeType).toBe('text/html;profile=mcp-app');
    expect(page._meta).toEqual({
      ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
    });
    expect('text' in page && page.text).toContain('ui/initialize');
  });
});
