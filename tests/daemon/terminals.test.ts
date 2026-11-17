import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '@pantheon/daemon';
import type { TerminalSpawn } from '@pantheon/control';
import type { Project, Session } from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import { eventually, ptyUsable, user } from '../helpers.js';
import { FakePty } from '../fixtures/fake-pty.js';

// ws is a dependency of the daemon only; its types come from the root @types/ws.
const { WebSocket } = createRequire(new URL('../../apps/daemon/package.json', import.meta.url))(
  'ws',
) as typeof import('ws');

async function terminalDaemon(spawn: TerminalSpawn) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-terminal-'));
  const projectRoot = path.join(root, 'project');
  mkdirSync(projectRoot);
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    terminalSpawn: spawn,
  });
  const project = (await daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'terminal', roots: [projectRoot] }),
  )) as Project;
  const open = async () =>
    (await daemon.control.execute(
      user,
      command(user.id, 'terminal.open', { project_id: project.id, cols: 80, rows: 24 }),
    )) as { terminal_id: string };
  const connect = (terminal_id: string, token = daemon.token) => {
    const ws = new WebSocket(
      daemon.url.replace('http:', 'ws:') + `/v1/terminals/${terminal_id}/ws`,
    );
    const frames: { data: Buffer; binary: boolean }[] = [];
    ws.on('message', (data: Buffer, binary: boolean) => frames.push({ data, binary }));
    ws.on('open', () => ws.send(JSON.stringify({ token })));
    const closed = new Promise<number>((resolve) => ws.on('close', resolve));
    return { ws, frames, closed };
  };
  return {
    daemon,
    project,
    open,
    connect,
    async close() {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('refuses terminal sockets from untrusted origins and rejects unknown or unauthenticated terminals', async () => {
  const f = await terminalDaemon(() => new FakePty());
  try {
    const { terminal_id } = await f.open();
    const denied = new WebSocket(
      f.daemon.url.replace('http:', 'ws:') + `/v1/terminals/${terminal_id}/ws`,
      { origin: 'https://untrusted.example' },
    );
    await expect(new Promise((_, reject) => denied.on('error', reject))).rejects.toThrow();
    expect(await f.connect('unknown-terminal').closed).toBe(1008);
    expect(await f.connect(terminal_id, 'invalid-token').closed).toBe(1008);
    const session = f.daemon.store.insert<Session>('sessions', {
      id: 'terminal-reader',
      revision: 1,
      project_id: f.project.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
    });
    expect(
      await f.connect(terminal_id, f.daemon.auth.issueSession(session, 'planner')).closed,
    ).toBe(1008);
  } finally {
    await f.close();
  }
});

it('sends replay as binary before live output, accepts input only through commands and closes with an exit frame', async () => {
  const pty = new FakePty();
  const f = await terminalDaemon(() => pty);
  try {
    const { terminal_id } = await f.open();
    pty.output('replay');
    const client = f.connect(terminal_id);
    await eventually(() => client.frames.length === 1);
    pty.output('live');
    const response = await fetch(f.daemon.url + '/v1/commands', {
      method: 'POST',
      headers: { Authorization: `Bearer ${f.daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command(user.id, 'terminal.write', { terminal_id, data: 'pwd\r' })),
    });
    expect(response.status).toBe(200);
    expect(pty.write).toHaveBeenCalledExactlyOnceWith('pwd\r');
    pty.exit(3);
    expect(await client.closed).toBe(1000);
    expect(client.frames.map((frame) => [frame.data.toString(), frame.binary])).toEqual([
      ['replay', true],
      ['live', true],
      ['{"type":"exit","code":3}', false],
    ]);
    const reopened = f.connect(terminal_id);
    await reopened.closed;
    expect(reopened.frames.map((frame) => [frame.data.toString(), frame.binary])).toEqual([
      ['replaylive', true],
      ['{"type":"exit","code":3}', false],
    ]);
    const inputSocket = f.connect((await f.open()).terminal_id);
    await new Promise<void>((resolve) => inputSocket.ws.once('open', resolve));
    inputSocket.ws.send('unrouted input');
    expect(await inputSocket.closed).toBe(1008);
    expect(pty.write).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

let nativeSpawn: TerminalSpawn | undefined;
try {
  const require = createRequire(new URL('../../packages/control/package.json', import.meta.url));
  const pty = await import(require.resolve('node-pty'));
  nativeSpawn = (_file, _args, options) => pty.spawn('/bin/sh', ['-c', 'echo ready'], options);
} catch {
  // Native loading is optional so the daemon can still start without a usable binary.
}

it.skipIf(!nativeSpawn || !ptyUsable)(
  'streams ready and the exit frame from a real node-pty shell',
  async () => {
    const f = await terminalDaemon(nativeSpawn!);
    try {
      const { terminal_id } = await f.open();
      const client = f.connect(terminal_id);
      expect(await client.closed).toBe(1000);
      const output = Buffer.concat(
        client.frames.filter((frame) => frame.binary).map((frame) => frame.data),
      );
      expect(output.toString()).toContain('ready');
      expect(JSON.parse(client.frames.at(-1)!.data.toString())).toEqual({ type: 'exit', code: 0 });
    } finally {
      await f.close();
    }
  },
);
