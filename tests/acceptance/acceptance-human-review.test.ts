import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireHumanReview } from './lib/human-review.mjs';
import { runCase } from './driver.mjs';

vi.mock('./scenarios/index.mjs', async () => {
  const { writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const rehearsal = {
    title: 'rehearsal screenshot review',
    mode: 'ui',
    async run({
      workspace,
      humanReview,
    }: {
      workspace: string;
      humanReview: (
        items: { name: string; path: string }[],
      ) => Promise<{ ok: boolean; reasons: string[]; receipt: unknown }>;
    }) {
      const screenshot = path.join(workspace, 'rehearsal-screenshot.txt');
      await writeFile(screenshot, 'rehearsal screenshot content\n');
      const review = await humanReview([{ name: 'rehearsal-screenshot', path: screenshot }]);
      return {
        observations: { review_ok: review.ok, review_reasons: review.reasons },
        evidence: review.ok ? { 'human-review.json': review.receipt } : {},
        adapters: [],
      };
    },
  };
  return { scenarios: new Map([[rehearsal.title, rehearsal]]) };
});

const reviewScript = fileURLToPath(new URL('../../scripts/acceptance-review.mjs', import.meta.url));
const manifestSha = 'a'.repeat(64);
const otherManifestSha = 'b'.repeat(64);
const spec = { id: 'settings-page-review', title: 'settings page review', mode: 'ui' };

let root: string;
let storeDir: string;
let screenshot: string;
let notes: string;
let items: { name: string; path: string }[];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-human-review-'));
  storeDir = path.join(root, 'store');
  screenshot = path.join(root, 'settings-screenshot.txt');
  notes = path.join(root, 'release-notes.md');
  writeFileSync(screenshot, 'settings screenshot\n');
  writeFileSync(notes, '# release notes\n');
  items = [
    { name: 'settings-screenshot', path: screenshot },
    { name: 'release-notes', path: notes },
  ];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function review(caseId: string, answers: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [reviewScript, '--store', storeDir, caseId]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(answers.map((answer) => answer + '\n').join(''));
  });
}

const check = (overrides: Record<string, unknown> = {}) =>
  requireHumanReview({
    spec,
    buildManifestSha256: manifestSha,
    items,
    storeDir,
    waitMs: 0,
    ...overrides,
  });

const receiptPath = () => path.join(storeDir, `${spec.id}.json`);

async function recordReceipt() {
  expect((await check()).ok).toBe(false);
  expect((await review(spec.id, ['y', 'YES', 'reviewer one'])).code).toBe(0);
}

it('passes once the reviewer confirms every item through the CLI', async () => {
  const before = await check();
  expect(before.ok).toBe(false);
  expect(before.reasons.at(-1)).toBe('no valid receipt within 0 ms');
  const request = JSON.parse(readFileSync(path.join(storeDir, `${spec.id}.request.json`), 'utf8'));
  expect(request.case).toEqual({ id: spec.id, title: spec.title });
  expect(request.build_manifest_sha256).toBe(manifestSha);
  expect(request.items.map((item: { name: string }) => item.name)).toEqual([
    'settings-screenshot',
    'release-notes',
  ]);

  const cli = await review(spec.id, ['y', 'yes', 'reviewer one']);
  expect(cli.code).toBe(0);

  const after = await check();
  expect(after.reasons).toEqual([]);
  expect(after.ok).toBe(true);
  expect(after.receipt).toMatchObject({
    check_spec_hash: request.check_spec_hash,
    build_manifest_sha256: manifestSha,
    confirmed_by: 'reviewer one',
  });
  expect(after.receipt.items).toEqual(
    request.items.map((item: { name: string; sha256: string }) => ({
      name: item.name,
      sha256: item.sha256,
      confirmed: true,
    })),
  );
  expect(Number.isNaN(Date.parse(after.receipt.confirmed_at))).toBe(false);
});

