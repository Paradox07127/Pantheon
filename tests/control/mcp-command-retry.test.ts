import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import type { Command } from '@pantheon/protocol';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
  vi.unstubAllGlobals();
});

/** Stands for a daemon that keeps one receipt per idempotency key, as Control does. */
function fakeDaemon() {
  const sent: Command[] = [];
  const executed: Command[] = [];
  const receipts = new Map<string, unknown>();
  const daemon = {
    sent,
    executed,
    lostReplies: 0,
    brokenBodies: 0,
    refusal: undefined as string | undefined,
    principalRequests: 0,
    unansweredPrincipals: 0,
    principalRefusal: undefined as string | undefined,
  };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/v1/session-principal') {
      daemon.principalRequests++;
      if (daemon.unansweredPrincipals > 0) {
        daemon.unansweredPrincipals--;
        throw new TypeError('fetch failed');
      }
      if (daemon.principalRefusal)
        return Response.json({ error: daemon.principalRefusal }, { status: 403 });
      return Response.json({
        principal: {
          id: 'session:worker-session',
          role: 'worker',
          session_id: 'worker-session',
          project_id: 'project-one',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    }
    const body = (await request.json()) as Command;
    sent.push(body);
    if (daemon.refusal)
      return Response.json({ error: daemon.refusal, message: 'Refused here' }, { status: 400 });
    if (!receipts.has(body.idempotency_key)) {
      executed.push(body);
      receipts.set(body.idempotency_key, { id: `report-${executed.length}` });
    }
    if (daemon.lostReplies > 0) {
      daemon.lostReplies--;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }
    if (daemon.brokenBodies > 0) {
      daemon.brokenBodies--;
      // The headers arrive, then the connection drops partway through the body.
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"receipt":'));
          controller.error(new DOMException('The operation was aborted', 'AbortError'));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }
    return Response.json({ receipt: receipts.get(body.idempotency_key) });
  });
  return daemon;
}

/** One MCP server process; connecting again stands for a restarted MCP child. */
async function connect() {
  const { createMcpServer } = await import('../../apps/cli/src/mcp.js');
  const server = await createMcpServer('http://127.0.0.1:4321', 'session-token');
  const client = new Client({ name: 'retry-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const report = { kind: 'risk', text: 'The export endpoint has no rate limit' };
const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
  (result.content as { text: string }[])[0]!.text;

it.each([
  [
    'sends a command again unchanged when its reply is lost after the daemon executed it',
    'lostReplies',
  ],
  ['sends a command again when the connection drops while its reply body is read', 'brokenBodies'],
] as const)('%s', async (_name, fault) => {
  const daemon = fakeDaemon();
  daemon[fault] = 1;
  const client = await connect();
  const result = await client.callTool({ name: 'report', arguments: report });
  expect(result.isError, text(result)).toBeFalsy();
  expect(JSON.parse(text(result))).toEqual({ receipt: { id: 'report-1' } });
  expect(daemon.executed).toHaveLength(1);
  expect(daemon.sent).toHaveLength(2);
  expect(daemon.sent[1]).toEqual(daemon.sent[0]);
});

it('gives up after three resends when the daemon stays unreachable', async () => {
  const daemon = fakeDaemon();
  daemon.lostReplies = 4;
  const client = await connect();
  const result = await client.callTool({ name: 'report', arguments: report });
  expect(text(result)).toBe('Refused report: daemon_unavailable');
  expect(daemon.sent).toHaveLength(4);
  expect(new Set(daemon.sent.map((sent) => sent.idempotency_key)).size).toBe(1);
  expect(daemon.executed).toHaveLength(1);
});

it('does not send a command again when the daemon refuses it', async () => {
  const daemon = fakeDaemon();
  daemon.refusal = 'conflict';
  const client = await connect();
  const result = await client.callTool({ name: 'report', arguments: report });
  expect(text(result)).toBe('Refused report: conflict — Refused here');
  expect(daemon.sent).toHaveLength(1);
});

it("keys a command by the runtime's tool call id, also across a restarted MCP server", async () => {
  const daemon = fakeDaemon();
  const call = (client: Client, meta?: Record<string, string>) =>
    client.callTool({ name: 'report', arguments: report, ...(meta ? { _meta: meta } : {}) });
  const first = await connect();
  await call(first, { 'claudecode/toolUseId': 'toolu_one' });
  await call(first, { 'claudecode/toolUseId': 'toolu_two' });
  const restarted = await connect();
  await call(restarted, { 'claudecode/toolUseId': 'toolu_one' });
  await call(restarted, { callId: 'call_one' });
  await call(restarted, { callId: 'call_one' });
  await call(restarted);
  await call(restarted);
  const keys = daemon.sent.map((sent) => sent.idempotency_key);
  expect(keys[2]).toBe(keys[0]);
  expect(keys[4]).toBe(keys[3]);
  expect(new Set([keys[0], keys[1], keys[3], keys[5], keys[6]]).size).toBe(5);
  expect(daemon.executed).toHaveLength(5);
});

it('asks the daemon for the session identity again when its first request goes unanswered', async () => {
  const daemon = fakeDaemon();
  daemon.unansweredPrincipals = 1;
  const client = await connect();
  expect(daemon.principalRequests).toBe(2);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toContain('report');
});

it('fails at once when the daemon refuses the session identity', async () => {
  const daemon = fakeDaemon();
  daemon.principalRefusal = 'permission_denied';
  await expect(connect()).rejects.toMatchObject({ code: 'permission_denied' });
  expect(daemon.principalRequests).toBe(1);
});
