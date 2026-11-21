import type { BoardSnapshot, CommandType } from '@pantheon/protocol';

export type SnapshotSession = BoardSnapshot['sessions'][number];

/** Runs one command; resolves to the failure text, or null once it went through. */
export type RunBoardCommand = (
  type: CommandType,
  input: Record<string, unknown>,
  expectedRevision: number | null,
) => Promise<string | null>;
