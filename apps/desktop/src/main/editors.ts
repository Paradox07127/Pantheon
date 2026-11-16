import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeResult } from '@pantheon/protocol';
import { readSettings, saveChoice } from './settings.js';

/** In default order; each id is its .app name without `.app`. */
export const KNOWN_EDITORS = [
  'Visual Studio Code',
  'Cursor',
  'Visual Studio Code - Insiders',
  'Windsurf',
  'Zed',
  'Sublime Text',
  'Xcode',
  'Nova',
  'BBEdit',
  'IntelliJ IDEA',
  'IntelliJ IDEA CE',
  'WebStorm',
  'PyCharm',
  'PyCharm CE',
  'GoLand',
  'Android Studio',
];

export const applicationRoots = (): string[] => [
  '/Applications',
  path.join(os.homedir(), 'Applications'),
];

export interface Editor {
  id: string;
  name: string;
  /** macOS: full path of the .app bundle. Windows and Linux: full path of its command line tool. */
  path: string;
}

/** The full path of a command, or undefined when it is not found. */
export type Lookup = (command: string) => string | undefined;

/** Finds a command with `where.exe`, skipping matches cmd.exe cannot run such as VS Code's shell script. */
export const whereLookup =
  (exec: (file: string, args: string[]) => string): Lookup =>
  (command) => {
    try {
      return exec('where.exe', [command])
        .split(/\r?\n/)
        .find((line) => /\.(exe|cmd|bat)$/i.test(line.trim()))
        ?.trim();
    } catch {
      return undefined;
    }
  };

/** Finds the first executable file named command in the directories of PATH. */
export const pathLookup =
  (PATH: string | undefined): Lookup =>
  (command) =>
    (PATH ?? '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, command))
      .find((file) => {
        try {
          accessSync(file, constants.X_OK);
          return statSync(file).isFile();
        } catch {
          return false;
        }
      });

/** Editors found by command line tool, in KNOWN_EDITORS order; Windows lists only those that open WSL folders. */
const COMMAND_EDITORS: [id: string, commands: string[], windows: boolean][] = [
  ['Visual Studio Code', ['code'], true],
  ['Cursor', ['cursor'], true],
  ['Visual Studio Code - Insiders', ['code-insiders'], true],
  ['Windsurf', ['windsurf'], true],
  ['Zed', ['zed', 'zeditor'], false],
  ['Sublime Text', ['subl'], false],
  ['IntelliJ IDEA', ['idea'], false],
  ['WebStorm', ['webstorm'], false],
  ['PyCharm', ['pycharm'], false],
  ['GoLand', ['goland'], false],
];

export function commandEditors(platform: 'win32' | 'linux', lookup: Lookup): Editor[] {
  return COMMAND_EDITORS.flatMap(([id, commands, windows]) => {
    if (platform === 'win32' && !windows) return [];
    for (const command of commands) {
      const cli = lookup(command);
      if (cli !== undefined) return [{ id, name: id, path: cli }];
    }
    return [];
  });
}

const unavailable = (message: string) =>
  ({ ok: false, error: { code: 'editor_unavailable', message } }) as const;

/** An earlier root wins when an editor is installed in several. */
export function scanEditors(roots: string[]): Editor[] {
  return KNOWN_EDITORS.flatMap((id) => {
    for (const root of roots) {
      const bundle = path.join(root, `${id}.app`);
      try {
        if (statSync(bundle).isDirectory()) return [{ id, name: id, path: bundle }];
      } catch {}
    }
    return [];
  });
}

/** The saved editor if it is still installed, else the first installed one in table order. */
export function selectedEditor(installed: Editor[], settingsFile: string): Editor | undefined {
  const saved = readSettings(settingsFile).editor;
  return installed.find((e) => e.id === saved) ?? installed[0];
}

/** Opens with the selected editor, or fails without launching when none is installed. */
export function openWithEditor(
  roots: string[],
  settingsFile: string,
  open: (bundle: string, editor: Editor) => Promise<BridgeResult<null>>,
  scan: (roots: string[]) => Editor[] = scanEditors,
): Promise<BridgeResult<null>> {
  const editor = selectedEditor(scan(roots), settingsFile);
  return editor
    ? open(editor.path, editor)
    : Promise.resolve(
        unavailable(
          roots.length
            ? `No known editor is installed in ${roots.join(' or ')}`
            : 'No known editor is on PATH',
        ),
      );
}

export function listEditors(
  roots: string[],
  settingsFile: string,
  scan: (roots: string[]) => Editor[] = scanEditors,
): BridgeResult<{ editors: { id: string; name: string }[]; selected: string | null }> {
  const installed = scan(roots);
  return {
    ok: true,
    value: {
      editors: installed.map(({ id, name }) => ({ id, name })),
      selected: selectedEditor(installed, settingsFile)?.id ?? null,
    },
  };
}

export function chooseEditor(
  id: string,
  roots: string[],
  settingsFile: string,
  scan: (roots: string[]) => Editor[] = scanEditors,
): BridgeResult<null> {
  if (!scan(roots).some((e) => e.id === id))
    return unavailable(`${JSON.stringify(id)} is not an installed editor`);
  saveChoice(settingsFile, 'editor', id);
  return { ok: true, value: null };
}
