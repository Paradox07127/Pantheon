import type { MemoryRecord } from '@pantheon/domain';

const sameTask = (a: MemoryRecord['task'], b: MemoryRecord['task']) =>
  a?.id === b?.id && a?.lead_session_id === b?.lead_session_id && a?.generation === b?.generation;

/** The records of a key's history that are versions of the item: the same key in the same task. */
export function keyVersions<T extends MemoryRecord>(
  item: MemoryRecord,
  history: readonly T[],
): T[] {
  return history.filter((v) => v.key === item.key && sameTask(v.task, item.task));
}
