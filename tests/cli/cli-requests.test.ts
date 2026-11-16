import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';

const run = promisify(execFile);
const requests: { method: string; url: string; body: string }[] = [];
let server: http.Server;
let dataDir: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method!, url: req.url!, body });
      if (req.url?.startsWith('/v1/extensions.inventory') || req.url === '/v1/runtime.models')
        setTimeout(() => res.setHeader('Content-Type', 'application/json').end('{}'), 6000);
      else res.setHeader('Content-Type', 'application/json').end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-cli-'));
  writeFileSync(path.join(dataDir, 'token'), 'user-token');
  writeFileSync(
    path.join(dataDir, 'daemon.json'),
    JSON.stringify({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token_file: path.join(dataDir, 'token'),
    }),
  );
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

it.each([
  {
    args: ['trace.time', '--project', 'p1', '--param', 'lane_key=lead'],
    method: 'GET',
    url: '/v1/trace.time?project_id=p1&lane_key=lead',
    body: '',
  },
  {
    args: ['memory.read', '--param', 'tag=a', '--param', 'tag=b'],
    method: 'GET',
    url: '/v1/memory.read?tag=a&tag=b',
    body: '',
  },
  {
    args: ['command', '--json', '{"type":"session.rename"}'],
    method: 'POST',
    url: '/v1/commands',
    body: '{"type":"session.rename"}',
  },
])('sends $method $url for cli $args', async ({ args, method, url, body }) => {
  requests.length = 0;
  await run('node', [path.resolve('apps/cli/dist/index.js'), ...args, '--data-dir', dataDir]);
  expect(requests).toEqual([{ method, url, body }]);
});

it.each(['extensions.inventory', 'runtime.models'])(
  'waits for %s discovery that takes more than five seconds',
  async (method) => {
    await expect(
      run('node', [path.resolve('apps/cli/dist/index.js'), method, '--data-dir', dataDir]),
    ).resolves.toMatchObject({ stdout: '{}\n', stderr: '' });
  },
);