it('rejects the receipt after a reviewed file changes', async () => {
  await recordReceipt();
  writeFileSync(notes, '# release notes, edited\n');
  const result = await check();
  expect(result.ok).toBe(false);
  expect(result.reasons.some((reason: string) => reason.includes('item release-notes'))).toBe(true);
  expect(result.reasons.some((reason: string) => reason.includes('settings-screenshot'))).toBe(
    false,
  );
});

it('rejects a receipt recorded for another build', async () => {
  await recordReceipt();
  const result = await check({ buildManifestSha256: otherManifestSha });
  expect(result.ok).toBe(false);
  expect(result.reasons.some((reason: string) => reason.includes('build_manifest_sha256'))).toBe(
    true,
  );
});

it('rejects a receipt recorded for a different case spec', async () => {
  await recordReceipt();
  const result = await check({ spec: { ...spec, title: 'settings page review, revised' } });
  expect(result.ok).toBe(false);
  expect(result.reasons.some((reason: string) => reason.includes('check_spec_hash'))).toBe(true);
});

it('writes the refusal and rejects the receipt when an item is not confirmed', async () => {
  await check();
  const cli = await review(spec.id, ['y', 'n', 'reviewer one']);
  expect(cli.code).toBe(1);
  const receipt = JSON.parse(readFileSync(receiptPath(), 'utf8'));
  expect(receipt.items.map((item: { confirmed: boolean }) => item.confirmed)).toEqual([
    true,
    false,
  ]);
  const result = await check();
  expect(result.ok).toBe(false);
  expect(result.reasons.some((reason: string) => reason.includes('item release-notes'))).toBe(true);
});

it('writes no receipt when the reviewer name is empty', async () => {
  await check();
  const cli = await review(spec.id, ['y', 'y', '']);
  expect(cli.code).toBe(64);
  expect(existsSync(receiptPath())).toBe(false);
});

it('passes when the receipt arrives while waiting', async () => {
  const pending = check({ waitMs: 1500, pollMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await review(spec.id, ['y', 'y', 'reviewer one'])).code).toBe(0);
  const result = await pending;
  expect(result.reasons).toEqual([]);
  expect(result.ok).toBe(true);
});

it('fails when the receipt arrives after the wait expires', async () => {
  const result = await check({ waitMs: 200, pollMs: 20 });
  expect(result.ok).toBe(false);
  expect(result.reasons).toContain('no valid receipt within 200 ms');
  expect((await review(spec.id, ['y', 'y', 'reviewer one'])).code).toBe(0);
  expect(result.ok).toBe(false);
  expect(result.reasons).toContain('no valid receipt within 200 ms');
});

it('lets a scenario reuse a recorded receipt through the driver', async () => {
  const rehearsalSpec = {
    id: 'rehearsal-screenshot-review',
    title: 'rehearsal screenshot review',
    mode: 'ui',
  };
  const workspace = path.join(root, 'workspace');
  const evidenceDir = path.join(root, 'evidence');
  mkdirSync(workspace);
  mkdirSync(evidenceDir);
  const run = () => runCase({ spec: rehearsalSpec, workspace, evidenceDir, reviewStore: storeDir });

  const first = await run();
  expect(first.observations.review_ok).toBe(false);
  expect(existsSync(path.join(storeDir, `${rehearsalSpec.id}.request.json`))).toBe(true);
  expect((await review(rehearsalSpec.id, ['y', 'reviewer one'])).code).toBe(0);

  const second = await run();
  expect(second.observations).toEqual({ review_ok: true, review_reasons: [] });
  const names = second.evidence.map((item: { name: string }) => item.name);
  expect(names).toContain('human-review.json');
  expect(names).toContain('build-manifest.json');
  const recorded = JSON.parse(
    readFileSync(
      second.evidence.find((item: { name: string }) => item.name === 'human-review.json')!.path,
      'utf8',
    ),
  );
  expect(recorded.build_manifest_sha256).toBe(second.provenance.build_manifest_sha256);
});
