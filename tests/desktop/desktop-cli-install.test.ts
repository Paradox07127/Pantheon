import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_MARKER, installCli } from '../../apps/desktop/src/main/cli-install.js';

const homes: string[] = [];
const tempHome = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'pantheon-cli-install-'));
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const resources = '/Applications/Pantheon.app/Contents/Resources';

it('writes an executable launcher that runs the bundled cli with the bundled node', () => {
  const home = tempHome();
  const bin = path.join(home, '.local/bin');
  const result = installCli(resources, home, `/usr/bin:${bin}`);
  const file = path.join(bin, 'pantheon');
  expect(result).toEqual({ status: 'installed', file });
  const lines = readFileSync(file, 'utf8').split('\n');
  expect(lines[0]).toBe('#!/bin/sh');
  expect(lines[1]).toBe(CLI_MARKER);
  expect(lines[2]).toBe(`exec '${resources}/node/bin/node' '${resources}/cli/dist/index.js' "$@"`);
  expect(statSync(file).mode & 0o777).toBe(0o755);
});

it('replaces a launcher it wrote before', () => {
  const home = tempHome();
  const file = path.join(home, '.local/bin/pantheon');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${CLI_MARKER}\nexec /old/node /old/cli "$@"\n`);
  expect(installCli(resources, home, path.dirname(file)).status).toBe('installed');
  expect(readFileSync(file, 'utf8')).toContain(`${resources}/cli/dist/index.js`);
});

it('leaves a pantheon file it did not write alone', () => {
  const home = tempHome();
  const file = path.join(home, '.local/bin/pantheon');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '#!/bin/sh\necho mine\n');
  expect(installCli(resources, home, path.dirname(file))).toEqual({ status: 'occupied', file });
  expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho mine\n');
});

it('gives the shell line to add when the folder is not on PATH', () => {
  const home = tempHome();
  const result = installCli(resources, home, '/usr/bin:/bin');
  expect(result).toEqual({
    status: 'installed',
    file: path.join(home, '.local/bin/pantheon'),
    pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
  });
});
