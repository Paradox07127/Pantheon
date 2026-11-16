import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DaemonEvent } from '@/data/sync';
import { buildTranscript, type SessionTurn, type TurnView } from '@/data/transcript';
import {
  arrivals,
  NO_ARRIVALS,
  pendingPermissions,
  threadIds,
  turnStatus,
  turnStatusSpoken,
  turnStatusText,
  unplacedPermissions,
} from '@/screens/sessions/model';
import { Items } from '@/screens/sessions/parts';
import { RequestSlot } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const turn = (id: string, extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id,
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-main',
  input: `input of ${id}`,
  kind: 'send',
  delivery: 'delivered',
  state: 'running',
  ...extra,
});

const event = (
  sequence: number,
  kind: string,
  aggregate_id: string,
  payload: unknown = {},
  created_at = 1_000 + sequence,
): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: sequence,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at,
  payload,
});

const view = (extra: Partial<TurnView> = {}): TurnView => ({
  turn: turn('turn-1'),
  at: 500,
  started_at: 1_000,
  ended_at: null,
  text: '',
  usage: null,
  end: null,
  items: [],
  ...extra,
});

describe('turn status line', () => {
  it('keeps the skeleton while the history loads', () => {
    expect(turnStatus(null, null).kind).toBe('loading');
    expect(turnStatusText(turnStatus(null, null), 0)).toBe('');
  });

  it('says a queued turn waits its turn, without a clock', () => {
    const status = turnStatus(view({ turn: turn('turn-1', { state: 'queued' }) }), null);
    expect(status.kind).toBe('queued');
    expect(turnStatusText(status, 99_000)).toBe(zh('sessions.model.status.queued'));
  });

  it('counts the seconds the agent thinks from the start of the turn', () => {
    const status = turnStatus(view(), null);
    expect(status.kind).toBe('thinking');
    expect(turnStatusText(status, 13_500)).toBe('思考中，12 秒');
    const reasoning = turnStatus(
      view({ items: [{ kind: 'reasoning', text: 'Look at the body.', summary: false }] }),
      null,
    );
    expect(reasoning.kind).toBe('thinking');
  });

  it('names the running tool and counts from the tool start', () => {
    const status = turnStatus(
      view({
        items: [
          { kind: 'tool', id: 'a', name: 'Read', input: {}, ok: true, started_at: 1_100 },
          { kind: 'tool', id: 'b', name: 'Bash', input: { command: 'ls' }, started_at: 2_000 },
        ],
      }),
      null,
    );
    expect(status.kind).toBe('tool');
    expect(turnStatusText(status, 36_000)).toBe('运行 Bash，34 秒');
  });

  it('thinks again once the tool completes and writes once text arrives', () => {
    const tool = { kind: 'tool', id: 'a', name: 'Bash', input: {}, ok: true, started_at: 1_100 };
    expect(turnStatus(view({ items: [tool as never] }), null).kind).toBe('thinking');
    const status = turnStatus(
      view({ text: 'Looking.', items: [tool as never, { kind: 'text', text: 'Looking.' }] }),
      null,
    );
    expect(status.kind).toBe('writing');
    expect(turnStatusText(status, 3_000)).toBe('输出中，2 秒');
  });

  it('counts the dispatched agents that finished while it waits for them', () => {
    const agent = (id: string, ok?: boolean) => ({
      kind: 'tool' as const,
      id,
      name: 'Task',
      input: { subagent_type: 'Explore' },
      started_at: 2_000,
      ...(ok === undefined ? {} : { ok }),
    });
    const status = turnStatus(
      view({
        items: [
          agent('a', true),
          agent('b', true),
          agent('c'),
          { kind: 'tool', id: 'd', name: 'Read', input: {}, parent: 'c', ok: true },
        ],
      }),
      null,
    );
    expect(status.kind).toBe('agents');
    expect(status.agents).toEqual({ done: 2, total: 3 });
    expect(turnStatusText(status, 5_000)).toBe('等子 agent，2 / 3，3 秒');
    const child = turnStatus(
      view({
        items: [agent('c'), { kind: 'tool', id: 'd', name: 'Bash', input: {}, parent: 'c' }],
      }),
      null,
    );
    expect(child.kind).toBe('tool');
  });

  it('asks for an approval or an answer while a request waits, without a clock', () => {
    const approval = turnStatus(view(), 'approval');
    expect(approval.kind).toBe('approval');
    expect(turnStatusText(approval, 99_000)).toBe(zh('sessions.thread.status.approval'));
    const question = turnStatus(view(), 'question');
    expect(turnStatusText(question, 99_000)).toBe(zh('sessions.thread.status.question'));
  });

  it('shows nothing once the turn ends', () => {
    expect(turnStatus(view({ end: { state: 'completed', error: null } }), 'approval').kind).toBe(
      'ended',
    );
    expect(turnStatus(view({ turn: turn('turn-1', { state: 'completed' }) }), null).kind).toBe(
      'ended',
    );
    expect(
      turnStatusText(turnStatus(view({ end: { state: 'failed', error: 'x' } }), null), 0),
    ).toBe('');
  });

  it('announces the kind of status and never the seconds', () => {
    expect(turnStatusSpoken(turnStatus(view(), null))).toBe(zh('sessions.model.status.working'));
    const tool = turnStatus(
      view({ items: [{ kind: 'tool', id: 'b', name: 'Bash', input: {}, started_at: 2_000 }] }),
      null,
    );
    expect(turnStatusSpoken(tool)).toBe(zh('sessions.model.status.working'));
    const writing = turnStatus(view({ items: [{ kind: 'text', text: 'Hi' }] }), null);
    expect(turnStatusSpoken(writing)).toBe(zh('sessions.model.status.working'));
    expect(turnStatusSpoken(turnStatus(view(), 'approval'))).toBe(
      zh('sessions.model.status.waiting'),
    );
    expect(turnStatusSpoken(turnStatus(view(), 'question'))).toBe(
      zh('sessions.model.status.waiting'),
    );
    expect(
      turnStatusSpoken(turnStatus(view({ turn: turn('turn-1', { state: 'queued' }) }), null)),
    ).toBe(zh('sessions.model.status.queued'));
    expect(
      turnStatusSpoken(turnStatus(view({ end: { state: 'completed', error: null } }), null)),
    ).toBe('');
  });
});

