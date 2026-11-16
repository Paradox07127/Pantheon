import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BackendProfile } from '@pantheon/protocol';
import {
  backendKey,
  homeRuntime,
  readUserConfig,
  runtimeConfig,
  writeUserConfig,
} from '../../packages/control/src/user-config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory(config?: string): string {
  const cache = path.resolve('node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(path.join(cache, 'user-config-'));
  roots.push(root);
  if (config !== undefined) writeFileSync(path.join(root, 'config.json'), config);
  return root;
}
const empty = { version: 1, backends: [], model_families: {} };
const deepseek: BackendProfile = {
  id: 'deepseek',
  protocol: 'anthropic',
  base_url: 'https://api.deepseek.com/anthropic',
  key: { env: 'DEEPSEEK_API_KEY' },
  models: ['deepseek-v4'],
};
const relay: BackendProfile = {
  id: 'office-relay',
  protocol: 'openai-responses',
  base_url: 'https://relay.example.invalid/v1',
  key: { keychain: 'pantheon-office-relay' },
};

it('reads no user configuration as an empty one', () => {
  expect(readUserConfig(undefined)).toEqual(empty);
  expect(readUserConfig(directory())).toEqual(empty);
});

it('rejects unreadable JSON, repeated backend ids and unknown protocols', () => {
  const invalid = expect.objectContaining({
    code: 'invalid_user_config',
    message: expect.stringContaining('config.json'),
  });
  expect(() => readUserConfig(directory('{ "version": 1,'))).toThrow(invalid);
  expect(() =>
    readUserConfig(directory(JSON.stringify({ version: 1, backends: [deepseek, deepseek] }))),
  ).toThrow(invalid);
  expect(() =>
    readUserConfig(
      directory(JSON.stringify({ version: 1, backends: [{ ...deepseek, protocol: 'bedrock' }] })),
    ),
  ).toThrow(invalid);
});

it('reads a valid configuration as written', () => {
  const config = {
    version: 1,
    backends: [deepseek, relay],
    model_families: { 'deepseek-': 'claude' },
  };
  expect(readUserConfig(directory(JSON.stringify(config)))).toEqual(config);
});

it('maps a model to its home runtime, configured families first and longest prefix winning', () => {
  expect(homeRuntime('claude-opus-4', {})).toBe('claude');
  expect(homeRuntime('gpt-5', {})).toBe('codex');
  expect(homeRuntime('o3', {})).toBe('codex');
  expect(homeRuntime('deepseek-v4', {})).toBe('dsh');
  expect(homeRuntime('qwen3-coder', {})).toBe('qwen');
  expect(homeRuntime('kimi-k2', {})).toBe('kimi');
  expect(homeRuntime('muse-spark-1.3', {})).toBe('muse');
  expect(homeRuntime('llama-3', {})).toBeUndefined();
  expect(homeRuntime('deepseek-v4', { 'deepseek-': 'claude' })).toBe('claude');
  expect(homeRuntime('deepseek-r2', { 'deepseek-': 'claude', 'deepseek-r': 'codex' })).toBe(
    'codex',
  );
});

it('reads a backend key from the environment or the keychain without echoing secrets', () => {
  const unused = () => {
    throw new Error('keychain not expected');
  };
  expect(backendKey(deepseek, { DEEPSEEK_API_KEY: 'sk-environment' }, unused)).toBe(
    'sk-environment',
  );
  expect(() => backendKey(deepseek, {}, unused)).toThrow(
    expect.objectContaining({
      code: 'backend_key_missing',
      message: expect.stringContaining('DEEPSEEK_API_KEY'),
    }),
  );
  const services: string[] = [];
  expect(
    backendKey(relay, {}, (service) => {
      services.push(service);
      return 'sk-keychain';
    }),
  ).toBe('sk-keychain');
  expect(services).toEqual(['pantheon-office-relay']);
  let failure: unknown;
  try {
    backendKey(relay, { RELAY_KEY: 'sk-unrelated' }, () => {
      throw new Error('security: item sk-leaked not found');
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: 'backend_key_missing',
    message: expect.stringContaining('pantheon-office-relay'),
  });
  expect((failure as Error).message).not.toContain('sk-');
  expect(() => backendKey(relay, {}, () => '')).toThrow(
    expect.objectContaining({ code: 'backend_key_missing' }),
  );
});

it('tells a Linux user to keep a keychain backend key in an environment variable', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    expect(() => backendKey(relay, {})).toThrow(
      expect.objectContaining({
        code: 'backend_key_missing',
        message: expect.stringContaining('key.env'),
      }),
    );
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

it('reads binary, extra arguments and enabled settings for ACP runtime names', () => {
  const runtimes = {
    grok: { binary: '/opt/grok', args: ['--verbose'], enabled: false },
    agy: { args: ['--sandbox'] },
  };
  const dir = directory(JSON.stringify({ version: 1, runtimes }));
  expect(readUserConfig(dir).runtimes).toEqual(runtimes);
  expect(runtimeConfig(dir, 'grok')).toEqual(runtimes.grok);
  expect(runtimeConfig(dir, 'agy')).toEqual(runtimes.agy);
});

const buildBox = { ssh: 'build-box', labels: ['cuda'], resources: { gpu: 2 }, max_sessions: 4 };

it('reads devices as written', () => {
  const devices = { 'build-box': buildBox };
  expect(readUserConfig(directory(JSON.stringify({ version: 1, devices }))).devices).toEqual(
    devices,
  );
});

it('reads and writes the labels, resources and session limit of this machine', () => {
  const dir = directory(JSON.stringify({ version: 1 }));
  const local_device = { labels: ['display'], resources: { display: 1 }, max_sessions: 2 };
  writeUserConfig(dir, { local_device });
  expect(readUserConfig(dir).local_device).toEqual(local_device);
  expect(() => writeUserConfig(dir, { local_device: { max_sessions: 0 } })).toThrow(
    expect.objectContaining({ code: 'invalid_user_config' }),
  );
});

it('rejects a device with the id local', () => {
  expect(() =>
    readUserConfig(directory(JSON.stringify({ version: 1, devices: { local: buildBox } }))),
  ).toThrow(expect.objectContaining({ code: 'invalid_user_config' }));
});

it('rejects a device with no sessions allowed', () => {
  expect(() =>
    readUserConfig(
      directory(
        JSON.stringify({ version: 1, devices: { 'build-box': { ...buildBox, max_sessions: 0 } } }),
      ),
    ),
  ).toThrow(expect.objectContaining({ code: 'invalid_user_config' }));
});
