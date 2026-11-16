import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applicationRoots } from '../../apps/desktop/src/main/editors.js';
import { browserRoots, scanBrowsers } from '../../apps/desktop/src/main/browsers.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('scans known browsers in application folders, including system Safari, and keeps the first bundle', () => {
  expect(browserRoots()).toEqual([...applicationRoots(), '/System/Applications']);
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-browsers-'));
  roots.push(root);
  const apps = path.join(root, 'Applications');
  const home = path.join(root, 'home/Applications');
  const system = path.join(root, 'System/Applications');
  const names = ['Safari', 'Google Chrome', 'Arc', 'Firefox', 'Microsoft Edge', 'Brave Browser'];
  for (const name of names)
    mkdirSync(path.join(name === 'Safari' ? system : apps, `${name}.app`), { recursive: true });
  mkdirSync(path.join(home, 'Firefox.app'), { recursive: true });
  mkdirSync(path.join(apps, 'Unknown.app'));
  expect(scanBrowsers([apps, home, system])).toEqual(
    names.map((id) => ({
      id,
      name: id,
      path: path.join(id === 'Safari' ? system : apps, `${id}.app`),
    })),
  );
  rmSync(path.join(apps, 'Firefox.app'), { recursive: true });
  writeFileSync(path.join(apps, 'Firefox.app'), 'not a bundle');
  expect(scanBrowsers([apps, home, system]).find((browser) => browser.id === 'Firefox')?.path).toBe(
    path.join(home, 'Firefox.app'),
  );
});

it('skips a root whose browser bundle cannot be read and finds it in the next root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-browsers-'));
  roots.push(root);
  const looping = path.join(root, 'looping');
  mkdirSync(looping);
  symlinkSync('Arc.app', path.join(looping, 'Arc.app'));
  const apps = path.join(root, 'Applications');
  mkdirSync(path.join(apps, 'Arc.app'), { recursive: true });
  expect(scanBrowsers([looping, apps])).toEqual([
    { id: 'Arc', name: 'Arc', path: path.join(apps, 'Arc.app') },
  ]);
});
