import { expect, it, vi } from 'vitest';
import { FixtureAdapter } from '@pantheon/adapters';
import type { Session } from '@pantheon/domain';
import type { ControlContext } from '../../packages/control/src/context.js';
import { awaitWorkspaceReady, eventually, user } from '../helpers.js';
import { workbenchFixture } from './workbench-fixture.js';

async function setup() {
  const f = await workbenchFixture({ delay: 10 });
  const lead = await f.create('Plan a report');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await eventually(
    () =>
      f.store.must<Session>('sessions', lead.id).state === 'open' &&
      f.turns(lead.id).every((turn) => turn.state === 'completed'),
    () => f.control.tick(),
  );
  const emit = f.start.mock.calls[0]![1];
  let sequence = 1000;
  const quota = (windows: { window: string; used_percent: number; resets_at?: number }[]) =>
    emit({
      kind: 'quota.updated',
      windows,
      key: String(++sequence),
      provider_sequence: sequence,
    });
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  return { ...f, lead, quota, ctx };
}

it('shares the latest quota across sessions and retains it through a runtime status refresh', async () => {
  const f = await setup();
  const seenAt = f.store.now();
  vi.spyOn(f.store, 'now').mockReturnValue(seenAt);
  const reset = seenAt + 60000;
  f.quota([{ window: 'five_hour', used_percent: 92, resets_at: reset }]);
  const second = await f.create('Read the plan');
  await awaitWorkspaceReady(f.control, second.workspace_id!);
  await eventually(
    () => f.start.mock.calls.length === 2,
    () => f.control.tick(),
  );
  f.start.mock.calls[1]![1]({
    kind: 'quota.updated',
    key: 'weekly-quota',
    provider_sequence: 1000,
    windows: [{ window: 'seven_day', used_percent: 40, resets_at: reset + 60000 }],
  });
  const expected = {
    windows: [
      { window: 'five_hour', used_percent: 92, resets_at: reset },
      { window: 'seven_day', used_percent: 40, resets_at: reset + 60000 },
    ],
    seen_at: seenAt,
  };
  expect(await f.control.runtimeStatus(user)).toEqual([
    expect.objectContaining({ runtime: 'fixture', quota: expected }),
    expect.objectContaining({ runtime: 'claude' }),
    expect.objectContaining({ runtime: 'codex' }),
    expect.objectContaining({ runtime: 'opencode' }),
    expect.objectContaining({ runtime: 'grok' }),
    expect.objectContaining({ runtime: 'agy' }),
    expect.objectContaining({ runtime: 'dsh' }),
    expect.objectContaining({ runtime: 'muse' }),
    expect.objectContaining({ runtime: 'cursor' }),
    expect.objectContaining({ runtime: 'copilot' }),
    expect.objectContaining({ runtime: 'gemini' }),
    expect.objectContaining({ runtime: 'kilo' }),
    expect.objectContaining({ runtime: 'cline' }),
    expect.objectContaining({ runtime: 'qwen' }),
    expect.objectContaining({ runtime: 'kimi' }),
    expect.objectContaining({ runtime: 'goose' }),
    expect.objectContaining({ runtime: 'openhands' }),
    expect.objectContaining({ runtime: 'auggie' }),
    expect.objectContaining({ runtime: 'kiro' }),
    expect.objectContaining({ runtime: 'junie' }),
    expect.objectContaining({ runtime: 'devin' }),
    expect.objectContaining({ runtime: 'vibe' }),
    expect.objectContaining({ runtime: 'hermes' }),
    expect.objectContaining({ runtime: 'omp' }),
    expect.objectContaining({ runtime: 'codebuddy' }),
    expect.objectContaining({ runtime: 'droid' }),
    expect.objectContaining({ runtime: 'qoder' }),
  ]);
  Object.assign(f.adapter, {
    preflight: async () => ({
      installed: true,
      version: '1',
      min_version: null,
      version_ok: true,
      auth: { state: 'unknown' },
    }),
  });
  expect(await f.control.runtimeStatus(user, true)).toEqual([
    expect.objectContaining({ runtime: 'fixture', quota: expected }),
    expect.objectContaining({ runtime: 'claude' }),
    expect.objectContaining({ runtime: 'codex' }),
    expect.objectContaining({ runtime: 'opencode' }),
    expect.objectContaining({ runtime: 'grok' }),
    expect.objectContaining({ runtime: 'agy' }),
    expect.objectContaining({ runtime: 'dsh' }),
    expect.objectContaining({ runtime: 'muse' }),
    expect.objectContaining({ runtime: 'cursor' }),
    expect.objectContaining({ runtime: 'copilot' }),
    expect.objectContaining({ runtime: 'gemini' }),
    expect.objectContaining({ runtime: 'kilo' }),
    expect.objectContaining({ runtime: 'cline' }),
    expect.objectContaining({ runtime: 'qwen' }),
    expect.objectContaining({ runtime: 'kimi' }),
    expect.objectContaining({ runtime: 'goose' }),
    expect.objectContaining({ runtime: 'openhands' }),
    expect.objectContaining({ runtime: 'auggie' }),
    expect.objectContaining({ runtime: 'kiro' }),
    expect.objectContaining({ runtime: 'junie' }),
    expect.objectContaining({ runtime: 'devin' }),
    expect.objectContaining({ runtime: 'vibe' }),
    expect.objectContaining({ runtime: 'hermes' }),
    expect.objectContaining({ runtime: 'omp' }),
    expect.objectContaining({ runtime: 'codebuddy' }),
    expect.objectContaining({ runtime: 'droid' }),
    expect.objectContaining({ runtime: 'qoder' }),
  ]);
});
