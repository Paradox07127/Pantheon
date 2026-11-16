import { describe, expect, it } from 'vitest';
import type { BoardModel } from '@pantheon/protocol';
import { lastEditProgress } from '@/screens/board/edit-progress';

type Lead = NonNullable<BoardModel['leads']>[number];
type Edit = NonNullable<Lead['recent_edits']>[number];
const NOW = Date.UTC(2026, 10, 7, 12);

const lead = (session_id: string, recent_edits?: Edit[]): Lead => ({
  session_id,
  title: session_id,
  state: 'running',
  inbox: 0,
  updated_at: NOW,
  ...(recent_edits ? { recent_edits } : {}),
});
const edit = (id: string, created_at: number, rest: Partial<Edit> = {}): Edit => ({
  id,
  created_at,
  plan_written_at: null,
  lead_read_at: null,
  sessions_notified_at: null,
  ...rest,
});

describe('last sent edit progress', () => {
  it('follows the newest edit of all the leads through its four steps', () => {
    const leads = [
      lead('lead-a', [edit('older', NOW - 60_000, { plan_written_at: NOW - 50_000 })]),
      lead('lead-b', [
        edit('newest', NOW - 10_000, { plan_written_at: NOW - 9_000, lead_read_at: NOW - 5_000 }),
        edit('middle', NOW - 30_000),
      ]),
    ];
    expect(lastEditProgress(leads)).toEqual([
      { step: 'sent', at: NOW - 10_000 },
      { step: 'planned', at: NOW - 9_000 },
      { step: 'read', at: NOW - 5_000 },
      { step: 'notified', at: null },
    ]);
  });

  it('marks every step the edit has reached', () => {
    const all = edit('done', NOW - 10_000, {
      plan_written_at: NOW - 9_000,
      lead_read_at: NOW - 8_000,
      sessions_notified_at: NOW - 7_000,
    });
    expect(lastEditProgress([lead('lead', [all])])!.map((s) => s.at)).toEqual([
      NOW - 10_000,
      NOW - 9_000,
      NOW - 8_000,
      NOW - 7_000,
    ]);
    expect(lastEditProgress([lead('lead', [edit('just sent', NOW)])])!.map((s) => s.at)).toEqual([
      NOW,
      null,
      null,
      null,
    ]);
  });

  it('gives nothing without a recent edit', () => {
    expect(lastEditProgress(undefined)).toBeNull();
    expect(lastEditProgress([])).toBeNull();
    expect(lastEditProgress([lead('lead'), lead('other', [])])).toBeNull();
  });
});
