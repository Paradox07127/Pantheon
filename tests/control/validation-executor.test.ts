import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insideSandbox, fixture } from '../helpers.js';
import { runValidationCommand } from '../../packages/control/dist/validation-executor.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { NATIVE_ENV_ALLOWLIST } from '@pantheon/domain';

/** A Control with a folder that stands for the gate candidate a verifier runs in. */
function candidateFixture(options?: Parameters<typeof fixture>[0]) {
  const f = fixture(options);
  const candidate = path.join(f.root, 'candidate');
  mkdirSync(candidate);
  return { ...f, candidate };
}

const isolated = process.platform === 'darwin' || process.platform === 'linux';
// Seatbelt denies access; bubblewrap leaves outside paths unmounted and mounts protected ones read-only.
const denied = JSON.stringify(
  process.platform === 'linux' ? ['ENOENT', 'EROFS'] : ['EPERM', 'EACCES'],
);

it.skipIf(!isolated || insideSandbox)(
  'isolates verifier file writes, sentinel reads and symlinks and allows only loopback network',
  async () => {
    const f = candidateFixture();
    try {
      const sentinel = path.join(f.root, 'outside');
      writeFileSync(sentinel, 'outside value');
      symlinkSync(sentinel, path.join(f.candidate, 'escape'));
      const script = `const fs = require('node:fs');
      const net = require('node:net');
      fs.writeFileSync('allowed', 'candidate output');
      for (const operation of [() => fs.readFileSync(${JSON.stringify(sentinel)}), () => fs.readFileSync('escape'), () => fs.linkSync(${JSON.stringify(sentinel)}, 'new-hardlink'), () => fs.writeFileSync(${JSON.stringify(sentinel)}, 'changed')]) {
        try { operation(); throw new Error('isolation escape'); } catch (e) { if (!${denied}.includes(e.code)) throw e; }
      }
      const server = net.createServer((socket) => socket.end('loopback reply'));
      server.on('error', (error) => { console.error('loopback listen failed: ' + error.code); process.exit(4); });
      server.listen(0, '127.0.0.1', () => {
        const local = net.connect(server.address().port, '127.0.0.1');
        local.on('error', (error) => { console.error('loopback connect failed: ' + error.code); process.exit(5); });
        local.on('data', (reply) => {
          if (String(reply) !== 'loopback reply') process.exit(6);
          server.close();
          const remote = net.connect(80, '10.255.255.1');
          remote.on('connect', () => { console.error('network escape'); process.exit(2); });
          remote.on('error', (error) => {
            if (!['EPERM', 'EACCES', 'ENETUNREACH'].includes(error.code)) { console.error('remote error ' + error.code); process.exit(3); }
            console.log('boundaries verified');
          });
        });
      });`;
      const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
      const result = await runValidationCommand({
        ctx,
        key: 'check-process:isolation:0',
        argv: [process.execPath, '-e', script],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 3000,
      });
      expect(result.error ?? result.stderr.toString()).toBe('');
      expect(result.exit_code).toBe(0);
      expect(result.stdout.toString()).toContain('boundaries verified');
      expect(readFileSync(sentinel, 'utf8')).toBe('outside value');
      expect(readFileSync(path.join(f.candidate, 'allowed'), 'utf8')).toBe('candidate output');
      expect(result.boundary).toMatchObject({
        network: 'loopback',
        supported: true,
        policy_sha256: expect.any(String),
      });
    } finally {
      await f.close();
    }
  },
);

