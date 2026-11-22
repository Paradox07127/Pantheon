import { afterEach, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { startDaemon } from '@pantheon/daemon';
import { command } from '@pantheon/protocol';
import type { Project, Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { user } from '../helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
});

async function daemonWithSession(prepare: (directory: string) => void = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-token-file-'));
  const directory = path.join(root, 'state');
  mkdirSync(path.join(root, 'project'));
  prepare(directory);
  const daemon = await startDaemon({ directory, adapters: [], intervalMs: 60_000 });
  cleanup.push(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = (await daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'tokens', roots: [path.join(root, 'project')] }),
  )) as Project;
  const session = daemon.store.insert<Session>('sessions', {
    id: 'baseline-reader',
    revision: 1,
    project_id: project.id,
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
    project_setup: true,
  });
  const ctx = (daemon.control as unknown as { ctx: ControlContext }).ctx;
  return { directory, daemon, session, ctx };
}

it('writes an issued session token to an owner-only file and removes it on revoke', async () => {
  const f = await daemonWithSession();
  const credential = f.ctx.issueSessionCredential!(f.session.id, 'planner');
  expect(credential).not.toHaveProperty('token');
  const file = credential.token_file;
  expect(path.dirname(file)).toBe(path.join(f.directory, 'session-tokens'));
  expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const token = readFileSync(file, 'utf8');
  expect(f.daemon.auth.authenticate(`Bearer ${token}`)).toMatchObject({
    session_id: f.session.id,
    role: 'planner',
  });
  f.ctx.revokeSessionCredential!(f.session.id);
  expect(existsSync(file)).toBe(false);
  expect(() => f.daemon.auth.authenticate(`Bearer ${token}`)).toThrow();
});

it('removes session token files left by an earlier daemon when it starts', async () => {
  const f = await daemonWithSession((directory) => {
    mkdirSync(path.join(directory, 'session-tokens'), { recursive: true });
    writeFileSync(path.join(directory, 'session-tokens', 'earlier-session'), 'stale-token');
  });
  expect(readdirSync(path.join(f.directory, 'session-tokens'))).toEqual([]);
});

it('authenticates the CLI mcp command with the token file named in its environment', async () => {
  const f = await daemonWithSession();
  const credential = f.ctx.issueSessionCredential!(f.session.id, 'planner');
  const client = new Client({ name: 'token-file-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), 'apps/cli/dist/index.js'), 'mcp'],
      // The parent's env carries settings a sandboxed node needs, such as OPENSSL_CONF in a gate.
      env: {
        ...(process.env as Record<string, string>),
        PANTHEON_DAEMON_URL: credential.daemon_url,
        PANTHEON_SESSION_TOKEN_FILE: credential.token_file,
      },
    }),
  );
  cleanup.push(() => client.close());
  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('project_read');
});
