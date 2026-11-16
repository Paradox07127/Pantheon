import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios/index.mjs';
import { buildManifest, productVersion } from './lib/build-manifest.mjs';
import { runCase } from './driver.mjs';

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('./cases.json', import.meta.url)), 'utf8'),
) as { cases: { id: string; title: string; mode: string }[] };

it('maps every registered scenario to exactly one catalog case with the same mode', () => {
  expect(scenarios.size).toBeGreaterThan(0);
  for (const [title, scenario] of scenarios as Map<string, { mode: string }>) {
    const matches = catalog.cases.filter((c) => c.title === title);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.mode).toBe(scenario.mode);
  }
});

it('derives the product version from the build manifest', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-manifest-'));
  try {
    const write = (file: string, content: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    };
    write('package.json', JSON.stringify({ version: '0.1.0' }));
    write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
    write('packages/a/package.json', '{}');
    write('packages/a/dist/index.js', 'export const a = 1;\n');
    write('apps/b/dist/main.js', 'console.log(1);\n');

    const first = await buildManifest(root);
    expect(first.git).toBeNull();
    const paths = first.files.map((f: { path: string }) => f.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain('packages/a/dist/index.js');
    const version = productVersion(first);
    expect(version).toMatch(/^0\.1\.0\+[0-9a-f]{64}$/);
    expect(productVersion(await buildManifest(root))).toBe(version);

    write('packages/a/dist/index.js', 'export const a = 2;\n');
    const changedDist = productVersion(await buildManifest(root));
    expect(changedDist).not.toBe(version);

    write('apps/b/out/app.bin', 'x');
    expect(productVersion(await buildManifest(root))).not.toBe(changedDist);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects an unregistered case as not implemented', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-driver-'));
  try {
    await expect(
      runCase({
        spec: { id: 'unregistered', title: 'unregistered scenario', mode: 'integration' },
        workspace: root,
        evidenceDir: root,
      }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
