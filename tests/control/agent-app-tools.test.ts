import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../apps/cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { startDaemon } from '@pantheon/daemon';
import {
  id,
  type AgentProfile,
  type Principal,
  type Project,
  type Session,
  type SessionTurn,
} from '@pantheon/domain';
import { command, type CommandType } from '@pantheon/protocol';
import type { ControlContext } from '../../packages/control/dist/context.js';
import { ensureAgents } from '../../packages/control/dist/agents.js';
import type { LocalCommand } from '../../packages/control/src/local-command.js';
import { fixture, user } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from './workbench-fixture.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse().splice(0)) await close();
});

const credential = (session: Session, role: Principal['role'] = 'lead'): Principal => ({
  id: `session:${session.id}`,
  role,
  project_id: session.project_id,
  session_id: session.id,
  expires_at: Date.now() + 60000,
});

type Caller = { control: { execute: (p: Principal, c: ReturnType<typeof command>) => unknown } };
const run = async <T>(f: Caller, p: Principal, type: CommandType, input: Record<string, unknown>) =>
  (await f.control.execute(p, command(p.id, type, input))) as T;
const refusal = async (
  f: Caller,
  p: Principal,
  type: CommandType,
  input: Record<string, unknown>,
) => {
  try {
    await run(f, p, type, input);
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return 'accepted';
};

const openResident = (f: Awaited<ReturnType<typeof workbenchFixture>>) =>
  f.call<Session>('resident.open', { project_id: f.project.id, kind: 'assistant' });

it("lists the project's sessions with type and state, reads a long one within its size, and refuses another project's", async () => {
  const f = await workbenchFixture();
  const residentSession = openResident(f);
  const resident = credential(residentSession);
  const direct = await f.create('Explain the answer file');
  const worker = await boundTaskSession(f, residentSession.id, 'a');

  const { sessions } = await run<{
    sessions: { id: string; type: string; state: string; runtime: string }[];
  }>(f, resident, 'agent.sessions', {});
  const listed = new Map(sessions.map((s) => [s.id, s]));
  expect(listed.get(residentSession.id)).toMatchObject({ type: 'resident' });
  expect(listed.get(direct.id)).toMatchObject({ type: 'direct', runtime: f.adapter.name });
  expect(listed.get(worker.id)).toMatchObject({ type: 'worker' });
  for (const session of sessions) expect(typeof session.state).toBe('string');
  const state = listed.get(direct.id)!.state;
  const filtered = await run<{ sessions: { state: string }[] }>(f, resident, 'agent.sessions', {
    state,
  });
  expect(filtered.sessions.length).toBeGreaterThan(0);
  expect(filtered.sessions.every((s) => s.state === state)).toBe(true);

  const long = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: f.project.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 30,
    title: 'Long conversation',
  });
  const turnIds: string[] = [];
  for (let n = 0; n < 30; n++) {
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id: id(),
      revision: 1,
      project_id: f.project.id,
      session_id: long.id,
      input: `Question ${n} ${'q'.repeat(3000)}`,
      kind: 'send',
      delivery: 'delivered',
      state: 'completed',
    });
    turnIds.push(turn.id);
    f.store.event('agent.message.delta', long, f.project.id, {
      kind: 'message.delta',
      turn_id: turn.id,
      text: `Answer ${n} ${'a'.repeat(3000)}`,
    });
  }
  const read = await run<{
    state: string;
    turns: { turn_id: string; input: string; output: string }[];
    cut_turns: number;
  }>(f, resident, 'agent.session_read', { session_id: long.id, turns: 20 });
  expect(JSON.stringify(read).length).toBeLessThanOrEqual(12000);
  expect(read.cut_turns).toBeGreaterThan(0);
  expect(read.turns.length + read.cut_turns).toBe(20);
  expect(read.turns.at(-1)!.turn_id).toBe(turnIds.at(-1));
  expect(read.turns.at(-1)!.output.startsWith('Answer 29 ')).toBe(true);
  for (const turn of read.turns) {
    expect(turn.input.length).toBeLessThanOrEqual(1500);
    expect(turn.output.length).toBeLessThanOrEqual(1500);
  }

  // Inside the fixture root, which is removed only after the control shuts down.
  const otherRoot = path.join(f.root, 'other');
  mkdirSync(otherRoot);
  const other = await f.call<Promise<Project>>('project.open', {
    name: 'Other',
    roots: [otherRoot],
  });
  const foreign = f.store.insert<Session>('sessions', {
    id: id(),
    revision: 1,
    project_id: other.id,
    runtime: f.adapter.name,
    state: 'open',
    turn_count: 0,
  });
  expect(await refusal(f, resident, 'agent.session_read', { session_id: foreign.id })).toBe(
    'permission_denied',
  );
});

