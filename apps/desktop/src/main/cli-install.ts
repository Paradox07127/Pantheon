import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** The second line of the launcher; a `pantheon` file without it is someone else's. */
export const CLI_MARKER = '# Pantheon Desktop command line launcher';

export type CliInstall =
  { status: 'installed'; file: string; pathLine?: string } | { status: 'occupied'; file: string };

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Whether the menu offers the launcher; an AppImage's resources move on every launch, so the launcher would break. */
export const cliInstallOffered = (
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): boolean => platform !== 'win32' && !env.APPIMAGE;

/** Writes ~/.local/bin/pantheon, which runs the packaged app's CLI with the node it bundles. */
export function installCli(resources: string, home: string, PATH: string | undefined): CliInstall {
  const bin = path.join(home, '.local/bin');
  const file = path.join(bin, 'pantheon');
  if (existsSync(file) && readFileSync(file, 'utf8').split('\n')[1] !== CLI_MARKER)
    return { status: 'occupied', file };
  mkdirSync(bin, { recursive: true });
  const node = path.join(resources, 'node/bin/node');
  const entry = path.join(resources, 'cli/dist/index.js');
  writeFileSync(file, `#!/bin/sh\n${CLI_MARKER}\nexec ${quote(node)} ${quote(entry)} "$@"\n`);
  chmodSync(file, 0o755);
  const onPath = (PATH ?? '').split(path.delimiter).some((entry) => path.resolve(entry) === bin);
  return onPath
    ? { status: 'installed', file }
    : { status: 'installed', file, pathLine: 'export PATH="$HOME/.local/bin:$PATH"' };
}