it.skipIf(!isolated || insideSandbox)(
  'lets native processes that a verifier starts run git',
  async () => {
    const f = candidateFixture();
    try {
      // A verifier that starts a native agent passes it only the allowlisted variables.
      const script = `const { spawnSync } = require('node:child_process');
      const allowlist = ${JSON.stringify(NATIVE_ENV_ALLOWLIST)};
      const env = Object.fromEntries(allowlist.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
      const git = spawnSync('git', ['config', '--list'], { env, encoding: 'utf8' });
      process.stderr.write(git.stderr);
      process.exit(git.status);`;
      const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
      const result = await runValidationCommand({
        ctx,
        key: 'check-process:native-git:0',
        argv: [process.execPath, '-e', script],
        cwd: f.candidate,
        root: f.candidate,
        env: { PATH: process.env.PATH },
        timeoutMs: 3000,
      });
      expect(result.stderr.toString()).toBe('');
      expect(result.exit_code).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it.skipIf(!isolated || insideSandbox).each([
  { argv: ['npm', '--version'] },
  // Gate commands run through the shell, which finds npm on PATH.
  { argv: ['/bin/sh', '-c', 'npm --version'] },
])('lets a package manager installed as a script read its own package: $argv', async ({ argv }) => {
  const f = candidateFixture();
  try {
    const result = await runValidationCommand({
      ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
      key: 'check-process:package-manager:0',
      argv,
      cwd: f.candidate,
      root: f.candidate,
      env: { PATH: process.env.PATH },
      timeoutMs: 20000,
    });
    expect(result.exit_code, result.error ?? result.tail).toBe(0);
    expect(result.stdout.toString()).toMatch(/^\d+\.\d+\.\d+/);
  } finally {
    await f.close();
  }
});

it.skipIf(!isolated)('rejects writable hardlinks before starting a verifier', async () => {
  const f = candidateFixture();
  try {
    const outside = path.join(f.root, 'outside');
    writeFileSync(outside, 'sentinel');
    linkSync(outside, path.join(f.candidate, 'linked'));
    const result = await runValidationCommand({
      ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
      key: 'check-process:hardlink:0',
      argv: ['/usr/bin/true'],
      cwd: f.candidate,
      root: f.candidate,
      disposable: true,
      timeoutMs: 1000,
    });
    expect(result.exit_code).toBeNull();
    expect(result.error).toContain('hardlink');
  } finally {
    await f.close();
  }
});

it.skipIf(!isolated || insideSandbox)(
  'runs in a root that is not a disposable clone when its installed packages are hardlinked',
  async () => {
    const f = candidateFixture();
    try {
      const stored = path.join(f.root, 'package-store/index.js');
      mkdirSync(path.dirname(stored));
      writeFileSync(stored, 'module.exports = 1;\n');
      mkdirSync(path.join(f.candidate, 'node_modules/pkg'), { recursive: true });
      linkSync(stored, path.join(f.candidate, 'node_modules/pkg/index.js'));
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:installed-hardlink:0',
        argv: ['/usr/bin/true'],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.exit_code).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it.skipIf(!isolated || insideSandbox)(
  'records bounded stop evidence when a verifier exceeds its timeout',
  async () => {
    const f = candidateFixture();
    try {
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:timeout:0',
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 250,
      });
      expect(result).toMatchObject({
        timedOut: true,
        signal: 'SIGKILL',
        stopped: { reason: 'timeout', descendants: 'unconfirmed' },
      });
    } finally {
      await f.close();
    }
  },
);

it('fails closed without launching commands on an unsupported platform', async () => {
  const f = candidateFixture();
  const realProcess = process;
  try {
    vi.stubGlobal('process', { ...realProcess, platform: 'win32' });
    const result = await runValidationCommand({
      ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
      key: 'check-process:unsupported:0',
      argv: ['/usr/bin/true'],
      cwd: f.candidate,
      root: f.candidate,
      timeoutMs: 1000,
    });
    expect(result).toMatchObject({
      exit_code: null,
      boundary: { supported: false },
      error: expect.stringContaining('validation_isolation_unavailable'),
    });
  } finally {
    vi.unstubAllGlobals();
    await f.close();
  }
});

it.skipIf(!isolated || insideSandbox)(
  "reads the candidate's agent configuration files but cannot change them",
  async () => {
    const f = candidateFixture();
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(path.join(f.candidate, '.claude/agents'), { recursive: true });
      writeFileSync(path.join(f.candidate, '.claude/agents/worker.md'), 'tracked notes\n');
      const script = `const fs = require('node:fs');
      process.stdout.write(fs.readFileSync('.claude/agents/worker.md', 'utf8'));
      try { fs.writeFileSync('.claude/agents/worker.md', 'changed'); console.error('write escape'); process.exit(2); }
      catch (e) { if (!${denied}.includes(e.code)) throw e; }`;
      const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
      const result = await runValidationCommand({
        ctx,
        key: 'check-process:agent-configuration:0',
        argv: [process.execPath, '-e', script],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 3000,
      });
      expect(result.stderr.toString()).toBe('');
      expect(result.exit_code).toBe(0);
      expect(result.stdout.toString()).toBe('tracked notes\n');
      expect(readFileSync(path.join(f.candidate, '.claude/agents/worker.md'), 'utf8')).toBe(
        'tracked notes\n',
      );
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'keeps verifier writes outside the candidate off the host on Linux',
  async () => {
    const f = candidateFixture();
    try {
      const sentinel = path.join(f.root, 'outside');
      writeFileSync(sentinel, 'outside value');
      const script = `const fs = require('node:fs');
      for (const target of [${JSON.stringify(sentinel)}, '/escape', '/tmp/escape']) {
        try { fs.writeFileSync(target, 'changed'); console.error('write escape ' + target); process.exit(2); }
        catch (e) { if (!['ENOENT', 'EROFS'].includes(e.code)) throw e; }
      }`;
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:outside-write:0',
        argv: [process.execPath, '-e', script],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 3000,
      });
      expect(result.error ?? result.stderr.toString()).toBe('');
      expect(result.exit_code).toBe(0);
      expect(result.boundary).toMatchObject({ kind: 'linux-bubblewrap', supported: true });
      expect(readFileSync(sentinel, 'utf8')).toBe('outside value');
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'hides protected folders outside the candidate, also inside a mounted package, on Linux',
  async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'pantheon-protected-'));
    const home = path.join(base, 'home'),
      tool = path.join(base, 'lib/node_modules/tool'),
      secrets = path.join(tool, 'secrets'),
      script = path.join(tool, 'bin/tool.js');
    mkdirSync(path.join(home, '.ssh'), { recursive: true });
    writeFileSync(path.join(home, '.ssh/key'), 'home secret');
    mkdirSync(path.join(tool, 'bin'), { recursive: true });
    mkdirSync(secrets);
    writeFileSync(path.join(secrets, 'key'), 'package secret');
    writeFileSync(path.join(tool, 'package.json'), '{"name":"tool"}');
    writeFileSync(
      script,
      `#!/usr/bin/env node
      const fs = require('node:fs');
      process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(tool, 'package.json'))}, 'utf8'));
      for (const target of ${JSON.stringify([path.join(home, '.ssh/key'), path.join(secrets, 'key')])}) {
        try { fs.readFileSync(target); console.error('read escape ' + target); process.exit(2); }
        catch (e) { if (!['ENOENT', 'EACCES'].includes(e.code)) throw e; }
      }`,
    );
    chmodSync(script, 0o755);
    const f = candidateFixture({
      controlOptions: {
        protectionPaths: {
          home,
          dataDir: path.join(base, 'data'),
          desktopUserDataDir: path.join(base, 'desktop'),
          codexHome: secrets,
          backupDir: path.join(base, 'backup'),
        },
      },
    });
    try {
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:protected-read:0',
        argv: [script],
        cwd: f.candidate,
        root: f.candidate,
        env: { PATH: process.env.PATH },
        timeoutMs: 3000,
      });
      expect(result.error ?? result.stderr.toString()).toBe('');
      expect(result.exit_code).toBe(0);
      expect(result.stdout.toString()).toBe('{"name":"tool"}');
    } finally {
      await f.close();
      rmSync(base, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux')(
  "mounts the candidate's .git read-only and lets git status run on Linux",
  async () => {
    const f = candidateFixture();
    try {
      execFileSync('git', ['init', '-q'], { cwd: f.candidate });
      writeFileSync(path.join(f.candidate, 'answer.txt'), '42\n');
      const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
      const write = await runValidationCommand({
        ctx,
        key: 'check-process:repository-write:0',
        argv: [
          process.execPath,
          '-e',
          `try { require('node:fs').writeFileSync('.git/config', ''); process.exit(2); } catch (e) { if (e.code !== 'EROFS') throw e; }`,
        ],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 3000,
      });
      expect(write.error ?? write.stderr.toString()).toBe('');
      expect(write.exit_code).toBe(0);
      expect(readFileSync(path.join(f.candidate, '.git/config'), 'utf8')).not.toBe('');
      const status = await runValidationCommand({
        ctx,
        key: 'check-process:repository-status:0',
        argv: ['git', 'status', '--porcelain'],
        cwd: f.candidate,
        root: f.candidate,
        env: { PATH: process.env.PATH },
        timeoutMs: 5000,
      });
      expect(status.error ?? status.stderr.toString()).toBe('');
      expect(status.exit_code).toBe(0);
      expect(status.stdout.toString()).toBe('?? answer.txt\n');
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'removes a protected file the command created in the candidate and fails the run on Linux',
  async () => {
    const f = candidateFixture();
    try {
      execFileSync('git', ['init', '-q'], { cwd: f.candidate });
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:protected-create:0',
        argv: ['/bin/sh', '-c', 'touch .mcp.json'],
        cwd: f.candidate,
        root: f.candidate,
        disposable: true,
        timeoutMs: 3000,
      });
      expect(result.error).toContain('validation_scope_violation');
      expect(result.exit_code).toBeNull();
      expect(existsSync(path.join(f.candidate, '.mcp.json'))).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'fails the run but keeps a protected file that appears in a root that is not a disposable clone on Linux',
  async () => {
    const f = candidateFixture();
    try {
      execFileSync('git', ['init', '-q'], { cwd: f.candidate });
      const settings = path.join(f.candidate, '.claude/settings.local.json');
      const run = runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:protected-appears:0',
        argv: ['/bin/sh', '-c', 'sleep 1'],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 5000,
      });
      // Outside the sandbox the empty folder that stands in for the missing entry stays writable.
      while (!existsSync(path.dirname(settings)))
        await new Promise((resolve) => setTimeout(resolve, 20));
      writeFileSync(settings, '{}\n');
      const result = await run;
      expect(result.error).toContain('validation_scope_violation');
      expect(readFileSync(settings, 'utf8')).toBe('{}\n');
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'keeps a command from creating agent configuration in a root that is not a disposable clone on Linux',
  async () => {
    const f = candidateFixture();
    try {
      execFileSync('git', ['init', '-q'], { cwd: f.candidate });
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:protected-session-create:0',
        argv: [
          '/bin/sh',
          '-c',
          'mkdir -p .claude; echo "{}" > .claude/settings.json; echo "{}" > .mcp.json; true',
        ],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 3000,
      });
      expect(existsSync(path.join(f.candidate, '.claude/settings.json'))).toBe(false);
      expect(result.error).toContain('validation_scope_violation');
      // The stand-ins for the missing entries are gone after the run.
      expect(existsSync(path.join(f.candidate, '.claude'))).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'shares the folders standing in for missing agent configuration between parallel runs in one root on Linux',
  async () => {
    const f = candidateFixture();
    try {
      execFileSync('git', ['init', '-q'], { cwd: f.candidate });
      const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
      const results = await Promise.all(
        ['0.2', '1'].map((seconds, index) =>
          runValidationCommand({
            ctx,
            key: `check-process:parallel-placeholders:${index}`,
            argv: ['/bin/sh', '-c', `sleep ${seconds}`],
            cwd: f.candidate,
            root: f.candidate,
            timeoutMs: 5000,
          }),
        ),
      );
      for (const result of results) {
        expect(result.error).toBeUndefined();
        expect(result.exit_code).toBe(0);
      }
      expect(existsSync(path.join(f.candidate, '.claude'))).toBe(false);
      expect(existsSync(path.join(f.candidate, '.codex'))).toBe(false);
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'leaves a missing protected file absent while the command runs on Linux',
  async () => {
    const f = candidateFixture();
    try {
      execFileSync('git', ['init', '-q'], { cwd: f.candidate });
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:protected-file-absent:0',
        argv: ['/bin/sh', '-c', 'test ! -e .env'],
        cwd: f.candidate,
        root: f.candidate,
        disposable: true,
        timeoutMs: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.exit_code).toBe(0);
    } finally {
      await f.close();
    }
  },
);

it.skipIf(!isolated || insideSandbox)(
  'skips a folder on PATH named like the command and runs the executable after it',
  async () => {
    const f = candidateFixture();
    try {
      const shadow = path.join(f.root, 'shadow'),
        tools = path.join(f.root, 'tools');
      mkdirSync(path.join(shadow, 'greet'), { recursive: true });
      mkdirSync(tools);
      writeFileSync(path.join(tools, 'greet'), '#!/bin/sh\necho greeted\n');
      chmodSync(path.join(tools, 'greet'), 0o755);
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:shadowed-command:0',
        argv: ['greet'],
        cwd: f.candidate,
        root: f.candidate,
        env: { PATH: `${shadow}:${tools}:/usr/bin:/bin` },
        timeoutMs: 5000,
      });
      expect(result.error ?? result.stderr.toString()).toBe('');
      expect(result.stdout.toString()).toBe('greeted\n');
    } finally {
      await f.close();
    }
  },
);

it.skipIf(!isolated || insideSandbox)(
  'settles a timed-out verifier whose descendant in its own session keeps the output open',
  async () => {
    const f = candidateFixture();
    try {
      const script = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'inherit' }).unref();
      setTimeout(() => {}, 30000);`;
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:detached-output:0',
        argv: [process.execPath, '-e', script],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 500,
      });
      expect(result.timedOut).toBe(true);
      expect(result.duration_ms).toBeLessThan(5000);
    } finally {
      await f.close();
    }
  },
);

it.skipIf(!isolated || insideSandbox)(
  'lets a command in a linked worktree read the git metadata it points to',
  async () => {
    const f = candidateFixture();
    try {
      const source = path.join(f.root, 'linked-source');
      const worktree = path.join(f.root, 'linked-worktree');
      mkdirSync(source);
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
      git(source, 'init', '-q');
      writeFileSync(path.join(source, 'file.txt'), 'content\n');
      git(source, 'add', 'file.txt');
      git(
        source,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-qm',
        'Add file',
      );
      git(source, 'worktree', 'add', '--quiet', '--detach', worktree);
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:linked-worktree-git:0',
        argv: ['git', 'rev-parse', 'HEAD'],
        cwd: worktree,
        root: worktree,
        env: { PATH: process.env.PATH },
        timeoutMs: 5000,
      });
      expect(result.error ?? result.stderr.toString()).toBe('');
      expect(result.exit_code).toBe(0);
      expect(result.stdout.toString().trim()).toBe(git(source, 'rev-parse', 'HEAD'));
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'allows a loopback server inside the sandbox and no outside network on Linux',
  async () => {
    const f = candidateFixture();
    try {
      const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
      const remote = await runValidationCommand({
        ctx,
        key: 'check-process:remote-network:0',
        argv: ['bash', '-c', '</dev/tcp/1.1.1.1/443'],
        cwd: f.candidate,
        root: f.candidate,
        env: { PATH: process.env.PATH },
        timeoutMs: 5000,
      });
      expect(remote.error).toBeUndefined();
      expect(remote.exit_code).not.toBe(0);
      expect(remote.stderr.toString()).toContain('Network is unreachable');
      const script = `const net = require('node:net');
      const server = net.createServer((socket) => socket.end('loopback reply'));
      server.listen(0, '127.0.0.1', () => {
        net.connect(server.address().port, '127.0.0.1').on('data', (reply) => {
          console.log(String(reply));
          server.close();
        });
      });`;
      const local = await runValidationCommand({
        ctx,
        key: 'check-process:loopback-network:0',
        argv: [process.execPath, '-e', script],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 3000,
      });
      expect(local.error ?? local.stderr.toString()).toBe('');
      expect(local.stdout.toString()).toBe('loopback reply\n');
    } finally {
      await f.close();
    }
  },
);

it.runIf(process.platform === 'linux')(
  'runs tools that a gate command finds on PATH outside the system folders on Linux',
  async () => {
    const f = candidateFixture();
    try {
      // A Node install under HOME: bin holds the binary and a link into lib/node_modules.
      const prefix = path.join(f.root, 'toolchain');
      const pkg = path.join(prefix, 'lib', 'node_modules', 'greeter');
      mkdirSync(path.join(prefix, 'bin'), { recursive: true });
      mkdirSync(path.join(pkg, 'bin'), { recursive: true });
      writeFileSync(path.join(pkg, 'package.json'), '{"name":"greeter"}');
      writeFileSync(path.join(pkg, 'message.txt'), 'hello from greeter\n');
      writeFileSync(
        path.join(pkg, 'bin', 'greet'),
        '#!/bin/sh\ncat "$(dirname "$(readlink -f "$0")")/../message.txt"\n',
      );
      chmodSync(path.join(pkg, 'bin', 'greet'), 0o755);
      symlinkSync('../lib/node_modules/greeter/bin/greet', path.join(prefix, 'bin', 'greet'));
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'check-process:path-tool:0',
        argv: ['/bin/sh', '-c', 'greet'],
        cwd: f.candidate,
        root: f.candidate,
        env: { PATH: `${path.join(prefix, 'bin')}:/usr/bin:/bin` },
        timeoutMs: 5000,
      });
      expect(result.error ?? result.stderr.toString()).toBe('');
      expect(result.stdout.toString()).toBe('hello from greeter\n');
      // A PATH folder inside protected state stays unmounted.
      const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
      const hidden = path.join(path.dirname(ctx.files.directory), 'tools');
      mkdirSync(hidden, { recursive: true });
      writeFileSync(path.join(hidden, 'secret'), '#!/bin/sh\necho leaked\n');
      chmodSync(path.join(hidden, 'secret'), 0o755);
      const denied = await runValidationCommand({
        ctx,
        key: 'check-process:protected-path-tool:0',
        argv: ['/bin/sh', '-c', 'secret'],
        cwd: f.candidate,
        root: f.candidate,
        env: { PATH: `${hidden}:/usr/bin:/bin` },
        timeoutMs: 5000,
      });
      expect(denied.stdout.toString()).toBe('');
      expect(denied.stderr.toString()).toContain('secret: not found');
    } finally {
      await f.close();
    }
  },
);

it.skipIf(!isolated || insideSandbox)(
  'collects test counts from verifier stdout and stderr',
  async () => {
    const f = candidateFixture();
    try {
      const result = await runValidationCommand({
        ctx: (f.control as unknown as { ctx: ControlContext }).ctx,
        key: 'summary-output',
        argv: [
          process.execPath,
          '-e',
          "console.log('Tests  4 passed (4)'); console.error('test result: FAILED. 2 passed; 1 failed; 3 ignored');",
        ],
        cwd: f.candidate,
        root: f.candidate,
        timeoutMs: 10000,
      });
      expect(result.exit_code).toBe(0);
      expect(result.tests).toEqual({ passed: 6, failed: 1, skipped: 3 });
    } finally {
      await f.close();
    }
  },
);