it('refuses a worker and a lead that is not a resident on each app tool', async () => {
  const f = await workbenchFixture();
  const residentSession = openResident(f);
  const direct = await f.create('Explain the answer file');
  const worker = await boundTaskSession(f, residentSession.id, 'a');
  const inputs: [CommandType, Record<string, unknown>][] = [
    ['agent.sessions', {}],
    ['agent.session_read', { session_id: residentSession.id }],
    ['agent.github_items', { project_id: f.project.id, kind: 'pr' }],
    ['agent.github_pr', { project_id: f.project.id, number: 1 }],
  ];
  for (const principal of [credential(worker, 'worker'), credential(direct, 'lead')])
    for (const [type, input] of inputs)
      expect(await refusal(f, principal, type, input), `${principal.role} ${type}`).toBe(
        'permission_denied',
      );
});

/** A daemon with a project whose assistant resident runs with the tools of profile. */
async function residentMcp(tools?: AgentProfile['tools']) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-app-tools-'));
  mkdirSync(path.join(root, 'project'));
  const daemon = await startDaemon({
    directory: path.join(root, 'state'),
    adapters: [],
    intervalMs: 60_000,
  });
  cleanup.push(async () => {
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = (await daemon.control.execute(
    user,
    command(user.id, 'project.open', { name: 'agents', roots: [path.join(root, 'project')] }),
  )) as Project;
  const ctx = (daemon.control as unknown as { ctx: ControlContext }).ctx;
  ctx.store.transaction(() => ensureAgents(ctx, project.id));
  const profile = daemon.control
    .agentList(user, project.id)
    .find((agent) => agent.template === 'assistant')!;
  if (tools) daemon.store.update<AgentProfile>('agents', { ...profile, tools }, profile.revision);
  const session = daemon.store.insert<Session>('sessions', {
    id: 'assistant-session',
    revision: 1,
    project_id: project.id,
    runtime: 'fixture',
    state: 'open',
    turn_count: 0,
    resident: { kind: 'assistant', agent_id: profile.id },
  });
  const issued = ctx.issueSessionCredential!(session.id, 'lead');
  const client = new Client({ name: 'app-tools-test', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(process.cwd(), 'apps/cli/dist/index.js'), 'mcp'],
      env: {
        ...(process.env as Record<string, string>),
        PANTHEON_DAEMON_URL: issued.daemon_url,
        PANTHEON_SESSION_TOKEN_FILE: issued.token_file,
      },
    }),
  );
  cleanup.push(() => client.close());
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  return { daemon, session, names };
}

it('lists the app tools to the default assistant and none to a profile without their groups', async () => {
  const appToolNames = ['session_list', 'session_read', 'github_items', 'github_pr'];
  const assistant = await residentMcp();
  for (const name of appToolNames) expect(assistant.names).toContain(name);

  const narrow = await residentMcp(['board']);
  for (const name of appToolNames) expect(narrow.names).not.toContain(name);
  expect(
    await refusal(
      { control: narrow.daemon.control },
      credential(narrow.session),
      'agent.sessions',
      {},
    ),
  ).toBe('permission_denied');
});

it('returns the items github.items returns to a resident through github_items', async () => {
  const items = [
    {
      number: 4,
      title: 'Item 4',
      url: 'https://github.com/owner/project/pull/4',
      state: 'OPEN',
      author: { login: 'writer' },
      updatedAt: '2026-11-14T00:00:00Z',
    },
  ];
  const auth = {
    hosts: {
      'github.com': [
        { state: 'success', active: true, host: 'github.com', login: 'owner', scopes: 'repo' },
      ],
    },
  };
  const localCommand: LocalCommand = vi.fn(async (_file, args) => ({
    stdout: JSON.stringify(args[0] === 'auth' ? auth : items),
    stderr: '',
    exit_code: 0,
  }));
  const f = await fixture({ controlOptions: { localCommand, externalSources: [] } });
  cleanup.push(() => f.close());
  execFileSync('git', ['init', '-q'], { cwd: f.projectRoot });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:owner/project.git'], {
    cwd: f.projectRoot,
  });
  const resident = credential(
    f.call<Session>('resident.open', { project_id: f.project.id, kind: 'triage' }),
  );
  const viaTool = await run<{ repo: string; items: { number: number }[] }>(
    f,
    resident,
    'agent.github_items',
    { project_id: f.project.id, kind: 'pr' },
  );
  expect(viaTool.items.map((item) => item.number)).toEqual([4]);
  expect(viaTool).toEqual(await f.control.githubItems(user, f.project.id, 'pr'));
});
