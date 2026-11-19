import { useCallback, useEffect, useState } from 'react';
import type { PlaybookSections } from '@pantheon/domain';
import {
  command,
  USER_PRINCIPAL_ID,
  type BridgeResult,
  type PlaybookRead,
} from '@pantheon/protocol';
import { useBoard } from './board';
import { runCommand } from './commands';
import { failureText } from './needs-you';
import { useRefetchTick } from './workbench-sessions';

export type { PlaybookRead, PlaybookSections };

/** The sections in the order the lead's instructions hold them. */
export const SECTIONS = [
  'before_you_plan',
  'routing',
  'replies',
] as const satisfies readonly (keyof PlaybookSections)[];

/** The project's default playbook without runtime, or one runtime's; with version, that stored version. */
export interface PlaybookKey {
  project_id: string;
  runtime: string | null;
  version?: number;
}

const inputOf = (key: PlaybookKey) =>
  JSON.stringify({
    project_id: key.project_id,
    ...(key.runtime === null ? {} : { runtime: key.runtime }),
    ...(key.version === undefined ? {} : { version: key.version }),
  });

/** playbook.get, read again after the project's playbook changes; reads nothing without a key. */
export function usePlaybook(key: PlaybookKey | null) {
  const projectId = key?.project_id ?? null;
  const sequence = useBoard(
    (s) =>
      s.events.findLast((e) => e.kind === 'playbook.changed' && e.project_id === projectId)
        ?.sequence ?? 0,
  );
  const tick = useRefetchTick(sequence, false);
  const [attempt, setAttempt] = useState(0);
  const input = key && inputOf(key);
  const [state, setState] = useState<{
    input: string | null;
    read: PlaybookRead | null;
    error: string | null;
  }>({ input: null, read: null, error: null });
  useEffect(() => {
    if (!input) return;
    let current = true;
    const bridge = window.pantheon;
    // A read: unlike runCommand it does not refresh the board afterwards.
    void (
      bridge
        ? bridge.command(command(USER_PRINCIPAL_ID, 'playbook.get', JSON.parse(input)))
        : Promise.resolve<BridgeResult<unknown>>({
            ok: false,
            error: { code: 'bridge_unavailable', message: 'Desktop bridge unavailable' },
          })
    )
      .catch((error: unknown): BridgeResult<unknown> => ({
        ok: false,
        error: { code: 'ipc_failed', message: String(error) },
      }))
      .then((result) => {
        if (!current) return;
        setState(
          result.ok
            ? { input, read: result.value as PlaybookRead, error: null }
            : { input, read: null, error: failureText(result.error) },
        );
      });
    return () => {
      current = false;
    };
  }, [input, tick, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  /** Shows what a command returned until the next read. */
  const put = useCallback((read: PlaybookRead) => setState({ input, read, error: null }), [input]);
  const mine = state.input === input;
  return { read: mine ? state.read : null, error: mine ? state.error : null, reload, put };
}

/** Stores sections as the playbook's next version; version_conflict unless base_version is its current one. */
export const setPlaybook = (
  project_id: string,
  runtime: string | null,
  base_version: number,
  sections: PlaybookSections,
) =>
  runCommand(
    'playbook.set',
    { project_id, ...(runtime === null ? {} : { runtime }), base_version, sections },
    null,
  );

/** Deletes a runtime's own playbook, so its leads follow the project default again. */
export const removePlaybook = (project_id: string, runtime: string, base_version: number) =>
  runCommand('playbook.remove', { project_id, runtime, base_version }, null);
