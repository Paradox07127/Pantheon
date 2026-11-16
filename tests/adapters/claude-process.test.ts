import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  Options,
  SDKUserMessage,
  SpawnedProcess,
} from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/claude.js';
import { descendants, readProcessIdentity } from '../../packages/adapters/src/process.js';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

vi.mock('../../packages/adapters/src/process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/adapters/src/process.js')>();
  return { ...actual, descendants: vi.fn(actual.descendants) };
});

const cache = path.join(process.cwd(), 'node_modules/.cache');
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(path.join(cache, 'claude-process-'));
const binary = path.join(root, 'stub.cjs');
writeFileSync(
  binary,
  `#!${process.execPath}\nprocess.stdin.resume(); process.stdout.write('ready\\n'); process.stdin.on('end', () => setTimeout(() => process.exit(0), 80));`,
);
chmodSync(binary, 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function psField(pid: number, field: 'ppid=' | 'command=' | 'stat='): string {
  try {
    return execFileSync('ps', ['-o', field, '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const spec: SessionSpec = {
  platform_session_id: 'owned-session',
  project_id: 'owned-project',
  runtime: 'claude',
  device_id: 'local',
  role: 'writer',
  cwd: root,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 1000 },
};
function ownedQuery(mismatch = false) {
  const exits: { code: number | null; signal: string | null }[] = [];
  const children: SpawnedProcess[] = [];
  const query = ({
    options,
    prompt,
  }: {
    options: Options;
    prompt: AsyncIterable<SDKUserMessage>;
  }) => {
    if (!options.spawnClaudeCodeProcess) throw new Error('Adapter did not supply a child spawner');
    const child = options.spawnClaudeCodeProcess({
      command: binary,
      args: [],
      cwd: options.cwd,
      env: options.env!,
      signal: new AbortController().signal,
    });
    children.push(child);
    child.on('exit', (code, signal) => exits.push({ code, signal }));
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
    });
    return {
      initializationResult: async () => {
        await ready;
        return {
          account: mismatch
            ? { apiKeySource: 'environment' }
            : { apiProvider: 'firstParty', subscriptionType: 'max' },
        };
      },
      close: () => child.stdin.end(),
      async *[Symbol.asyncIterator]() {
        for await (const _message of prompt)
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            usage: { input_tokens: 0, output_tokens: 0 },
            total_cost_usd: 0,
          };
      },
    };
  };
  return { adapter: new ClaudeAdapter(binary, 'test', query as never), exits, children };
}

