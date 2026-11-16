import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BridgeResult } from '@pantheon/protocol';
import { applicationRoots, type Lookup } from './editors.js';
import { cmdQuoted, type Launch } from './open-target.js';
import { readSettings, saveChoice } from './settings.js';

export const KNOWN_TERMINALS = ['Terminal', 'iTerm', 'Warp', 'Ghostty'];

export const terminalRoots = (): string[] => [
  ...applicationRoots(),
  '/System/Applications/Utilities',
  '/Applications/Utilities',
];

export interface Terminal {
  id: string;
  name: string;
  path: string;
}

export function scanTerminals(roots: string[]): Terminal[] {
  return KNOWN_TERMINALS.flatMap((id) => {
    for (const root of roots) {
      const bundle = path.join(root, `${id}.app`);
      try {
        if (statSync(bundle, { throwIfNoEntry: false })?.isDirectory())
          return [{ id, name: id, path: bundle }];
      } catch {
        // An unreadable bundle (EACCES, ELOOP) is not installed in this root.
      }
    }
    return [];
  });
}

export function selectedTerminal(
  installed: Terminal[],
  settingsFile: string,
): Terminal | undefined {
  const saved = readSettings(settingsFile).terminal;
  return installed.find((terminal) => terminal.id === saved) ?? installed[0];
}

export function openWithTerminal(
  roots: string[],
  settingsFile: string,
  open: (bundle: string) => Promise<BridgeResult<null>>,
): Promise<BridgeResult<null>> {
  const terminal = selectedTerminal(scanTerminals(roots), settingsFile);
  return open(terminal?.path ?? 'Terminal');
}

/** Terminals found on PATH on Linux, in default order, with the arguments that open a folder. */
const LINUX_TERMINALS: [id: string, command: string, directory: (dir: string) => string[]][] = [
  ['GNOME Terminal', 'gnome-terminal', (dir) => [`--working-directory=${dir}`]],
  ['Konsole', 'konsole', (dir) => ['--workdir', dir]],
  ['kitty', 'kitty', (dir) => ['--directory', dir]],
  ['Alacritty', 'alacritty', (dir) => ['--working-directory', dir]],
  ['WezTerm', 'wezterm', (dir) => ['start', '--cwd', dir]],
  // It takes no working directory, so a shell changes into it.
  [
    'x-terminal-emulator',
    'x-terminal-emulator',
    (dir) => ['-e', 'bash', '-c', 'cd "$1" && exec bash', '_', dir],
  ],
];

export function commandTerminals(platform: 'win32' | 'linux', lookup: Lookup): Terminal[] {
  const table: [id: string, command: string, ...rest: unknown[]][] =
    platform === 'win32' ? [['Windows Terminal', 'wt.exe']] : LINUX_TERMINALS;
  return table.flatMap(([id, command]) => {
    const found = lookup(command);
    return found === undefined ? [] : [{ id, name: id, path: found }];
  });
}

/** Runs wsl.exe with wslArgs in Windows Terminal, or in a console cmd.exe starts when there is none. */
const windowsLaunch = (terminal: Terminal | undefined, wslArgs: string[]): Launch =>
  terminal
    ? {
        command: terminal.path,
        // wt.exe splits commands at any unescaped ';', even inside one argument.
        args: ['-w', 'new', 'wsl.exe', ...wslArgs.map((arg) => arg.replaceAll(';', '\\;'))],
      }
    : {
        command: 'cmd.exe',
        // start and its empty title stay unquoted, or cmd.exe does not see its built-in command.
        args: ['/d', '/v:off', '/s', '/c', `"start "" ${cmdQuoted(['wsl.exe', ...wslArgs])}"`],
        verbatim: true,
      };

/** Opens dir, a Linux path in distro on Windows; null when Linux has no known terminal. */
export function terminalCommand(
  platform: 'win32' | 'linux',
  terminal: Terminal | undefined,
  dir: string,
  distro?: string,
): Launch | null {
  if (platform === 'win32') return windowsLaunch(terminal, ['-d', distro!, '--cd', dir]);
  const row = LINUX_TERMINALS.find(([id]) => id === terminal?.id);
  return terminal && row ? { command: terminal.path, args: row[2](dir) } : null;
}