describe('new messages', () => {
  const delta = (sequence: number, text: string) =>
    event(sequence, 'agent.message.delta', 'session-main', { turn_id: 'turn-1', text });
  const tool = (sequence: number, id: string) =>
    event(sequence, 'agent.tool.started', 'session-main', {
      turn_id: 'turn-1',
      tool_call_id: id,
      name: 'Bash',
      input: { command: 'ls' },
    });
  const ids = (events: DaemonEvent[], turns = [turn('turn-1')]) =>
    threadIds(buildTranscript(turns, events), []);

  it('takes nothing as new before or at the first history load', () => {
    const waiting = arrivals(NO_ARRIVALS, null);
    expect(waiting.baseline).toBeNull();
    const loaded = arrivals(waiting, ids([delta(1, 'Hi'), tool(2, 'call-1')]));
    expect(loaded.baseline?.size).toBeGreaterThan(0);
    expect([...loaded.fresh]).toEqual([]);
  });

  it('takes ids that show up after the baseline as new and keeps them new', () => {
    const loaded = arrivals(NO_ARRIVALS, ids([delta(1, 'Hi')]));
    const next = arrivals(loaded, ids([delta(1, 'Hi'), tool(2, 'call-1')]));
    expect([...next.fresh]).toEqual(['tool:call-1']);
    const later = arrivals(next, ids([delta(1, 'Hi'), tool(2, 'call-1'), delta(3, 'Done')]));
    expect([...later.fresh]).toEqual(['tool:call-1', 'text:tool:call-1']);
  });

  it('keeps the id of a message whose text grows', () => {
    const loaded = arrivals(NO_ARRIVALS, ids([delta(1, 'Hi')]));
    const grown = arrivals(loaded, ids([delta(1, 'Hi'), delta(2, ' there')]));
    expect(grown).toBe(loaded);
  });

  it('takes a new turn as new', () => {
    const loaded = arrivals(NO_ARRIVALS, ids([delta(1, 'Hi')]));
    const sent = arrivals(loaded, ids([delta(1, 'Hi')], [turn('turn-1'), turn('turn-2')]));
    expect([...sent.fresh]).toEqual(['turn:turn-2']);
  });

  it('replays nothing when the session opens again or its history is rebuilt', () => {
    const events = [delta(1, 'Hi'), tool(2, 'call-1')];
    const reopened = arrivals(arrivals(NO_ARRIVALS, null), ids(events));
    expect([...reopened.fresh]).toEqual([]);
    const rebuilt = arrivals(reopened, ids([...events]));
    expect(rebuilt).toBe(reopened);
  });

  it('names a waiting card by its approval', () => {
    const pending = [{ id: 'approval-1', tool: 'Bash', revision: 1 }];
    expect(threadIds(buildTranscript([], []), pending)).toContain('approval:approval-1');
  });
});

describe('permission cards and their results', () => {
  const needs = { items: [], loading: false, error: null, reload: () => {} };
  const requested = (sequence: number) =>
    event(sequence, 'agent.permission.requested', 'session-main', {
      turn_id: 'turn-1',
      request_id: 'req-1',
      tool: 'Bash',
      detail: { input: { command: 'rm -rf build' } },
    });
  const approval = (sequence: number, kind: string, state: string) =>
    event(sequence, kind, 'approval-1', {
      session_id: 'session-main',
      kind: 'permission',
      request_id: 'req-1',
      tool: 'Bash',
      state,
    });

  const thread = (events: DaemonEvent[]) => {
    const transcript = buildTranscript([turn('turn-1')], events);
    const pending = pendingPermissions(events, 'session-main');
    const items = createElement(Items, {
      items: transcript.turns[0]!.items,
      verbose: false,
      ended: false,
      folders: [],
      sessionId: 'session-main',
      owner: 'turn-1',
      request: (item, enter) =>
        createElement(RequestSlot, {
          key: item.id,
          item,
          permission: pending.find((p) => p.request === item.id),
          needs,
          folders: [],
          enter,
        }),
    });
    return {
      html: renderToStaticMarkup(items),
      unplaced: unplacedPermissions(pending, transcript),
    };
  };

  it('ties a waiting card to its request and leaves it off the list below the thread', () => {
    const { html, unplaced } = thread([requested(1), approval(2, 'approval.requested', 'pending')]);
    expect(html).toContain('aria-label="权限请求 Bash"');
    expect(html).not.toContain('ss-resolved');
    expect(unplaced).toEqual([]);
  });

  it('shows one result row once the request is answered', () => {
    const { html, unplaced } = thread([
      requested(1),
      approval(2, 'approval.requested', 'pending'),
      approval(3, 'approval.approved', 'approved'),
    ]);
    expect(html.match(/class="ss-resolved/g)).toHaveLength(1);
    expect(html).not.toContain('权限请求');
    expect(unplaced).toEqual([]);
  });

  it('keeps a waiting card below the thread when its request is not in the transcript', () => {
    const events = [approval(1, 'approval.requested', 'pending')];
    const pending = pendingPermissions(events, 'session-main');
    expect(unplacedPermissions(pending, buildTranscript([turn('turn-1')], events))).toEqual(
      pending,
    );
  });
});
