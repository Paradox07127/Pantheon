import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  callbacks: [] as ((error: Error | null, out: string) => void)[],
  exec: vi.fn(),
  start: vi.fn(),
  oneShot: vi.fn(),
  constructed: [] as unknown[][],
  home: '',
}));
vi.mock('node:child_process', () => ({ execFile: mock.exec }));
vi.mock('node:os', async (actual) => {
  const real = await actual<typeof import('node:os')>();
  const homedir = () => mock.home;
  return { ...real, homedir, default: { ...real, homedir } };
});
vi.mock('node:util', async (actual) => ({
  ...(await actual<object>()),
  parseArgs: () => ({ values: { 'data-dir': '/test-state' } }),
}));
vi.mock('@pantheon/adapters', async () => ({
  acpProfiles: (await import('../../packages/adapters/src/acp-profiles.js')).acpProfiles,
  AcpAdapter: class {
    constructor(...args: unknown[]) {
      mock.constructed.push(['acp', ...args]);
    }
  },
  nativeEnvironment: () => ({ PATH: '/stub' }),
  withInstallFolders: (PATH: string) => PATH,
  versionOf: () => 'synchronous-probe',
  ClaudeAdapter: class {
    constructor(...args: unknown[]) {
      mock.constructed.push(['claude', ...args]);
    }
  },
  CodexAdapter: class {
    constructor(...args: unknown[]) {
      mock.constructed.push(['codex', ...args]);
    }
  },
  OpencodeAdapter: class {
    constructor(...args: unknown[]) {
      mock.constructed.push(['opencode', ...args]);
    }
  },
  nativeRuntimes: ['claude', 'codex', 'opencode'],
  FixtureAdapter: class {},
  claudeOneShot: mock.oneShot,
}));
vi.mock('@pantheon/control', async () => ({
  runtimeConfig: (await import('../../packages/control/dist/user-config.js')).runtimeConfig,
}));
vi.mock('../../apps/daemon/src/index.js', () => ({ startDaemon: mock.start }));
beforeEach(() => {
  mock.home = mkdtempSync(path.join(os.tmpdir(), 'pantheon-entry-home-'));
  mock.callbacks.length = 0;
  mock.constructed.length = 0;
  mock.exec.mockReset();
  mock.start.mockReset();
  vi.resetModules();
  mock.exec.mockImplementation((_binary, _args, _options, callback) => {
    mock.callbacks.push(callback);
  });
  mock.start.mockResolvedValue({ url: 'http://daemon', control: { on() {} } });
  vi.spyOn(process, 'on').mockReturnValue(process);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(mock.home, { recursive: true, force: true });
});
it('starts native and ACP version probes before awaiting their results', async () => {
  const entry = import('../../apps/daemon/src/main.js');
  await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledTimes(26));
  expect(mock.start).not.toHaveBeenCalled();
  mock.callbacks[0]!(null, 'claude-version\n');
  for (const callback of mock.callbacks.slice(1)) callback(new Error('missing'), '');
  await entry;
  expect(mock.constructed.map((args) => args[2])).toEqual([
    'claude-version',
    'unprobed',
    'unprobed',
  ]);
  expect(mock.start).toHaveBeenCalledTimes(1);
});
it('probes and starts each runtime with the binary and arguments of the user configuration', async () => {
  mkdirSync(path.join(mock.home, '.pantheon'));
  writeFileSync(
    path.join(mock.home, '.pantheon/config.json'),
    JSON.stringify({
      version: 1,
      runtimes: {
        grok: { enabled: false },
        agy: { enabled: false },
        dsh: { enabled: false },
        muse: { enabled: false },
        opencode: { enabled: false },
        cursor: { enabled: false },
        copilot: { enabled: false },
        gemini: { enabled: false },
        kilo: { enabled: false },
        cline: { enabled: false },
        qwen: { enabled: false },
        kimi: { enabled: false },
        goose: { enabled: false },
        openhands: { enabled: false },
        auggie: { enabled: false },
        kiro: { enabled: false },
        junie: { enabled: false },
        devin: { enabled: false },
        vibe: { enabled: false },
        hermes: { enabled: false },
        omp: { enabled: false },
        codebuddy: { enabled: false },
        droid: { enabled: false },
        qoder: { enabled: false },
        claude: { binary: '/opt/claude/bin/claude', args: ['--verbose'] },
        codex: { binary: '/opt/codex/bin/codex', args: ['-c', 'model_verbosity=low'] },
      },
    }),
  );
  const entry = import('../../apps/daemon/src/main.js');
  await vi.waitFor(() => expect(mock.exec).toHaveBeenCalledTimes(2));
  expect(mock.exec.mock.calls.map(([binary, args]) => [binary, args])).toEqual([
    ['/opt/claude/bin/claude', ['--version']],
    ['/opt/codex/bin/codex', ['--version']],
  ]);
  mock.callbacks[0]!(null, '2.1.312 (Claude Code)\n');
  mock.callbacks[1]!(null, 'codex-cli 0.165.0\n');
  await entry;
  expect(mock.constructed).toEqual([
    [
      'claude',
      '/opt/claude/bin/claude',
      '2.1.312 (Claude Code)',
      undefined,
      { args: ['--verbose'] },
    ],
    ['codex', '/opt/codex/bin/codex', 'codex-cli 0.165.0', { args: ['-c', 'model_verbosity=low'] }],
  ]);
  expect(mock.start).toHaveBeenCalledWith(
    expect.objectContaining({ userConfigDir: path.join(mock.home, '.pantheon') }),
  );
});

