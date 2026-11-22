import { describe, expect, it } from 'vitest';
import type { WorkbenchSession } from '@pantheon/protocol';
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
  it('takes the context, the fork and the oldest open request from the list', () => {
    const facts = sessionFacts([
      listed('asking', {
        waiting_kind: 'approval',
        waiting_request: { id: 'approval-old', tool: 'Bash', detail: 'pnpm test' },
        run: { phase: 'waiting_approval', since: 5, wait: { reason: 'approval', since: 7 } },
        context: { used_tokens: 10, window_tokens: 100 },
        forked_from: { session_id: 'origin' },
      }),
      listed('quiet'),
    ]);
    expect(facts.get('asking')).toEqual({
      context: { used_tokens: 10, window_tokens: 100 },
      forked: true,
      waiting: { kind: 'approval', summary: 'pnpm test', approval_id: 'approval-old', since: 7 },
    });
    expect(facts.get('quiet')).toEqual({ context: undefined, forked: false, waiting: undefined });
  });

  it.each([
    ['every open request is a question', 'question'],
    ['a permission request waits after the question', 'approval'],
  ] as const)('asks for input on a question listed first, when %s', (_, waiting_kind) => {
    const asking = listed('asking', {
      waiting: 2,
      waiting_kind,
      waiting_request: { id: 'ask', tool: 'AskUserQuestion' },
      last_activity_at: iso(NOW),
    });
    expect(sessionFacts([asking]).get('asking')?.waiting).toEqual({
      kind: 'input',
      summary: 'AskUserQuestion',
      approval_id: 'ask',
      since: NOW,
    });
  });

  it('waits on nothing when the list names no request', () => {
    const asking = listed('asking', { waiting_kind: 'approval', last_activity_at: iso(NOW) });
    expect(sessionFacts([asking]).get('asking')?.waiting).toBeUndefined();
  });
});
