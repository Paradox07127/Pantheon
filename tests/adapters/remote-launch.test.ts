import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Options,
  SDKUserMessage,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { AcpAdapter } from '../../packages/adapters/src/acp.js';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { CodexAdapter } from '../../packages/adapters/src/codex.js';
import {
  JsonRpcProcess,
  remoteSpawn,
  validateSessionSpec,
} from '../../packages/adapters/src/process.js';
import {
  NATIVE_ENV_ALLOWLIST,
  type AgentEvent,
  type RemoteLaunch,
  type SessionSpec,
} from '@pantheon/domain';
import { psUsable } from '../helpers.js';

const acpServer = fileURLToPath(new URL('./fake-acp-server.mjs', import.meta.url));
const fakeSsh = fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url));
const shell: RemoteLaunch = { transport: ['/bin/sh', '-c'], binary: process.execPath };
const roots: string[] = [];
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-remote-'));
  roots.push(root);
  return root;
}

function remoteSpec(root: string, remote: RemoteLaunch, overrides: Partial<SessionSpec> = {}) {
  const spec: SessionSpec = {
    platform_session_id: 'remote-session',
    project_id: 'remote-project',
    runtime: 'remote-runtime',
    device_id: 'studio',
    remote,
    role: 'writer',
    cwd: root,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 1, wall_time_ms: 60000 },
    ...overrides,
  };
  return spec;
}

/** As the device stop check counts it: an exited process nobody has reaped is not running. */
function running(pid: number): boolean {
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  return /^\s*[^Z\s]/.test(state);
}

/**
 * A device runtime that starts a tool, then serves stdin until EOF; the transport detaches it.
 * stderrDelay holds back the device's standard error, which reports its process group. With
 * unreaped, a holder outside the group keeps an exited child in it, as an init that does not reap.
 */
async function deviceRuntime(
  root: string,
  plainTransport: string[],
  { stderrDelay = 0, unreaped = false } = {},
) {
  const toolPid = path.join(root, 'tool.pid');
  const holderPid = path.join(root, 'holder.pid');
  const holder = `perl -MPOSIX=setpgid -e '$g = getpgrp; exit if fork; setpgid(0, 0); if (!fork) { setpgid(0, $g); exit } select(undef, undef, undef, 0.2); open(my $f, ">", shift); print $f "$$"; close $f; sleep 20' '${holderPid}' </dev/null >/dev/null 2>&1;`;
  const rpc = new JsonRpcProcess(
    '/bin/sh',
    ['-c', `sleep 20 & echo $! > '${toolPid}'; ${unreaped ? holder : ''} exec cat`],
    undefined,
    undefined,
    {},
    {
      remote: {
        transport: [process.execPath, fakeSsh, root, String(stderrDelay)],
        plain_transport: plainTransport,
        binary: '/bin/sh',
      },
    },
  );
  rpc.on('protocolError', () => {});
  if (unreaped) {
    const pid = await written(holderPid);
    closers.push(async () => process.kill(pid, 'SIGKILL'));
  }
  return { rpc, tool: await written(toolPid) };
}

function written(pidFile: string): Promise<number> {
  return vi.waitFor(() => {
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    return pid;
  });
}

async function output(child: ChildProcess): Promise<string> {
  let text = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (text += chunk));
  await new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  return text;
}

