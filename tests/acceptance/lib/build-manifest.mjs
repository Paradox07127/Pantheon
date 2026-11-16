import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const sha256hex = (value) => createHash('sha256').update(value).digest('hex');

async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function walk(dir) {
  const files = [];
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function gitState(rootDir) {
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  try {
    if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return null;
  } catch {
    return null;
  }
  return {
    head: git('rev-parse', 'HEAD').trim(),
    dirty: git('status', '--porcelain').trim() !== '',
  };
}

export async function buildManifest(rootDir) {
  const version = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8')).version;
  const paths = [path.join(rootDir, 'package.json'), path.join(rootDir, 'pnpm-lock.yaml')];
  for (const [group, outputs] of [
    ['packages', ['dist']],
    ['apps', ['dist', 'out']],
  ]) {
    for (const entry of await listDir(path.join(rootDir, group))) {
      if (!entry.isDirectory()) continue;
      const pkgDir = path.join(rootDir, group, entry.name);
      paths.push(path.join(pkgDir, 'package.json'));
      for (const output of outputs) paths.push(...(await walk(path.join(pkgDir, output))));
    }
  }
  const files = [];
  for (const file of paths) {
    const content = await readIfExists(file);
    if (content === null) continue;
    files.push({
      path: path.relative(rootDir, file).split(path.sep).join('/'),
      sha256: sha256hex(content),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version, files, git: gitState(rootDir) };
}

export function productVersion(manifest) {
  const version = `${manifest.version}+${sha256hex(JSON.stringify(manifest))}`;
  return manifest.git?.dirty ? version + '.dirty' : version;
}
