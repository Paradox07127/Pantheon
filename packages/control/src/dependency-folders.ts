import { spawn } from 'node:child_process';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DomainError } from '@pantheon/domain';
import { globalExcludes } from './checkpoint.js';
import { runGit } from './git.js';

function copy(flags: string[], from: string, to: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('/bin/cp', [...flags, from, to], { stdio: 'ignore', signal });
    // An aborted copy keeps writing until it closes.
    child.on('error', () => {
      if (!child.pid) resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Removes a folder this copy created; its folders are made writable first so the removal can enter them. */
async function remove(folder: string): Promise<void> {
  await new Promise((resolve) => {
    const child = spawn('/bin/chmod', ['-R', 'u+rwx', folder], { stdio: 'ignore' });
    child.on('error', resolve);
    child.on('close', resolve);
  });
  await rm(folder, { recursive: true, force: true });
}

/** The clone's path to the folder, from the clone down: a symbolic link on it, or whether the folder exists. */
async function inspect(clone: string, entry: string): Promise<{ link?: string; exists: boolean }> {
  let current = clone;
  for (const segment of entry.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink())
        return { link: path.relative(clone, current), exists: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
      throw error;
    }
  }
  return { exists: true };
}

/**
 * Copies the source checkout's ignored node_modules folders into a clone. Copies keep their
 * symlinks, so workspace links such as `../../../y` resolve inside the clone, not the source.
 * A folder the clone reaches through a symbolic link is skipped and reported.
 */
export async function copyDependencyFolders(
  source: string,
  clone: string,
  signal?: AbortSignal,
): Promise<void> {
  const listed = await runGit(
    source,
    [
      ...(await globalExcludes()),
      'ls-files',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
      '-z',
    ],
    undefined,
    true,
  );
  if (listed.exit_code !== 0)
    throw new Error(
      (listed.stderr.toString().trim() || listed.error || 'Git command failed').split('\n')[0]!,
    );
  const skipped: string[] = [];
  for (const entry of listed.stdout.toString().split('\0')) {
    const segments = entry.split('/').filter(Boolean);
    // A node_modules folder with tracked files in it is listed as its ignored entries.
    if (
      !segments.slice(0, -1).includes('node_modules') &&
      !(entry.endsWith('/') && segments.at(-1) === 'node_modules')
    )
      continue;
    const target = await inspect(clone, entry);
    if (target.link) {
      skipped.push(`${entry} (${target.link} is a symbolic link)`);
      continue;
    }
    // `folder/.` copies the folder's contents, also into a folder the clone already has.
    const from = path.join(source, entry) + (entry.endsWith('/') ? '.' : ''),
      to = path.join(clone, entry);
    await mkdir(path.dirname(to), { recursive: true });
    const cloning = process.platform === 'linux' ? ['--reflink=auto', '-RP'] : ['-cRP'];
    try {
      if (await copy(cloning, from, to, signal)) continue;
      signal?.throwIfAborted();
      // APFS clones need a volume that supports them.
      if (!target.exists) await remove(to);
      if (!(await copy(['-RP'], from, to, signal))) {
        signal?.throwIfAborted();
        throw new Error(`Could not copy dependency folder ${entry}`);
      }
    } catch (error) {
      // Only a folder this copy created is removed.
      if (!target.exists) await remove(to);
      throw error;
    }
  }
  if (skipped.length)
    throw new DomainError(
      'dependency_folder_skipped',
      `Skipped dependency folders ${skipped.join(', ')}`,
    );
}
