import { describe, expect, it } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { waitingSessions } from '@/components/NeedsYou';

const session = (
  id: string,
  state: WorkbenchSession['state'],
  waiting = state === 'waiting' ? 1 : 0,
): WorkbenchSession => ({
  id,
  created_at: '2026-01-01T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state,
  waiting,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
});

describe('waiting sessions', () => {
  it('lists the sessions waiting on a request', () => {
    const sessions = [
      session('a', 'waiting', 2),
      session('b', 'running'),
      session('c', 'waiting', 1),
      session('d', 'idle'),
    ];
    expect(waitingSessions(sessions).map((s) => s.id)).toEqual(['a', 'c']);
  });
});
