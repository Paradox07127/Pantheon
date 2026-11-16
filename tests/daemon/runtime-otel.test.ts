import { createServer } from 'node:http';
import { Store } from '@pantheon/store';
import { expect, it, vi } from 'vitest';
import { startRuntimeOtel } from '../../apps/daemon/dist/runtime-otel.js';
import { eventually, fixture } from '../helpers.js';

it('tails lifecycle events to a local OTLP collector and omits tool contents', async () => {
  const f = fixture();
  let request: { url?: string; body: string } | undefined;
  const collector = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    request = { url: req.url, body };
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  const address = collector.address() as { port: number };
  const stop = startRuntimeOtel(f.store, `http://127.0.0.1:${address.port}`, (error) => {
    throw error;
  });
  try {
    f.store.event('agent.tool.completed', f.project, f.project.id, {
      turn_id: 'turn-one',
      tool_call_id: 'tool-one',
      ok: true,
      duration_ms: 8231,
      output: 'private-output',
    });
    f.store.event('agent.message.delta', f.project, f.project.id, { text: 'private-message' });
    f.store.event('trace.evidence_read', f.project, f.project.id, {
      view: 'findings',
      bytes: 418,
      turn_id: 'turn-one',
      evidence: 'private-evidence',
    });
    await eventually(() => request !== undefined);
    expect(request?.url).toBe('/v1/logs');
    expect(request!.body).not.toMatch(/private-output|private-message|private-evidence/);
    expect(JSON.parse(request!.body).resourceLogs[0].scopeLogs[0].logRecords).toEqual([
      expect.objectContaining({
        eventName: 'agent.tool.completed',
        traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
        attributes: expect.arrayContaining([
          { key: 'pantheon.duration_ms', value: { intValue: '8231' } },
          { key: 'pantheon.tool.ok', value: { boolValue: true } },
        ]),
      }),
      expect.objectContaining({
        eventName: 'trace.evidence_read',
        attributes: expect.arrayContaining([
          { key: 'pantheon.analysis.view', value: { stringValue: 'findings' } },
          { key: 'pantheon.analysis.response_bytes', value: { intValue: '418' } },
        ]),
      }),
    ]);
  } finally {
    await stop();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
    await f.close();
  }
});

it('reads lifecycle events past text deltas in the same interval and starts at the live cursor', async () => {
  const store = new Store(':memory:');
  const entity = { id: 'project', revision: 1 };
  store.event('agent.tool.completed', entity, entity.id, { tool_call_id: 'old-tool' });
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  vi.useFakeTimers();
  const stop = startRuntimeOtel(store, 'http://127.0.0.1:4318', (error) => {
    throw error;
  });
  try {
    for (let i = 0; i < 512; i++)
      store.event('agent.message.delta', entity, entity.id, { text: 'private-message' });
    store.event('agent.tool.completed', entity, entity.id, { tool_call_id: 'new-tool' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);
    const batch = JSON.parse(send.mock.calls[0]![1]!.body as string);
    expect(batch.resourceLogs[0].scopeLogs[0].logRecords).toEqual([
      expect.objectContaining({
        eventName: 'agent.tool.completed',
        attributes: expect.arrayContaining([
          { key: 'pantheon.tool_call_id', value: { stringValue: 'new-tool' } },
        ]),
      }),
    ]);
  } finally {
    await stop();
    vi.useRealTimers();
    send.mockRestore();
    store.close();
  }
});

it('reads past a tail of text deltas only once', async () => {
  const store = new Store(':memory:');
  const entity = { id: 'project', revision: 1 };
  const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  const read = vi.spyOn(store, 'events');
  vi.useFakeTimers();
  const stop = startRuntimeOtel(store, 'http://127.0.0.1:4318', (error) => {
    throw error;
  });
  try {
    for (let i = 0; i < 300; i++)
      store.event('agent.message.delta', entity, entity.id, { text: 'private-message' });
    const head = store.cursor();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(read.mock.calls.map(([after]) => after)).toEqual([0, head]);
    expect(send).not.toHaveBeenCalled();
  } finally {
    await stop();
    vi.useRealTimers();
    send.mockRestore();
    store.close();
  }
});

it('exports every full lifecycle batch without waiting for another interval', async () => {
  const store = new Store(':memory:');
  const entity = { id: 'project', revision: 1 };
  const send = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
  vi.useFakeTimers();
  const stop = startRuntimeOtel(store, 'http://127.0.0.1:4318', (error) => {
    throw error;
  });
  try {
    for (let i = 0; i < 257; i++)
      store.event('agent.tool.completed', entity, entity.id, { tool_call_id: `tool-${i}` });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(
      send.mock.calls.map(([, init]) => {
        const batch = JSON.parse(init!.body as string);
        return batch.resourceLogs[0].scopeLogs[0].logRecords.length;
      }),
    ).toEqual([128, 128, 1]);
  } finally {
    await stop();
    vi.useRealTimers();
    send.mockRestore();
    store.close();
  }
});
