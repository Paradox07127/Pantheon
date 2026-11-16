import os from 'node:os';
import path from 'node:path';

// Kept out of index.ts: the web bundle imports index and cannot load node:os.

/** The daemon's data directory; its parent holds Pantheon's other folders, so on Linux it is not XDG_DATA_HOME itself. */
export function defaultDataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'linux')
    return path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'pantheon', 'data');
  return path.join(home, 'Library/Application Support/Pantheon');
}

/** Electron's userData folder for the desktop app. */
export function defaultDesktopUserDataDirectory(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  if (platform === 'linux')
    return (
      env.PANTHEON_DESKTOP_DATA_DIR ||
      path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Pantheon Desktop')
    );
  return path.join(home, 'Library/Application Support/Pantheon Desktop');
}
