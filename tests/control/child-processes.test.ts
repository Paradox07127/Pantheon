import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { expect, it, vi, type MockInstance } from 'vitest';
import {
  recoverChildProcesses,
  trackChildProcess,
} from '../../packages/control/dist/child-processes.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { workbenchFixture } from './workbench-fixture.js';

const pid = 4000001,
  started = 1700000000123456;

it.each<[string, (read: MockInstance<ControlContext['readProcess']>) => unknown, boolean]>([
  [
    'does not kill a reused pid from a recorded process even within the same second',
    (read) => read.mockReturnValue({ pid, start_time_us: started + 1 }),
    false,
  ],
  [
    'reaps an exactly matching recorded process even if its session was already removed',
    (read) => read.mockReturnValueOnce({ pid, start_time_us: started }).mockReturnValue(undefined),
    true,
  ],
])('%s', (_name, reads, killed) => {
  const f = workbenchFixture();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  f.store.remember('gate-process:session-deleted:workspace', '', {
    pid,
    started,
    precision: 'microseconds',
  });
  reads(vi.spyOn(ctx, 'readProcess'));
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  f.store.transaction(() => recoverChildProcesses(ctx));
  if (killed) expect(kill).toHaveBeenCalledWith(-pid, 'SIGKILL');
  else expect(kill).not.toHaveBeenCalled();
  expect(
    f.store.db.prepare("SELECT source_key FROM inbox WHERE source_key GLOB 'gate-process:*'").all(),
  ).toEqual([]);
});

it('rechecks the identity before stopping a tracked live process', () => {
  const f = workbenchFixture();
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const read = vi.spyOn(ctx, 'readProcess').mockReturnValue({ pid, start_time_us: started });
  const child = Object.assign(new EventEmitter(), { pid }) as unknown as ChildProcess;
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const stop = trackChildProcess(ctx, 'gate-process:owned:workspace', child, () => {});
  read.mockReturnValue({ pid, start_time_us: started + 1 });
  stop();
  expect(kill).not.toHaveBeenCalled();
  child.emit('close');
});
