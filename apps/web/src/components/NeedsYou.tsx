import type { WorkbenchSession } from '@pantheon/protocol';

/** The sessions waiting on a permission request or a question. */
export const waitingSessions = (sessions: readonly WorkbenchSession[]): WorkbenchSession[] =>
  sessions.filter((s) => s.state === 'waiting');
