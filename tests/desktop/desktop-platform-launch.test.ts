import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commandEditors,
  listEditors,
  pathLookup,
  whereLookup,
  type Editor,
} from '../../apps/desktop/src/main/editors.js';
import { editorCommand } from '../../apps/desktop/src/main/open-target.js';
import {
  commandRuntimeLogin,
  commandTerminals,
  loginCommand,
  terminalCommand,
} from '../../apps/desktop/src/main/terminals.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pantheon-platform-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const lookupOf =
  (found: Record<string, string>) =>
  (command: string): string | undefined =>
    found[command];
const editor = (id: string, cli: string): Editor => ({ id, name: id, path: cli });

describe('command line tool lookup', () => {
  it('takes the first runnable match where.exe prints, skipping the extensionless shell script', () => {
    const calls: [string, string[]][] = [];
    const lookup = whereLookup((file, args) => {
      calls.push([file, args]);
      return 'C:\\VS Code\\bin\\code\r\nC:\\VS Code\\bin\\code.cmd\r\nC:\\Other\\code.exe\r\n';
    });
    expect(lookup('code')).toBe('C:\\VS Code\\bin\\code.cmd');
    expect(calls).toEqual([['where.exe', ['code']]]);
  });

  it('finds nothing when where.exe fails', () => {
    const lookup = whereLookup(() => {
      throw new Error('INFO: Could not find files');
    });
    expect(lookup('code')).toBeUndefined();
  });

  it('finds the first executable file along PATH', () => {
    const dir = tempDir();
    const first = path.join(dir, 'first');
    const second = path.join(dir, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(path.join(first, 'zed'), '');
    writeFileSync(path.join(second, 'zed'), '');
    chmodSync(path.join(second, 'zed'), 0o755);
    mkdirSync(path.join(first, 'code'));
    const lookup = pathLookup([first, second].join(path.delimiter));
    expect(lookup('zed')).toBe(path.join(second, 'zed'));
    expect(lookup('code')).toBeUndefined();
  });
});

describe('editors on Windows and Linux', () => {
  const everything = lookupOf({
    code: '/bin/code',
    cursor: '/bin/cursor',
    'code-insiders': '/bin/code-insiders',
    windsurf: '/bin/windsurf',
    zeditor: '/bin/zeditor',
    subl: '/bin/subl',
    idea: '/bin/idea',
    webstorm: '/bin/webstorm',
    pycharm: '/bin/pycharm',
    goland: '/bin/goland',
  });

  it('lists only the VS Code family on Windows, by the names macOS uses', () => {
    expect(commandEditors('win32', everything)).toEqual([
      editor('Visual Studio Code', '/bin/code'),
      editor('Cursor', '/bin/cursor'),
      editor('Visual Studio Code - Insiders', '/bin/code-insiders'),
      editor('Windsurf', '/bin/windsurf'),
    ]);
  });

  it('lists every editor on PATH on Linux, finding Zed as zeditor too', () => {
    expect(commandEditors('linux', everything).map((e) => [e.id, e.path])).toEqual([
      ['Visual Studio Code', '/bin/code'],
      ['Cursor', '/bin/cursor'],
      ['Visual Studio Code - Insiders', '/bin/code-insiders'],
      ['Windsurf', '/bin/windsurf'],
      ['Zed', '/bin/zeditor'],
      ['Sublime Text', '/bin/subl'],
      ['IntelliJ IDEA', '/bin/idea'],
      ['WebStorm', '/bin/webstorm'],
      ['PyCharm', '/bin/pycharm'],
      ['GoLand', '/bin/goland'],
    ]);
  });

  it('selects from the editors found on PATH', () => {
    const settings = path.join(tempDir(), 'settings.json');
    writeFileSync(settings, JSON.stringify({ editor: 'Zed' }));
    expect(listEditors([], settings, () => commandEditors('linux', everything))).toMatchObject({
      ok: true,
      value: { selected: 'Zed' },
    });
  });
});

describe('editor commands', () => {
  const code = editor('Visual Studio Code', 'C:\\VS Code\\bin\\code.cmd');

  it('opens a folder or a line of a file in the distro through cmd.exe on Windows', () => {
    expect(editorCommand('win32', code, '/home/u/my proj', undefined, undefined, 'Ubuntu')).toEqual(
      {
        command: 'cmd.exe',
        args: [
          '/d',
          '/v:off',
          '/s',
          '/c',
          '""C:\\VS Code\\bin\\code.cmd" "--remote" "wsl+Ubuntu" "/home/u/my proj""',
        ],
        verbatim: true,
      },
    );
    expect(editorCommand('win32', code, '/home/u/a.ts', 3, 4, 'Ubuntu').args.at(-1)).toBe(
      '""C:\\VS Code\\bin\\code.cmd" "--remote" "wsl+Ubuntu" "-g" "/home/u/a.ts:3:4""',
    );
  });

  it('refuses to hand cmd.exe a word with a quote or a percent sign', () => {
    const open = (target: string, line?: number) =>
      editorCommand('win32', code, target, line, undefined, 'Ubuntu');
    expect(() => open('/home/u/a"&calc&".txt')).toThrow(/cmd\.exe/);
    expect(() => open('/home/u/%PATH%.txt')).toThrow(/cmd\.exe/);
    expect(() => open('/home/u/a.ts', '1"&calc&"' as unknown as number)).toThrow(/cmd\.exe/);
  });

  it('runs the command line tool on Linux with each family’s line syntax', () => {
    const at = (id: string, line?: number, column?: number) =>
      editorCommand('linux', editor(id, `/bin/${id}`), '/p/a.ts', line, column);
    expect(at('Cursor')).toEqual({ command: '/bin/Cursor', args: ['/p/a.ts'] });
    expect(at('Cursor', 3, 4)).toEqual({ command: '/bin/Cursor', args: ['-g', '/p/a.ts:3:4'] });
    expect(at('Zed', 3)).toEqual({ command: '/bin/Zed', args: ['/p/a.ts:3'] });
    expect(at('Sublime Text', 3, 4)).toEqual({
      command: '/bin/Sublime Text',
      args: ['/p/a.ts:3:4'],
    });
    expect(at('GoLand', 3, 4)).toEqual({
      command: '/bin/GoLand',
      args: ['--line', '3', '/p/a.ts'],
    });
  });
});

describe('terminals on Windows and Linux', () => {
  it('offers only Windows Terminal on Windows, when wt.exe is found', () => {
    const wt = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
    expect(commandTerminals('win32', lookupOf({ 'wt.exe': wt, konsole: '/bin/konsole' }))).toEqual([
      { id: 'Windows Terminal', name: 'Windows Terminal', path: wt },
    ]);
    expect(commandTerminals('win32', lookupOf({}))).toEqual([]);
  });

  it('lists the terminals on PATH on Linux', () => {
    const found = lookupOf({ kitty: '/bin/kitty', 'gnome-terminal': '/bin/gnome-terminal' });
    expect(commandTerminals('linux', found).map((t) => [t.id, t.path])).toEqual([
      ['GNOME Terminal', '/bin/gnome-terminal'],
      ['kitty', '/bin/kitty'],
    ]);
  });

  it('opens the distro folder in Windows Terminal, else in a console started by cmd.exe', () => {
    const wt = { id: 'Windows Terminal', name: 'Windows Terminal', path: 'C:\\wt.exe' };
    expect(terminalCommand('win32', wt, '/home/u/p', 'Ubuntu')).toEqual({
      command: 'C:\\wt.exe',
      args: ['-w', 'new', 'wsl.exe', '-d', 'Ubuntu', '--cd', '/home/u/p'],
    });
    expect(terminalCommand('win32', undefined, '/home/u/p', 'Ubuntu')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '"start "" "wsl.exe" "-d" "Ubuntu" "--cd" "/home/u/p""'],
      verbatim: true,
    });
    expect(terminalCommand('win32', undefined, '/home/u/a&calc', 'Ubuntu')?.args.at(-1)).toBe(
      '"start "" "wsl.exe" "-d" "Ubuntu" "--cd" "/home/u/a&calc""',
    );
  });

  it('escapes semicolons so Windows Terminal does not split the folder into a second command', () => {
    const wt = { id: 'Windows Terminal', name: 'Windows Terminal', path: 'C:\\wt.exe' };
    expect(terminalCommand('win32', wt, '/home/u/repo;calc.exe', 'Ubuntu')?.args).toEqual([
      '-w',
      'new',
      'wsl.exe',
      '-d',
      'Ubuntu',
      '--cd',
      '/home/u/repo\\;calc.exe',
    ]);
  });

  it('passes the folder with each Linux terminal’s own flag', () => {
    const open = (id: string) =>
      terminalCommand('linux', { id, name: id, path: `/bin/${id}` }, '/p')?.args;
    expect(open('GNOME Terminal')).toEqual(['--working-directory=/p']);
    expect(open('Konsole')).toEqual(['--workdir', '/p']);
    expect(open('kitty')).toEqual(['--directory', '/p']);
    expect(open('Alacritty')).toEqual(['--working-directory', '/p']);
    expect(open('WezTerm')).toEqual(['start', '--cwd', '/p']);
    expect(open('x-terminal-emulator')).toEqual([
      '-e',
      'bash',
      '-c',
      'cd "$1" && exec bash',
      '_',
      '/p',
    ]);
    expect(terminalCommand('linux', undefined, '/p')).toBeNull();
  });

  it('runs the runtime login in an interactive login shell of the distro or of Linux', () => {
    const wt = { id: 'Windows Terminal', name: 'Windows Terminal', path: 'C:\\wt.exe' };
    expect(loginCommand('win32', wt, 'claude', 'Ubuntu')).toEqual({
      command: 'C:\\wt.exe',
      args: ['-w', 'new', 'wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-lic', 'claude auth login'],
    });
    expect(loginCommand('win32', undefined, 'codex', 'Ubuntu')).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/v:off',
        '/s',
        '/c',
        '"start "" "wsl.exe" "-d" "Ubuntu" "--exec" "bash" "-lic" "codex login""',
      ],
      verbatim: true,
    });
    const gnome = { id: 'GNOME Terminal', name: 'GNOME Terminal', path: '/bin/gnome-terminal' };
    expect(loginCommand('linux', gnome, 'codex')).toEqual({
      command: '/bin/gnome-terminal',
      args: ['--', 'bash', '-lic', 'codex login'],
    });
    const konsole = { id: 'Konsole', name: 'Konsole', path: '/bin/konsole' };
    expect(loginCommand('linux', konsole, 'claude')?.args).toEqual([
      '-e',
      'bash',
      '-lic',
      'claude auth login',
    ]);
  });

  it('opens the selected terminal for a known runtime and refuses any other', async () => {
    const settings = path.join(tempDir(), 'settings.json');
    writeFileSync(settings, JSON.stringify({ terminal: 'kitty' }));
    const installed = commandTerminals(
      'linux',
      lookupOf({ konsole: '/bin/konsole', kitty: '/bin/kitty' }),
    );
    const ran: { command: string; args: string[] }[] = [];
    const run = async (launch: { command: string; args: string[] }) => {
      ran.push(launch);
      return { ok: true as const, value: null };
    };
    expect(
      await commandRuntimeLogin('codex', 'linux', installed, settings, undefined, run),
    ).toEqual({ ok: true, value: undefined });
    const refused = await commandRuntimeLogin('bash', 'linux', installed, settings, undefined, run);
    expect(!refused.ok && refused.error.code).toBe('unknown_runtime');
    expect(ran).toEqual([{ command: '/bin/kitty', args: ['-e', 'bash', '-lic', 'codex login'] }]);
  });

  it('fails the login instead of handing cmd.exe a distro name it cannot quote', async () => {
    const settings = path.join(tempDir(), 'settings.json');
    const run = async () => ({ ok: true as const, value: null });
    const failed = await commandRuntimeLogin('codex', 'win32', [], settings, 'Ub"untu', run);
    expect(!failed.ok && failed.error.code).toBe('open_failed');
  });
});
