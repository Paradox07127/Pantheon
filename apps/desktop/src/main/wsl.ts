import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface Distro {
  name: string;
  state: string;
  version: 1 | 2;
  isDefault: boolean;
}

export interface Prerequisites {
  home: string;
  git: string;
  bwrap: string;
  socat: string;
  claude: string;
  codex: string;
  claudeVersion: string;
  codexVersion: string;
  userns: boolean;
  /** Required pieces the distro lacks; Claude and Codex are optional on their own. */
  missing: string[];
}

/**
 * Runs `file` with `args`, writing `input` to its stdin when given, and resolves its stdout;
 * past `timeout` ms it kills the process and rejects.
 */
export type RunWsl = (
  file: string,
  args: string[],
  input?: string,
  timeout?: number,
) => Promise<Buffer>;

export const runWsl: RunWsl = (file, args, input, timeout) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: 'buffer', windowsHide: true, timeout, killSignal: 'SIGKILL' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(input);
  });

/** The rows of `wsl.exe --list --verbose`, which prints UTF-16LE; Docker Desktop's own distros are left out. */
export const parseDistroList = (stdout: Buffer): Distro[] =>
  stdout
    .toString('utf16le')
    .split(/\r?\n/)
    .slice(1)
    .flatMap((line) => {
      const row = line.trim();
      const isDefault = row.startsWith('*');
      const [name, state, version] = row.replace(/^\*/, '').trim().split(/\s+/);
      if (!name || !state || (version !== '1' && version !== '2')) return [];
      if (name.startsWith('docker-desktop')) return [];
      return [{ name, state, version: version === '1' ? 1 : 2, isDefault }];
    });

/** The WSL2 distros; WSL1 cannot run bubblewrap. */
export const listDistros = async (run: RunWsl): Promise<Distro[]> =>
  parseDistroList(await run('wsl.exe', ['--list', '--verbose'], undefined, 15_000)).filter(
    (distro) => distro.version === 2,
  );

/**
 * Takes the PATH of an interactive bash, since .bashrc returns early in a non-interactive shell, before nvm and the like add to PATH;
 * the markers skip what rc files print, and stdin /dev/null ends an rc file that reads input or execs another shell.
 * With a terminal, an interactive bash stops trying to take it over and ignores SIGTERM: setsid drops the terminal, -k kills.
 */
export const INTERACTIVE_PATH_SCRIPT = `pantheon_path="$(timeout -k 1 5 setsid bash -ic 'printf "__PANTHEON_PATH__%s__PANTHEON_PATH__" "$PATH"' </dev/null 2>/dev/null)"
case "$pantheon_path" in
  *__PANTHEON_PATH__?*__PANTHEON_PATH__*)
    pantheon_path="\${pantheon_path#*__PANTHEON_PATH__}"
    export PATH="\${pantheon_path%%__PANTHEON_PATH__*}";;
esac`;

// bash reads this script from stdin, so every command it starts gets /dev/null as stdin.
export const PREREQUISITE_SCRIPT = `${INTERACTIVE_PATH_SCRIPT}
printf 'home=%s\\n' "$HOME"
for tool in git bwrap socat claude codex; do
  printf '%s=%s\\n' "$tool" "$(command -v "$tool" 2>/dev/null)"
done
for tool in claude codex; do
  version=
  if command -v "$tool" >/dev/null 2>&1; then
    version=$(timeout -k 1 5 "$tool" --version </dev/null 2>/dev/null | head -n 1)
  fi
  printf '%s_version=%s\\n' "$tool" "$version"
done
if command -v bwrap >/dev/null 2>&1 && bwrap --ro-bind / / --unshare-all true </dev/null >/dev/null 2>&1; then
  echo userns=1
else
  echo userns=0
fi
# The bundled arm64 Node links libatomic.so.1, which minimal distros leave out.
if [ "$(uname -m)" != aarch64 ] || { /sbin/ldconfig -p || /usr/sbin/ldconfig -p || ldconfig -p; } 2>/dev/null | grep -q 'libatomic\.so\.1'; then
  echo libatomic=1
else
  echo libatomic=0
fi
`;

