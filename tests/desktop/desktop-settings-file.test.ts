import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSettings,
  readShellPrefs,
  saveChoice,
  saveShellPrefs,
} from '../../apps/desktop/src/main/settings.js';
import { readWindowState, writeWindowState } from '../../apps/desktop/src/main/window.js';

// While `full` is set, every write empties its file and then fails, as on a full disk.
const disk = vi.hoisted(() => ({ full: false }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const fs = {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (!disk.full) return actual.writeFileSync(...args);
      actual.writeFileSync(args[0], '');
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    },
  };
  return { ...fs, default: fs };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  disk.full = false;
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function tempDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-settings-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe('settings file writes', () => {
  it('keeps the saved settings when a save fails part way', () => {
    const file = path.join(tempDir(), 'settings.json');
    saveChoice(file, 'editor', 'Cursor');
    saveChoice(file, 'locale', 'de');
    const saved = readFileSync(file, 'utf8');
    disk.full = true;
    expect(() => saveChoice(file, 'browser', 'Firefox')).toThrow('ENOSPC');
    expect(() => saveShellPrefs(file, { ...readShellPrefs(file), show_tray_icon: false })).toThrow(
      'ENOSPC',
    );
    disk.full = false;
    expect(readFileSync(file, 'utf8')).toBe(saved);
    expect(readSettings(file)).toEqual({ editor: 'Cursor', locale: 'de' });
  });

  it('writes into a folder that does not exist yet', () => {
    const file = path.join(tempDir(), 'nested/settings.json');
    saveChoice(file, 'terminal', 'iTerm');
    expect(readSettings(file)).toEqual({ terminal: 'iTerm' });
  });

  it('keeps the saved window state when a save fails part way', () => {
    const file = path.join(tempDir(), 'window.json');
    const state = { x: 120, y: 64, width: 1400, height: 900, maximized: true };
    writeWindowState(file, state);
    disk.full = true;
    expect(() => writeWindowState(file, { width: 800, height: 600, maximized: false })).toThrow(
      'ENOSPC',
    );
    disk.full = false;
    expect(readWindowState(file)).toEqual(state);
  });
});

describe('settings file reads', () => {
  it.each(['null', '[]', '42', '"text"'])('reads %s as no settings', (text) => {
    const file = path.join(tempDir(), 'settings.json');
    writeFileSync(file, text);
    expect(readSettings(file)).toEqual({});
    expect(readShellPrefs(file)).toMatchObject({
      keep_running_on_close: true,
      show_tray_icon: true,
      voice_input: true,
      mini_window: false,
    });
  });
});
