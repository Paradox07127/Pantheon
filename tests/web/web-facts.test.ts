import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { factsRefresher } from '@/data/facts-read';

describe('factsRefresher', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends one refresh per change of the current project', async () => {
    const send = vi.fn(async (): Promise<BridgeResult<unknown>> => ({ ok: true, value: {} }));
    const refresh = factsRefresher(send);
    refresh(null);
    refresh('project-a');
    refresh('project-a');
    refresh('project-b');
    refresh('project-b');
    refresh(null);
    refresh('project-a');
    await Promise.resolve();
    expect(send.mock.calls).toEqual([['project-a'], ['project-b'], ['project-a']]);
  });

  it('sends the refresh again for the same project after one fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results: BridgeResult<unknown>[] = [
      { ok: false, error: { code: 'ipc_failed', message: 'gone' } },
      { ok: true, value: {} },
    ];
    const send = vi.fn(async () => results.shift()!);
    const refresh = factsRefresher(send);
    refresh('project-a');
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledTimes(1));
    refresh('project-a');
    await Promise.resolve();
    refresh('project-a');
    expect(send.mock.calls).toEqual([['project-a'], ['project-a']]);
  });

  it('only warns when the refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refresh = factsRefresher(async () => ({
      ok: false,
      error: { code: 'ipc_failed', message: 'gone' },
    }));
    refresh('project-a');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0]![0]).toContain('gone');
  });
});
