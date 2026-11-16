import { afterEach, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeResult } from '@pantheon/protocol';
import { loginScript, runtimeLogin } from '../../apps/desktop/src/main/terminals.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function machine() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-login-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const apps = path.join(root, 'Applications');
  for (const name of ['Terminal', 'iTerm'])
    mkdirSync(path.join(apps, `${name}.app`), { recursive: true });
  const settingsFile = path.join(root, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ terminal: 'iTerm' }));
  const opened: [string, string][] = [];
  const launch =
    (application: string) =>
    async (target: string): Promise<BridgeResult<null>> => {
      opened.push([application, target]);
      return { ok: true, value: null };
    };
  return { root, apps, settingsFile, directory: path.join(root, 'tmp'), opened, launch };
}

it('opens a fixed login script for each known runtime in the terminal the settings chose', async () => {
  const m = machine();
  for (const [runtime, script] of [
    ['claude', "exec 'claude' auth login\n"],
    ['codex', "exec 'codex' login\n"],
  ] as const) {
    expect(await runtimeLogin(runtime, m.directory, [m.apps], m.settingsFile, m.launch)).toEqual({
      ok: true,
      value: undefined,
    });
    const file = m.opened.at(-1)![1];
    expect(m.opened.at(-1)).toEqual([path.join(m.apps, 'iTerm.app'), file]);
    expect(path.dirname(file)).toBe(m.directory);
    expect(file.endsWith('.command')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(script);
    expect(statSync(file).mode & 0o777).toBe(0o700);
  }
});

it('refuses a runtime outside the table without writing or opening anything', async () => {
  const m = machine();
  for (const runtime of ['bash', 'claude; rm -rf ~', undefined]) {
    const result = await runtimeLogin(runtime, m.directory, [m.apps], m.settingsFile, m.launch);
    expect(!result.ok && result.error.code).toBe('unknown_runtime');
  }
  expect(m.opened).toEqual([]);
  expect(existsSync(m.directory)).toBe(false);
});

it('quotes the binary so a single quote in it stays part of the path', () => {
  expect(loginScript("/opt/it's/claude", 'auth login')).toBe(
    "exec '/opt/it'\\''s/claude' auth login\n",
  );
});

it('passes a failed open back with its code', async () => {
  const m = machine();
  const result = await runtimeLogin(
    'codex',
    m.directory,
    [m.apps],
    m.settingsFile,
    () => async () => ({
      ok: false,
      error: { code: 'open_failed', message: 'no such app' },
    }),
  );
  expect(result).toEqual({ ok: false, error: { code: 'open_failed', message: 'no such app' } });
});