describe('remote runtime launch', () => {
  it('passes every argument through the device shell byte for byte', async () => {
    const values = [
      'two words',
      "it's",
      'say "hi"',
      '$HOME',
      '`whoami`',
      'line one\nline two',
      "'\\''",
    ];
    const launch = remoteSpawn(shell, '/usr/bin/printf', ['%s', ...values], undefined, {});
    expect(launch.command).toBe('/bin/sh');
    const child = spawn(launch.command, launch.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    expect(await output(child)).toBe(values.join(''));
  });

  it('runs the command in the device directory with the device variables', async () => {
    const cwd = realpathSync(os.tmpdir());
    const launch = remoteSpawn(
      { ...shell, env: { X: 'from the device', Y: 'device only' } },
      '/bin/sh',
      ['-c', 'pwd; printf %s "$X|$Y"'],
      cwd,
      { X: "it's $HOME" },
    );
    const child = spawn(launch.command, launch.args, {
      cwd: '/',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(await output(child)).toBe(`${cwd}\nit's $HOME|device only`);
  });

  it.skipIf(!psUsable).each([
    { name: 'reported at once', options: {} },
    { name: 'reported after the stop starts', options: { stderrDelay: 500 } },
    { name: 'holding an exited member nobody reaps', options: { unreaped: true } },
  ])('stops the device processes before it confirms a stop: group $name', async ({ options }) => {
    const { rpc, tool } = await deviceRuntime(tempRoot(), ['/bin/sh', '-c'], options);
    const receipt = await rpc.close(Date.now() + 5000);
    expect(running(tool)).toBe(false);
    expect(receipt.stopped).toBe(true);
  });

  it('does not confirm a stop the device link cannot check', async () => {
    const { rpc } = await deviceRuntime(tempRoot(), ['/missing/device-link']);
    const receipt = await rpc.close(Date.now() + 5000);
    expect(receipt.stopped).toBe(false);
    expect(receipt.reason).toMatch(/device/i);
  });

  it('accepts another device only with launch details and no backend key', () => {
    const root = os.tmpdir();
    expect(() => validateSessionSpec(remoteSpec(root, shell, { remote: undefined }), 'v')).toThrow(
      /Cannot honor/,
    );
    expect(() => validateSessionSpec(remoteSpec(root, shell), 'v')).not.toThrow();
    expect(() =>
      validateSessionSpec(
        remoteSpec(root, shell, {
          backend: { id: 'b', protocol: 'anthropic', base_url: 'http://x', api_key: 'secret' },
        }),
        'v',
      ),
    ).toThrow(/backend on a remote device/);
    expect(() => validateSessionSpec(remoteSpec(root, shell, { device_id: 'local' }), 'v')).toThrow(
      /Cannot honor/,
    );
  });

  it('accepts MCP servers only on this machine', () => {
    const root = os.tmpdir();
    const mcp_servers = [{ name: 'chrome_devtools', command: 'npx', args: [], env: {} }];
    expect(() =>
      validateSessionSpec(
        remoteSpec(root, shell, { device_id: 'local', remote: undefined, mcp_servers }),
        'v',
      ),
    ).not.toThrow();
    expect(() => validateSessionSpec(remoteSpec(root, shell, { mcp_servers }), 'v')).toThrow(
      /MCP servers on a remote device/,
    );
  });

  it('runs an ACP turn through the device transport', async () => {
    const root = tempRoot();
    const log = path.join(root, 'frames.jsonl');
    const spec = remoteSpec(root, shell, { runtime: 'scripted-acp', env: { FAKE_ACP_LOG: log } });
    const adapter = new AcpAdapter({
      name: 'scripted-acp',
      binary: '/missing/acp-agent',
      args: [acpServer],
      profile: { binary: '/missing/acp-agent', args: [], resume: 'resume' },
    });
    const events: AgentEvent[] = [];
    const handle = await adapter.start(spec, (event) => events.push(event));
    closers.push(() => adapter.close(handle, Date.now() + 5000));
    expect(handle.device_id).toBe('studio');
    await adapter.send(handle, { turn_id: 'remote-turn', input: 'text' });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ kind: 'turn.completed', status: 'completed' }),
      ),
    );
    expect(
      events.filter((event) => event.kind === 'message.delta').map((event) => event.text),
    ).toEqual(['Hel', 'lo', ' world']);
    expect(readFileSync(log, 'utf8')).toContain('session/prompt');
  });

  it('starts a Codex session through the device transport without local native state', async () => {
    const root = tempRoot();
    const server = path.join(root, 'app-server.mjs');
    writeFileSync(
      server,
      `#!${process.execPath}
import { createInterface } from 'node:readline';
const results = {
  initialize: {},
  'account/read': { account: { type: 'chatgpt', planType: 'plus' } },
  'config/read': { config: { model_provider: 'openai' } },
  'thread/start': { thread: { id: 'remote-thread' } },
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  process.stdout.write(JSON.stringify({ id: request.id, result: results[request.method] ?? {} }) + '\\n');
});
`,
    );
    chmodSync(server, 0o755);
    const spec = remoteSpec(
      root,
      { transport: ['/bin/sh', '-c'], binary: server },
      { runtime: 'codex', native_state_dir: path.join(root, 'native-state') },
    );
    const adapter = new CodexAdapter('/missing/codex');
    const handle = await adapter.start(spec, () => {});
    closers.push(() => adapter.close(handle, Date.now() + 5000));
    expect(handle.device_id).toBe('studio');
    expect(handle.native_state_dir).toBeUndefined();
  });

  it('hands Claude the device binary and spawns it through the device transport', async () => {
    const root = tempRoot();
    let captured: Options | undefined;
    const query = ({
      options,
      prompt,
    }: {
      options: Options;
      prompt: AsyncIterable<SDKUserMessage>;
    }) => {
      captured = options;
      return {
        initializationResult: async () => ({
          account: { apiProvider: 'firstParty', subscriptionType: 'max' },
        }),
        close: () => {},
        async *[Symbol.asyncIterator]() {
          for await (const _message of prompt) return;
        },
      };
    };
    const adapter = new ClaudeAdapter('/missing/claude', 'test', query as never);
    const spec = remoteSpec(
      root,
      { transport: ['/bin/sh', '-c'], binary: '/device/bin/claude' },
      {
        runtime: 'claude',
        native_state_dir: path.join(root, 'native-state'),
        // This machine has its own TMPDIR; the device's one still reaches the device.
        env: { PROJECT_VAR: 'project value', TMPDIR: '/device/tmp' },
      },
    );
    // Linux sets no TMPDIR by default, so the test gives this machine one.
    vi.stubEnv('TMPDIR', os.tmpdir());
    const handle = await adapter.start(spec, () => {});
    closers.push(() => adapter.close(handle, Date.now() + 5000));
    expect(process.env.TMPDIR).toBeDefined();
    expect(captured!.pathToClaudeCodeExecutable).toBe('/device/bin/claude');
    expect(captured!.env).toEqual({
      PROJECT_VAR: 'project value',
      TMPDIR: '/device/tmp',
      CLAUDE_CODE_ARTIFACT: '1',
    });
    expect(captured!.env).not.toHaveProperty('HOME');
    expect(captured!.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    const child = captured!.spawnClaudeCodeProcess!({
      command: '/bin/echo',
      args: ['hello', "it's", '$HOME'],
      cwd: root,
      env: { ...captured!.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
      signal: new AbortController().signal,
    }) as unknown as ChildProcess;
    expect(child.spawnfile).toBe('/bin/sh');
    expect(child.spawnargs.slice(1, 2)).toEqual(['-c']);
    expect(child.spawnargs[2]).toContain("CLAUDE_CODE_ENTRYPOINT='sdk-ts'");
    expect(child.spawnargs[2]).toContain("TMPDIR='/device/tmp'");
    expect(child.spawnargs[2]).toContain("CLAUDE_CODE_ARTIFACT='1'");
    expect(await output(child)).toBe("hello it's $HOME\n");
  });

  it.skipIf(!psUsable)(
    'stops the Claude processes on the device before it confirms a stop',
    async () => {
      const root = tempRoot();
      let captured: Options | undefined;
      const query = ({
        options,
        prompt,
      }: {
        options: Options;
        prompt: AsyncIterable<SDKUserMessage>;
      }) => {
        captured = options;
        return {
          initializationResult: async () => ({
            account: { apiProvider: 'firstParty', subscriptionType: 'max' },
          }),
          close: () => {},
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) return;
          },
        };
      };
      const adapter = new ClaudeAdapter('/missing/claude', 'test', query as never);
      const spec = remoteSpec(
        root,
        {
          transport: [process.execPath, fakeSsh, root],
          plain_transport: ['/bin/sh', '-c'],
          binary: '/device/bin/claude',
        },
        { runtime: 'claude', native_state_dir: path.join(root, 'native-state') },
      );
      const handle = await adapter.start(spec, () => {});
      const toolPid = path.join(root, 'tool.pid');
      captured!.spawnClaudeCodeProcess!({
        command: '/bin/sh',
        args: ['-c', `sleep 20 & echo $! > '${toolPid}'; exec cat`],
        cwd: root,
        env: {},
        signal: captured!.abortController!.signal,
      });
      const tool = await written(toolPid);
      const receipt = await adapter.close(handle, Date.now() + 5000);
      expect(running(tool)).toBe(false);
      expect(receipt.stopped).toBe(true);
    },
  );

  it('lists the extensions of a Claude device session through the device transport', async () => {
    const root = tempRoot();
    const captured: Options[] = [];
    const query = ({
      options,
      prompt,
    }: {
      options: Options;
      prompt: AsyncIterable<SDKUserMessage>;
    }) => {
      captured.push(options);
      return {
        initializationResult: async () => ({
          account: { apiProvider: 'firstParty', subscriptionType: 'max' },
        }),
        reloadPlugins: async () => ({ plugins: [] }),
        mcpServerStatus: async () => [],
        supportedCommands: async () => [],
        getContextUsage: async () => ({}),
        close: () => {},
        async *[Symbol.asyncIterator]() {
          for await (const _message of prompt) return;
        },
      };
    };
    const adapter = new ClaudeAdapter('/missing/claude', 'test', query as never);
    const spec = remoteSpec(
      root,
      // The listing ends before the runtime starts: it must not hold the session tools forward.
      {
        transport: ['/missing/forwarding-transport'],
        plain_transport: ['/bin/sh', '-c'],
        binary: '/device/bin/claude',
      },
      {
        runtime: 'claude',
        native_state_dir: path.join(root, 'native-state'),
        extensions: {
          mode: 'inherit',
          overrides: {
            disabled_mcp_servers: [],
            disabled_plugins: [],
            disabled_skills: [],
            disable_apps: false,
            disable_hooks: false,
            enabled_user_skills: [],
          },
        },
      },
    );
    const handle = await adapter.start(spec, () => {});
    closers.push(() => adapter.close(handle, Date.now() + 5000));
    // The listing query runs before the session's own query.
    const [listing] = captured;
    expect(listing!.pathToClaudeCodeExecutable).toBe('/device/bin/claude');
    expect(listing!.env).not.toHaveProperty('HOME');
    const child = listing!.spawnClaudeCodeProcess?.({
      command: '/bin/echo',
      args: ['listing'],
      cwd: root,
      env: { ...listing!.env },
      signal: new AbortController().signal,
    }) as unknown as ChildProcess | undefined;
    expect(child?.spawnfile).toBe('/bin/sh');
    expect(await output(child!)).toBe('listing\n');
  });
});
