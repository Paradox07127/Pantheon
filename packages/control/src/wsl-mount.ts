import { readFileSync, realpathSync } from 'node:fs';

/** The `root` of a wsl.conf's `[automount]` section with one trailing slash; WSL's default, /mnt/, without one. */
export function automountRootFromConf(conf: string): string {
  let section = '';
  let root = '/mnt/';
  for (const line of conf.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (header) section = header[1]!.trim().toLowerCase();
    const entry = /^\s*root\s*=\s*"?([^"]*?)"?\s*$/i.exec(line);
    if (section === 'automount' && entry?.[1]?.startsWith('/'))
      root = entry[1].replace(/\/*$/, '/');
  }
  return root;
}

let automountRoot: string | undefined;
/** Where this WSL distribution mounts the Windows drives; undefined outside WSL. */
export function wslAutomountRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.WSL_DISTRO_NAME) return undefined;
  if (automountRoot === undefined) {
    let conf = '';
    try {
      conf = readFileSync('/etc/wsl.conf', 'utf8');
    } catch {
      /* WSL's defaults apply. */
    }
    automountRoot = automountRootFromConf(conf);
  }
  return automountRoot;
}

/** Whether `file` lies on a Windows drive that WSL mounts under `root`. */
export function onWslAutomount(file: string, root = wslAutomountRoot()): boolean {
  if (root === undefined) return false;
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return false;
  }
  // The root also holds WSL's own mounts, such as wsl and wslg; drives are single letters.
  return real.startsWith(root) && /^[a-z](\/|$)/i.test(real.slice(root.length));
}

/** The path under `root` of a Windows drive path such as `D:/x` or `D:\x`; undefined for any other path. */
export function wslDrivePath(windowsPath: string, root: string): string | undefined {
  const drive = /^([a-z]):([\\/].*)?$/i.exec(windowsPath);
  return drive
    ? `${root}${drive[1]!.toLowerCase()}${(drive[2] ?? '').replaceAll('\\', '/')}`
    : undefined;
}
