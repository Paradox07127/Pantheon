import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeStatus } from '@pantheon/domain';
import { nativeEnvironment } from './process.js';

export type Preflight = Omit<RuntimeStatus, 'runtime' | 'checked_at'>;

/** The first x.y.z in a version text, such as `2.1.312 (Claude Code)` or `codex-cli 0.165.0`. */
export function parseVersion(text: string): string | null {
  return /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null;
}

/** Compares the first x.y.z of each text; false when either has none. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const have = parseVersion(version)?.split('.').map(Number);
  const need = parseVersion(minimum)?.split('.').map(Number);
  if (!have || !need) return false;
  for (let part = 0; part < 3; part++)
    if (have[part] !== need[part]) return have[part]! > need[part]!;
  return true;
}

/** The trimmed output of `<binary> --version`; rejects when the binary cannot run. */
export function readVersion(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      ['--version'],
      { encoding: 'utf8', timeout: 5000, env: nativeEnvironment() },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

/**
 * PATH followed by the folders CLI installers use. A daemon started outside a login shell, as
 * from Finder, gets only the system folders, where no runtime is.
 */
export function withInstallFolders(PATH: string | undefined, home = os.homedir()): string {
  const folders = [
    ...(PATH ?? '').split(path.delimiter).filter(Boolean),
    ...['.local/bin', '.npm-global/bin', '.bun/bin'].map((folder) => path.join(home, folder)),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return [...new Set(folders)].join(path.delimiter);
}

export function installedFields(
  version: string,
  minimum: string,
): Pick<Preflight, 'installed' | 'version' | 'min_version' | 'version_ok'> {
  return {
    installed: true,
    version,
    min_version: minimum,
    version_ok: parseVersion(version) ? versionAtLeast(version, minimum) : null,
  };
}

export function notInstalled(minimum: string, error: unknown): Preflight {
  return {
    installed: false,
    version: null,
    min_version: minimum,
    version_ok: null,
    auth: { state: 'unknown' },
    error: error instanceof Error ? error.message : String(error),
  };
}