describe('Claude owned process', () => {
  it.each(['cancel', 'close'] as const)(
    'records process start time and waits for exit before confirming %s',
    async (method) => {
      const f = ownedQuery();
      const handle = await f.adapter.start(spec, () => {});
      try {
        const identity = handle.process_identity!;
        expect(identity).toMatchObject({
          pid: expect.any(Number),
          start_time_us: expect.any(Number),
        });
        expect(identity).toEqual(readProcessIdentity(identity.pid));
        expect(await f.adapter.inspect(handle)).toMatchObject({ process_identity: identity });
        expect(f.exits).toEqual([]);
        const receipt = await f.adapter[method](handle, Date.now() + 1000);
        expect(f.exits).toEqual([{ code: 0, signal: null }]);
        expect(receipt).toMatchObject({
          stopped: true,
          evidence: {
            method: 'process_group',
            members: [identity],
            exits: [{ pid: identity.pid, code: 0, signal: null }],
          },
        });
        expect((await f.adapter.inspect(handle)).state).toBe('exited');
      } finally {
        await f.adapter.close(handle, Date.now() + 1000);
      }
    },
  );

  it('does not confirm an expired stop deadline until the child exit is observed', async () => {
    const f = ownedQuery();
    const handle = await f.adapter.start(spec, () => {});
    try {
      expect(await f.adapter.close(handle, Date.now() - 1)).toMatchObject({
        stopped: false,
        reason: expect.any(String),
      });
      expect(f.exits).toEqual([]);
      expect(await f.adapter.close(handle, Date.now() + 1000)).toMatchObject({ stopped: true });
      expect(f.exits).toHaveLength(1);
    } finally {
      await f.adapter.close(handle, Date.now() + 1000);
    }
  });

  it('keeps one owned process with its exit evidence across sequential turns', async () => {
    const f = ownedQuery(),
      events: AgentEvent[] = [];
    const completions: (() => void)[] = [];
    const handle = await f.adapter.start(spec, (event) => {
      events.push(event);
      if (event.kind === 'turn.completed') completions.shift()?.();
    });
    try {
      const first = handle.process_identity;
      for (const turn_id of ['first', 'second']) {
        const done = new Promise<void>((resolve) => completions.push(resolve));
        await f.adapter.send(handle, { turn_id, input: 'hello' });
        await done;
      }
      expect(handle.process_identity).toEqual(first);
      expect(await f.adapter.close(handle, Date.now() + 1000)).toMatchObject({
        stopped: true,
        evidence: { members: [first], exits: [{ pid: first!.pid, code: 0, signal: null }] },
      });
      expect(f.exits).toHaveLength(1);
      expect(events.filter((event) => event.kind === 'turn.completed')).toHaveLength(2);
    } finally {
      await f.adapter.close(handle, Date.now() + 1000);
    }
  });

  it('stops what the CLI leaves running in its process group before confirming a stop', async () => {
    const leaving = path.join(root, 'leaving.cjs');
    writeFileSync(
      leaving,
      `#!${process.execPath}\nconst left = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });\nprocess.stdin.resume(); process.stdout.write('ready ' + left.pid + '\\n'); process.stdin.on('end', () => process.exit(0));`,
    );
    chmodSync(leaving, 0o755);
    let leftPid = 0;
    const query = ({ options }: { options: Options }) => {
      const child = options.spawnClaudeCodeProcess!({
        command: leaving,
        args: [],
        cwd: options.cwd,
        env: options.env!,
        signal: new AbortController().signal,
      });
      const ready = new Promise<void>((resolve) =>
        child.stdout.once('data', (data: Buffer) => {
          leftPid = Number(String(data).trim().split(' ')[1]);
          resolve();
        }),
      );
      return {
        initializationResult: async () => {
          await ready;
          return { account: { apiProvider: 'firstParty', subscriptionType: 'max' } };
        },
        close: () => child.stdin.end(),
        async *[Symbol.asyncIterator]() {},
      };
    };
    const adapter = new ClaudeAdapter(leaving, 'test', query as never);
    const handle = await adapter.start(spec, () => {});
    const alive = () => {
      try {
        process.kill(leftPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    const receipt = await adapter.close(handle, Date.now() + 3000);
    expect(alive()).toBe(false);
    expect(receipt).toMatchObject({
      stopped: true,
      evidence: { method: 'process_group', members: [handle.process_identity] },
    });
  });

  it('does not confirm a stop while a tool that left the process group still runs', async () => {
    const marker = `claude-escape-${randomUUID()}`;
    const escaping = path.join(root, 'escaping.cjs');
    writeFileSync(
      escaping,
      `#!${process.execPath}\nconst escaped = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', process.argv[2]], { detached: true, stdio: 'ignore' });\nescaped.unref();\nprocess.stdin.resume(); process.stdout.write('ready ' + escaped.pid + '\\n'); process.stdin.on('end', () => process.exit(0));`,
    );
    chmodSync(escaping, 0o755);
    let escapedPid = 0;
    const query = ({ options }: { options: Options }) => {
      const child = options.spawnClaudeCodeProcess!({
        command: escaping,
        args: [marker],
        cwd: options.cwd,
        env: options.env!,
        signal: new AbortController().signal,
      });
      const ready = new Promise<void>((resolve) =>
        child.stdout.once('data', (data: Buffer) => {
          escapedPid = Number(String(data).trim().split(' ')[1]);
          resolve();
        }),
      );
      return {
        initializationResult: async () => {
          await ready;
          return { account: { apiProvider: 'firstParty', subscriptionType: 'max' } };
        },
        close: () => child.stdin.end(),
        async *[Symbol.asyncIterator]() {},
      };
    };
    const adapter = new ClaudeAdapter(escaping, 'test', query as never);
    const handle = await adapter.start(spec, () => {});
    const escaped = readProcessIdentity(escapedPid);
    try {
      expect(escaped?.start_time_us).toEqual(expect.any(Number));
      expect(psField(escapedPid, 'ppid=')).toBe(String(handle.process_identity!.pid));
      const receipt = await adapter.close(handle, Date.now() + 3000);
      expect(receipt.stopped, 'a tool in its own session still runs').toBe(false);
      expect(receipt.reason).toBe('Descendants that left the process group are still running');
      expect((await adapter.close(handle, Date.now() + 1000)).stopped).toBe(false);
    } finally {
      const target = { pid: escapedPid, start_time_us: escaped?.start_time_us };
      console.log('Signal targets:', JSON.stringify([target]));
      if (
        target.start_time_us === undefined ||
        readProcessIdentity(target.pid)?.start_time_us !== target.start_time_us ||
        !psField(target.pid, 'command=').includes(marker)
      )
        throw new Error(`Cleanup aborted; ${target.pid} is not the process this test started`);
      process.kill(target.pid, 'SIGKILL');
    }
  });

  it('confirms a stop once a tool that left the process group has exited unreaped', async () => {
    const marker = `claude-unreaped-${randomUUID()}`;
    // After exec, node never waits for the backgrounded sleep, so it stays unreaped once it exits.
    const holder = spawn(
      'sh',
      [
        '-c',
        'sleep 1 & echo $!; exec "$0" -e "setTimeout(() => {}, 30000)" "$1"',
        process.execPath,
        marker,
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const holderIdentity = readProcessIdentity(holder.pid!);
    try {
      const exitedPid = await new Promise<number>((resolve) =>
        holder.stdout.once('data', (data: Buffer) => resolve(Number(String(data).trim()))),
      );
      const exited = readProcessIdentity(exitedPid)!;
      for (let tries = 0; !psField(exitedPid, 'stat=').startsWith('Z') && tries < 300; tries++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(psField(exitedPid, 'stat=')).toMatch(/^Z/);
      const f = ownedQuery();
      const handle = await f.adapter.start(spec, () => {});
      vi.mocked(descendants).mockReturnValueOnce([
        { pid: exitedPid, start_time_us: exited.start_time_us!, command: 'sleep 1' },
      ]);
      const receipt = await f.adapter.close(handle, Date.now() + 1000);
      expect(readProcessIdentity(exitedPid)?.start_time_us).toBe(exited.start_time_us);
      expect(receipt).toMatchObject({ stopped: true });
    } finally {
      const target = { pid: holder.pid!, start_time_us: holderIdentity?.start_time_us };
      console.log('Signal targets:', JSON.stringify([target]));
      if (
        target.start_time_us === undefined ||
        readProcessIdentity(target.pid)?.start_time_us !== target.start_time_us ||
        !psField(target.pid, 'command=').includes(marker)
      )
        throw new Error(`Cleanup aborted; ${target.pid} is not the process this test started`);
      process.kill(target.pid, 'SIGKILL');
    }
  });

  it('does not signal a group number none of the members an earlier stop saw still holds', async () => {
    const lingering = path.join(root, 'lingering.cjs');
    writeFileSync(
      lingering,
      `#!${process.execPath}\nconst tool = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' });\nprocess.stdin.resume(); process.stdout.write('ready ' + tool.pid + '\\n'); process.stdin.on('end', () => process.exit(0));`,
    );
    chmodSync(lingering, 0o755);
    let toolPid = 0;
    let cliExited: Promise<unknown> = Promise.resolve();
    const query = ({ options }: { options: Options }) => {
      const child = options.spawnClaudeCodeProcess!({
        command: lingering,
        args: [],
        cwd: options.cwd,
        env: options.env!,
        signal: new AbortController().signal,
      });
      cliExited = new Promise((resolve) => child.once('exit', resolve));
      const ready = new Promise<void>((resolve) =>
        child.stdout.once('data', (data: Buffer) => {
          toolPid = Number(String(data).trim().split(' ')[1]);
          resolve();
        }),
      );
      return {
        initializationResult: async () => {
          await ready;
          return { account: { apiProvider: 'firstParty', subscriptionType: 'max' } };
        },
        close: () => child.stdin.end(),
        async *[Symbol.asyncIterator]() {},
      };
    };
    const adapter = new ClaudeAdapter(lingering, 'test', query as never);
    const handle = await adapter.start(spec, () => {});
    const decoy = spawn(
      process.execPath,
      ['-e', "console.log('ready'); setInterval(() => {}, 1000)"],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const running = (pid: number) => /^[^Z]/.test(psField(pid, 'stat='));
    try {
      await new Promise((resolve) => decoy.stdout.once('data', resolve));
      // A deadline already passed leaves the group running with the CLI and its tool in it.
      expect((await adapter.close(handle, Date.now() - 1)).stopped).toBe(false);
      await cliExited;
      for (let tries = 0; running(toolPid) && tries < 300; tries++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(running(toolPid)).toBe(false);
      // Stands in for the group number passing to another group between the stops.
      Object.assign(handle.process_identity!, { pid: decoy.pid });

      const again = await adapter.close(handle, Date.now() + 1000);

      expect(running(decoy.pid!), 'the group that took over the number still runs').toBe(true);
      expect(again).toMatchObject({
        stopped: false,
        reason: 'Process group number may now belong to another process group',
      });
    } finally {
      // Still unreaped while its exit code is unset, so its pid is still its own.
      if (decoy.exitCode === null && decoy.signalCode === null) decoy.kill('SIGKILL');
    }
  });

  it('attaches observed exit evidence to a billing failure after spawning', async () => {
    const f = ownedQuery(true);
    await expect(f.adapter.start(spec, () => {})).rejects.toMatchObject({
      code: 'billing_channel_mismatch',
      message: 'API key channel',
      stop: {
        stopped: true,
        evidence: { method: 'process_group', exits: [expect.objectContaining({ code: 0 })] },
      },
    });
    expect(f.exits).toHaveLength(1);
  });
});
