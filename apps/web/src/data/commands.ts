import {
  command,
  USER_PRINCIPAL_ID,
  type BridgeResult,
  type CommandType,
} from '@pantheon/protocol';
import { recordAppError } from './app-errors';
import { useBoard } from './board';

export async function runCommand(
  type: CommandType,
  input: Record<string, unknown>,
  expected_revision: number | null,
): Promise<BridgeResult<unknown>> {
  const bridge = window.pantheon;
  if (!bridge)
    return {
      ok: false,
      error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
    };
  const result = await bridge
    .command(command(USER_PRINCIPAL_ID, type, input, expected_revision))
    .catch((error: unknown): BridgeResult<unknown> => ({
      ok: false,
      error: { code: 'ipc_failed', message: String(error) },
    }));
  // A timed-out command may still commit in the daemon, so the board decides what happened.
  if (result.ok || ['revision_conflict', 'command_timeout'].includes(result.error.code))
    useBoard.getState().refresh();
  if (!result.ok)
    recordAppError({
      source: 'command',
      command: type,
      input,
      code: result.error.code,
      message: result.error.message,
      ...(result.error.status === undefined ? {} : { status: result.error.status }),
      ...(result.error.details === undefined ? {} : { details: result.error.details }),
      ...(result.error.stack === undefined ? {} : { stack: result.error.stack }),
    });
  return result;
}
