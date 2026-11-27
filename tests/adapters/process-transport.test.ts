import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  JsonRpcProcess,
  sandboxFactsOnDevice,
  splitLines,
} from '../../packages/adapters/src/process.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const settled = (promise: Promise<unknown>, ms: number) =>
  Promise.race([
    promise.then(
      (value) => ({ resolved: value }),
      (error: Error) => ({ rejected: error.message }),
    ),
    sleep(ms).then(() => 'still pending'),
  ]);

it('rejects a request sent after the runtime exited at once', async () => {
  const rpc = new JsonRpcProcess(process.execPath, ['-e', '']);
  rpc.on('protocolError', () => {});
  await once(rpc, 'closed');

  expect(await settled(rpc.request('late', {}, null), 500)).toEqual({
    rejected: 'Protocol transport closed',
  });
});

it.each([
  ['input', 'exec 0<&-; echo ready; sleep 3'],
  ['output', 'echo ready; exec 1>&-; sleep 3'],
])('rejects every request once the runtime closes its standard %s', async (_, script) => {
  // The runtime closes one of its pipes, then exits on its own a while later.
  const rpc = new JsonRpcProcess('/bin/sh', ['-c', script]);
  const ready = once(rpc, 'protocolError');
  await ready;

  expect(await settled(rpc.request('unwritable', {}, null), 1500)).toEqual({
    rejected: expect.any(String),
  });
  expect(await settled(rpc.request('later', {}, null), 500)).toEqual({
    rejected: 'Protocol transport closed',
  });
  await rpc.exited;
});

it('reads a frame whose strings hold line and paragraph separators', async () => {
  // JSON leaves U+2028 and U+2029 unescaped.
  const script = `process.stdout.write(JSON.stringify({ method: 'output', params: { text: 'a\\u2028b\\u2029c' } }) + '\\n');`;
  const rpc = new JsonRpcProcess(process.execPath, ['-e', script]);
  const texts: string[] = [];
  const errors: string[] = [];
  rpc.on('notification', (frame: { params: { text: string } }) => texts.push(frame.params.text));
  rpc.on('protocolError', (error: Error) => errors.push(error.message));
  await rpc.exited;
  expect(texts).toEqual(['a\u2028b\u2029c']);
  expect(errors.filter((message) => message !== 'Protocol transport closed')).toEqual([]);
});

it('joins a line whose character is cut between two reads, and ends a CRLF line before the CR', async () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  splitLines(stream, (line) => lines.push(line));
  const bytes = Buffer.from('café\r\nlast');
  const cut = bytes.indexOf(0xa9);
  stream.write(bytes.subarray(0, cut));
  stream.write(bytes.subarray(cut));
  stream.end();
  await once(stream, 'end');
  expect(lines).toEqual(['café', 'last']);
});

it('drops and closes a protocol frame whose unterminated part passes the line cap', async () => {
  // The runtime writes an endless frame start and exits once its standard input ends.
  const rpc = new JsonRpcProcess(
    process.execPath,
    [
      '-e',
      "process.stdout.write('{\"x\":\"'+'a'.repeat(65536)); process.stdin.on('end',()=>process.exit()); process.stdin.resume();",
    ],
    undefined,
    undefined,
    {},
    { maxLine: 1024 },
  );
  const errors: string[] = [];
  rpc.on('protocolError', (error: Error) => errors.push(error.message));
  try {
    expect(await settled(once(rpc, 'protocolError'), 1500)).toEqual({
      resolved: [new Error('Oversized protocol frame')],
    });
  } finally {
    rpc.child.stdin.end();
    await rpc.exited;
  }
  expect(errors[0]).toBe('Oversized protocol frame');
});

it('reads non-ASCII file text from a device intact across pipe reads', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'device-text-'));
  roots.push(root);
  // One of the two texts starts a two-byte character at an odd output offset.
  const texts = ['é'.repeat(150_000), 'a' + 'é'.repeat(150_000)];
  const files = texts.map((text, index) => path.join(root, `text-${index}.txt`));
  texts.forEach((text, index) => writeFileSync(files[index]!, text));

  const facts = await sandboxFactsOnDevice(
    { transport: ['/bin/sh', '-c'], binary: 'unused' },
    [],
    files,
    [],
    Date.now() + 10_000,
  );

  expect(
    facts?.files.map((read, index) => read === texts[index]),
    'device file texts equal the files',
  ).toEqual([true, true]);
});
