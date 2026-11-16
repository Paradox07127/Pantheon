import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { useRuntimeModels, useSkills } from '@/data/runtime-models';

const down: BridgeResult<unknown> = {
  ok: false,
  error: { code: 'daemon_unavailable', message: 'connect ECONNREFUSED' },
};
const inventory = {
  mcp_servers: [],
  plugins: [],
  skills: [],
  hooks: [],
  connectors: [],
  apps: false,
};
const model = { id: 'model-a', label: 'Model A', efforts: [] };

let up: boolean;
let query: ReturnType<typeof vi.fn>;
const asked = (method: string) => query.mock.calls.filter(([m]) => m === method).length;
beforeEach(() => {
  up = false;
  query = vi.fn(async (method: string): Promise<BridgeResult<unknown>> =>
    !up ? down : { ok: true, value: method === 'runtime.models' ? [model] : inventory },
  );
  vi.stubGlobal('window', { pantheon: { query } });
  mock.board = { board: null, status: { state: 'offline', reason: 'connect ECONNREFUSED' } };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const reconnect = () => {
  up = true;
  mock.board = { ...mock.board, status: { state: 'live' } };
};

it('reads the models again once the stream is live after a failed read', async () => {
  const h = mount(() => useRuntimeModels('project-down', ['claude']));
  await h.flush();
  expect(h.value.claude!.state).toBe('failed');
  reconnect();
  h.render();
  await h.flush();
  expect(asked('runtime.models')).toBe(2);
  expect(h.value.claude).toEqual({ state: 'ready', models: [model] });
});

it('reads the skills again once the stream is live after a failed read', async () => {
  const h = mount(() => useSkills('project-skills-down', 'claude'));
  await h.flush();
  expect(asked('extensions.inventory')).toBe(1);
  reconnect();
  h.render();
  await h.flush();
  expect(asked('extensions.inventory')).toBe(2);
});
