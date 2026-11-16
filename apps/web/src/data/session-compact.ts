import type { BridgeResult } from '@pantheon/protocol';
import { runCommand } from './commands';

/** Asks the session to compact its context now; empty instructions are left out. */
export const compactSession = (
  sessionId: string,
  instructions: string,
  revision: number,
): Promise<BridgeResult<unknown>> =>
  runCommand(
    'session.compact',
    { session_id: sessionId, ...(instructions ? { instructions } : {}) },
    revision,
  );
