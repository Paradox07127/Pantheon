import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDaemon } from '@pantheon/daemon';
import type { Project } from '@pantheon/domain';
import { command, type TerminalFrame } from '@pantheon/protocol';
import { DaemonBridge } from '../../apps/desktop/src/main/daemon.js';
import { FakePty } from '../fixtures/fake-pty.js';
import { eventually, user } from '../helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});

// Records each socket the bridge opens and what it sends.
const sockets: { socket: WebSocket; sent: unknown[] }[] = [];
class RecordingSocket extends WebSocket {
  sent: unknown[] = [];
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    sockets.push({ socket: this, sent: this.sent });
  }
  override send(data: Parameters<WebSocket['send']>[0]) {
    this.sent.push(data);
    super.send(data);
  }
}

async function terminalBridge(pty: FakePty) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-desktop-terminal-'));
  mkdirSync(path.join(root, 'project'));
  const directory = path.join(root, 'state');
  const daemon = await startDaemon({ directory, adapters: [], terminalSpawn: () => pty });
  cleanups.push(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'terminal', roots: [path.join(root, 'project')] }),
  ) as Project;
  const { terminal_id } = (await daemon.control.execute(
    user,
    command(user.id, 'terminal.open', { project_id: project.id, cols: 80, rows: 24 }),
  )) as { terminal_id: string };
  const bridge = new DaemonBridge({
    directory,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  return { daemon, bridge, terminal_id };
}

it('sends the token first, relays output as bytes and the exit code, and ends with the exit', async () => {
  sockets.length = 0;
  vi.stubGlobal('WebSocket', RecordingSocket);
  const pty = new FakePty();
  const { daemon, bridge, terminal_id } = await terminalBridge(pty);
  pty.output('replay');
  const frames: TerminalFrame[] = [];
  bridge.terminalSubscribe(terminal_id, (frame) => frames.push(frame));
  await eventually(() => frames.length === 1);
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.socket.url).toBe(
    `${daemon.url.replace('http:', 'ws:')}/v1/terminals/${terminal_id}/ws`,
  );
  expect(sockets[0]!.sent).toEqual([JSON.stringify({ token: daemon.token })]);
  pty.output('live');
  await eventually(() => frames.length === 2);
  pty.exit(3);
  await eventually(() => frames.length === 3);
  const decoded = frames.map((frame) =>
    'data' in frame ? new TextDecoder().decode(frame.data) : frame,
  );
  expect(decoded).toEqual(['replay', 'live', { exit: 3 }]);
  expect(
    frames.slice(0, 2).every((frame) => 'data' in frame && frame.data instanceof Uint8Array),
  ).toBe(true);
});

it('closes the socket when the subscription ends and relays nothing after', async () => {
  sockets.length = 0;
  vi.stubGlobal('WebSocket', RecordingSocket);
  const pty = new FakePty();
  const { bridge, terminal_id } = await terminalBridge(pty);
  const frames: TerminalFrame[] = [];
  const end = bridge.terminalSubscribe(terminal_id, (frame) => frames.push(frame));
  pty.output('first');
  await eventually(() => frames.length === 1);
  end();
  await eventually(() => sockets[0]!.socket.readyState === WebSocket.CLOSED);
  pty.output('later');
  pty.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(frames).toHaveLength(1);
  expect(pty.kill).not.toHaveBeenCalled();
});

it('says once that the stream closed when the socket ends without the exit', async () => {
  sockets.length = 0;
  vi.stubGlobal('WebSocket', RecordingSocket);
  const pty = new FakePty();
  const { bridge, terminal_id } = await terminalBridge(pty);
  const frames: TerminalFrame[] = [];
  bridge.terminalSubscribe(terminal_id, (frame) => frames.push(frame));
  pty.output('first');
  await eventually(() => frames.length === 1);
  sockets[0]!.socket.dispatchEvent(new Event('error'));
  sockets[0]!.socket.close(4000);
  await eventually(() => frames.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(frames.slice(1)).toEqual([{ closed: true }]);
});

it('says nothing more after the exit when the socket then closes', async () => {
  sockets.length = 0;
  vi.stubGlobal('WebSocket', RecordingSocket);
  const pty = new FakePty();
  const { bridge, terminal_id } = await terminalBridge(pty);
  const frames: TerminalFrame[] = [];
  bridge.terminalSubscribe(terminal_id, (frame) => frames.push(frame));
  pty.output('first');
  await eventually(() => frames.length === 1);
  pty.exit(0);
  await eventually(() => sockets[0]!.socket.readyState === WebSocket.CLOSED);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(frames.slice(1)).toEqual([{ exit: 0 }]);
});

it('says the stream closed when the daemon cannot be reached', async () => {
  const { bridge, terminal_id } = await terminalBridge(new FakePty());
  vi.spyOn(bridge, 'connect').mockResolvedValue({
    ok: false,
    error: { code: 'unavailable', message: 'daemon down' },
  } as Awaited<ReturnType<DaemonBridge['connect']>>);
  const frames: TerminalFrame[] = [];
  bridge.terminalSubscribe(terminal_id, (frame) => frames.push(frame));
  await eventually(() => frames.length === 1);
  expect(frames).toEqual([{ closed: true }]);
});
