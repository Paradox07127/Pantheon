import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ query: vi.fn(), duringMkdtemp: () => {} }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mock.query }));
vi.mock('node:fs/promises', async (actual) => {
  const real = await actual<typeof import('node:fs/promises')>();
  const mkdtemp = async (prefix: string) => {
    const made = await real.mkdtemp(prefix);
    mock.duringMkdtemp();
    return made;
  };
  return { ...real, mkdtemp, default: { ...real, mkdtemp } };
});
/** A fresh module, so no test sees another test's cached login. */
async function load() {
  vi.resetModules();
  return import('../../packages/adapters/src/one-shot.js');
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  mock.query.mockReset();
  mock.duringMkdtemp = () => {};
});

/** A `claude` stand-in whose `auth status` answers from a file the test can change. */
function fakeClaude(loggedIn: boolean): { binary: string; login: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-one-shot-test-'));
  roots.push(root);
  const status = path.join(root, 'status.json');
  const write = (value: boolean) =>
    writeFileSync(status, JSON.stringify({ loggedIn: value, authMethod: 'claude.ai' }));
  write(loggedIn);
  const binary = path.join(root, 'claude');
  writeFileSync(binary, `#!/bin/sh\ncat '${status}'\n`);
  chmodSync(binary, 0o755);
  return { binary, login: () => write(true) };
}

it('sees a login made after a logged-out answer', async () => {
  const { claudeSubscription } = await load();
  const claude = fakeClaude(false);
  expect(await claudeSubscription(claude.binary)).toBe(false);
  claude.login();
  expect(await claudeSubscription(claude.binary)).toBe(true);
});

it('asks each binary for its own login', async () => {
  const { claudeSubscription } = await load();
  expect(await claudeSubscription(fakeClaude(true).binary)).toBe(true);
  expect(await claudeSubscription(fakeClaude(false).binary)).toBe(false);
});

it('asks again after a probe that could not start', async () => {
  const { claudeSubscription } = await load();
  await expect(claudeSubscription('claude\0broken')).rejects.toThrow();
  await expect(claudeSubscription('claude\0broken')).rejects.toThrow();
});

it('does not start the query when the caller gave up while the folder was made', async () => {
  const { claudeOneShot } = await load();
  const caller = new AbortController();
  mock.duringMkdtemp = () => caller.abort();
  await expect(
    claudeOneShot('prompt', 'model', caller.signal, fakeClaude(true).binary),
  ).rejects.toThrow(/abort/i);
  expect(mock.query).not.toHaveBeenCalled();
});
