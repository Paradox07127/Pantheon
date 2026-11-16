import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

const stats = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const fs = {
    ...actual,
    lstatSync: ((file: string, ...rest: unknown[]) => {
      stats.paths.push(String(file));
      return (actual.lstatSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.lstatSync,
  };
  return { ...fs, default: fs };
});

it('measures only the directory entries it returns', () => {
  const f = workbenchFixture();
  const many = path.join(f.source, 'many');
  mkdirSync(many);
  for (let index = 0; index < 3000; index++)
    writeFileSync(path.join(many, `${String(index).padStart(4, '0')}.txt`), 'x');
  stats.paths.length = 0;
  const listed = f.control.filesList(user, f.project.id, undefined, 'many');
  expect(listed.entries).toHaveLength(1000);
  expect(listed.entries[999]).toEqual({ name: '0999.txt', kind: 'file', size: 1 });
  expect(listed.truncated).toBe(true);
  expect(
    stats.paths.filter((file) => path.dirname(file) === realpathSync(many)).length,
  ).toBeLessThanOrEqual(1000);
});
