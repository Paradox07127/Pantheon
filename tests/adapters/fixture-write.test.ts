import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FixtureAdapter } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';

describe('fixture write targets', () => {
  it.each([
    ['write', false],
    ['write', true],
    ['write_outside', false],
    ['write_outside', true],
  ] as const)('refuses a FIFO in %s with reader=%s', async (kind, hasReader) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'pantheon-fixture-fifo-')),
      target = path.join(cwd, 'target'),
      adapter = new FixtureAdapter(40, false, false, 100),
      events: AgentEvent[] = [],
      completed = Promise.withResolvers<void>();
    execFileSync('mkfifo', [target]);
    let reader = hasReader
      ? openSync(target, constants.O_RDONLY | constants.O_NONBLOCK)
      : undefined;
    const spec: SessionSpec = {
      platform_session_id: 'fifo-session',
      project_id: 'fifo-project',
      runtime: 'fixture',
      device_id: 'local',
      role: 'writer',
      cwd,
      env_allowlist: NATIVE_ENV_ALLOWLIST,
      skills: [],
      mcp_servers: [],
      budget: { max_turns: 1, wall_time_ms: 10000 },
    };
    const handle = await adapter.start(spec, (event) => {
      events.push(event);
      if (event.kind === 'turn.completed') completed.resolve();
    });
    try {
      await adapter.send(handle, {
        turn_id: 'fifo',
        input: `fixture-script\n${JSON.stringify([
          { [kind]: { path: kind === 'write' ? 'target' : target, text: 'blocked\n' } },
        ])}`,
      });
      const settled = await Promise.race([
        completed.promise.then(() => true),
        sleep(500).then(() => false),
      ]);
      expect(settled, 'the FIFO write did not settle without unblocking it').toBe(true);
      expect(events.find((event) => event.kind === 'tool.completed')).toMatchObject({ ok: false });
    } finally {
      // Release an old blocking open so a failing regression leaves no pinned worker.
      reader ??= openSync(target, constants.O_RDONLY | constants.O_NONBLOCK);
      await adapter.close(handle, Date.now() + 1000);
      closeSync(reader);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
