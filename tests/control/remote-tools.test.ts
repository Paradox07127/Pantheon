import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import { serveSessionTools } from '../../packages/control/src/remote-tools.js';
import { eventually } from '../helpers.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it('relays a line to a tools process per connection and ends it on close', async () => {
  // A socket path must stay short, so the directory is the system's own.
  const root = mkdtempSync(path.join(os.tmpdir(), 'tools-relay-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const echo = path.join(root, 'echo.mjs'),
    pidFile = path.join(root, 'pid'),
    socket = path.join(root, 'tools.sock');
  writeFileSync(
    echo,
    [
      "import { writeFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline';",
      'writeFileSync(process.env.ECHO_PID_FILE, String(process.pid));',
      "createInterface({ input: process.stdin }).on('line', (line) => process.stdout.write(line + '\\n'));",
    ].join('\n'),
  );
  const relay = await serveSessionTools(
    { command: process.execPath, args: [echo], env: { ECHO_PID_FILE: pidFile } },
    socket,
  );
  let closed = false;
  cleanups.push(() => closed || relay.close());

  const connection = net.createConnection(socket);
  const reply = new Promise<string>((resolve, reject) => {
    connection.once('error', reject);
    createInterface({ input: connection }).once('line', resolve);
  });
  connection.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  expect(await reply).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(running(pid)).toBe(true);

  relay.close();
  closed = true;
  expect(existsSync(socket)).toBe(false);
  await eventually(() => !running(pid));
});

it('lets no other account connect to the session tools socket', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tools-relay-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const socket = path.join(root, 'tools.sock');
  const relay = await serveSessionTools({ command: 'true', args: [], env: {} }, socket);
  cleanups.push(() => relay.close());

  expect((statSync(socket).mode & 0o777).toString(8)).toBe('600');
});
