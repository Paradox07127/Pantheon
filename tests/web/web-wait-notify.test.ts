import { describe, expect, it } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import { newlyWaiting, waitNotice } from '@/data/notifications';
import type { DaemonEvent } from '@/data/sync';
import { zh } from './i18n-setup.js';

const session = (id: string, state: WorkbenchSession['state'], title = `title of ${id}`) =>
  ({
    id,
    created_at: '2026-01-01T00:00:00.000Z',
    title,
    runtime: 'claude',
    model: null,
    effort: null,
    permission_mode: 'ask',
    workspace_id: `workspace-${id}`,
    workspace_kind: 'linked_worktree',
    state,
    waiting: state === 'waiting' ? 1 : 0,
    reconciling: false,
    stopping: false,
    last_activity_at: '2026-01-01T00:00:00.000Z',
    changes: null,
    merge: null,
  }) satisfies WorkbenchSession;

let sequence = 0;
const requested = (approval_id: string, payload: Record<string, unknown>): DaemonEvent => ({
  sequence: ++sequence,
  event_id: `event-${sequence}`,
  kind: 'approval.requested',
  aggregate_id: approval_id,
  aggregate_revision: 1,
  project_id: 'project',
  causation_id: '',
  created_at: sequence,
  payload: { id: approval_id, kind: 'permission', state: 'pending', ...payload },
});

const ids = (sessions: WorkbenchSession[]) => sessions.map((s) => s.id);

describe('wait notifications', () => {
  it('skips the sessions already waiting on the first list', () => {
    expect(newlyWaiting(null, [session('a', 'waiting'), session('b', 'running')])).toEqual([]);
  });

  it('picks only the sessions that entered waiting since the previous list', () => {
    const previous = [session('a', 'waiting'), session('b', 'running'), session('c', 'idle')];
    const next = [
      session('a', 'waiting'),
      session('b', 'waiting'),
      session('c', 'idle'),
      session('d', 'waiting'),
    ];
    expect(ids(newlyWaiting(previous, next))).toEqual(['b', 'd']);
  });

  it('notifies a session once per wait and again after it waits anew', () => {
    const first = [session('a', 'running')];
    const waiting = [session('a', 'waiting')];
    const answered = [session('a', 'running')];
    expect(ids(newlyWaiting(first, waiting))).toEqual(['a']);
    expect(ids(newlyWaiting(waiting, waiting))).toEqual([]);
    expect(ids(newlyWaiting(waiting, answered))).toEqual([]);
    expect(ids(newlyWaiting(answered, waiting))).toEqual(['a']);
  });

  it.each([
    [
      'titles the notice with the session and gives the wait reason as its body',
      session('a', 'waiting'),
      [requested('approval-1', { session_id: 'a', tool: 'Bash' })],
      {
        title: 'title of a',
        body: zh('data.notifications.reasonDetail')
          .replace('{reason}', zh('data.reason.permissionRequested'))
          .replace('{detail}', 'Bash'),
      },
    ],
    [
      'asks for the review of a baseline session with no request',
      { ...session('d', 'waiting', '摸底 11-02 09:18'), workspace_id: null, waiting: 0 },
      [],
      { title: '摸底 11-02 09:18', body: zh('data.notifications.baselinePending') },
    ],
    [
      'falls back to the plain reason and the short session name',
      session('session-c', 'waiting', ' '),
      [],
      {
        title: zh('data.transcript.sessionId').replace('{id}', 'session-'),
        body: zh('data.reason.permissionRequested'),
      },
    ],
  ])('%s', (_, waiting, events, notice) => {
    expect(waitNotice(waiting, events)).toEqual(notice);
  });

  it('gives the question as the body of an AskUserQuestion request', () => {
    const events = [
      requested('approval-2', {
        session_id: 'b',
        tool: 'AskUserQuestion',
        questions: [
          {
            question: 'Which package manager?',
            header: 'Tooling',
            options: [],
            multiSelect: false,
          },
        ],
      }),
    ];
    expect(waitNotice(session('b', 'waiting'), events).body).toBe('Which package manager?');
  });
});
