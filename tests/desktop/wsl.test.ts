import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  INTERACTIVE_PATH_SCRIPT,
  PREREQUISITE_SCRIPT,
  checkDistro,
  listDistros,
  parseDistroList,
  parsePrerequisites,
  runWsl,
  windowsPathFromWsl,
  wslPathFromWindows,
  wslUnavailable,
} from '../../apps/desktop/src/main/wsl.js';

const utf16 = (text: string) => Buffer.from(text, 'utf16le');
const verboseList =
  '  NAME              STATE           VERSION\r\n' +
  '* Ubuntu            Running         2\r\n' +
  '  docker-desktop    Stopped         2\r\n';

describe('distro list', () => {
  it('reads the UTF-16 list, marks the default distro and leaves out Docker Desktop', () => {
    expect(parseDistroList(utf16(verboseList))).toEqual([
      { name: 'Ubuntu', state: 'Running', version: 2, isDefault: true },
    ]);
  });

  it('runs wsl.exe --list --verbose with a deadline and keeps only WSL2 distros', async () => {
    const calls: unknown[][] = [];
    const distros = await listDistros(async (...call) => {
      calls.push(call);
      return utf16(`${verboseList}  Legacy            Stopped         1\r\n`);
    });
    expect(calls).toEqual([['wsl.exe', ['--list', '--verbose'], undefined, 15_000]]);
    expect(distros.map((distro) => distro.name)).toEqual(['Ubuntu']);
  });
});

