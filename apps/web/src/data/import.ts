import { useEffect, useState } from 'react';
import type { ImportCandidates } from '@pantheon/protocol';
import { useQuery, type QueryState } from './workbench-sessions';

/** How soon the candidates are read again while the native history is still being indexed. */
const INDEXING_MS = 2_000;

const noParams = () => ({});
const acceptCandidates = (value: unknown): ImportCandidates | null => {
  const read = value as Partial<ImportCandidates> | null;
  return read && Array.isArray(read.candidates) && read.indexing !== undefined
    ? (read as ImportCandidates)
    : null;
};

/** GET /v1/import.candidates; read again every INDEXING_MS until indexing is null. */
export function useImportCandidates(): QueryState<ImportCandidates> {
  const [tick, setTick] = useState(0);
  const read = useQuery('import.candidates', 'all', noParams, acceptCandidates, tick, {}, true);
  const indexing = read.data?.indexing != null;
  useEffect(() => {
    if (!indexing || read.refreshing) return;
    const timer = setTimeout(() => setTick((n) => n + 1), INDEXING_MS);
    return () => clearTimeout(timer);
  }, [indexing, read.refreshing]);
  return read;
}
