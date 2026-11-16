import { afterEach, it, expect } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applicationRoots,
  chooseEditor,
  listEditors,
  openWithEditor,
  scanEditors,
} from '../../apps/desktop/src/main/editors.js';
import {
  chooseTerminal,
  listTerminals,
  openWithTerminal,
  scanTerminals,
  terminalRoots,
} from '../../apps/desktop/src/main/terminals.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-editors-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
/** Creates an applications root holding an empty bundle directory per name. */
function applications(root: string, name: string, ...apps: string[]): string {
  const directory = path.join(root, name);
  for (const app of apps) mkdirSync(path.join(directory, `${app}.app`), { recursive: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

it('lists only installed bundle directories in table order', () => {
  const root = tempRoot();
  const apps = applications(root, 'Applications', 'Xcode', 'Cursor');
  writeFileSync(path.join(apps, 'Visual Studio Code.app'), '');
  expect(scanEditors([apps, path.join(root, 'missing')])).toEqual([
    { id: 'Cursor', name: 'Cursor', path: path.join(apps, 'Cursor.app') },
    { id: 'Xcode', name: 'Xcode', path: path.join(apps, 'Xcode.app') },
  ]);
});

it('uses the first root when an editor is installed in two', () => {
  const root = tempRoot();
  const system = applications(root, 'system', 'Cursor');
  const home = applications(root, 'home', 'Cursor', 'Zed');
  expect(scanEditors([system, home])).toEqual([
    { id: 'Cursor', name: 'Cursor', path: path.join(system, 'Cursor.app') },
    { id: 'Zed', name: 'Zed', path: path.join(home, 'Zed.app') },
  ]);
});

it('selects Visual Studio Code by default, else the first installed editor, else none', () => {
  const root = tempRoot();
  const settings = path.join(root, 'settings.json');
  const withCode = applications(root, 'code', 'Xcode', 'Visual Studio Code', 'Cursor');
  expect(listEditors([withCode], settings)).toEqual({
    ok: true,
    value: {
      editors: [
        { id: 'Visual Studio Code', name: 'Visual Studio Code' },
        { id: 'Cursor', name: 'Cursor' },
        { id: 'Xcode', name: 'Xcode' },
      ],
      selected: 'Visual Studio Code',
    },
  });
  const withoutCode = applications(root, 'other', 'Xcode', 'Zed');
  expect(listEditors([withoutCode], settings)).toMatchObject({
    ok: true,
    value: { selected: 'Zed' },
  });
  const empty = applications(root, 'empty');
  expect(listEditors([empty], settings)).toEqual({
    ok: true,
    value: { editors: [], selected: null },
  });
});

it('keeps the chosen editor until it is no longer installed', () => {
  const root = tempRoot();
  const settings = path.join(root, 'user data/settings.json');
  const apps = applications(root, 'Applications', 'Visual Studio Code', 'Cursor');
  expect(chooseEditor('Cursor', [apps], settings)).toEqual({ ok: true, value: null });
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ editor: 'Cursor' });
  expect(listEditors([apps], settings)).toMatchObject({ ok: true, value: { selected: 'Cursor' } });
  rmSync(path.join(apps, 'Cursor.app'), { recursive: true });
  expect(listEditors([apps], settings)).toMatchObject({
    ok: true,
    value: { selected: 'Visual Studio Code' },
  });
});

it('falls back to the default when settings.json is not valid JSON', () => {
  const root = tempRoot();
  const settings = path.join(root, 'settings.json');
  const apps = applications(root, 'Applications', 'Visual Studio Code', 'Cursor');
  writeFileSync(settings, '{"editor": "Cursor"');
  expect(listEditors([apps], settings)).toMatchObject({
    ok: true,
    value: { selected: 'Visual Studio Code' },
  });
});

it('opens with the selected editor bundle and launches nothing when no editor is installed', async () => {
  const root = tempRoot();
  const settings = path.join(root, 'settings.json');
  const apps = applications(root, 'Applications', 'Visual Studio Code', 'Cursor');
  const opened: string[] = [];
  const open = async (bundle: string) => {
    opened.push(bundle);
    return { ok: true as const, value: null };
  };
  chooseEditor('Cursor', [apps], settings);
  expect(await openWithEditor([apps], settings, open)).toEqual({ ok: true, value: null });
  expect(opened).toEqual([path.join(apps, 'Cursor.app')]);
  expect(await openWithEditor([applications(root, 'empty')], settings, open)).toMatchObject({
    ok: false,
    error: { code: 'editor_unavailable' },
  });
  expect(opened).toHaveLength(1);
});

it('refuses to choose an editor that is not installed and leaves settings unchanged', () => {
  const root = tempRoot();
  const settings = path.join(root, 'settings.json');
  const apps = applications(root, 'Applications', 'Visual Studio Code', 'Cursor');
  expect(chooseEditor('Zed', [apps], settings)).toMatchObject({
    ok: false,
    error: { code: 'editor_unavailable' },
  });
  expect(existsSync(settings)).toBe(false);
  writeFileSync(settings, '{"editor":"Cursor"}');
  expect(chooseEditor('Sublime Text', [apps], settings)).toMatchObject({
    ok: false,
    error: { code: 'editor_unavailable' },
  });
  expect(readFileSync(settings, 'utf8')).toBe('{"editor":"Cursor"}');
});

it('scans terminals in default order across application and Utilities roots', () => {
  expect(terminalRoots()).toEqual([
    ...applicationRoots(),
    '/System/Applications/Utilities',
    '/Applications/Utilities',
  ]);
  const root = tempRoot();
  const apps = applications(root, 'Applications', 'Ghostty', 'Warp', 'iTerm', 'Unknown');
  const home = applications(root, 'home/Applications', 'Ghostty');
  const system = applications(root, 'System/Applications/Utilities', 'Terminal');
  const utilities = applications(root, 'Applications/Utilities', 'Terminal');
  const roots = [apps, home, system, utilities];
  expect(scanTerminals(roots)).toEqual([
    { id: 'Terminal', name: 'Terminal', path: path.join(system, 'Terminal.app') },
    { id: 'iTerm', name: 'iTerm', path: path.join(apps, 'iTerm.app') },
    { id: 'Warp', name: 'Warp', path: path.join(apps, 'Warp.app') },
    { id: 'Ghostty', name: 'Ghostty', path: path.join(apps, 'Ghostty.app') },
  ]);
  rmSync(path.join(system, 'Terminal.app'), { recursive: true });
  expect(scanTerminals(roots)[0]?.path).toBe(path.join(utilities, 'Terminal.app'));
  rmSync(path.join(apps, 'Warp.app'), { recursive: true });
  writeFileSync(path.join(apps, 'Warp.app'), '');
  expect(scanTerminals(roots).map((terminal) => terminal.id)).toEqual([
    'Terminal',
    'iTerm',
    'Ghostty',
  ]);
});

it('skips a root whose terminal bundle cannot be read and finds it in the next root', () => {
  const root = tempRoot();
  const looping = applications(root, 'looping');
  symlinkSync('Terminal.app', path.join(looping, 'Terminal.app'));
  const utilities = applications(root, 'Utilities', 'Terminal');
  expect(scanTerminals([looping, utilities])).toEqual([
    { id: 'Terminal', name: 'Terminal', path: path.join(utilities, 'Terminal.app') },
  ]);
});

it('opens the chosen terminal, falls back to the first installed one, and finally Terminal', async () => {
  const root = tempRoot();
  const settings = path.join(root, 'settings.json');
  const apps = applications(root, 'Applications', 'Ghostty', 'iTerm', 'Terminal');
  expect(listTerminals([apps], settings)).toEqual({
    ok: true,
    value: {
      terminals: [
        { id: 'Terminal', name: 'Terminal' },
        { id: 'iTerm', name: 'iTerm' },
        { id: 'Ghostty', name: 'Ghostty' },
      ],
      selected: 'Terminal',
    },
  });
  const opened: string[] = [];
  const open = async (bundle: string) => {
    opened.push(bundle);
    return { ok: true as const, value: null };
  };
  expect(chooseTerminal('Ghostty', [apps], settings)).toEqual({ ok: true, value: null });
  expect(listTerminals([apps], settings)).toMatchObject({ value: { selected: 'Ghostty' } });
  expect(await openWithTerminal([apps], settings, open)).toEqual({ ok: true, value: null });
  rmSync(path.join(apps, 'Ghostty.app'), { recursive: true });
  expect(listTerminals([apps], settings)).toMatchObject({ value: { selected: 'Terminal' } });
  await openWithTerminal([apps], settings, open);
  rmSync(path.join(apps, 'Terminal.app'), { recursive: true });
  expect(listTerminals([apps], settings)).toMatchObject({ value: { selected: 'iTerm' } });
  await openWithTerminal([apps], settings, open);
  rmSync(path.join(apps, 'iTerm.app'), { recursive: true });
  expect(listTerminals([apps], settings)).toEqual({
    ok: true,
    value: { terminals: [], selected: null },
  });
  expect(await openWithTerminal([apps], settings, open)).toEqual({ ok: true, value: null });
  expect(opened).toEqual([
    path.join(apps, 'Ghostty.app'),
    path.join(apps, 'Terminal.app'),
    path.join(apps, 'iTerm.app'),
    'Terminal',
  ]);
});

it('keeps the terminal when choosing an editor and the editor when choosing a terminal', () => {
  const root = tempRoot();
  const settings = path.join(root, 'user data/settings.json');
  const apps = applications(
    root,
    'Applications',
    'Visual Studio Code',
    'Cursor',
    'Ghostty',
    'Warp',
  );
  chooseTerminal('Ghostty', [apps], settings);
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ terminal: 'Ghostty' });
  chooseEditor('Cursor', [apps], settings);
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
    terminal: 'Ghostty',
    editor: 'Cursor',
  });
  chooseTerminal('Warp', [apps], settings);
  expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
    terminal: 'Warp',
    editor: 'Cursor',
  });
});

it('refuses an unavailable terminal and leaves the settings unchanged', () => {
  const root = tempRoot();
  const settings = path.join(root, 'settings.json');
  const apps = applications(root, 'Applications', 'Ghostty');
  expect(chooseTerminal('Warp', [apps], settings)).toMatchObject({
    ok: false,
    error: { code: 'terminal_unavailable' },
  });
  expect(existsSync(settings)).toBe(false);
  writeFileSync(settings, '{"editor":"Cursor","terminal":"Ghostty"}');
  expect(chooseTerminal('Terminal', [apps], settings)).toMatchObject({
    ok: false,
    error: { code: 'terminal_unavailable' },
  });
  expect(readFileSync(settings, 'utf8')).toBe('{"editor":"Cursor","terminal":"Ghostty"}');
});
