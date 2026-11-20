import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startDaemon } from '@pantheon/daemon';
import { FixtureAdapter } from '@pantheon/adapters';
import { command } from '@pantheon/protocol';
import type { AgentProfile, Project, Session } from '@pantheon/domain';
import { user } from '../helpers.js';

const TOKEN = 'personal-secret';
const personal = { id: 'personal:k1', role: 'personal' } as const;

let root: string;
let daemon: Awaited<ReturnType<typeof startDaemon>>;
let project: Project;
const diagnostics: unknown[] = [];

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-personal-'));
  mkdirSync(path.join(root, 'project'));
  daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [new FixtureAdapter()],
  });
  daemon.control.on('diagnostic', (error) => diagnostics.push(error));
  project = (await daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'personal', roots: [path.join(root, 'project')] }),
  )) as Project;
  daemon.auth.add(TOKEN, personal);
});
afterAll(async () => {
  await daemon.close();
  rmSync(root, { recursive: true, force: true });
});

const request = (method: string, route: string, body?: unknown) =>
  fetch(daemon.url + route.replace('{project}', project.id), {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it.each([
  ['GET', '/v1/projects.summary', 200],
  ['GET', '/v1/needs_you.list', 200],
  ['GET', '/v1/needs_you.list?project_id={project}', 200],
  ['GET', '/v1/project.brief?project_id={project}', 200],
  ['GET', '/v1/project.decisions?project_id={project}', 200],
  ['GET', '/v1/board', 403],
  ['GET', '/v1/board?project_id={project}', 403],
  ['GET', '/v1/events', 403],
  ['GET', '/v1/events?project_id={project}', 403],
  ['GET', '/v1/session.list?project_id={project}', 403],
  ['GET', '/v1/board.view?project_id={project}&days=14', 403],
  ['GET', '/v1/project.read?project_id={project}', 403],
  ['GET', '/v1/app.settings', 403],
  ['GET', '/v1/session-principal', 403],
  ['GET', '/v1/capabilities', 403],
  ['GET', '/v1/unknown-route', 403],
  ['POST', '/v1/attachments?project_id={project}&name=note.txt', 403],
  ['POST', '/v1/projects.summary', 403],
] as const)('answers %s %s from a personal principal with %i', async (method, route, status) => {
  const response = await request(method, route, method === 'POST' ? {} : undefined);
  expect(response.status).toBe(status);
  if (status === 403)
    expect(((await response.json()) as { error: string }).error).toBe('permission_denied');
});

it('accepts project.seen and refuses commands off its list from a personal principal', async () => {
  const seen = await request(
    'POST',
    '/v1/commands',
    command(personal.id, 'project.seen', { project_id: project.id }),
  );
  expect(seen.status).toBe(200);
  for (const type of ['project.open', 'request.reroute'] as const) {
    const refused = await request('POST', '/v1/commands', command(personal.id, type, {}));
    expect(refused.status).toBe(403);
  }
  // On the list, request.send reaches its input check.
  const send = await request('POST', '/v1/commands', command(personal.id, 'request.send', {}));
  expect(send.status).toBe(400);
});

it('starts no reads it may not make when a personal principal lists the summary', async () => {
  diagnostics.length = 0;
  expect((await request('GET', '/v1/projects.summary')).status).toBe(200);
  expect((await request('GET', '/v1/needs_you.list')).status).toBe(200);
  expect(
    diagnostics.filter((error) => (error as { code?: string }).code === 'permission_denied'),
  ).toEqual([]);
});

it.each([
  ['the event socket for every project', '/v1/events/ws', {}],
  ['the event socket for one project', '/v1/events/ws', { project_id: 'project' }],
  ['a terminal socket', '/v1/terminals/terminal-1/ws', {}],
] as const)('closes %s to a personal principal with 1008', async (_name, route, extra) => {
  const ws = new WebSocket(daemon.url.replace('http:', 'ws:') + route);
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener('close', (e) => resolve(e.code), { once: true }),
  );
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.send(
    JSON.stringify({ token: TOKEN, ...('project_id' in extra ? { project_id: project.id } : {}) }),
  );
  expect(await closed).toBe(1008);
});

it('answers the built-in personal agent on its key until the user revokes the key', async () => {
  const session = (await daemon.control.execute(
    user,
    command(user.id, 'resident.open', { kind: 'personal' }),
  )) as Session;
  const keyId = daemon.store.must<AgentProfile>(
    'agents',
    session.resident!.agent_id!,
  ).personal_key_id!;
  const token = readFileSync(daemon.control['ctx'].personalKeyFile!(keyId).token_file, 'utf8');
  const summary = () =>
    fetch(`${daemon.url}/v1/projects.summary`, { headers: { Authorization: `Bearer ${token}` } });
  expect((await summary()).status).toBe(200);
  await daemon.control.execute(user, command(user.id, 'personal.key.revoke', { key_id: keyId }));
  expect((await summary()).status).toBe(403);
});
