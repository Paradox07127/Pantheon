import { afterEach, expect, it, vi } from 'vitest';
import { command, type CommandType } from '@pantheon/protocol';
import { daemonClient } from '../../apps/cli/dist/mcp.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const deadline = async (type: CommandType) => {
  vi.stubGlobal('fetch', async () => Response.json({ receipt: { id: 'receipt' } }));
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  await daemonClient('http://127.0.0.1:4321', 'session-token').send(
    command('session:conductor', type, {}),
  );
  return timeout.mock.calls.map(([ms]) => ms);
};

it.each(['conductor.ready', 'conductor.review'] as const)(
  'waits for %s as long as the desktop waits for a merge',
  async (type) => {
    expect(await deadline(type)).toEqual([250_000]);
  },
);

it('waits five seconds for any other command', async () => {
  expect(await deadline('memory.context')).toEqual([5000]);
});
