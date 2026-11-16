import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonBridge, packagedLaunch } from '../../apps/desktop/src/main/daemon.js';
import { eventually } from '../helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-packaged-'));
  roots.push(root);
  return root;
}

// Records its argv and env, serves the two routes the bridge reads, and exits after /health.
const fakeDaemon = `
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
const directory = process.argv[process.argv.indexOf('--data-dir') + 1];
writeFileSync(path.join(directory, 'seen.json'), JSON.stringify({
  argv: process.argv.slice(2),
  PATH: process.env.PATH,
  mcp: process.env.PANTHEON_MCP_ENTRY,
}));
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/health')
    return response.end(JSON.stringify({ version: '0.0.0', protocol_version: 1 }), () => process.exit(0));
  response.end('{}');
});
server.listen(0, '127.0.0.1', () => {
  const tokenFile = path.join(directory, 'token');
  writeFileSync(tokenFile, 'secret');
  writeFileSync(path.join(directory, 'daemon.json'), JSON.stringify({
    url: 'http://127.0.0.1:' + server.address().port,
    token_file: tokenFile,
    pid: process.pid,
  }));
});
setTimeout(() => process.exit(1), 20000);
`;

it('points the launch at the node, daemon and CLI inside the app Resources', () => {
  const resources = '/Applications/Pantheon.app/Contents/Resources';
  expect(packagedLaunch(resources, '/login/bin:/usr/bin')).toEqual({
    node: `${resources}/node/bin/node`,
    entry: `${resources}/daemon/dist/main.js`,
    env: { PATH: '/login/bin:/usr/bin', PANTHEON_MCP_ENTRY: `${resources}/cli/dist/index.js` },
  });
  expect(packagedLaunch(resources, undefined).env).toEqual({
    PANTHEON_MCP_ENTRY: `${resources}/cli/dist/index.js`,
  });
});

it('starts the bundled daemon of a packaged app with the launch node, entry and env', async () => {
  const root = tempRoot();
  const directory = path.join(root, 'state');
  mkdirSync(directory);
  const entry = path.join(root, 'daemon.mjs');
  writeFileSync(entry, fakeDaemon);
  const bridge = new DaemonBridge({
    directory,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'logs/daemon.log'),
    launch: {
      node: process.execPath,
      entry,
      env: { PATH: '/login/bin:/usr/bin', PANTHEON_MCP_ENTRY: '/bundle/cli/dist/index.js' },
    },
  });
  const found = await bridge.daemon();
  expect(found).toMatchObject({ ok: true, value: { started_here: true, data_dir: directory } });
  const seen = JSON.parse(readFileSync(path.join(directory, 'seen.json'), 'utf8'));
  expect(seen).toEqual({
    argv: ['--data-dir', directory],
    PATH: '/login/bin:/usr/bin',
    mcp: '/bundle/cli/dist/index.js',
  });
  // The fake daemon exits once it answered /health.
  await eventually(() => {
    try {
      process.kill(bridge.startedPid!, 0);
      return false;
    } catch {
      return true;
    }
  });
});

it('calls a packaged app with missing bundled files damaged, not unbuilt', async () => {
  const root = tempRoot();
  const resources = path.join(root, 'Resources');
  const bridge = new DaemonBridge({
    directory: path.join(root, 'state'),
    packaged: true,
    repo: root,
    logFile: path.join(root, 'logs/daemon.log'),
    launch: packagedLaunch(resources, '/usr/bin'),
  });
  const found = await bridge.daemon();
  expect(found.ok).toBe(false);
  if (found.ok) return;
  expect(found.error.message).toContain(path.join(resources, 'node/bin/node'));
  expect(found.error.message).toMatch(/damaged/);
  expect(found.error.message).not.toMatch(/pnpm build/);
});
