import { afterEach, expect, it, vi } from 'vitest';
import { fixture, user } from '../helpers.js';
import type { LocalCommand, LocalCommandResult } from '../../packages/control/src/local-command.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});
const missing = { stdout: '', stderr: '', exit_code: null, missing: true };
const absent = { state: 'missing', installed: false, signed_in: false };
const hosts = {
  'github.com': [
    {
      host: 'github.com',
      login: 'owner',
      active: true,
      state: 'success',
      scopes: 'repo, read:org, gist',
    },
  ],
};
async function setup(replies: Record<string, LocalCommandResult> = {}) {
  const run: LocalCommand = vi.fn(async (file) => replies[file] ?? missing);
  const f = await fixture({ controlOptions: { localCommand: run } });
  cleanups.push(() => f.close());
  return { ...f, run, replies };
}
const ok = (stdout: string): LocalCommandResult => ({ stdout, stderr: '', exit_code: 0 });

it('distinguishes missing tools and falls back only when hf is missing', async () => {
  const f = await setup();
  expect(await f.control.connectionsStatus(user)).toEqual({
    github: absent,
    huggingface: absent,
    cloudflare: absent,
  });
  expect(f.run).toHaveBeenCalledWith('hf', ['auth', 'whoami']);
  expect(f.run).toHaveBeenCalledWith('huggingface-cli', ['whoami']);
  expect(f.run).toHaveBeenCalledWith('wrangler', ['whoami']);
});

it('distinguishes timeouts and installed tools without a signed-in account', async () => {
  const f = await setup({
    gh: { stdout: '', stderr: '', exit_code: null, timed_out: true },
    hf: ok('Not logged in'),
    wrangler: ok('You are not authenticated. Please run `wrangler login`.'),
  });
  expect(await f.control.connectionsStatus(user)).toEqual({
    github: { state: 'timeout', installed: true, signed_in: null },
    huggingface: { state: 'signed_out', installed: true, signed_in: false },
    cloudflare: { state: 'signed_out', installed: true, signed_in: false },
  });
  expect(f.run).not.toHaveBeenCalledWith('huggingface-cli', ['whoami']);
});

it('reads the accounts and scopes and caches for sixty seconds or until refresh', async () => {
  const f = await setup({
    gh: ok(JSON.stringify({ hosts })),
    hf: ok('user: researcher\norgs: lab'),
    wrangler: ok(
      'Getting User settings...\n👋 You are logged in with an OAuth Token, associated with the email dev@example.com!',
    ),
  });
  let now = Date.now();
  vi.spyOn(f.store, 'now').mockImplementation(() => now);
  const expected = {
    github: {
      state: 'signed_in',
      installed: true,
      signed_in: true,
      account: 'owner',
      host: 'github.com',
      scopes: ['repo', 'read:org', 'gist'],
    },
    huggingface: {
      state: 'signed_in',
      installed: true,
      signed_in: true,
      account: 'researcher',
    },
    cloudflare: {
      state: 'signed_in',
      installed: true,
      signed_in: true,
      account: 'dev@example.com',
    },
  };
  expect(await f.control.connectionsStatus(user)).toEqual(expected);
  f.replies.gh = ok(JSON.stringify({ hosts: {} }));
  expect(await f.control.connectionsStatus(user)).toEqual(expected);
  now += 60_000;
  expect((await f.control.connectionsStatus(user)).github.state).toBe('signed_out');
  f.replies.gh = ok(JSON.stringify({ hosts }));
  expect((await f.control.connectionsStatus(user, true)).github.state).toBe('signed_in');
});

it('reads the bare account from the user=name line hf auth whoami prints', async () => {
  const f = await setup({ hf: ok('user=researcher orgs=lab\n') });
  expect(await f.control.connectionsStatus(user)).toMatchObject({
    huggingface: { state: 'signed_in', account: 'researcher' },
  });
});

it('reads a legacy Hugging Face login and reports other tool timeouts', async () => {
  const f = await setup({
    'huggingface-cli': ok('legacy-user\norgs: lab'),
    wrangler: { stdout: '', stderr: '', exit_code: null, timed_out: true },
  });
  expect(await f.control.connectionsStatus(user)).toMatchObject({
    huggingface: { state: 'signed_in', account: 'legacy-user' },
    cloudflare: { state: 'timeout', installed: true, signed_in: null },
  });
});
