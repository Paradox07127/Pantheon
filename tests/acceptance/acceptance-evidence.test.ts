import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { writeEvidence } from './lib/evidence.mjs';

it('writes binary evidence byte for byte and other values as text or JSON', async () => {
  const dir = path.join(process.cwd(), 'node_modules/.cache/evidence-test');
  await mkdir(dir, { recursive: true });
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await writeEvidence(dir, { 'shot.png': png, 'note.txt': 'text', 'data.json': { a: 1 } });
    expect(await readFile(path.join(dir, 'shot.png'))).toEqual(png);
    expect(await readFile(path.join(dir, 'note.txt'), 'utf8')).toBe('text');
    expect(JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8'))).toEqual({ a: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
