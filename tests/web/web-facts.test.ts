import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@pantheon/protocol';
import { factsRefresher } from '@/data/facts-read';
import { workstreamRows } from '@/screens/projects/facts';
import { WorkstreamBars } from '@/screens/projects/WorkstreamBars';
import { zh } from './i18n-setup.js';
import { nodes, text } from './web-hook-host.js';

describe('workstreamRows', () => {
  it('labels each status and counts done against all found items', () => {
    const rows = workstreamRows([
      { id: 'a', title: 'Importer', status: 'running', done: 2, open: 3, missing: 0 },
      { id: 'b', title: 'Exports', status: 'done', done: 4, open: 0, missing: 2 },
      { id: 'c', title: 'Search', status: 'next', done: 0, open: 0, missing: 0 },
      {
        id: 'd',
        title: 'Sync',
        status: 'blocked',
        done: 1,
        open: 1,
        missing: 0,
        reason: 'Waiting for keys',
      },
    ]);
    const status = (id: string) => zh(`projects.workstream.${id}`);
    expect(rows.map((r) => [r.status, r.tone, r.counts, r.total, r.missing])).toEqual([
      [status('running'), 'run', '2/5', 5, null],
      [status('done'), 'ok', '4/4', 4, '2 项未找到'],
      [status('next'), '', '0/0', 0, null],
      [status('blocked'), 'bad', '1/2', 2, null],
    ]);
    expect(rows.map((r) => r.hint)).toEqual(['Importer', 'Exports', 'Search', 'Waiting for keys']);
  });
});

describe('WorkstreamBars', () => {
  it('counts a workstream with items and shows no count for one with none found', () => {
    const tree = WorkstreamBars({
      rows: workstreamRows([
        { id: 'a', title: 'Importer', status: 'running', done: 2, open: 3, missing: 0 },
        { id: 'b', title: 'Search', status: 'done', done: 0, open: 0, missing: 0 },
      ]),
    });
    const [counted, empty] = nodes(tree).filter((n) => n.props.role === 'listitem');
    expect(text(counted)).toContain('2/5');
    expect(text(empty)).toBe(`${zh('projects.workstream.done')}Search`);
  });
});

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