/** The `key=value` lines PREREQUISITE_SCRIPT prints; profile output around them is ignored. */
export const parsePrerequisites = (stdout: string): Prerequisites => {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\w+)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, match[2]!.trim());
  }
  const value = (key: string) => values.get(key) ?? '';
  const result = {
    home: value('home'),
    git: value('git'),
    bwrap: value('bwrap'),
    socat: value('socat'),
    claude: value('claude'),
    codex: value('codex'),
    claudeVersion: value('claude_version'),
    codexVersion: value('codex_version'),
    userns: value('userns') === '1',
  };
  const missing: string[] = (['git', 'bwrap', 'socat'] as const).filter((tool) => !result[tool]);
  if (!result.userns) missing.push('userns');
  if (value('libatomic') !== '1') missing.push('libatomic');
  return { ...result, missing };
};

/** Runs PREREQUISITE_SCRIPT in a login shell of `distro` as its default user. */
export const checkDistro = async (distro: string, run: RunWsl): Promise<Prerequisites> =>
  parsePrerequisites(
    (
      await run(
        'wsl.exe',
        ['-d', distro, '--exec', 'bash', '-l', '-s'],
        PREREQUISITE_SCRIPT,
        15_000,
      )
    ).toString('utf8'),
  );

const PACKAGES: Record<string, string> = {
  git: 'git',
  bwrap: 'bubblewrap',
  socat: 'socat',
  libatomic: 'libatomic1',
};

/** Why the daemon cannot run in `distro` and how to fix it; undefined when nothing is missing. */
export const wslUnavailable = (
  distro: string | undefined,
  missing: readonly string[],
): string | undefined => {
  if (distro === undefined)
    return 'Pantheon runs its daemon in WSL 2. Install WSL and a Linux distribution with: wsl --install';
  const tools = missing.filter((item) => item in PACKAGES);
  // Without bwrap, userns fails too; installing bubblewrap is the whole fix.
  const userns =
    missing.includes('userns') && !missing.includes('bwrap')
      ? `bubblewrap cannot create user namespaces in ${distro}; WSL 1 is not supported.`
      : '';
  // The install command comes last, so it can be copied as it is.
  const install = tools.length
    ? `WSL distribution ${distro} lacks ${tools.join(', ')}. Install them in ${distro} with: sudo apt install ${tools.map((tool) => PACKAGES[tool]).join(' ')}`
    : '';
  return [userns, install].filter(Boolean).join(' ') || undefined;
};

/** The `root` of a wsl.conf's `[automount]` section with one trailing slash; WSL's default, /mnt/, without one. */
export const parseAutomountRoot = (conf: string): string => {
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
};

const automountRoots = new Map<string, string>();
/** Where `distro` mounts the Windows drives, read once from its /etc/wsl.conf through its share. */
export const automountRoot = (distro: string): string => {
  let root = automountRoots.get(distro.toLowerCase());
  if (root === undefined) {
    let conf = '';
    try {
      conf = readFileSync(`\\\\wsl.localhost\\${distro}\\etc\\wsl.conf`, 'utf8');
    } catch {}
    root = parseAutomountRoot(conf);
    automountRoots.set(distro.toLowerCase(), root);
  }
  return root;
};

/** The Linux path of a folder in `distro`'s share or on a Windows drive; undefined for any other path. */
export const wslPathFromWindows = (
  winPath: string,
  distro: string,
  root = automountRoot(distro),
): string | undefined => {
  const share = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i.exec(winPath);
  if (share)
    return share[1]!.toLowerCase() === distro.toLowerCase()
      ? (share[2] ?? '\\').replaceAll('\\', '/')
      : undefined;
  const drive = /^([a-z]):(\\.*)?$/i.exec(winPath);
  return drive
    ? `${root}${drive[1]!.toLowerCase()}${(drive[2] ?? '').replaceAll('\\', '/')}`
    : undefined;
};

/** The Windows path of a Linux path in `distro`: a drive path under its automount root, else its share path. */
export const windowsPathFromWsl = (
  linuxPath: string,
  distro: string,
  root = automountRoot(distro),
): string => {
  const drive = linuxPath.startsWith(root)
    ? /^([a-z])(\/.*)?$/i.exec(linuxPath.slice(root.length))
    : null;
  return drive
    ? `${drive[1]!.toUpperCase()}:${(drive[2] ?? '/').replaceAll('/', '\\')}`
    : `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll('/', '\\')}`;
};
