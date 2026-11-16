import { readProcessIdentity } from '@pantheon/adapters';
import { requireThat, type ProcessIdentity, type Session } from '@pantheon/domain';
import type { ControlContext } from './context.js';

export function readProcess(pid: number): ProcessIdentity | undefined {
  try {
    return readProcessIdentity(pid);
  } catch {
    requireThat(
      false,
      'termination_unconfirmed',
      'Process table could not confirm the old execution',
    );
  }
}

export function confirmTermination(ctx: ControlContext, session: Session): void {
  const identity = session.process_identity;
  requireThat(
    identity && Number.isSafeInteger(identity.pid) && identity.pid > 0,
    'termination_unconfirmed',
    'No stored process identity can confirm termination',
  );
  let current: ProcessIdentity | undefined;
  try {
    current = ctx.readProcess(identity.pid);
  } catch {
    requireThat(false, 'termination_unconfirmed', 'Process table could not confirm termination');
  }
  // Stored identities may hold whole seconds from ps. Subsecond differences cannot prove PID reuse.
  requireThat(
    !current ||
      (current.pid === identity.pid &&
        identity.start_time_us !== undefined &&
        current.start_time_us !== undefined &&
        Number.isFinite(identity.start_time_us) &&
        Number.isFinite(current.start_time_us) &&
        Math.floor(identity.start_time_us / 1000000) !==
          Math.floor(current.start_time_us / 1000000)),
    'termination_unconfirmed',
    'The old execution is still present or its termination is unconfirmed',
  );
  // Native processes lead their own group; members that outlive the leader keep its pid as group id.
  if (!current && process.platform !== 'win32') {
    let groupGone = false;
    try {
      process.kill(-identity.pid, 0);
    } catch (error) {
      groupGone = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    requireThat(
      groupGone,
      'termination_unconfirmed',
      'Processes of the old execution are still running',
    );
  }
}
