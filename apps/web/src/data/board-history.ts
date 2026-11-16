import type { BoardHistory } from '@pantheon/protocol';
import { useBoard } from './board';
import { newest } from './board-view';
import { useQuery, useRefetchTick } from './workbench-sessions';

const acceptHistory = (value: unknown): BoardHistory | null =>
  Array.isArray((value as Partial<BoardHistory> | null)?.tasks) ? (value as BoardHistory) : null;

/** The project's whole task history; read again after the events that change the board view. */
export function useBoardHistory(
  projectId: string | null,
): ReturnType<typeof useQuery<BoardHistory>> {
  const sequence = useBoard((s) => (projectId ? (newest(s.events, projectId)?.sequence ?? 0) : 0));
  const resync = useBoard((s) => s.resync);
  const tick = useRefetchTick(sequence, false);
  return useQuery(
    'board.history',
    projectId,
    () => ({ project_id: projectId! }),
    acceptHistory,
    tick + resync,
    {},
    true,
  );
}
