import type { BoardModel } from '@pantheon/protocol';

export type EditStep = 'sent' | 'planned' | 'read' | 'notified';

/** The newest recent user edit of any lead, step by step; at is null until it reaches the step. */
export function lastEditProgress(
  leads: BoardModel['leads'],
): { step: EditStep; at: number | null }[] | null {
  const edits = (leads ?? []).flatMap((lead) => lead.recent_edits ?? []);
  if (!edits.length) return null;
  const last = edits.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  return [
    { step: 'sent', at: last.created_at },
    { step: 'planned', at: last.plan_written_at },
    { step: 'read', at: last.lead_read_at },
    { step: 'notified', at: last.sessions_notified_at },
  ];
}
