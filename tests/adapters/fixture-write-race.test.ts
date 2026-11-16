import { afterEach, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_ENV_ALLOWLIST, type AgentEvent, type SessionSpec } from '@pantheon/domain';
import { FixtureAdapter } from '../../packages/adapters/src/fixture.js';

const swap = vi.hoisted(() => ({ beforeOpen: undefined as ((file: string) => void) | undefined }));
vi.mock('node:fs/promises', async (actual) => {
  const real = await actual<typeof import('node:fs/promises')>();
  const open = ((file: Parameters<typeof real.open>[0], ...rest: unknown[]) => {
    swap.beforeOpen?.(String(file));
    return (real.open as (...args: unknown[]) => ReturnType<typeof real.open>)(file, ...rest);
  }) as typeof real.open;
  return { ...real, open, default: { ...real, open } };
});

const roots: string[] = [];
afterEach(() => {
  swap.beforeOpen = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pantheon-fixture-race-')));
  roots.push(root);
  const cwd = path.join(root, 'work'),
    elsewhere = path.join(root, 'elsewhere');
  mkdirSync(path.join(cwd, 'inner'), { recursive: true });
  mkdirSync(elsewhere);
  return { root, cwd, elsewhere };
}

const spec = (cwd: string, overrides: Partial<SessionSpec> = {}): SessionSpec => ({
  platform_session_id: 'race-session',
  project_id: 'race-project',
  runtime: 'fixture',
  device_id: 'local',
  role: 'writer',
  cwd,
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 10000 },
  ...overrides,
});

it.each(['write', 'write_outside'] as const)(
  'does not %s through a directory swapped for a link after its checks',
  async (kind) => {
    const { cwd, elsewhere } = layout();
    const adapter = new FixtureAdapter(40),
      events: AgentEvent[] = [];
    const handle = await adapter.start(
      spec(cwd, { sandbox: { writable_roots: [cwd], protected_entries: [] } }),
      (event) => events.push(event),
    );
    // Between the checks and the open, another process swaps the directory for a link outside.
    swap.beforeOpen = (file) => {
      if (path.basename(file) !== 'target') return;
      swap.beforeOpen = undefined;
      renameSync(path.join(cwd, 'inner'), path.join(cwd, 'checked'));
      symlinkSync(elsewhere, path.join(cwd, 'inner'));
    };
    try {
      await adapter.send(handle, {
        turn_id: 'race',
        input: `fixture-script\n${JSON.stringify([
          {
            [kind]: {
              path: kind === 'write' ? 'inner/target' : path.join(cwd, 'inner', 'target'),
              text: 'moved\n',
            },
          },
        ])}`,
      });
      await vi.waitFor(() =>
        expect(events.some((event) => event.kind === 'turn.completed')).toBe(true),
      );
      const outside = path.join(elsewhere, 'target');
      expect(existsSync(outside) ? readFileSync(outside, 'utf8') : '').toBe('');
      expect(events.find((event) => event.kind === 'tool.completed')).toMatchObject({ ok: false });
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  },
);

it('keeps the write sentinel on the file it opened when the name becomes a link', async () => {
  const { cwd, elsewhere } = layout();
  const outside = path.join(elsewhere, 'protected.txt');
  writeFileSync(outside, '');
  const adapter = new FixtureAdapter(600, true),
    events: AgentEvent[] = [];
  const handle = await adapter.start(spec(cwd), (event) => events.push(event));
  const output = path.join(cwd, 'fixture-output.txt');
  try {
    await adapter.send(handle, { turn_id: 'sentinel', input: 'write the sentinel' });
    await vi.waitFor(() => expect(readFileSync(output, 'utf8')).toContain('tick'), {
      timeout: 5000,
    });
    unlinkSync(output);
    symlinkSync(outside, output);
    await vi.waitFor(
      () => expect(events.some((event) => event.kind === 'turn.completed')).toBe(true),
      { timeout: 5000 },
    );

    expect(readFileSync(outside, 'utf8')).toBe('');
  } finally {
    await adapter.close(handle, Date.now() + 1000);
  }
});
