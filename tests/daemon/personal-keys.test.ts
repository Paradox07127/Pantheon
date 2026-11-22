import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDaemon } from '@pantheon/daemon';
import { FixtureAdapter } from '@pantheon/adapters';
import { command, type CommandType } from '@pantheon/protocol';
import { id, type Project, type Session } from '@pantheon/domain';
import { user } from '../helpers.js';

let root: string;
let daemon: Awaited<ReturnType<typeof startDaemon>>;
let project: Project;
// The failpoint that throws, and what runs just before it throws.
let failing: { name: string; before?: () => void } | undefined;

const start = async () =>
  (daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [new FixtureAdapter()],
    failpoint: (name) => {
      if (name !== failing?.name) return;
      failing.before?.();
      throw new Error(`failpoint ${name}`);
    },
  }));
const keysFolder = () => path.join(root, 'state', 'personal-keys');

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-personal-keys-'));
  mkdirSync(path.join(root, 'project'));
  await start();
  project = (await daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'keys', roots: [path.join(root, 'project')] }),
  )) as Project;
});
afterAll(async () => {
  await daemon.close();
  rmSync(root, { recursive: true, force: true });
});

const call = async (token: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(daemon.url + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
};
const send = (token: string, actor: string, type: CommandType, input: Record<string, unknown>) =>
  call(token, 'POST', '/v1/commands', command(actor, type, input));
const summary = (token: string) => call(token, 'GET', '/v1/projects.summary');

async function createKey(label: string) {
  const created = await send(daemon.token, user.id, 'personal.key.create', { label });
  expect(created.status).toBe(200);
  const receipt = created.body.receipt as { key_id: string; token_file: string };
  return { receipt, token: readFileSync(receipt.token_file, 'utf8') };
}

it('writes a new key to a file only the user can read, and its token reaches the summary', async () => {
  const { receipt, token } = await createKey('phone');
  expect(statSync(receipt.token_file).mode & 0o777).toBe(0o600);
  expect((await summary(token)).status).toBe(200);
});

it('keeps the token text out of the receipt and every stored receipt and event', async () => {
  const { receipt, token } = await createKey('laptop');
  expect(token.length).toBeGreaterThan(0);
  const stored = [
    ...daemon.store.db.prepare('SELECT receipt AS text FROM inbox').all(),
    ...daemon.store.db.prepare('SELECT payload AS text FROM events').all(),
    ...daemon.store.db.prepare('SELECT data AS text FROM personal_keys').all(),
  ] as { text: string }[];
  expect(stored.length).toBeGreaterThan(0);
  for (const { text } of stored) expect(text).not.toContain(token);
  expect(Object.keys(receipt).sort()).toEqual(['key_id', 'token_file']);
});

it('lists each key without its digest', async () => {
  const { receipt } = await createKey('tablet');
  const listed = await call(daemon.token, 'GET', '/v1/personal.key.list');
  expect(listed.status).toBe(200);
  expect(listed.body).toContainEqual({
    id: receipt.key_id,
    label: 'tablet',
    created_at: expect.any(Number),
  });
  for (const key of listed.body) expect(Object.keys(key)).not.toContain('digest');
});

it('refuses a revoked key at once and removes its file', async () => {
  const { receipt, token } = await createKey('watch');
  expect((await summary(token)).status).toBe(200);
  const revoked = await send(daemon.token, user.id, 'personal.key.revoke', {
    key_id: receipt.key_id,
  });
  expect(revoked.status).toBe(200);
  const refused = await summary(token);
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe('permission_denied');
  expect(() => statSync(receipt.token_file)).toThrow();
  const listed = await call(daemon.token, 'GET', '/v1/personal.key.list');
  expect(listed.body).toContainEqual({
    id: receipt.key_id,
    label: 'watch',
    created_at: expect.any(Number),
    revoked_at: expect.any(Number),
  });
});

it('keeps a live key working and a revoked key refused after a restart on the same data', async () => {
  const live = await createKey('desk');
  const revoked = await createKey('old phone');
  expect(
    (await send(daemon.token, user.id, 'personal.key.revoke', { key_id: revoked.receipt.key_id }))
      .status,
  ).toBe(200);
  await daemon.close();
  await start();
  expect((await summary(live.token)).status).toBe(200);
  const refused = await summary(revoked.token);
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe('permission_denied');
});

it('revokes a key whose token file the user already deleted', async () => {
  const { receipt, token } = await createKey('deleted file');
  rmSync(receipt.token_file);
  const revoked = await send(daemon.token, user.id, 'personal.key.revoke', {
    key_id: receipt.key_id,
  });
  expect(revoked.status).toBe(200);
  expect((await summary(token)).status).toBe(403);
});

it('keeps a key live and its file in place when its revoke rolls back', async () => {
  const { receipt, token } = await createKey('rolled back revoke');
  failing = { name: 'before_transaction_commit' };
  try {
    const revoked = await send(daemon.token, user.id, 'personal.key.revoke', {
      key_id: receipt.key_id,
    });
    expect(revoked.status).not.toBe(200);
  } finally {
    failing = undefined;
  }
  const listed = await call(daemon.token, 'GET', '/v1/personal.key.list');
  expect(listed.body).toContainEqual({
    id: receipt.key_id,
    label: 'rolled back revoke',
    created_at: expect.any(Number),
  });
  expect((await summary(token)).status).toBe(200);
  expect(readFileSync(receipt.token_file, 'utf8')).toBe(token);
});

it('leaves no row, file or working token when a create rolls back', async () => {
  const filesBefore = readdirSync(keysFolder()).sort(),
    rowsBefore = daemon.store.list('personal_keys').length;
  let token = '';
  failing = {
    name: 'before_transaction_commit',
    before: () => {
      const added = readdirSync(keysFolder()).find((name) => !filesBefore.includes(name))!;
      token = readFileSync(path.join(keysFolder(), added), 'utf8');
    },
  };
  try {
    const created = await send(daemon.token, user.id, 'personal.key.create', { label: 'lost' });
    expect(created.status).not.toBe(200);
  } finally {
    failing = undefined;
  }
  expect(token.length).toBeGreaterThan(0);
  expect(daemon.store.list('personal_keys')).toHaveLength(rowsBefore);
  expect(readdirSync(keysFolder()).sort()).toEqual(filesBefore);
  expect((await summary(token)).status).toBe(403);
});

it('finishes at start a revoke whose file was set aside but whose row is still live', async () => {
  const { receipt, token } = await createKey('interrupted revoke');
  await daemon.close();
  renameSync(receipt.token_file, `${receipt.token_file}.revoked`);
  await start();
  const listed = await call(daemon.token, 'GET', '/v1/personal.key.list');
  expect(listed.body).toContainEqual({
    id: receipt.key_id,
    label: 'interrupted revoke',
    created_at: expect.any(Number),
    revoked_at: expect.any(Number),
  });
  expect((await summary(token)).status).toBe(403);
  expect(existsSync(receipt.token_file)).toBe(false);
  expect(existsSync(`${receipt.token_file}.revoked`)).toBe(false);
});

it('removes partial files and files of unknown keys at start and keeps live key files', async () => {
  const live = await createKey('kept');
  await daemon.close();
  const partial = path.join(keysFolder(), `${id()}.0123456789ab.tmp`),
    unknown = path.join(keysFolder(), id());
  writeFileSync(partial, 'partial', { mode: 0o600 });
  writeFileSync(unknown, 'unknown', { mode: 0o600 });
  await start();
  expect(existsSync(partial)).toBe(false);
  expect(existsSync(unknown)).toBe(false);
  expect(readFileSync(live.receipt.token_file, 'utf8')).toBe(live.token);
});

it('refuses to start when the key folder is a symlink', async () => {
  const directory = path.join(root, 'linked'),
    elsewhere = path.join(root, 'elsewhere');
  mkdirSync(directory);
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, path.join(directory, 'personal-keys'));
  await expect(startDaemon({ directory, adapters: [new FixtureAdapter()] })).rejects.toThrow(
    path.join(directory, 'personal-keys'),
  );
});