export function listTerminals(
  roots: string[],
  settingsFile: string,
  scan: (roots: string[]) => Terminal[] = scanTerminals,
): BridgeResult<{ terminals: { id: string; name: string }[]; selected: string | null }> {
  const installed = scan(roots);
  return {
    ok: true,
    value: {
      terminals: installed.map(({ id, name }) => ({ id, name })),
      selected: selectedTerminal(installed, settingsFile)?.id ?? null,
    },
  };
}

export function chooseTerminal(
  id: string,
  roots: string[],
  settingsFile: string,
  scan: (roots: string[]) => Terminal[] = scanTerminals,
): BridgeResult<null> {
  if (!scan(roots).some((terminal) => terminal.id === id))
    return {
      ok: false,
      error: {
        code: 'terminal_unavailable',
        message: `${JSON.stringify(id)} is not an installed terminal`,
      },
    };
  saveChoice(settingsFile, 'terminal', id);
  return { ok: true, value: null };
}

/** The login each runtime runs; the renderer names only the runtime. */
const LOGINS: Record<'claude' | 'codex', string> = { claude: 'auth login', codex: 'login' };

export const terminalUnavailable = {
  code: 'terminal_unavailable',
  message: 'No known terminal is on PATH',
};

/** Runs the runtime's login in an interactive login shell; null when Linux has no known terminal. */
export function loginCommand(
  platform: 'win32' | 'linux',
  terminal: Terminal | undefined,
  runtime: keyof typeof LOGINS,
  distro?: string,
): Launch | null {
  const login = `${runtime} ${LOGINS[runtime]}`;
  if (platform === 'win32')
    return windowsLaunch(terminal, ['-d', distro!, '--exec', 'bash', '-lic', login]);
  if (!terminal) return null;
  const run = terminal.id === 'GNOME Terminal' ? '--' : '-e';
  return { command: terminal.path, args: [run, 'bash', '-lic', login] };
}

/** Opens the runtime's login in the selected terminal on Windows and Linux. */
export async function commandRuntimeLogin(
  runtime: unknown,
  platform: 'win32' | 'linux',
  installed: Terminal[],
  settingsFile: string,
  distro: string | undefined,
  run: (launch: Launch) => Promise<BridgeResult<null>>,
): Promise<BridgeResult<void>> {
  if (runtime !== 'claude' && runtime !== 'codex')
    return {
      ok: false,
      error: { code: 'unknown_runtime', message: `${JSON.stringify(runtime)} has no login` },
    };
  let launch: Launch | null;
  try {
    launch = loginCommand(platform, selectedTerminal(installed, settingsFile), runtime, distro);
  } catch (error) {
    return { ok: false, error: { code: 'open_failed', message: String(error) } };
  }
  if (launch === null) return { ok: false, error: terminalUnavailable };
  const opened = await run(launch);
  return opened.ok ? { ok: true, value: undefined } : opened;
}

/** A shell script that runs binary, single-quoted, with args. */
export const loginScript = (binary: string, args: string): string =>
  `exec '${binary.replaceAll("'", "'\\''")}' ${args}\n`;

/** Writes the runtime's login script into directory and opens it in the selected terminal. */
export async function runtimeLogin(
  runtime: unknown,
  directory: string,
  roots: string[],
  settingsFile: string,
  launch: (application: string) => (target: string) => Promise<BridgeResult<null>>,
): Promise<BridgeResult<void>> {
  if (runtime !== 'claude' && runtime !== 'codex')
    return {
      ok: false,
      error: { code: 'unknown_runtime', message: `${JSON.stringify(runtime)} has no login` },
    };
  const script = path.join(directory, `${runtime}-login.command`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The runtime status names no binary, so the login shell's PATH finds it.
    writeFileSync(script, loginScript(runtime, LOGINS[runtime]));
    chmodSync(script, 0o700);
  } catch (error) {
    return { ok: false, error: { code: 'write_failed', message: String(error) } };
  }
  const opened = await openWithTerminal(roots, settingsFile, (bundle) => launch(bundle)(script));
  return opened.ok ? { ok: true, value: undefined } : opened;
}
