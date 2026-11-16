// Builds the desktop installers of one --target into apps/desktop/release: mac and linux carry their own Node,
// daemon and CLI; win carries them for Linux in linux-runtime.tar.gz, since its daemon runs in WSL.
// pnpm package [--target mac-arm64|win-x64|win-arm64|linux-x64|linux-arm64]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The tarball of a Node release for darwin-arm64, linux-x64 or linux-arm64. */
export const nodeTarball = (version, target) => `node-v${version}-${target}.tar.xz`;

/** The build cache folder on a host platform. */
export const buildCache = (platform, env, home) =>
  platform === 'darwin'
    ? path.join(home, 'Library/Caches/pantheon-build')
    : path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'pantheon-build');

// A deb needs a homepage; only Linux packages get it, so the mac package metadata stays as it is.
const debHomepage = '-c.extraMetadata.homepage=https://github.com/Paradox07127/Pantheon';

/** Per --target: the Node it carries, its electron-builder flags, and whether that Node is packed for WSL. */
const targets = {
  'mac-arm64': { node: 'darwin-arm64', builder: ['--mac'], wsl: false },
  'linux-x64': { node: 'linux-x64', builder: ['--linux', '--x64', debHomepage], wsl: false },
  'linux-arm64': { node: 'linux-arm64', builder: ['--linux', '--arm64', debHomepage], wsl: false },
  'win-x64': { node: 'linux-x64', builder: ['--win', '--x64'], wsl: true },
  'win-arm64': { node: 'linux-arm64', builder: ['--win', '--arm64'], wsl: true },
};

/** A file of a Node release on nodejs.org. */
export const nodeUrl = (version, file) => `https://nodejs.org/dist/v${version}/${file}`;

/** File name to sha256 from the lines of a SHASUMS256.txt. */
export const parseShasums = (text) =>
  new Map(
    text.split('\n').flatMap((line) => {
      const match = /^([0-9a-f]{64}) +(\S+)$/.exec(line.trim());
      return match ? [[match[2], match[1]]] : [];
    }),
  );

/**
 * Deletes from a hoisted pnpm deploy the files Node never loads at runtime, the prebuilt addons of
 * platforms other than node (such as linux-x64), and the file: paths of the build machine.
 */
export function pruneDeploy(directory, node) {
  // A hoisted deploy still writes a full copy of each package under .pnpm that nothing resolves to.
  for (const name of [
    'node_modules/.pnpm',
    'node_modules/.modules.yaml',
    'node_modules/.pnpm-workspace-state-v1.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ])
    rmSync(path.join(directory, name), { recursive: true, force: true });
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true }))
    if (entry.isFile() && /\.(map|[cm]?ts|tsbuildinfo)$/.test(entry.name))
      rmSync(path.join(entry.parentPath, entry.name), { force: true });
    else if (
      entry.isDirectory() &&
      path.basename(entry.parentPath) === 'prebuilds' &&
      entry.name !== node
    )
      rmSync(path.join(entry.parentPath, entry.name), { recursive: true });
  // Its dependencies are file: URLs into this checkout; Node resolves the hoisted node_modules without them.
  const manifest = path.join(directory, 'package.json');
  const { dependencies, ...kept } = JSON.parse(readFileSync(manifest, 'utf8'));
  writeFileSync(manifest, `${JSON.stringify(kept, null, 2)}\n`);
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function download(url, file) {
  console.log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/** The official Node tarball in the build cache, downloaded unless a verified copy is there. */
async function nodeArchive(version, target, cache) {
  mkdirSync(cache, { recursive: true });
  const sums = path.join(cache, `SHASUMS256-v${version}.txt`);
  if (!existsSync(sums)) await download(nodeUrl(version, 'SHASUMS256.txt'), sums);
  const tarball = nodeTarball(version, target);
  const expected = parseShasums(readFileSync(sums, 'utf8')).get(tarball);
  if (!expected) throw new Error(`${sums} lists no ${tarball}`);
  const archive = path.join(cache, tarball);
  if (existsSync(archive) && sha256(archive) === expected) return archive;
  await download(nodeUrl(version, tarball), archive);
  const actual = sha256(archive);
  if (actual !== expected) {
    rmSync(archive);
    throw new Error(`${tarball} has sha256 ${actual}, SHASUMS256.txt says ${expected}`);
  }
  return archive;
}

async function main() {
  const { values } = parseArgs({ options: { target: { type: 'string', default: 'mac-arm64' } } });
  const target = targets[values.target];
  if (!target)
    throw new Error(`--target ${values.target} is not one of ${Object.keys(targets).join(', ')}`);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const desktop = path.join(repo, 'apps/desktop');
  const stage = path.join(desktop, 'stage');
  const cache = buildCache(process.platform, process.env, os.homedir());
  const run = (command, args, options = {}) =>
    execFileSync(command, args, { cwd: repo, stdio: 'inherit', ...options });

  run('pnpm', ['build']);
  run('pnpm', ['--filter', '@pantheon/desktop', 'bundle']);

  rmSync(stage, { recursive: true, force: true });
  // Without optional dependencies the agent SDK leaves out its native claude, which Pantheon never runs.
  for (const [name, directory] of [
    ['@pantheon/daemon', 'daemon'],
    ['@pantheon/cli', 'cli'],
  ]) {
    run('pnpm', [
      'deploy',
      '--filter',
      name,
      '--prod',
      '--no-optional',
      '--node-linker',
      'hoisted',
      path.join(stage, directory),
    ]);
    pruneDeploy(path.join(stage, directory), target.node);
  }
  if (values.target === 'mac-arm64') run('node', [path.join(desktop, 'scripts/build-voice.mjs')]);

  const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).devEngines
    .runtime.version;
  const archive = await nodeArchive(version, target.node, cache);
  mkdirSync(path.join(stage, 'node'), { recursive: true });
  run('tar', [
    '-xJf',
    archive,
    '-C',
    path.join(stage, 'node'),
    '--strip-components',
    '1',
    `node-v${version}-${target.node}/bin/node`,
  ]);
  if (target.wsl)
    run(
      'tar',
      // Without --no-xattrs, macOS tar writes com.apple.provenance headers that GNU tar warns about per file.
      [
        '--no-xattrs',
        '-czf',
        path.join(stage, 'linux-runtime.tar.gz'),
        '-C',
        stage,
        'node',
        'daemon',
        'cli',
      ],
      {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      },
    );

  run('pnpm', ['exec', 'install-electron'], { cwd: desktop });
  // install-electron unpacks only the host's Electron from its download cache, so other targets download their own.
  const electronDist =
    values.target === 'mac-arm64' ? ['-c.electronDist=node_modules/electron/dist'] : [];
  // The notarytool keychain profile; electron-builder would skip notarization without one instead of failing.
  const profile = process.env.APPLE_KEYCHAIN_PROFILE ?? 'pantheon-notary';
  const mac = values.target === 'mac-arm64';
  run('pnpm', ['exec', 'electron-builder', ...target.builder, ...electronDist], {
    cwd: desktop,
    // The dmg target downloads its dmgbuild tool into this cache.
    env: {
      ...process.env,
      ...(mac ? { APPLE_KEYCHAIN_PROFILE: profile } : {}),
      ELECTRON_BUILDER_CACHE: path.join(cache, 'electron-builder'),
    },
  });
  if (mac) {
    // electron-builder notarizes the app but not the dmg around it.
    const release = path.join(desktop, 'release');
    for (const dmg of readdirSync(release).filter((name) => name.endsWith('.dmg'))) {
      const file = path.join(release, dmg);
      run('xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait']);
      run('xcrun', ['stapler', 'staple', file]);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
