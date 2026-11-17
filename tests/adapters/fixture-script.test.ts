import { describe, it, expect, afterAll, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { FixtureAdapter } from '@pantheon/adapters';
import {
  NATIVE_ENV_ALLOWLIST,
  type AgentEvent,
  type SessionHandle,
  type SessionSpec,
} from '@pantheon/domain';
import { eventually } from '../helpers.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

type Completed = Extract<AgentEvent, { kind: 'turn.completed' }>;

const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-fixture-script-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fakeServer = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

let repositories = 0;
function repository(): string {
  const cwd = path.join(root, `repository-${++repositories}`);
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '--allow-empty', '-qm', 'initial');
  return cwd;
}
function hook(cwd: string, body: string): void {
  const file = path.join(cwd, '.git', 'hooks', 'pre-commit');
  writeFileSync(file, `#!${process.execPath}\n${body}`);
  chmodSync(file, 0o755);
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const spec = (
  cwd: string,
  mode: string | null = 'ok',
  overrides: Partial<SessionSpec> = {},
): SessionSpec => ({
  platform_session_id: 'script-session',
  project_id: 'script-project',
  runtime: 'fixture',
  device_id: 'local',
  role: 'writer',
  cwd,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  ...(mode === null
    ? {}
    : {
        pantheon_mcp: {
          command: process.execPath,
          args: [fakeServer, mode],
          env: { FAKE_TOKEN: 'session-token' },
        },
      }),
  budget: { max_turns: 1, wall_time_ms: 10000 },
  ...overrides,
});
const script = (...steps: unknown[]) =>
  `fixture-script\n${JSON.stringify(steps)}\nInbox: a report that the script ignores`;

function recorder() {
  const events: AgentEvent[] = [];
  return {
    events,
    sink: (event: AgentEvent) => void events.push(event),
    completed: () => events.filter((e): e is Completed => e.kind === 'turn.completed'),
    of: (turn_id: string) => events.filter((e) => e.turn_id === turn_id),
  };
}
async function runTurn(
  adapter: FixtureAdapter,
  handle: SessionHandle,
  r: ReturnType<typeof recorder>,
  turn_id: string,
  input: string,
): Promise<AgentEvent[]> {
  expect(await adapter.send(handle, { turn_id, input })).toMatchObject({ status: 'delivered' });
  await eventually(() => r.completed().some((e) => e.turn_id === turn_id), undefined, 10000);
  return r.of(turn_id);
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};
const spawnedPids = (match: (args: string[]) => boolean): number[] =>
  vi
    .mocked(spawn)
    .mock.results.map((result) => result.value)
    .filter((child) => child?.pid && match(child.spawnargs))
    .map((child) => child.pid as number);
const pidOf = (event: AgentEvent | undefined): number =>
  Number(/pid=(\d+)/.exec(String(event?.kind === 'tool.completed' ? event.output : ''))?.[1]);

describe('fixture script turns', () => {
  it('says, writes and commits in order and leaves the commit in the repository', async () => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(cwd), r.sink);
    try {
      const write = { write: { path: 'notes/plan.txt', text: 'alpha\n' } };
      const events = await runTurn(
        adapter,
        handle,
        r,
        'scripted',
        script({ say: 'hello' }, write, { commit: 'Add the plan' }),
      );
      expect(events.map((e) => e.kind)).toEqual([
        'message.delta',
        'tool.started',
        'tool.completed',
        'tool.started',
        'tool.completed',
        'usage.updated',
        'turn.completed',
      ]);
      expect(events[0]).toMatchObject({ text: 'hello' });
      expect(events[1]).toMatchObject({ name: 'fixture.write', input: write });
      expect(events[2]).toMatchObject({
        tool_call_id: (events[1] as { tool_call_id: string }).tool_call_id,
        ok: true,
      });
      expect(events[3]).toMatchObject({ name: 'fixture.commit' });
      expect(events[4]).toMatchObject({ ok: true });
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
      expect(readFileSync(path.join(cwd, 'notes/plan.txt'), 'utf8')).toBe('alpha\n');
      expect(git(cwd, 'log', '-1', '--format=%s')).toBe('Add the plan');
      expect(git(cwd, 'show', '--name-only', '--format=', 'HEAD')).toBe('notes/plan.txt');
      expect(git(cwd, 'status', '--porcelain')).toBe('');
      expect(r.events.map((e) => e.provider_sequence)).toEqual(r.events.map((_, i) => i + 1));
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('calls Pantheon MCP tools through one server process per turn and closes it', async () => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(cwd), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'tools',
        script(
          { tool: { name: 'report', arguments: { kind: 'done', text: 'finished' } } },
          { tool: { name: 'project_read', arguments: {} } },
        ),
      );
      expect(events.map((e) => e.kind)).toEqual([
        'tool.started',
        'tool.completed',
        'tool.started',
        'tool.completed',
        'usage.updated',
        'turn.completed',
      ]);
      expect(events[0]).toMatchObject({ name: 'report' });
      expect(events[1]).toMatchObject({
        ok: true,
        output: expect.stringContaining(
          'report {"kind":"done","text":"finished"} token=session-token',
        ),
      });
      expect(events[2]).toMatchObject({ name: 'project_read' });
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
      const pid = pidOf(events[1]);
      expect(pidOf(events[3])).toBe(pid);
      expect(alive(pid)).toBe(false);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it.each<[string, string | null, RegExp]>([
    ['a tool result marked as an error', 'error', /report .*token=session-token/],
    ['a server that exits on start', 'exit', /exited with 4: fake server refused to start/],
    ['a server that never answers', 'silent', /timed out/i],
    ['a session without a Pantheon MCP server', null, /no Pantheon MCP/],
  ])('fails the turn for %s', async (_, mode, error) => {
    const cwd = repository(),
      // Only the silent server needs a short step timeout; the others must outlast a slow server start.
      adapter = new FixtureAdapter(40, false, false, mode === 'silent' ? 300 : 10000),
      r = recorder();
    const handle = await adapter.start(spec(cwd, mode), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'tool-failure',
        script({ tool: { name: 'report', arguments: {} } }, { say: 'never said' }),
      );
      expect(r.completed()).toEqual([expect.objectContaining({ status: 'failed' })]);
      expect(r.completed()[0]?.error).toMatch(error);
      expect(events.some((e) => e.kind === 'message.delta')).toBe(false);
      for (const pid of spawnedPids((args) => args.includes(fakeServer)))
        await eventually(() => !alive(pid));
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it.each([
    ['a fail step', script({ fail: 'planned failure' }, { say: 'never said' }), /planned failure/],
    ['an unknown step', script({ jump: 'elsewhere' }), /step/i],
    ['a malformed script', 'fixture-script\n[{"say": ', /script/i],
    ['a step with two keys', script({ hang: true, compact: 'auto' }), /step/i],
    ['a wait beyond the timer limit', script({ wait: 2147483648 }, { say: 'never said' }), /step/i],
  ])('fails the turn for %s without running later steps', async (_, input, error) => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      const events = await runTurn(adapter, handle, r, 'failure', input);
      expect(events.map((e) => e.kind)).toEqual(['usage.updated', 'turn.completed']);
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(error),
      });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('fails a commit that git refuses with the tail of its error output', async () => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    hook(cwd, "process.stderr.write('hook refused the commit\\n'); process.exit(1);");
    const handle = await adapter.start(spec(cwd), r.sink);
    try {
      await runTurn(
        adapter,
        handle,
        r,
        'refused',
        script({ write: { path: 'a.txt', text: 'a' } }, { commit: 'Refused' }),
      );
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('hook refused the commit'),
      });
      expect(git(cwd, 'log', '-1', '--format=%s')).toBe('initial');
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it.each([
    ['a string', ''],
    ['an object', { message: '', error_code: 'empty_failure', resets_at: 1767225600000 }],
  ] as const)('fails a fail step with an empty message in %s', async (_, fail) => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      await runTurn(adapter, handle, r, 'empty-failure', script({ fail }, { say: 'never said' }));
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: '',
        ...(typeof fail === 'object'
          ? { error_code: fail.error_code, resets_at: fail.resets_at }
          : {}),
      });
      expect(r.events.some((e) => e.kind === 'message.delta')).toBe(false);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('refuses to write outside the working directory', async () => {
    const cwd = repository(),
      outside = path.join(root, `outside-${repositories}`);
    mkdirSync(outside);
    symlinkSync(outside, path.join(cwd, 'linked'));
    for (const target of [
      '../escaped.txt',
      path.join(outside, 'absolute.txt'),
      'linked/through-link.txt',
    ]) {
      const adapter = new FixtureAdapter(),
        r = recorder();
      const handle = await adapter.start(spec(cwd), r.sink);
      try {
        await runTurn(
          adapter,
          handle,
          r,
          'escape',
          script({ write: { path: target, text: 'escaped' } }, { say: 'never said' }),
        );
        expect(r.completed()[0], target).toMatchObject({ status: 'failed' });
        expect(r.events.some((e) => e.kind === 'message.delta')).toBe(false);
      } finally {
        await adapter.close(handle, Date.now() + 10000);
      }
    }
    expect(existsSync(path.join(root, 'escaped.txt'))).toBe(false);
    expect(existsSync(path.join(outside, 'absolute.txt'))).toBe(false);
    expect(existsSync(path.join(outside, 'through-link.txt'))).toBe(false);
  });

  it.each([
    ['an outside file link', true],
    ['a dangling outside link', false],
  ] as const)('refuses to write through %s', async (_, exists) => {
    const cwd = repository(),
      outside = path.join(root, `outside-file-${repositories}.txt`),
      adapter = new FixtureAdapter(),
      r = recorder();
    if (exists) writeFileSync(outside, 'original');
    symlinkSync(outside, path.join(cwd, 'linked.txt'));
    const handle = await adapter.start(spec(cwd), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'file-link',
        script({ write: { path: 'linked.txt', text: 'escaped' } }, { say: 'never said' }),
      );
      expect(events.find((e) => e.kind === 'tool.completed')).toMatchObject({ ok: false });
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/symbolic link/i),
      });
      expect(events.some((e) => e.kind === 'message.delta')).toBe(false);
      expect(existsSync(outside)).toBe(exists);
      if (exists) expect(readFileSync(outside, 'utf8')).toBe('original');
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('refuses to create directories through an outside ancestor directory link', async () => {
    const cwd = repository(),
      outside = path.join(root, `outside-directory-${repositories}`),
      adapter = new FixtureAdapter(),
      r = recorder();
    mkdirSync(outside);
    mkdirSync(path.join(cwd, 'notes'));
    symlinkSync(outside, path.join(cwd, 'notes', 'linked'));
    const handle = await adapter.start(spec(cwd), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'directory-link',
        script(
          { write: { path: 'notes/linked/new/nested/escaped.txt', text: 'escaped' } },
          { say: 'never said' },
        ),
      );
      expect(events.find((e) => e.kind === 'tool.completed')).toMatchObject({ ok: false });
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('outside the working directory'),
      });
      expect(events.some((e) => e.kind === 'message.delta')).toBe(false);
      expect(existsSync(path.join(outside, 'new'))).toBe(false);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  const sandboxed = (
    cwd: string,
    writable_roots: string[],
    protected_entries: NonNullable<SessionSpec['sandbox']>['protected_entries'] = [],
  ) => spec(cwd, 'ok', { sandbox: { writable_roots, protected_entries } });

  it.each<[string, (cwd: string) => SessionSpec, unknown]>([
    [
      'a write outside the writable roots',
      (cwd) => sandboxed(cwd, [path.join(cwd, 'allowed')]),
      { write: { path: 'escaped.txt', text: 'escaped' } },
    ],
    [
      'a write in a session without writable roots',
      (cwd) => sandboxed(cwd, []),
      { write: { path: 'allowed/escaped.txt', text: 'escaped' } },
    ],
    [
      'a write to a protected entry',
      (cwd) => sandboxed(cwd, [cwd], [{ path: path.join(cwd, '.mcp.json'), deny: 'write' }]),
      { write: { path: '.mcp.json', text: 'escaped' } },
    ],
    [
      'a commit into protected git metadata',
      (cwd) => sandboxed(cwd, [cwd], [{ path: path.join(cwd, '.git'), deny: 'read_write' }]),
      { commit: 'Never lands' },
    ],
    [
      'a commit in a session without writable roots',
      (cwd) => sandboxed(cwd, []),
      { commit: 'Never lands' },
    ],
  ])('fails the sandboxed turn for %s', async (_, session, step) => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    mkdirSync(path.join(cwd, 'allowed'));
    writeFileSync(path.join(cwd, '.mcp.json'), 'original');
    writeFileSync(path.join(cwd, 'pending.txt'), 'pending');
    const handle = await adapter.start(session(cwd), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'sandboxed',
        script(step, { say: 'never said' }),
      );
      expect(events.find((e) => e.kind === 'tool.completed')).toMatchObject({ ok: false });
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/writable roots|protected/),
      });
      expect(events.some((e) => e.kind === 'message.delta')).toBe(false);
      expect(existsSync(path.join(cwd, 'escaped.txt'))).toBe(false);
      expect(existsSync(path.join(cwd, 'allowed', 'escaped.txt'))).toBe(false);
      expect(readFileSync(path.join(cwd, '.mcp.json'), 'utf8')).toBe('original');
      expect(git(cwd, 'log', '-1', '--format=%s')).toBe('initial');
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('writes and commits inside the writable roots of a sandboxed session', async () => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(
      sandboxed(cwd, [cwd], [{ path: path.join(cwd, '.git', 'hooks'), deny: 'write' }]),
      r.sink,
    );
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'inside',
        script({ write: { path: 'notes/inside.txt', text: 'inside' } }, { commit: 'Inside' }),
      );
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
      expect(git(cwd, 'log', '-1', '--format=%s')).toBe('Inside');
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it.each([
    ['a write', { write: { path: 'read-only.txt', text: 'escaped' } }],
    ['a commit', { commit: 'Never lands' }],
  ])('fails %s in a read-only turn', async (_, step) => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    writeFileSync(path.join(cwd, 'pending.txt'), 'pending');
    const handle = await adapter.start(sandboxed(cwd, [cwd]), r.sink);
    try {
      expect(
        await adapter.send(handle, {
          turn_id: 'read-only',
          input: script(step, { say: 'never said' }),
          read_only: true,
        }),
      ).toMatchObject({ status: 'delivered' });
      await eventually(() => r.completed().length > 0, undefined, 10000);
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/read-only/),
      });
      expect(r.events.some((e) => e.kind === 'message.delta')).toBe(false);
      expect(existsSync(path.join(cwd, 'read-only.txt'))).toBe(false);
      expect(git(cwd, 'log', '-1', '--format=%s')).toBe('initial');
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it.each<[string, (cwd: string) => SessionSpec, boolean]>([
    ['a session without writable roots', (cwd) => sandboxed(cwd, []), false],
    ['a read-only turn', (cwd) => sandboxed(cwd, [cwd]), true],
    ['a plan-mode session', (cwd) => spec(cwd, 'ok', { permission_mode: 'plan' }), false],
  ])('fails the sentinel write for %s', async (_, session, read_only) => {
    const cwd = repository(),
      adapter = new FixtureAdapter(20, true),
      r = recorder();
    const handle = await adapter.start(session(cwd), r.sink);
    try {
      await adapter.send(handle, { turn_id: 'sentinel', input: 'hello', read_only });
      await eventually(() => r.completed().length > 0, undefined, 10000);
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/writable roots|read-only/),
      });
      expect(existsSync(path.join(cwd, 'fixture-output.txt'))).toBe(false);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('writes the sentinel inside the writable roots', async () => {
    const cwd = repository(),
      adapter = new FixtureAdapter(40, true),
      r = recorder();
    const handle = await adapter.start(sandboxed(cwd, [cwd]), r.sink);
    try {
      const events = await runTurn(adapter, handle, r, 'sentinel', 'hello');
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
      expect(existsSync(path.join(cwd, 'fixture-output.txt'))).toBe(true);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it.each(['inside', 'outside'] as const)(
    'refuses a dangling sentinel link %s the writable roots',
    async (location) => {
      const cwd = repository(),
        target = path.join(location === 'inside' ? cwd : root, `sentinel-${repositories}.txt`),
        adapter = new FixtureAdapter(40, true),
        r = recorder();
      symlinkSync(target, path.join(cwd, 'fixture-output.txt'));
      const handle = await adapter.start(sandboxed(cwd, [cwd]), r.sink);
      try {
        await runTurn(adapter, handle, r, 'sentinel-link', 'hello');
        expect(r.completed()[0]).toMatchObject({ status: 'failed' });
        expect(existsSync(target)).toBe(false);
      } finally {
        await adapter.close(handle, Date.now() + 10000);
      }
    },
  );

  it.each(['write', 'write_outside', 'commit'] as const)(
    'refuses a %s step in a plan-mode session',
    async (kind) => {
      const cwd = repository(),
        adapter = new FixtureAdapter(),
        r = recorder();
      const target = path.join(cwd, 'plan.txt');
      const step =
        kind === 'commit'
          ? { commit: 'Never lands' }
          : { [kind]: { path: kind === 'write' ? 'plan.txt' : target, text: 'escaped' } };
      writeFileSync(path.join(cwd, 'pending.txt'), 'pending');
      const handle = await adapter.start(spec(cwd, 'ok', { permission_mode: 'plan' }), r.sink);
      try {
        const events = await runTurn(adapter, handle, r, 'plan', script(step));
        expect(events.find((e) => e.kind === 'tool.completed')).toMatchObject({ ok: false });
        expect(existsSync(target)).toBe(false);
        expect(git(cwd, 'log', '-1', '--format=%s')).toBe('initial');
      } finally {
        await adapter.close(handle, Date.now() + 10000);
      }
    },
  );

  it('interrupts a running script, stops its processes and runs the next script turn', async () => {
    const cwd = repository(),
      hookPid = path.join(root, `hook-${repositories}.pid`),
      adapter = new FixtureAdapter(),
      r = recorder();
    hook(
      cwd,
      `require('node:fs').writeFileSync(${JSON.stringify(hookPid)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const handle = await adapter.start(spec(cwd), r.sink);
    try {
      await adapter.send(handle, {
        turn_id: 'interrupted',
        input: script(
          { tool: { name: 'report', arguments: {} } },
          { write: { path: 'b.txt', text: 'b' } },
          { commit: 'Never lands' },
          { say: 'never said' },
        ),
      });
      await eventually(() => existsSync(hookPid) && readFileSync(hookPid, 'utf8') !== '');
      const mcp = pidOf(r.events.find((e) => e.kind === 'tool.completed'));
      const commit = spawnedPids((args) => args.includes('Never lands'));
      expect(alive(mcp)).toBe(true);
      expect(commit).toHaveLength(1);
      expect(await adapter.interrupt(handle)).toEqual({ ok: true });
      expect(r.completed()).toEqual([
        expect.objectContaining({ turn_id: 'interrupted', status: 'interrupted' }),
      ]);
      const count = r.events.length;
      expect(r.events.at(-1)?.kind).toBe('turn.completed');
      for (const pid of [mcp, commit[0]!, Number(readFileSync(hookPid, 'utf8'))])
        expect(alive(pid), `process ${pid} survived the interrupt`).toBe(false);
      await sleep(200);
      expect(r.events).toHaveLength(count);
      expect(git(cwd, 'log', '-1', '--format=%s')).toBe('initial');

      rmSync(path.join(cwd, '.git', 'hooks', 'pre-commit'));
      const next = await runTurn(adapter, handle, r, 'next', script({ say: 'again' }));
      expect(next.at(-1)).toMatchObject({ status: 'completed' });
      expect(next[0]).toMatchObject({ kind: 'message.delta', text: 'again' });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('lands no file of a write that was still in flight when the script was interrupted', async () => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(cwd), r.sink);
    try {
      const reached = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(mkdir).mockImplementationOnce(async (...args) => {
        reached.resolve();
        await release.promise;
        return actual.mkdir(...args);
      });
      await adapter.send(handle, {
        turn_id: 'interrupted-write',
        input: script({ write: { path: 'late/file.txt', text: 'late\n' } }),
      });
      await reached.promise;
      const interrupted = adapter.interrupt(handle);
      release.resolve();
      expect(await interrupted).toEqual({ ok: true });
      await sleep(100);
      expect(existsSync(path.join(cwd, 'late', 'file.txt'))).toBe(false);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('cancels a script waiting on its MCP server with process evidence', async () => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository(), 'silent'), r.sink);
    const before = spawnedPids((args) => args.includes(fakeServer));
    await adapter.send(handle, {
      turn_id: 'cancelled',
      input: script({ tool: { name: 'report', arguments: {} } }),
    });
    await eventually(() => spawnedPids((args) => args.includes(fakeServer)).length > before.length);
    const pid = spawnedPids((args) => args.includes(fakeServer)).at(-1)!;
    const receipt = await adapter.cancel(handle, Date.now() + 10000);
    expect(receipt).toMatchObject({ stopped: true, evidence: { method: 'process_group' } });
    expect(receipt.evidence.members.map((m) => m.pid)).toContain(pid);
    expect(r.completed()).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(alive(pid)).toBe(false);
  });

  it('returns an unconfirmed stop by its deadline while a write is pending', async () => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(cwd), r.sink);
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(mkdir).mockImplementationOnce(async (...args) => {
      reached.resolve();
      await release.promise;
      return actual.mkdir(...args);
    });
    try {
      await adapter.send(handle, {
        turn_id: 'pending-write',
        input: script({ write: { path: 'pending/file.txt', text: 'late' } }),
      });
      await reached.promise;
      const pending = adapter.cancel(handle, Date.now() + 50);
      const receipt = await Promise.race([pending, sleep(300).then(() => undefined)]);
      release.resolve();
      await pending;
      expect(receipt).toMatchObject({ stopped: false });
      expect(await adapter.inspect(handle)).toMatchObject({ state: 'unknown' });
      expect(r.completed()).toEqual([
        expect.objectContaining({ status: 'interrupted', turn_id: 'pending-write' }),
      ]);
    } finally {
      release.resolve();
      expect((await adapter.close(handle, Date.now() + 10000)).stopped).toBe(true);
    }
  });

  it('fails a script turn that exceeds its wall-clock budget and stops its server', async () => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(
      spec(repository(), 'silent', { budget: { max_turns: 1, wall_time_ms: 200 } }),
      r.sink,
    );
    try {
      await runTurn(
        adapter,
        handle,
        r,
        'late',
        script({ tool: { name: 'report', arguments: {} } }),
      );
      expect(r.completed()).toEqual([
        expect.objectContaining({ status: 'failed', error: expect.stringMatching(/deadline/) }),
      ]);
      expect(alive(spawnedPids((args) => args.includes(fakeServer)).at(-1)!)).toBe(false);
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('runs a script whose marker line follows a title and a goal line', async () => {
    const adapter = new FixtureAdapter(20),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'titled',
        `Task A\n\nAdd a.txt\n${script({ say: 'from the goal' })}`,
      );
      expect(events.find((e) => e.kind === 'message.delta')).toMatchObject({
        text: 'from the goal',
      });
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('fails the turn with the error code and reset time of a fail step object', async () => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'limited',
        script(
          {
            fail: {
              message: 'usage limit reached',
              error_code: 'usage_limit',
              resets_at: 1767225600000,
            },
          },
          { say: 'never said' },
        ),
      );
      expect(events.map((e) => e.kind)).toEqual(['usage.updated', 'turn.completed']);
      expect(r.completed()[0]).toMatchObject({
        status: 'failed',
        error: 'usage limit reached',
        error_code: 'usage_limit',
        resets_at: 1767225600000,
      });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  const asking = script(
    { ask: { tool: 'Bash', input: { command: 'pnpm test' } } },
    { say: 'after the answer' },
  );
  it.each([
    ['an approval', 'allow', true],
    ['a denial', 'deny', false],
  ] as const)('continues the script after %s of an ask step', async (_, decision, ok) => {
    const adapter = new FixtureAdapter(40, false, false, 100),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      await adapter.send(handle, { turn_id: 'asking', input: asking });
      await eventually(() => r.events.some((e) => e.kind === 'permission.requested'));
      const request = r.events.find((e) => e.kind === 'permission.requested');
      expect(request).toMatchObject({
        tool: 'Bash',
        rule: 'Bash(pnpm test)',
        detail: { input: { command: 'pnpm test' } },
      });
      // Waiting for the answer outlasts the step timeout.
      await sleep(200);
      expect(r.completed()).toEqual([]);
      const request_id = (request as { request_id: string }).request_id;
      expect(await adapter.answerPermission(handle, request_id, decision)).toEqual({ ok: true });
      await eventually(() => r.completed().length > 0);
      const events = r.of('asking');
      expect(events.map((e) => e.kind)).toEqual([
        'tool.started',
        'permission.requested',
        'permission.resolved',
        'tool.completed',
        'message.delta',
        'usage.updated',
        'turn.completed',
      ]);
      expect(events[0]).toMatchObject({ name: 'Bash', input: { command: 'pnpm test' } });
      expect(events[2]).toMatchObject({ request_id, decision });
      expect(events[3]).toMatchObject({ ok });
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('marks an answer to a request the running session does not hold as an unknown request', async () => {
    const adapter = new FixtureAdapter(40, false, false, 100),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      await adapter.send(handle, { turn_id: 'asking', input: asking });
      await eventually(() => r.events.some((e) => e.kind === 'permission.requested'));
      expect(await adapter.answerPermission(handle, 'unknown-request', 'deny')).toMatchObject({
        ok: false,
        unknown_request: true,
      });
      expect(
        await adapter.answerPermission({ ...handle }, 'unknown-request', 'deny'),
      ).not.toHaveProperty('unknown_request');
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('withdraws the pending request of an ask step when the turn is cancelled', async () => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    await adapter.send(handle, { turn_id: 'withdrawn', input: asking });
    await eventually(() => r.events.some((e) => e.kind === 'permission.requested'));
    expect(await adapter.cancel(handle, Date.now() + 10000)).toMatchObject({ stopped: true });
    expect(r.of('withdrawn').map((e) => e.kind)).toEqual([
      'tool.started',
      'permission.requested',
      'permission.resolved',
      'usage.updated',
      'turn.completed',
    ]);
    expect(r.events.find((e) => e.kind === 'permission.resolved')).toMatchObject({
      decision: 'deny',
      cancelled: true,
    });
    expect(r.completed()[0]).toMatchObject({ status: 'interrupted' });
  });

  it('records a failed tool call of a try step and runs the later steps', async () => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'tried',
        script(
          { try: { tool: 'Edit', input: { file_path: 'a.txt' }, error: 'old_string not found' } },
          { say: 'carried on' },
        ),
      );
      expect(events.map((e) => e.kind)).toEqual([
        'tool.started',
        'tool.completed',
        'message.delta',
        'usage.updated',
        'turn.completed',
      ]);
      expect(events[0]).toMatchObject({ name: 'Edit', input: { file_path: 'a.txt' } });
      expect(events[1]).toMatchObject({
        tool_call_id: (events[0] as { tool_call_id: string }).tool_call_id,
        ok: false,
        output: 'old_string not found',
      });
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('emits trace step events without running anything and leaves an open call open', async () => {
    const cwd = repository(),
      adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(cwd), r.sink);
    const spawned = vi.mocked(spawn).mock.calls.length;
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'traced',
        script(
          { trace: { tool: 'Bash', input: { command: 'touch traced.txt' }, ok: false } },
          { trace: { tool: 'Bash', input: { command: 'touch open.txt' }, open: true } },
          { say: 'traced' },
        ),
      );
      expect(events.map((e) => e.kind)).toEqual([
        'tool.started',
        'tool.completed',
        'tool.started',
        'message.delta',
        'usage.updated',
        'turn.completed',
      ]);
      expect(events[0]).toMatchObject({ name: 'Bash', input: { command: 'touch traced.txt' } });
      expect(events[1]).toMatchObject({ ok: false });
      expect(events[2]).toMatchObject({ name: 'Bash', input: { command: 'touch open.txt' } });
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
      expect(vi.mocked(spawn).mock.calls.length).toBe(spawned);
      expect(git(cwd, 'status', '--porcelain')).toBe('');
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('continues after a wait step longer than the step timeout', async () => {
    const adapter = new FixtureAdapter(40, false, false, 50),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      const started = Date.now();
      const events = await runTurn(
        adapter,
        handle,
        r,
        'waited',
        script({ wait: 150 }, { say: 'after the wait' }),
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      expect(events[0]).toMatchObject({ kind: 'message.delta', text: 'after the wait' });
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('ends a wait step at once when the turn is cancelled', async () => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    await adapter.send(handle, {
      turn_id: 'cancelled-wait',
      input: script({ say: 'waiting' }, { wait: 60000 }, { say: 'never said' }),
    });
    await eventually(() => r.events.some((e) => e.kind === 'message.delta'));
    const started = Date.now();
    expect(await adapter.cancel(handle, Date.now() + 10000)).toMatchObject({ stopped: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.completed()).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(r.events.filter((e) => e.kind === 'message.delta')).toHaveLength(1);
  });

  it.each(['cancel', 'interrupt'] as const)(
    'keeps a hang step running until the turn is stopped by %s',
    async (method) => {
      const adapter = new FixtureAdapter(40, false, false, 50),
        r = recorder();
      const handle = await adapter.start(spec(repository()), r.sink);
      const spawned = vi.mocked(spawn).mock.calls.length;
      try {
        await adapter.send(handle, {
          turn_id: 'hung',
          input: script({ say: 'hanging' }, { hang: true }, { say: 'never said' }),
        });
        await eventually(() => r.events.some((e) => e.kind === 'message.delta'));
        await sleep(200);
        expect(r.completed()).toEqual([]);
        expect(await adapter.inspect(handle)).toMatchObject({ state: 'running' });
        if (method === 'cancel')
          expect(await adapter.cancel(handle, Date.now() + 10000)).toMatchObject({
            stopped: true,
          });
        else expect(await adapter.interrupt(handle)).toEqual({ ok: true });
        expect(r.completed()).toEqual([expect.objectContaining({ status: 'interrupted' })]);
        expect(r.events.filter((e) => e.kind === 'message.delta')).toHaveLength(1);
        expect(vi.mocked(spawn).mock.calls.length).toBe(spawned);
      } finally {
        await adapter.close(handle, Date.now() + 10000);
      }
    },
  );

  it('judges a write_outside step only by the sandbox and carries on after a refusal', async () => {
    const cwd = repository(),
      outside = path.join(root, `write-outside-${repositories}`),
      adapter = new FixtureAdapter(),
      r = recorder();
    mkdirSync(outside);
    const handle = await adapter.start(
      sandboxed(cwd, [cwd, outside], [{ path: path.join(outside, 'protected'), deny: 'write' }]),
      r.sink,
    );
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'outside',
        script(
          { write_outside: { path: path.join(outside, 'protected', 'a.txt'), text: 'no' } },
          { write_outside: { path: path.join(root, `elsewhere-${repositories}.txt`), text: 'no' } },
          { write_outside: { path: path.join(outside, 'notes', 'b.txt'), text: 'yes' } },
          { say: 'carried on' },
        ),
      );
      const completed = events.filter((e) => e.kind === 'tool.completed');
      expect(completed.map((e) => e.ok)).toEqual([false, false, true]);
      expect(String(completed[0]?.output)).toMatch(/protected/);
      expect(String(completed[1]?.output)).toMatch(/writable roots/);
      expect(events.find((e) => e.kind === 'tool.started')).toMatchObject({
        name: 'fixture.write_outside',
      });
      expect(events.some((e) => e.kind === 'message.delta')).toBe(true);
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
      expect(existsSync(path.join(outside, 'protected'))).toBe(false);
      expect(existsSync(path.join(root, `elsewhere-${repositories}.txt`))).toBe(false);
      expect(readFileSync(path.join(outside, 'notes', 'b.txt'), 'utf8')).toBe('yes');
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('emits context.compacted with the trigger of a compact step', async () => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'compacted',
        script({ compact: 'auto' }, { compact: 'manual' }),
      );
      expect(events.filter((e) => e.kind === 'context.compacted')).toEqual([
        expect.objectContaining({ trigger: 'auto' }),
        expect.objectContaining({ trigger: 'manual' }),
      ]);
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('reports the context usage of a usage step when the turn ends, and refuses one without numbers', async () => {
    const adapter = new FixtureAdapter(),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      const events = await runTurn(
        adapter,
        handle,
        r,
        'usage',
        script(
          {
            usage: {
              context_tokens: 160000,
              context_window: 200000,
              auto_compact_at_tokens: 180000,
            },
          },
          { say: 'done' },
        ),
      );
      expect(events.filter((e) => e.kind === 'usage.updated')).toEqual([
        expect.objectContaining({
          context_tokens: 160000,
          context_window: 200000,
          auto_compact_at_tokens: 180000,
        }),
      ]);
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
      const refused = await runTurn(
        adapter,
        handle,
        r,
        'usage-refused',
        script({ usage: { context_tokens: 'many', context_window: 200000 } }),
      );
      expect(refused.at(-1)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Unknown fixture script step'),
      });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });

  it('runs the fixed program when no line is the script marker', async () => {
    const adapter = new FixtureAdapter(20),
      r = recorder();
    const handle = await adapter.start(spec(repository()), r.sink);
    try {
      const events = await runTurn(adapter, handle, r, 'plain', 'hello\nfixture-scripts\n[]');
      expect(events.find((e) => e.kind === 'message.delta')).toMatchObject({
        text: 'fixture completed\n',
      });
      expect(events.at(-1)).toMatchObject({ status: 'completed' });
    } finally {
      await adapter.close(handle, Date.now() + 10000);
    }
  });
});
