import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeEvidence } from '../lib/evidence.mjs';

export const title = '仓库与 fixture 可复现';
export const mode = 'integration';
export const controls = { 'write-user-checkout': { touchUserCheckout: true } };

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const worker = fileURLToPath(new URL('../lib/reproducibility-fixtures.mjs', import.meta.url));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function snapshot(root) {
  const files = {};
  async function visit(relative) {
    const file = path.join(root, relative);
    const stat = await lstat(file, { bigint: true });
    const entry = {
      mode: String(stat.mode),
      mtime_ns: String(stat.mtimeNs),
      ctime_ns: String(stat.ctimeNs),
    };
    if (stat.isSymbolicLink()) entry.link = await readlink(file);
    else if (stat.isFile()) entry.sha256 = sha256(await readFile(file));
    files[relative] = entry;
    if (stat.isDirectory())
      for (const name of (await readdir(file)).sort())
        await visit(relative === '.' ? name : path.join(relative, name));
  }
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const status = git(root, 'status', '--porcelain');
  await visit('.');
  return { files, state: { head, status, tree_sha256: sha256(JSON.stringify(files)) } };
}

async function execute(command, args, cwd, log) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
}

export async function run({ workspace, evidenceDir, control }) {
  if (control !== undefined && !Object.hasOwn(controls, control))
    throw new Error(`Unknown control: ${control}`);
  const source = await realpath(repository);
  for (const dir of [workspace, evidenceDir]) {
    const relative = path.relative(source, await realpath(dir));
    if (relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)))
      throw new Error('Reproducibility workspace and evidence must be outside the user checkout');
  }
  const before = await snapshot(source);
  const clone = path.join(workspace, 'checkout');
  git(workspace, 'clone', '--no-hardlinks', '--no-checkout', source, clone);
  git(clone, 'checkout', '--detach', before.state.head);
  const pkg = JSON.parse(await readFile(path.join(clone, 'package.json'), 'utf8'));
  const expectedPnpm = pkg.packageManager.slice('pnpm@'.length);
  const actualNode = execFileSync('node', ['--version'], {
    cwd: clone,
    env,
    encoding: 'utf8',
  }).trim();
  const actualPnpm = execFileSync('pnpm', ['--version'], {
    cwd: clone,
    env,
    encoding: 'utf8',
  }).trim();
  const lockfile = path.join(clone, 'pnpm-lock.yaml');
  const environment = {
    commit: before.state.head,
    locked_versions: {
      node: pkg.devEngines.runtime.version,
      node_engine: pkg.engines.node,
      pnpm: expectedPnpm,
    },
    actual_versions: { node: actualNode, pnpm: actualPnpm },
    lockfile_sha256: { before: sha256(await readFile(lockfile)) },
    user_repository: { before: before.state },
    build: { started_at: new Date().toISOString() },
  };
  let manifest = { fixtures: {}, adapters: [] };
  let failure;
  const log = await open(path.join(evidenceDir, 'build.log'), 'wx');
  const started = performance.now();
  try {
    await log.writeFile('Command: sh scripts/install.sh --prefer-offline\n');
    await writeEvidence(evidenceDir, { 'environment.json': environment });
    environment.build.exit_code = await execute(
      'sh',
      ['scripts/install.sh', '--prefer-offline'],
      clone,
      log,
    );
    environment.build.elapsed_ms = Math.round(performance.now() - started);
    if (environment.build.exit_code !== 0)
      throw new Error(
        `Install and build failed after ${environment.build.elapsed_ms} ms (exit ${environment.build.exit_code}); see build.log`,
      );
    const code = await execute(
      process.execPath,
      [worker, clone, workspace, ...(controls[control]?.touchUserCheckout ? [source] : [])],
      clone,
      log,
    );
    if (code !== 0) throw new Error(`Reproducibility fixtures exited ${code}; see build.log`);
    manifest = JSON.parse(await readFile(path.join(workspace, 'fixture-manifest.json'), 'utf8'));
  } catch (error) {
    failure = error;
    manifest.error = error.message;
  } finally {
    await log.close();
    environment.lockfile_sha256.after = sha256(await readFile(lockfile));
    const after = await snapshot(source);
    environment.user_repository.after = after.state;
    environment.user_repository.changed_paths = [
      ...new Set([...Object.keys(before.files), ...Object.keys(after.files)]),
    ].filter((file) => JSON.stringify(before.files[file]) !== JSON.stringify(after.files[file]));
    await writeEvidence(evidenceDir, {
      'environment.json': environment,
      'fixture-manifest.json': manifest,
    });
  }
  if (failure) throw failure;
  const range = /^>=(\d+) <(\d+)$/.exec(pkg.engines.node);
  const version = /^v(\d+)\.\d+\.\d+$/.exec(actualNode);
  return {
    observations: {
      environment: {
        locked: Boolean(
          range &&
          version &&
          +version[1] >= +range[1] &&
          +version[1] < +range[2] &&
          actualPnpm === expectedPnpm &&
          environment.lockfile_sha256.before === environment.lockfile_sha256.after,
        ),
      },
      fixtures: {
        reproducible: ['repo-basic', 'fake-agent'].every(
          (name) =>
            manifest.fixtures[name]?.hashes.length === 2 &&
            manifest.fixtures[name].hashes[0] === manifest.fixtures[name].hashes[1],
        ),
        touched_user_workspace:
          environment.user_repository.before.head !== environment.user_repository.after.head ||
          environment.user_repository.before.status !== environment.user_repository.after.status ||
          environment.user_repository.changed_paths.length > 0,
      },
    },
    evidence: {
      'build.log': await readFile(path.join(evidenceDir, 'build.log'), 'utf8'),
      'environment.json': environment,
      'fixture-manifest.json': manifest,
    },
    adapters: manifest.adapters,
  };
}
