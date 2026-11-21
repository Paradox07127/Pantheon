import { describe, expect, it } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
import type { DaemonEvent } from '@/data/sync';
import { RECENT_MS, runtimeSessions, sessionFacts } from '@/screens/runtime/runtime-model';

const NOW = 10 * 60 * 60_000;
const iso = (at: number) => new Date(at).toISOString();

const listed = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: iso(0),
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: iso(0),
  changes: null,
  merge: null,
  ...extra,
});

const approval = (sequence: number, id: string, session: string, state: string): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind: state === 'pending' ? 'approval.requested' : 'approval.resolved',
  aggregate_id: id,
  aggregate_revision: sequence,
  project_id: 'project-a',
  causation_id: '',
  created_at: sequence,
  payload: { session_id: session, kind: 'permission', state, tool: 'Bash' },
});

describe('runtimeSessions', () => {
  const old = iso(NOW - RECENT_MS - 1);
  const recent = iso(NOW - RECENT_MS);
  const ids = (sessions: WorkbenchSession[], parents = new Map<string, string>()) =>
    runtimeSessions(sessions, parents, NOW).map((s) => s.id);

  it('keeps the sessions live now and those active within the hour, in list order', () => {
    expect(
      ids([
        listed('merged-old', { state: 'merged', last_activity_at: old }),
        listed('merged-recent', { state: 'merged', last_activity_at: recent }),
        listed('waiting', { state: 'waiting', last_activity_at: old }),
        listed('starting', { state: 'starting', last_activity_at: old }),
        listed('running', { state: 'running', last_activity_at: old }),
        listed('merging', { state: 'merging', last_activity_at: old }),
        listed('idle-old', { last_activity_at: old }),
        listed('idle-fresh', { last_activity_at: iso(NOW - 1000) }),
      ]),
    ).toEqual(['merged-recent', 'waiting', 'starting', 'running', 'merging', 'idle-fresh']);
  });

  it('keeps the sessions that started a kept session, however long they were idle', () => {
    expect(
      ids(
        [
          listed('root', { last_activity_at: old }),
          listed('middle', { last_activity_at: old }),
          listed('leaf', { state: 'running' }),
          listed('other', { last_activity_at: old }),
        ],
        new Map([
          ['leaf', 'middle'],
          ['middle', 'root'],
          ['other', 'root'],
        ]),
      ),
    ).toEqual(['root', 'middle', 'leaf']);
  });

  it('keeps nothing without sessions', () => {
    expect(ids([])).toEqual([]);
  });
});

describe('sessionFacts', () => {
  it('takes the context and fork from the list and the oldest open permission from the events', () => {
    const facts = sessionFacts(
      [
        listed('asking', {
          waiting_kind: 'approval',
          waiting_request: { tool: 'Bash', detail: 'pnpm test' },
          run: { phase: 'waiting_approval', since: 5, wait: { reason: 'approval', since: 7 } },
          context: { used_tokens: 10, window_tokens: 100 },
          forked_from: { session_id: 'origin' },
        }),
        listed('quiet'),
      ],
      [
        approval(1, 'approval-done', 'asking', 'pending'),
        approval(2, 'approval-old', 'asking', 'pending'),
        approval(3, 'approval-new', 'asking', 'pending'),
        approval(4, 'approval-done', 'asking', 'approved'),
      ],
    );
    expect(facts.get('asking')).toEqual({
      context: { used_tokens: 10, window_tokens: 100 },
      forked: true,
      waiting: { kind: 'approval', summary: 'pnpm test', approval_id: 'approval-old', since: 7 },
    });
    expect(facts.get('quiet')).toEqual({ context: undefined, forked: false, waiting: undefined });
  });

  it('asks for input when every open request is a question, and waits on nothing without its event', () => {
    const question = listed('question', {
      waiting_kind: 'question',
      waiting_request: { tool: 'AskUserQuestion' },
      last_activity_at: iso(NOW),
    });
    expect(
      sessionFacts([question], [approval(1, 'ask', 'question', 'pending')]).get('question'),
    ).toMatchObject({
      waiting: { kind: 'input', summary: 'AskUserQuestion', approval_id: 'ask', since: NOW },
    });
    expect(sessionFacts([question], []).get('question')?.waiting).toBeUndefined();
  });
});
