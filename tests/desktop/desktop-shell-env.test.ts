import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureShellPath,
  parseShellPath,
  shellPath,
} from '../../apps/desktop/src/main/shell-env.js';
import { eventually } from '../helpers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-shell-env-'));
  roots.push(root);
  return root;
}
/** A stand-in for `$SHELL -ilc <script>` that prints rc noise around the script's output. */
function fakeShell(root: string, body: string): string {
  const shell = path.join(root, 'shell');
  writeFileSync(shell, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return shell;
}
const noisyShell = (root: string, PATH: string) =>
  fakeShell(root, `echo 'Last login: today'\nPATH=${PATH}\neval "$2"\necho 'rc done'`);

it('reads the PATH between the markers and ignores what the rc files print around it', () => {
  const marker = '__marker__';
  expect(
    parseShellPath(`Last login: today\n${marker}/a/bin:/usr/bin${marker}\nrc done\n`, marker),
  ).toBe('/a/bin:/usr/bin');
  expect(parseShellPath(`${marker}/a/bin:/usr/bin\n`, marker)).toBeUndefined();
  expect(parseShellPath(`${marker}${marker}`, marker)).toBeUndefined();
  expect(parseShellPath('no markers here', marker)).toBeUndefined();
});

it('captures the login shell PATH and caches it when nothing is cached yet', async () => {
  const root = tempRoot();
  const cache = path.join(root, 'shell-env.json');
  const shell = noisyShell(root, '/login/bin:/usr/bin:/bin');
  expect(await shellPath(cache, { shell })).toBe('/login/bin:/usr/bin:/bin');
  expect(JSON.parse(readFileSync(cache, 'utf8')).path).toBe('/login/bin:/usr/bin:/bin');
});

it('starts with the cached PATH and refreshes the cache for the next start', async () => {
  const root = tempRoot();
  const cache = path.join(root, 'shell-env.json');
  writeFileSync(cache, JSON.stringify({ path: '/cached/bin:/usr/bin' }));
  const shell = noisyShell(root, '/fresh/bin:/usr/bin:/bin');
  expect(await shellPath(cache, { shell })).toBe('/cached/bin:/usr/bin');
  await eventually(
    () => JSON.parse(readFileSync(cache, 'utf8')).path === '/fresh/bin:/usr/bin:/bin',
  );
});

it('falls back to the own PATH when the shell does not answer in time', async () => {
  const root = tempRoot();
  const cache = path.join(root, 'shell-env.json');
  const shell = fakeShell(root, 'exec sleep 30');
  const started = Date.now();
  expect(await shellPath(cache, { shell, timeout: 300 })).toBe(process.env.PATH);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(existsSync(cache)).toBe(false);
});

it.skipIf(process.platform === 'win32')(
  'ends what the rc files started when the shell does not answer in time',
  async () => {
    const root = tempRoot();
    // A sleep that ends by itself, with a length no other process has.
    const length = `20.${process.pid}${Date.now() % 1000}`;
    const pids = path.join(root, 'pids');
    const shell = fakeShell(root, `sleep ${length} &\necho "$$ $!" > '${pids}'\nwait`);
    const started = Date.now();
    expect(await captureShellPath({ shell, timeout: 1000 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
    const [, rcChild] = readFileSync(pids, 'utf8').trim().split(' ') as [string, string];
    const command = () => {
      try {
        return execFileSync('ps', ['-o', 'command=', '-p', rcChild], { encoding: 'utf8' });
      } catch {
        return '';
      }
    };
    await eventually(() => !command().includes(length));
  },
);

it('runs a csh-family shell with -l alone and gives it the command on stdin', async () => {
  const root = tempRoot();
  const shell = path.join(root, 'csh');
  writeFileSync(
    shell,
    `#!/bin/sh\nprintf '%s\\n' "$*" > '${path.join(root, 'args')}'\nPATH=/csh/bin:/usr/bin:/bin exec sh -s\n`,
    { mode: 0o755 },
  );
  expect(await captureShellPath({ shell, timeout: 2000 })).toBe('/csh/bin:/usr/bin:/bin');
  expect(readFileSync(path.join(root, 'args'), 'utf8')).toBe('-l\n');
});

it.skipIf(!existsSync('/bin/tcsh'))('captures the PATH of a real tcsh', async () => {
  expect(await captureShellPath({ shell: '/bin/tcsh' })).toMatch(/\//);
});
