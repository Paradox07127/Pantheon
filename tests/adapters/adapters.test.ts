import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { terminate } from '../../packages/adapters/dist/process.js';
import path from 'node:path';
import os from 'node:os';
import { JsonRpcProcess, nativeEnvironment, ClaudeAdapter, CodexAdapter } from '@pantheon/adapters';

it('does not inherit API billing or permission override variables', () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  try {
    expect(nativeEnvironment().OPENAI_API_KEY).toBeUndefined();
    expect(nativeEnvironment().HOME).toBe(process.env.HOME);
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  }
});
it('advertises measured native write isolation whatever CLI version is installed', () => {
  // The isolation was measured on macOS and Linux only.
  for (const adapter of [new ClaudeAdapter(), new CodexAdapter()])
    expect(adapter.report.capabilities.write_isolation?.status).toBe(
      ['darwin', 'linux'].includes(process.platform) ? 'supported' : 'unknown',
    );
});
it('correlates protocol responses, declines server requests and rejects pending calls on exit', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-rpc-')),
    file = path.join(root, 'server.cjs');
  writeFileSync(
    file,
    `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture'}})+'\\n');if(m.method==='probe'){process.stdout.write(JSON.stringify({id:99,method:'item/commandExecution/requestApproval',params:{}})+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{ok:true}})+'\\n');}});`,
  );
  const rpc = new JsonRpcProcess(process.execPath, [file], root);
  try {
    expect(await rpc.initialize()).toMatchObject({ userAgent: 'fixture' });
    const denied: unknown[] = [];
    rpc.on('deniedRequest', (e) => denied.push(e));
    expect(await rpc.request('probe')).toEqual({ ok: true });
    expect(denied).toHaveLength(1);
    const pending = rpc.request('never-replies');
    const assertion = expect(pending).rejects.toThrow(/closed/);
    await rpc.close();
    await assertion;
  } finally {
    await rpc.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('parses a protocol frame over the default line cap when the process allows longer lines', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pantheon-rpc-')),
    file = path.join(root, 'server.cjs');
  writeFileSync(
    file,
    `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,result:{blob:'x'.repeat(5*1024*1024)}})+'\\n');});`,
  );
  const rpc = new JsonRpcProcess(
    process.execPath,
    [file],
    root,
    undefined,
    {},
    {
      maxLine: 8 * 1024 * 1024,
    },
  );
  try {
    const reply = await Promise.race([
      rpc.request<{ blob: string }>('large'),
      new Promise<never>((_, reject) => rpc.once('protocolError', reject)),
    ]);
    expect(reply.blob).toHaveLength(5 * 1024 * 1024);
  } finally {
    await rpc.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not report zero live members when the group leader exited but a descendant survives', async () => {
  const source = `const {spawn}=require('node:child_process');
    const member=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send('ready');setTimeout(()=>process.exit(),10000)"],{stdio:['ignore','ignore','ignore','ipc']});
    member.on('message',()=>process.exit(0));`;
  const child = spawn(process.execPath, ['-e', source], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    await done;
    expect(child.exitCode).toBe(0);
    const receipt = await terminate(child, done, Date.now() - 1);
    expect(receipt.stopped).toBe(false);
    expect(receipt.evidence.live_count, 'an exited leader does not prove an empty group').not.toBe(
      0,
    );
  } finally {
    await terminate(child, done, Date.now() + 5000);
  }
});

it('never signals a group after observing ESRCH even while transport close is pending', async () => {
  const child = spawn(process.execPath, ['-e', ''], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error('group exited'), { code: 'ESRCH' });
    return true;
  });
  try {
    const pending = new Promise(() => {});
    const receipt = await terminate(child, pending, Date.now() + 40);
    await terminate(child, pending, Date.now() + 40);
    expect(
      kill.mock.calls.filter(([pid, signal]) => pid === -child.pid! && signal !== 0),
      'ESRCH must permanently fence signals',
    ).toEqual([]);
    expect(receipt.stopped, 'an open transport is not a confirmed stop').toBe(false);
  } finally {
    kill.mockRestore();
  }
});

it('does not confirm a stop while a process outside the group holds the transport', async () => {
  const source = `const {spawn}=require('node:child_process');
    const holder=spawn(process.execPath,['-e',"process.send('ready');setTimeout(()=>process.exit(),1500)"],{detached:true,stdio:['ignore','inherit','ignore','ipc']});
    holder.on('message',()=>process.exit(0));`;
  const child = spawn(process.execPath, ['-e', source], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0) throw Object.assign(new Error('group exited'), { code: 'ESRCH' });
    return true;
  });
  try {
    const receipt = await terminate(child, closed, Date.now() + 200);
    expect(receipt.stopped, 'the holder left the group but still holds the pipe').toBe(false);
    expect(receipt.evidence.live_count).toBeUndefined();
    await closed;
    expect((await terminate(child, closed, Date.now() + 200)).stopped).toBe(true);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  } finally {
    kill.mockRestore();
  }
});

it('never confirms a spawned Windows process without whole-tree observation', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const child = {
    pid: 12345,
    exitCode: 0,
    signalCode: null,
    kill() {},
  } as unknown as ChildProcessWithoutNullStreams;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  try {
    const receipt = await terminate(child, Promise.resolve(), Date.now());
    expect(receipt.stopped, 'a leader exit is insufficient on Windows').toBe(false);
    expect(receipt.evidence).toMatchObject({ method: 'none' });
    expect(receipt.evidence.live_count).toBeUndefined();
  } finally {
    kill.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  }
});
