import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, it } from 'vitest';

const cli = (...args: string[]) =>
  spawnSync('node', [path.resolve('apps/cli/dist/index.js'), ...args], { encoding: 'utf8' });

it.each(['--help', '-h'])('prints usage and exits 0 for %s', (flag) => {
  const result = cli(flag);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^Usage: pnpm cli /);
  expect(result.stdout).toContain('pnpm cli review [--base REF] [RANGE] [--runtime NAME]...');
  expect(result.stdout).toContain('pnpm cli land [BRANCH] [--message TEXT]');
  expect(result.stderr).toBe('');
});

it('reports an unknown option as one usage error line with exit 64', () => {
  const result = cli('health', '--bogus');
  expect(result.status).toBe(64);
  expect(result.stdout).toBe('');
  const lines = result.stderr.trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("'--bogus'");
  expect(result.stderr).not.toMatch(/\n\s+at /);
});