it('summarizes turns with the configured Claude binary', async () => {
  mkdirSync(path.join(mock.home, '.pantheon'));
  writeFileSync(
    path.join(mock.home, '.pantheon/config.json'),
    JSON.stringify({ version: 1, runtimes: { claude: { binary: '/opt/claude/bin/claude' } } }),
  );
  mock.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, 'installed'));
  mock.oneShot.mockResolvedValue({ text: 'summary' });
  await import('../../apps/daemon/src/main.js');
  const signal = new AbortController().signal;
  await mock.start.mock.calls[0]![0].turnSummarizer('prompt', signal);
  expect(mock.oneShot).toHaveBeenCalledWith(
    'prompt',
    'claude-haiku-5-5',
    signal,
    '/opt/claude/bin/claude',
  );
});

it('summarizes turns with the Claude binary configured when the summary starts', async () => {
  const config = path.join(mock.home, '.pantheon/config.json');
  mkdirSync(path.join(mock.home, '.pantheon'));
  writeFileSync(
    config,
    JSON.stringify({ version: 1, runtimes: { claude: { binary: '/opt/claude/bin/claude' } } }),
  );
  mock.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, 'installed'));
  mock.oneShot.mockClear().mockResolvedValue({ text: 'summary' });
  await import('../../apps/daemon/src/main.js');
  const summarize = mock.start.mock.calls[0]![0].turnSummarizer;
  const signal = new AbortController().signal;
  writeFileSync(
    config,
    JSON.stringify({ version: 1, runtimes: { claude: { binary: '/usr/local/bin/claude' } } }),
  );
  await summarize('first', signal);
  writeFileSync(config, JSON.stringify({ version: 1, runtimes: {} }));
  await summarize('second', signal);
  expect(mock.oneShot.mock.calls.map((call) => call[3])).toEqual([
    '/usr/local/bin/claude',
    undefined,
  ]);
});

it('keeps new worktrees in the home configuration folder and still recognizes the earlier root', async () => {
  vi.stubEnv('PANTHEON_DATA_DIR', undefined);
  mock.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, 'installed'));
  await import('../../apps/daemon/src/main.js');
  expect(mock.start).toHaveBeenCalledWith(
    expect.objectContaining({
      directory: path.resolve('/test-state'),
      workspaceRoot: path.join(mock.home, '.pantheon/worktrees'),
      formerWorkspaceRoots: [path.resolve('/Pantheon Workspaces')],
    }),
  );
});

it('keeps worktrees beside a data directory chosen through the environment', async () => {
  vi.stubEnv('PANTHEON_DATA_DIR', '/elsewhere/state');
  mock.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, 'installed'));
  await import('../../apps/daemon/src/main.js');
  expect(mock.start).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceRoot: path.resolve('/Pantheon Workspaces') }),
  );
});

it('registers installed ACP profiles and skips a missing binary', async () => {
  mock.exec.mockImplementation((binary, _args, _options, callback) => {
    callback(binary === 'agy' ? new Error('missing') : null, `${binary}-version\n`);
  });
  await import('../../apps/daemon/src/main.js');
  expect(mock.constructed).toContainEqual([
    'acp',
    expect.objectContaining({
      name: 'grok',
      profile: expect.objectContaining({ binary: 'grok' }),
      version: 'grok-version',
    }),
  ]);
  expect(mock.constructed).toContainEqual([
    'acp',
    expect.objectContaining({
      name: 'dsh',
      profile: expect.objectContaining({ binary: 'dsh' }),
      version: 'dsh-version',
    }),
  ]);
  expect(mock.constructed).toContainEqual([
    'acp',
    expect.objectContaining({
      name: 'muse',
      profile: expect.objectContaining({ binary: 'muse' }),
      version: 'muse-version',
    }),
  ]);
  expect(mock.constructed.filter(([kind]) => kind === 'acp')).toHaveLength(22);
  expect(mock.start.mock.calls[0]![0].adapters).toHaveLength(25);
});

it('uses configured ACP binaries and extra arguments and skips a disabled profile', async () => {
  mkdirSync(path.join(mock.home, '.pantheon'));
  writeFileSync(
    path.join(mock.home, '.pantheon/config.json'),
    JSON.stringify({
      version: 1,
      runtimes: {
        grok: { binary: '/opt/grok', args: ['--verbose'] },
        agy: { binary: '/opt/agy', enabled: false },
      },
    }),
  );
  mock.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, 'installed'));
  await import('../../apps/daemon/src/main.js');
  expect(mock.exec.mock.calls.map(([binary]) => binary)).toEqual([
    'claude',
    'codex',
    'opencode',
    '/opt/grok',
    'dsh',
    'muse',
    'cursor-agent',
    'copilot',
    'gemini',
    'kilo',
    'cline',
    'qwen',
    'kimi',
    'goose',
    'openhands',
    'auggie',
    'kiro-cli',
    'junie',
    'devin',
    'vibe-acp',
    'hermes',
    'omp',
    'codebuddy',
    'droid',
    'qodercli',
  ]);
  expect(mock.constructed).toContainEqual([
    'acp',
    expect.objectContaining({
      name: 'grok',
      binary: '/opt/grok',
      args: ['--verbose'],
      version: 'installed',
    }),
  ]);
  expect(mock.constructed.filter(([kind]) => kind === 'acp')).toHaveLength(22);
});