it('makes an existing key folder private at start', async () => {
  const directory = path.join(root, 'open');
  mkdirSync(path.join(directory, 'personal-keys'), { recursive: true });
  chmodSync(path.join(directory, 'personal-keys'), 0o755);
  const other = await startDaemon({ directory, adapters: [new FixtureAdapter()] });
  try {
    expect(statSync(path.join(directory, 'personal-keys')).mode & 0o777).toBe(0o700);
  } finally {
    await other.close();
  }
});

const callers = {
  'a session': () => {
    const session = daemon.store.insert<Session>('sessions', {
      id: id(),
      revision: 1,
      project_id: project.id,
      runtime: 'fixture',
      state: 'open',
      turn_count: 0,
      project_setup: true,
    });
    return Promise.resolve({
      token: daemon.auth.issueSession(session, 'planner'),
      actor: `session:${session.id}`,
    });
  },
  'a personal agent': async () => {
    const { receipt, token } = await createKey('agent');
    return { token, actor: `personal:${receipt.key_id}` };
  },
};

it.each([
  ['personal.key.create', 'a session'],
  ['personal.key.revoke', 'a session'],
  ['personal.key.list', 'a session'],
  ['personal.key.create', 'a personal agent'],
  ['personal.key.revoke', 'a personal agent'],
  ['personal.key.list', 'a personal agent'],
] as const)('refuses %s from %s', async (method, caller) => {
  const { token, actor } = await callers[caller]();
  const { receipt: target } = await createKey('target');
  const answer =
    method === 'personal.key.list'
      ? await call(token, 'GET', '/v1/personal.key.list')
      : await send(
          token,
          actor,
          method,
          method === 'personal.key.create' ? { label: 'stolen' } : { key_id: target.key_id },
        );
  expect(answer.status).toBe(403);
  expect(answer.body.error).toBe('permission_denied');
  expect((await summary(readFileSync(target.token_file, 'utf8'))).status).toBe(200);
});
