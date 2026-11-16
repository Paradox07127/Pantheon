import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachmentMime, DaemonBridge } from '../../apps/desktop/src/main/daemon.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});

function bridgeWith(attachments: (init: RequestInit) => Response) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-attachments-'));
  roots.push(root);
  const token = path.join(root, 'user.token');
  writeFileSync(token, 'secret');
  writeFileSync(
    path.join(root, 'daemon.json'),
    JSON.stringify({ url: 'http://127.0.0.1:1234', token_file: token, pid: 1 }),
  );
  const timeouts: number[] = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  const requests: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL, init: RequestInit = {}) => {
      if (input.pathname !== '/v1/attachments')
        return new Response(JSON.stringify({ version: '0.1.0', protocol_version: 1 }));
      requests.push({ url: input, init });
      return attachments(init);
    }),
  );
  const bridge = new DaemonBridge({
    directory: root,
    packaged: true,
    repo: root,
    logFile: path.join(root, 'daemon.log'),
  });
  return { bridge, requests, timeouts };
}

it('posts the bytes to the attachments route with their mime and the bearer token', async () => {
  const meta = { id: 'attachment', name: 'shot one.png', mime: 'image/png', size: 3 };
  const { bridge, requests, timeouts } = bridgeWith(() => new Response(JSON.stringify(meta)));
  await bridge.daemon();
  timeouts.length = 0;
  const result = await bridge.attach(
    'project',
    'shot one.png',
    'image/png',
    new Uint8Array([1, 2, 3]),
  );
  expect(result).toEqual({ ok: true, value: meta });
  expect(requests).toHaveLength(1);
  const { url, init } = requests[0]!;
  expect(url.pathname).toBe('/v1/attachments');
  expect(url.searchParams.get('project_id')).toBe('project');
  expect(url.searchParams.get('name')).toBe('shot one.png');
  expect(init.method).toBe('POST');
  const headers = init.headers as Record<string, string>;
  expect(headers['Content-Type']).toBe('image/png');
  expect(headers.Authorization).toBe('Bearer secret');
  expect([...new Uint8Array(init.body as Uint8Array)]).toEqual([1, 2, 3]);
  expect(timeouts).toEqual([30_000]);
});

it('sends bytes without a mime as application/octet-stream', async () => {
  const { bridge, requests } = bridgeWith(
    () => new Response(JSON.stringify({ id: 'a', name: 'blob', mime: '', size: 0 })),
  );
  await bridge.attach('project', 'blob', '', new Uint8Array());
  expect((requests[0]!.init.headers as Record<string, string>)['Content-Type']).toBe(
    'application/octet-stream',
  );
});

it('fails with attachment_too_large when the daemon answers 413', async () => {
  const { bridge } = bridgeWith(
    () =>
      new Response(
        JSON.stringify({
          error: 'attachment_too_large',
          message: 'Attachments are limited to 20 MiB',
        }),
        { status: 413 },
      ),
  );
  const result = await bridge.attach('project', 'big.bin', '', new Uint8Array([0]));
  expect(result.ok).toBe(false);
  expect(!result.ok && result.error.code).toBe('attachment_too_large');
  expect(!result.ok && result.error.status).toBe(413);
});

it('derives the mime of a picked file from its extension', () => {
  expect(attachmentMime('/a/shot.png')).toBe('image/png');
  expect(attachmentMime('/a/photo.JPG')).toBe('image/jpeg');
  expect(attachmentMime('/a/photo.jpeg')).toBe('image/jpeg');
  expect(attachmentMime('/a/anim.gif')).toBe('image/gif');
  expect(attachmentMime('/a/pic.webp')).toBe('image/webp');
  expect(attachmentMime('/a/spec.pdf')).toBe('application/pdf');
  expect(attachmentMime('/a/notes.txt')).toBe('text/plain');
  expect(attachmentMime('/a/readme.md')).toBe('text/markdown');
  expect(attachmentMime('/a/data.json')).toBe('application/json');
  expect(attachmentMime('/a/run.log')).toBe('text/plain');
  expect(attachmentMime('/a/table.csv')).toBe('text/csv');
  expect(attachmentMime('/a/archive.zip')).toBe('application/octet-stream');
  expect(attachmentMime('/a/Makefile')).toBe('application/octet-stream');
});
