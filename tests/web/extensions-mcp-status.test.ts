import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { mount, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
import { useMcpStatus } from '@/data/extensions';

const reading = (answer: BridgeResult<unknown>) => {
  const query = vi.fn(async (_method: string, _params?: Record<string, string>) => answer);
  vi.stubGlobal('window', { pantheon: { query } });
  return query;
};

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('MCP server states of a project', () => {
  const failed = { name: 'tracker', state: 'failed', reason: 'spawn ENOENT' };
  it.each([
    [
      'reads the states of the runtime the project selects',
      'claude',
      { runtime: 'claude', reconnect_available: false, servers: [failed] },
      [failed],
    ],
    [
      'has no states when the runtime does not report them',
      'codex',
      { runtime: 'codex', reconnect_available: false },
      [],
    ],
  ])('%s', async (_name, runtime, value, states) => {
    const query = reading({ ok: true, value });
    const h = mount(() => useMcpStatus('alpha', runtime));
    await h.flush();
    expect(query).toHaveBeenCalledWith('mcp.status', { project_id: 'alpha', runtime });
    expect([...h.value.values()]).toEqual(states);
  });
});
