import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeAdapter,
  CodexAdapter,
  MIN_VERSIONS,
  parseVersion,
  versionAtLeast,
  withInstallFolders,
} from '@pantheon/adapters';
import { DomainError, NATIVE_ENV_ALLOWLIST, type SessionSpec } from '@pantheon/domain';

const cache = path.join(process.cwd(), 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(path.join(cache, 'preflight-tests-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A runtime binary that prints a version and otherwise answers app-server requests. */
function fakeBinary(version: string, account: unknown = null) {
  const directory = mkdtempSync(path.join(root, 'binary-'));
  const argv = path.join(directory, 'argv.jsonl');
  writeFileSync(argv, '');
  const binary = path.join(directory, 'runtime.cjs');
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(version)} + '\\n');
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const responses = ${JSON.stringify({
      initialize: {},
      'account/read': { account },
      'config/read': { config: { model_provider: 'openai' } },
      'model/list': { data: [], nextCursor: null },
      'thread/start': { thread: { id: 'new-thread' } },
    })};
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id !== undefined)
    process.stdout.write(JSON.stringify({ id: request.id, result: responses[request.method] || {} }) + '\\n');
});
`,
  );
  chmodSync(binary, 0o755);
  return {
    binary,
    argv: () =>
      readFileSync(argv, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

function fakeQuery(account: unknown, answer = true) {
  const streams: { close: ReturnType<typeof vi.fn> }[] = [];
  const query = vi.fn((_: { options: Record<string, unknown> }) => {
    const stream = {
      close: vi.fn(),
      initializationResult: vi.fn(() =>
        answer ? Promise.resolve({ account }) : new Promise(() => {}),
      ),
      supportedModels: vi.fn(async () => []),
      getSettings: vi.fn(async () => ({ applied: { model: null, effort: null } })),
    };
    streams.push(stream);
    return stream;
  });
  return { query, streams };
}

const claudeVersion = '2.1.312 (Claude Code)';
const email = 'person@example.invalid';

describe('version parsing', () => {
  it('reads the first x.y.z of a version text', () => {
    expect(parseVersion(claudeVersion)).toBe('2.1.312');
    expect(parseVersion('codex-cli 0.165.0')).toBe('0.165.0');
    expect(parseVersion('no version here')).toBeNull();
  });

  it('compares versions part by part as numbers', () => {
    expect(versionAtLeast('2.1.312', '2.1.312')).toBe(true);
    expect(versionAtLeast('codex-cli 0.165.0', '0.165.0')).toBe(true);
    expect(versionAtLeast('2.1.311', '2.1.312')).toBe(false);
    expect(versionAtLeast('2.10.0', '2.9.99')).toBe(true);
    expect(versionAtLeast('1.0', '0.1.0')).toBe(false);
    expect(MIN_VERSIONS).toEqual({ claude: '2.1.312', codex: '0.165.0' });
  });
});

describe('Claude preflight', () => {
  it('reports the version, the subscription login and its email without sending a turn', async () => {
    const { binary } = fakeBinary(claudeVersion);
    const { query, streams } = fakeQuery({
      apiProvider: 'firstParty',
      subscriptionType: 'max',
      email,
    });
    const adapter = new ClaudeAdapter(binary, 'unprobed', query as never);
    expect(await adapter.preflight()).toEqual({
      installed: true,
      version: claudeVersion,
      min_version: '2.1.312',
      version_ok: true,
      auth: { state: 'ok', email, plan: 'max' },
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]![0].options).toMatchObject({
      cwd: os.tmpdir(),
      pathToClaudeCodeExecutable: binary,
    });
    expect(streams[0]!.close).toHaveBeenCalledOnce();
    expect(adapter.report.version).toBe(claudeVersion);
  });

  it.each([
    [
      'an API key',
      { apiProvider: 'firstParty', subscriptionType: 'max', apiKeySource: 'environment' },
      { state: 'unsupported_channel', reason: 'API key channel' },
    ],
    [
      'an external provider',
      { apiProvider: 'bedrock' },
      { state: 'unsupported_channel', reason: 'Non-first-party provider' },
    ],
    ['no account', undefined, { state: 'logged_out', reason: 'Unverified account channel' }],
  ])('names %s with the rule a turn uses', async (_, account, auth) => {
    const { binary } = fakeBinary(claudeVersion);
    const adapter = new ClaudeAdapter(binary, claudeVersion, fakeQuery(account).query as never);
    expect((await adapter.preflight()).auth).toEqual(auth);
  });

  it('reports an unknown login when the CLI does not answer in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { binary } = fakeBinary(claudeVersion);
      const { query, streams } = fakeQuery(undefined, false);
      const adapter = new ClaudeAdapter(binary, claudeVersion, query as never);
      const status = adapter.preflight();
      await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(15000);
      expect((await status).auth).toEqual({ state: 'unknown', reason: 'timeout' });
      expect(streams[0]!.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('finds the CLI in a usual install folder that the PATH the daemon started with leaves out', async () => {
    const home = mkdtempSync(path.join(root, 'home-'));
    mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    symlinkSync(fakeBinary(claudeVersion).binary, path.join(home, '.local/bin/claude'));
    const account = { apiProvider: 'firstParty', subscriptionType: 'max' };
    vi.stubEnv('PATH', withInstallFolders('/usr/bin:/bin', home));
    try {
      const adapter = new ClaudeAdapter('claude', 'unprobed', fakeQuery(account).query as never);
      expect(await adapter.preflight()).toMatchObject({ installed: true, version: claudeVersion });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('stops at a missing binary', async () => {
    const { query } = fakeQuery(undefined);
    const adapter = new ClaudeAdapter(
      path.join(root, 'missing-claude'),
      claudeVersion,
      query as never,
    );
    expect(await adapter.preflight()).toMatchObject({
      installed: false,
      version: null,
      min_version: '2.1.312',
      version_ok: null,
      auth: { state: 'unknown' },
    });
    expect(query).not.toHaveBeenCalled();
    expect(adapter.report.version).toBe('unprobed');
  });

  it('marks a version below the minimum', async () => {
    const { binary } = fakeBinary('2.1.300 (Claude Code)');
    const adapter = new ClaudeAdapter(
      binary,
      claudeVersion,
      fakeQuery({ apiProvider: 'firstParty', subscriptionType: 'pro' }).query as never,
    );
    expect(await adapter.preflight()).toMatchObject({
      version: '2.1.300 (Claude Code)',
      version_ok: false,
    });
    expect(adapter.report.version).toBe('2.1.300 (Claude Code)');
  });

  it('passes the configured arguments to the CLI as extra arguments', async () => {
    const { binary } = fakeBinary(claudeVersion);
    const { query } = fakeQuery({ apiProvider: 'firstParty', subscriptionType: 'max' });
    const adapter = new ClaudeAdapter(binary, claudeVersion, query as never, {
      args: ['--debug-file', '/var/log/claude.log', '--verbose', '--betas=one'],
    });
    await adapter.preflight();
    await adapter.models(root);
    const expected = { 'debug-file': '/var/log/claude.log', verbose: null, betas: 'one' };
    expect(query.mock.calls.map((call) => call[0].options.extraArgs)).toEqual([expected, expected]);
  });

  it.each([
    ['--dangerously-skip-permissions'],
    ['--allow-dangerously-skip-permissions'],
    ['--permission-mode', 'bypassPermissions'],
    ['--settings=/tmp/settings.json'],
    ['--mcp-config', 'servers.json'],
    ['--allowed-tools', 'Bash'],
    ['--allowedTools', 'Bash'],
    ['--add-dir', '/'],
    ['positional'],
  ])('refuses %s', (...args) => {
    expect(() => new ClaudeAdapter('claude', 'unprobed', undefined, { args })).toThrow(
      expect.objectContaining({ code: 'invalid_user_config' }) as DomainError,
    );
  });
});

describe('Codex preflight', () => {
  it.each([
    [
      'a ChatGPT login',
      { type: 'chatgpt', planType: 'plus', email },
      { state: 'ok', email, plan: 'plus' },
    ],
    ['no login', null, { state: 'logged_out', reason: 'Unverified account channel' }],
    ['an API key', { type: 'apiKey' }, { state: 'unsupported_channel', reason: 'API key account' }],
  ])('reports %s', async (_, account, auth) => {
    const { binary } = fakeBinary('codex-cli 0.165.0', account);
    const adapter = new CodexAdapter(binary);
    expect(await adapter.preflight()).toEqual({
      installed: true,
      version: 'codex-cli 0.165.0',
      min_version: '0.165.0',
      version_ok: true,
      auth,
    });
    expect(adapter.report.version).toBe('codex-cli 0.165.0');
  });

  it('marks a version below the minimum and a missing binary', async () => {
    const { binary } = fakeBinary('codex-cli 0.164.2', { type: 'chatgpt' });
    expect(await new CodexAdapter(binary).preflight()).toMatchObject({ version_ok: false });
    expect(await new CodexAdapter(path.join(root, 'missing-codex')).preflight()).toMatchObject({
      installed: false,
      version: null,
      version_ok: null,
    });
  });

  it('puts the configured arguments before app-server', async () => {
    const fake = fakeBinary('codex-cli 0.165.0', { type: 'chatgpt', planType: 'plus' });
    const args = ['-c', 'model_reasoning_summary="concise"', '--enable', 'web_search'];
    const adapter = new CodexAdapter(fake.binary, 'codex-cli 0.165.0', { args });
    await adapter.preflight();
    await adapter.models(root);
    const spec: SessionSpec = {
      platform_session_id: 'preflight-session',
      project_id: 'preflight-project',
      runtime: 'codex',
      device_id: 'local',
      role: 'writer',
      cwd: root,
      env_allowlist: NATIVE_ENV_ALLOWLIST,
      skills: [],
      mcp_servers: [],
      budget: { max_turns: 1, wall_time_ms: 10000 },
    };
    const handle = await adapter.start(spec, () => {});
    await adapter.close(handle, Date.now() + 10000);
    const launches = fake.argv();
    expect(launches).toHaveLength(3);
    expect(launches.slice(0, 2)).toEqual([
      [...args, 'app-server'],
      [...args, 'app-server'],
    ]);
    const session = launches[2]!;
    expect(session.slice(0, args.length)).toEqual(args);
    expect(session.at(-1)).toBe('app-server');
  });

  it.each([
    ['--dangerously-bypass-approvals-and-sandbox'],
    ['--full-auto'],
    ['--profile', 'yolo'],
    ['-p', 'yolo'],
    ['-s', 'danger-full-access'],
    ['--sandbox=workspace-write'],
    ['-a', 'never'],
    ['--ask-for-approval', 'never'],
    ['-c', 'sandbox_mode="danger-full-access"'],
    ['--config', 'sandbox_workspace_write.network_access=true'],
    ['--config=approval_policy="never"'],
    ['-c', 'approval_policy="never"'],
  ])('refuses %s', (...args) => {
    expect(() => new CodexAdapter('codex', 'unprobed', { args })).toThrow(
      expect.objectContaining({ code: 'invalid_user_config' }) as DomainError,
    );
  });
});
