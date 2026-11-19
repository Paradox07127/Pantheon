import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import type { Command } from '@pantheon/protocol';
import { createMcpServer } from '../../apps/cli/src/mcp.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
  vi.unstubAllGlobals();
});

it('offers plain proposal tools to the lead with bound project and revision and sends their commands', async () => {
  const sent: Command[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/v1/session-principal')
      return Response.json({
        principal: {
          id: 'session:lead',
          role: 'lead',
          session_id: 'lead',
          project_id: 'project',
          expires_at: Date.now() + 60_000,
        },
      });
    sent.push((await request.json()) as Command);
    return Response.json({ receipt: { proposal_id: 'proposal' } });
  });
  const server = await createMcpServer('http://127.0.0.1:4321', 'session-token');
  const client = new Client({ name: 'proposal-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  expect(client.getServerVersion()).toEqual({
    name: 'pantheon',
    version: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
      .version,
  });
  const tools = (await client.listTools()).tools;
  const propose = tools.find((tool) => tool.name === 'propose_board')!;
  const withdraw = tools.find((tool) => tool.name === 'withdraw_board_proposal')!;
  expect(propose.description).toContain('card for the user');
  expect(propose.description).toContain('withdraw_board_proposal');
  expect(Object.keys(propose.inputSchema.properties ?? {})).toEqual([
    'base_version',
    'trigger_event',
    'reason',
    'ops',
  ]);
  expect(Object.keys(withdraw.inputSchema.properties ?? {})).toEqual(['proposal_id']);
  const arguments_ = {
    base_version: 2,
    reason: 'Split the requested task',
    ops: [{ type: 'remove_task', task_id: 'api' }],
  };
  expect(
    (await client.callTool({ name: 'propose_board', arguments: arguments_ })).isError,
  ).not.toBe(true);
  expect(
    (
      await client.callTool({
        name: 'withdraw_board_proposal',
        arguments: { proposal_id: 'proposal' },
      })
    ).isError,
  ).not.toBe(true);
  expect(sent).toMatchObject([
    {
      type: 'board.plan.propose',
      expected_revision: null,
      input: { project_id: 'project', ...arguments_ },
    },
    {
      type: 'board.plan.proposal.withdraw',
      expected_revision: null,
      input: { project_id: 'project', proposal_id: 'proposal' },
    },
  ]);
});