describe('prerequisites', () => {
  const report = (overrides: Record<string, string> = {}) =>
    Object.entries({
      home: '/home/ada',
      git: '/usr/bin/git',
      bwrap: '/usr/bin/bwrap',
      socat: '/usr/bin/socat',
      claude: '/home/ada/.local/bin/claude',
      codex: '/usr/local/bin/codex',
      claude_version: '2.1.0 (Claude Code)',
      codex_version: 'codex-cli 0.50.0',
      userns: '1',
      libatomic: '1',
      ...overrides,
    })
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

  it('reports nothing missing when every tool is there', () => {
    expect(parsePrerequisites(`profile noise\n${report()}\n`)).toEqual({
      home: '/home/ada',
      git: '/usr/bin/git',
      bwrap: '/usr/bin/bwrap',
      socat: '/usr/bin/socat',
      claude: '/home/ada/.local/bin/claude',
      codex: '/usr/local/bin/codex',
      claudeVersion: '2.1.0 (Claude Code)',
      codexVersion: 'codex-cli 0.50.0',
      userns: true,
      missing: [],
    });
  });

  it('reports libatomic missing where the bundled Node needs it', () => {
    expect(parsePrerequisites(report({ libatomic: '' })).missing).toEqual(['libatomic']);
    expect(wslUnavailable('Ubuntu', ['libatomic'])).toContain('sudo apt install libatomic1');
  });

  it('reports bubblewrap missing', () => {
    expect(parsePrerequisites(report({ bwrap: '', userns: '0' })).missing).toEqual([
      'bwrap',
      'userns',
    ]);
  });

  it('reports user namespaces missing when bubblewrap cannot start a sandbox', () => {
    const result = parsePrerequisites(report({ userns: '0' }));
    expect(result.userns).toBe(false);
    expect(result.missing).toEqual(['userns']);
  });

  it('does not count a missing Claude as missing when Codex is there', () => {
    const result = parsePrerequisites(report({ claude: '', claude_version: '' }));
    expect(result.claude).toBe('');
    expect(result.claudeVersion).toBe('');
    expect(result.codex).toBe('/usr/local/bin/codex');
    expect(result.missing).toEqual([]);
  });

  it('feeds the script to a login bash in the chosen distro with a deadline', async () => {
    const calls: unknown[][] = [];
    const result = await checkDistro('Ubuntu', async (...call) => {
      calls.push(call);
      return Buffer.from(report(), 'utf8');
    });
    expect(calls).toEqual([
      ['wsl.exe', ['-d', 'Ubuntu', '--exec', 'bash', '-l', '-s'], PREREQUISITE_SCRIPT, 15_000],
    ]);
    expect(result.missing).toEqual([]);
  });

  it('looks for libatomic with the ldconfig in sbin, which a non-root PATH leaves out', () => {
    expect(PREREQUISITE_SCRIPT).toContain(
      '{ /sbin/ldconfig -p || /usr/sbin/ldconfig -p || ldconfig -p; } 2>/dev/null',
    );
  });

  it.runIf(process.platform === 'linux')('gives up on a version probe that does not answer', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pantheon-wsl-home-'));
    try {
      const bin = path.join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nsleep 30\n');
      chmodSync(path.join(bin, 'claude'), 0o755);
      const started = Date.now();
      const stdout = execFileSync(
        'env',
        ['-i', `HOME=${home}`, `PATH=${bin}:/usr/bin:/bin`, 'bash', '-s'],
        {
          input: PREREQUISITE_SCRIPT,
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(parsePrerequisites(stdout).claude).toBe(path.join(bin, 'claude'));
      expect(parsePrerequisites(stdout).claudeVersion).toBe('');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'linux')('runs the script in a real login bash', () => {
    const stdout = execFileSync('bash', ['-l', '-s'], {
      input: PREREQUISITE_SCRIPT,
      encoding: 'utf8',
    });
    const result = parsePrerequisites(stdout);
    expect(result.home).toBe(process.env.HOME);
    expect(result.git).toMatch(/\/git$/);
    expect(result.bwrap).toMatch(/\/bwrap$/);
    expect(result.socat).toMatch(/\/socat$/);
    expect(result.missing.filter((name) => name !== 'userns')).toEqual([]);
  });

  it.runIf(process.platform === 'linux')(
    'takes the PATH an interactive bash sets up past the non-interactive return in .bashrc',
    () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'pantheon-wsl-home-'));
      try {
        const nvm = path.join(home, 'nvm-bin');
        writeFileSync(
          path.join(home, '.bashrc'),
          `case $- in\n  *i*) ;;\n  *) return;;\nesac\necho noise\nexport PATH="${nvm}:$PATH"\n`,
        );
        const login = (script: string) =>
          execFileSync('env', ['-i', `HOME=${home}`, 'PATH=/usr/bin:/bin', 'bash', '-lc', script], {
            encoding: 'utf8',
          });
        expect(login('printf %s "$PATH"')).not.toContain(nvm);
        expect(login(`${INTERACTIVE_PATH_SCRIPT}; printf %s "$PATH"`)).toContain(nvm);
        // From ssh the shell has a terminal, which an interactive bash tries to take over.
        const script = `${INTERACTIVE_PATH_SCRIPT}; printf %s "$PATH"`.replaceAll("'", "'\\''");
        const withTerminal = execFileSync(
          'script',
          ['-qec', `env -i HOME=${home} PATH=/usr/bin:/bin bash -lc '${script}'`, '/dev/null'],
          { encoding: 'utf8', timeout: 20_000 },
        );
        expect(withTerminal).toContain(nvm);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

describe('wsl.exe calls', () => {
  it('rejects a call that does not exit within its timeout', async () => {
    const call = runWsl(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], undefined, 300);
    const outcome = await Promise.race([
      call.then(
        () => 'answered',
        () => 'rejected',
      ),
      sleep(4000).then(() => 'still running'),
    ]);
    expect(outcome).toBe('rejected');
  });
});

describe('path conversion', () => {
  it('reads a folder of the distro or of a Windows drive as its Linux path', () => {
    expect(wslPathFromWindows('\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', 'Ubuntu')).toBe(
      '/home/u/proj',
    );
    expect(wslPathFromWindows('\\\\WSL$\\ubuntu\\home\\u', 'Ubuntu')).toBe('/home/u');
    expect(wslPathFromWindows('\\\\wsl.localhost\\Ubuntu\\', 'Ubuntu')).toBe('/');
    expect(wslPathFromWindows('C:\\x y\\z', 'Ubuntu')).toBe('/mnt/c/x y/z');
  });

  it('has no Linux path for another distro, a network share or a relative path', () => {
    expect(wslPathFromWindows('\\\\wsl.localhost\\Debian\\home\\u', 'Ubuntu')).toBeUndefined();
    expect(wslPathFromWindows('\\\\server\\share\\x', 'Ubuntu')).toBeUndefined();
    expect(wslPathFromWindows('x\\y', 'Ubuntu')).toBeUndefined();
  });

  it('writes a Linux path as a drive path under /mnt, else through the distro share', () => {
    expect(windowsPathFromWsl('/mnt/c/x y/z', 'Ubuntu')).toBe('C:\\x y\\z');
    expect(windowsPathFromWsl('/home/u/proj', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj',
    );
  });
});
