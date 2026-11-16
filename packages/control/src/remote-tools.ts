import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { nativeEnvironment } from '@pantheon/adapters';
import type { SessionSpec } from '@pantheon/domain';

/** Listens on a local socket and joins each connection to its own session tools process. */
export async function serveSessionTools(
  server: NonNullable<SessionSpec['pantheon_mcp']>,
  socket: string,
): Promise<{ close(): void }> {
  const connections = new Set<net.Socket>(),
    children = new Set<ChildProcess>();
  const listener = net.createServer((connection) => {
    const child = spawn(server.command, server.args, {
      env: { ...nativeEnvironment(), ...server.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    connections.add(connection);
    children.add(child);
    connection.pipe(child.stdin);
    child.stdout.pipe(connection);
    // Each side's error is followed by its close, which ends the other side.
    connection.on('error', () => child.kill());
    child.stdin.on('error', () => connection.destroy());
    child.on('error', () => connection.destroy());
    connection.on('close', () => {
      connections.delete(connection);
      child.kill();
    });
    child.on('close', () => {
      children.delete(child);
      connection.end();
    });
  });
  rmSync(socket, { force: true });
  // The socket is bound in a private directory and only moved to its path once no other account
  // can connect to it: each connection gets a tools process with the session's credentials.
  const directory = mkdtempSync(path.join(path.dirname(socket), 'pantheon-tools-'));
  try {
    const bound = path.join(directory, 's');
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(bound, resolve);
    });
    chmodSync(bound, 0o600);
    renameSync(bound, socket);
  } catch (error) {
    listener.close();
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return {
    close() {
      listener.close();
      for (const connection of connections) connection.destroy();
      for (const child of children) child.kill();
      rmSync(socket, { force: true });
    },
  };
}
