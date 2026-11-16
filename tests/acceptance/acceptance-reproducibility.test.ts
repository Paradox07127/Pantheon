import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { insideSandbox } from '../helpers.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const title = '仓库与 fixture 可复现';
const scenarioFile = 'tests/acceptance/scenarios/repository-fixture-reproducibility.mjs';

async function execute(cmd: string, args: string[], cwd: string, env = process.env) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => (output += data));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, output };
}

async function cleanup(dir: string) {
  await chmod(dir, 0o755);
  for (const entry of await readdir(dir, { withFileTypes: true }))
    if (entry.isDirectory()) await cleanup(path.join(dir, entry.name));
  await rm(dir, { recursive: true, force: true });
}

async function withInstaller(
  version: string,
  run: (dir: string, env: NodeJS.ProcessEnv) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(root, '.install-test-'));
  try {
    await mkdir(path.join(dir, 'scripts'));
    await mkdir(path.join(dir, 'bin'));
    await copyFile(path.join(root, 'scripts/install.sh'), path.join(dir, 'scripts/install.sh'));
    await copyFile(path.join(root, 'package.json'), path.join(dir, 'package.json'));
    await writeFile(
      path.join(dir, 'bin/pnpm'),
      '#!/bin/sh\nif [ "$1" = --version ]; then printf "%s\\n" "$TEST_PNPM_VERSION"; else printf "%s\\n" "$*" >> "$TEST_PNPM_CALLS"; fi\n',
      { mode: 0o755 },
    );
    await writeFile(
      path.join(dir, 'bin/node'),
      '#!/bin/sh\nif [ "$1" = --version ]; then printf "%s\\n" "$TEST_NODE_VERSION"; else exec "$TEST_NODE_BINARY" "$@"; fi\n',
      { mode: 0o755 },
    );
    await run(dir, {
      ...process.env,
      PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
      TEST_PNPM_VERSION: version,
      TEST_PNPM_CALLS: path.join(dir, 'calls'),
      TEST_NODE_VERSION: process.version,
      TEST_NODE_BINARY: process.execPath,
    });
  } finally {
    await cleanup(dir);
  }
}

it('installs from the lockfile with extra arguments before building', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await withInstaller(pkg.packageManager.slice('pnpm@'.length), async (dir, env) => {
    const result = await execute('sh', ['scripts/install.sh', '--prefer-offline'], dir, env);
    expect(result.code, result.output).toBe(0);
    expect(await readFile(path.join(dir, 'calls'), 'utf8')).toBe(
      'install --frozen-lockfile --prefer-offline\nbuild\n',
    );
  });
});

it('refuses mismatching tool versions before installation and prints expected and actual versions', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await withInstaller('0.0.0', async (dir, env) => {
    const result = await execute('sh', ['scripts/install.sh'], dir, env);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(pkg.packageManager.slice('pnpm@'.length));
    expect(result.output).toContain('0.0.0');
    await expect(readFile(path.join(dir, 'calls'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  await withInstaller(pkg.packageManager.slice('pnpm@'.length), async (dir, env) => {
    const result = await execute('sh', ['scripts/install.sh'], dir, {
      ...env,
      TEST_NODE_VERSION: 'v25.0.0',
    });
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain(pkg.engines.node);
    expect(result.output).toContain('v25.0.0');
    await expect(readFile(path.join(dir, 'calls'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function runScenario(control?: string) {
  const { scenarios } = await import('./scenarios/index.mjs');
  expect(scenarios.get(title), 'Missing repository reproducibility scenario').toBeDefined();
  // Under the repository root it would dirty git status for parallel tests; under node_modules tsc rejects the build.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pantheon-reproducibility-'));
  const source = path.join(dir, 'source');
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'fixture-author@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Author',
    GIT_COMMITTER_EMAIL: 'fixture-author@example.invalid',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
  };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await execute('git', args, cwd, env);
    expect(result.code, result.output).toBe(0);
  };
  try {
    await git(dir, 'clone', '--no-hardlinks', root, source);
    const catalog = JSON.parse(
      await readFile(path.join(source, 'tests/acceptance/cases.json'), 'utf8'),
    );
    const spec = catalog.cases.find((entry: { title: string }) => entry.title === title);
    const driver = path.join(dir, 'scenario-driver.mjs');
    await writeFile(
      driver,
      `import * as scenario from ${JSON.stringify(pathToFileURL(path.join(source, scenarioFile)).href)};
import { scenarios } from ${JSON.stringify(new URL('./scenarios/index.mjs', import.meta.url).href)};
scenarios.set(scenario.title, { ...scenario, run: args => scenario.run({ ...args, control: ${JSON.stringify(control)} }) });
export { runCase } from ${JSON.stringify(new URL('./driver.mjs', import.meta.url).href)};
`,
    );
    const out = path.join(dir, 'report');
    const started = performance.now();
    const result = await execute(
      process.execPath,
      [
        path.join(root, 'scripts/acceptance.mjs'),
        '--case',
        spec.id,
        '--driver',
        driver,
        '--out',
        out,
      ],
      source,
      env,
    );
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8'));
    const log = await readFile(path.join(out, spec.id, 'driver.log'), 'utf8');
    const evidenceDir = path.join(out, spec.id, 'evidence');
    const read = async (name: string) => {
      try {
        return await readFile(path.join(evidenceDir, name), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    };
    return {
      ...result,
      entry: report.cases[0],
      log:
        log +
        `\nRunner elapsed: ${Math.round(performance.now() - started)} ms\n` +
        (await read('build.log')).slice(-3000),
      environment: JSON.parse((await read('environment.json')) || 'null'),
      fixtures: JSON.parse((await read('fixture-manifest.json')) || 'null'),
    };
  } finally {
    await cleanup(dir);
  }
}

it.skipIf(insideSandbox)(
  'reproduces the committed checkout and fixtures through the acceptance runner',
  async () => {
    const { code, output, log, entry, environment, fixtures } = await runScenario();
    expect(code, output + log).toBe(0);
    expect(entry.status).toBe('passed');
    expect(entry.evidence.every((file: { bytes: number }) => file.bytes > 0)).toBe(true);
    expect(environment.user_repository.before.head).toBe(environment.commit);
    expect(environment.user_repository.after).toEqual(environment.user_repository.before);
    expect(environment.build.exit_code).toBe(0);
    expect(Object.keys(fixtures.fixtures)).toEqual(['repo-basic', 'fake-agent']);
    for (const fixture of Object.values(fixtures.fixtures) as { hashes: string[] }[]) {
      expect(fixture.hashes).toHaveLength(2);
      expect(fixture.hashes[0]).toMatch(/^[a-f0-9]{64}$/);
      expect(fixture.hashes[1]).toBe(fixture.hashes[0]);
    }
  },
  130000,
);

it.skipIf(insideSandbox)(
  'fails the acceptance runner for a fixture that writes and removes a user checkout file',
  async () => {
    const { code, output, log, entry, environment } = await runScenario('write-user-checkout');
    expect(code, output + log).toBe(1);
    expect(entry.status).toBe('failed');
    expect(entry.errors, log).toEqual([]);
    expect(entry.assertions.filter((assertion: { passed: boolean }) => !assertion.passed)).toEqual([
      {
        path: 'fixtures.touched_user_workspace',
        op: 'eq',
        expected: false,
        actual: true,
        passed: false,
      },
    ]);
    expect(environment.user_repository.after.head).toBe(environment.user_repository.before.head);
    expect(environment.user_repository.after.status).toBe(
      environment.user_repository.before.status,
    );
    expect(environment.user_repository.changed_paths).toContain('.');
  },
  130000,
);
