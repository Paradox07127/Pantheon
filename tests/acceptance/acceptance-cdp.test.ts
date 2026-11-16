import { afterEach, expect, it } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { connect } from './lib/cdp.mjs';

// The repository's ws package is a dependency of the daemon, not of the root.
const { WebSocketServer } = createRequire(
  fileURLToPath(new URL('../../apps/daemon/package.json', import.meta.url)),
)('ws');

interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}
interface Peer {
  reply: (id: number, result: unknown) => void;
  event: (method: string, params: unknown) => void;
  close: () => void;
}
// Returns a result to answer at once, or undefined to answer later (or never).
type Handler = (request: Request, peer: Peer) => unknown;

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
});

/** A loopback DevTools endpoint with one file: page that reports itself loaded. */
async function fakeDevtools(handle: Handler = () => undefined) {
  const server = http.createServer((request, response) => {
    const { port } = server.address() as { port: number };
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/json/list') {
      response.end(
        JSON.stringify([
          { type: 'service_worker', url: 'file:///sw.js', webSocketDebuggerUrl: 'ws://unused' },
          {
            type: 'page',
            url: 'file:///app/index.html?kind=popover',
            webSocketDebuggerUrl: 'ws://unused',
          },
          {
            type: 'page',
            url: 'file:///app/index.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
          },
        ]),
      );
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket: import('ws').WebSocket) => {
    const peer: Peer = {
      reply: (id, result) => socket.send(JSON.stringify({ id, result })),
      event: (method, params) => socket.send(JSON.stringify({ method, params })),
      close: () => socket.close(1011, 'test closed the page'),
    };
    socket.on('message', (data: Buffer) => {
      const request = JSON.parse(String(data)) as Request;
      const answer = handle(request, peer);
      if (answer !== undefined) peer.reply(request.id, answer);
      else if (request.method.endsWith('.enable')) peer.reply(request.id, {});
      else if (
        request.method === 'Runtime.evaluate' &&
        /readyState|__acceptanceLocator/.test(String(request.params.expression))
      )
        peer.reply(request.id, { result: { type: 'boolean', value: true } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as { port: number }).port };
}

const soon = (ms = 10000) => Date.now() + ms;

it('pairs replies with requests by id when they come back out of order', async () => {
  const held: Request[] = [];
  const { port } = await fakeDevtools((request, peer) => {
    if (!request.method.startsWith('Echo.')) return undefined;
    held.push(request);
    if (held.length === 2) {
      for (const r of [...held].reverse()) peer.reply(r.id, { echoed: r.params.value });
    }
    return undefined;
  });
  const page = await connect(port, soon());
  const [first, second] = await Promise.all([
    page.send('Echo.first', { value: 'one' }),
    page.send('Echo.second', { value: 'two' }),
  ]);
  expect(first).toEqual({ echoed: 'one' });
  expect(second).toEqual({ echoed: 'two' });
  page.close();
});

it('fails a request that gets no answer by its deadline and keeps the connection usable', async () => {
  const { port } = await fakeDevtools((request) =>
    request.method === 'Echo.ping' ? { pong: true } : undefined,
  );
  const page = await connect(port, soon());
  const started = Date.now();
  await expect(page.send('Never.answered', {}, Date.now() + 200)).rejects.toThrow(
    'Timed out: Never.answered',
  );
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await page.send('Echo.ping', {})).toEqual({ pong: true });
  await expect(page.send('Echo.ping', {}, Date.now() - 1)).rejects.toThrow('Timed out: Echo.ping');
  page.close();
});

it('turns a page exception from Runtime.evaluate into a thrown error', async () => {
  const { port } = await fakeDevtools((request) => {
    if (request.method !== 'Runtime.evaluate') return undefined;
    if (request.params.expression === 'missing.value')
      return {
        result: { type: 'object', subtype: 'error' },
        exceptionDetails: {
          text: 'Uncaught',
          exception: {
            type: 'object',
            subtype: 'error',
            description: 'ReferenceError: missing is not defined\n    at <anonymous>:1:1',
          },
        },
      };
    if (request.params.expression === '6 * 7') return { result: { type: 'number', value: 42 } };
    return undefined;
  });
  const page = await connect(port, soon());
  expect(await page.evaluate('6 * 7')).toBe(42);
  await expect(page.evaluate('missing.value')).rejects.toThrow(
    /^Page threw: ReferenceError: missing is not defined$/,
  );
  page.close();
});

it('fails pending and later requests at once when the connection closes', async () => {
  const { port } = await fakeDevtools((request, peer) => {
    if (request.method === 'Close.now') setTimeout(() => peer.close(), 50);
    return undefined;
  });
  const page = await connect(port, soon());
  const started = Date.now();
  const pending = page.send('Never.answered', {}, soon());
  await page.send('Close.now', {}, soon()).catch(() => {});
  await expect(pending).rejects.toThrow('CDP connection closed (code 1011, test closed the page)');
  expect(Date.now() - started).toBeLessThan(2000);
  const later = Date.now();
  await expect(page.send('Echo.ping', {}, soon())).rejects.toThrow('CDP connection closed');
  await expect(page.evaluate('1', soon())).rejects.toThrow('CDP connection closed');
  expect(Date.now() - later).toBeLessThan(100);
});

it('fails pending and later requests at once after a top-level navigation', async () => {
  const { port } = await fakeDevtools((request, peer) => {
    if (request.method === 'Navigate.child')
      peer.event('Page.frameNavigated', {
        frame: { id: 'child', parentId: 'main', url: 'file:///app/frame.html' },
      });
    if (request.method === 'Navigate.child') return { navigated: 'child' };
    if (request.method === 'Navigate.top')
      setTimeout(
        () =>
          peer.event('Page.frameNavigated', {
            frame: { id: 'main', url: 'https://example.invalid/elsewhere' },
          }),
        50,
      );
    return undefined;
  });
  const page = await connect(port, soon());
  expect(await page.send('Navigate.child', {})).toEqual({ navigated: 'child' });
  expect(page.failure).toBeNull();
  const started = Date.now();
  const pending = page.send('Never.answered', {}, soon());
  void page.send('Navigate.top', {}, soon()).catch(() => {});
  await expect(pending).rejects.toThrow('Page navigated to https://example.invalid/elsewhere');
  expect(Date.now() - started).toBeLessThan(2000);
  const later = Date.now();
  await expect(page.send('Echo.ping', {}, soon())).rejects.toThrow('Page navigated to');
  expect(Date.now() - later).toBeLessThan(100);
  page.close();
});
