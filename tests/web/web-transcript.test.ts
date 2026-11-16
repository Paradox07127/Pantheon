import { describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@/data/sync';
import { mergeEvents } from '@/data/logs';
import {
  buildTranscript,
  composeState,
  isQuietEvent,
  isSessionEvent,
  modelText,
  sessionTitle,
  toolState,
  type Session,
  type SessionTurn,
} from '@/data/transcript';
import { zh } from './i18n-setup.js';

const session = (id: string, state: Session['state'], extra: Partial<Session> = {}): Session => ({
  id,
  revision: 1,
  project_id: 'project-a',
  runtime: 'fixture',
  state,
  turn_count: 0,
  ...extra,
});

const turn = (id: string, extra: Partial<SessionTurn> = {}): SessionTurn => ({
  id,
  revision: 1,
  project_id: 'project-a',
  session_id: 'session-main',
  input: `input of ${id}`,
  kind: 'send',
  delivery: 'delivered',
  state: 'completed',
  ...extra,
});

const event = (
  sequence: number,
  kind: string,
  aggregate_id: string,
  payload: unknown = {},
): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at: 1_000 + sequence,
  payload,
});

const delta = (sequence: number, turn_id: string, text: string) =>
  event(sequence, 'agent.message.delta', 'session-main', { turn_id, text });

describe('session events', () => {
  it('keeps one copy of an event that both the history read and the reconnected stream carry', () => {
    const history = [delta(1, 'turn-1', 'Hel'), delta(2, 'turn-1', 'lo')];
    // After a reconnect the stream replays from its cursor, so event 2 arrives again.
    const replayed = [delta(2, 'turn-1', 'lo'), delta(3, 'turn-1', '!')];
    const merged = mergeEvents(history, replayed);
    expect(merged.map((e) => e.event_id)).toEqual(['event-1', 'event-2', 'event-3']);
    expect(buildTranscript([turn('turn-1')], merged).turns[0]!.text).toBe('Hello!');
  });

  it('joins message deltas in sequence order whatever order they arrive in', () => {
    const events = [delta(7, 'turn-1', 'c'), delta(3, 'turn-1', 'a'), delta(5, 'turn-1', 'b')];
    expect(buildTranscript([turn('turn-1')], events).turns[0]!.text).toBe('abc');
  });

  it('puts each turn’s output, usage, delivery event and end state under that turn', () => {
    const turns = [turn('turn-1'), turn('turn-2', { kind: 'steer', state: 'failed' })];
    const events = [
      event(1, 'turn.queued', 'turn-1'),
      delta(2, 'turn-1', 'first'),
      event(3, 'agent.usage.updated', 'session-main', {
        turn_id: 'turn-1',
        input_tokens: 10,
        cost_source: 'unknown',
      }),
      event(4, 'turn.completed', 'turn-1', { error: undefined }),
      event(5, 'turn.queued', 'turn-2'),
      event(6, 'session.turn.delivery', 'turn-2', { delivery: 'failed', reason: 'unsupported' }),
      event(7, 'turn.failed', 'turn-2', { error: 'adapter refused' }),
      delta(8, 'turn-unknown', 'stray'),
      event(9, 'agent.tool.started', 'session-main', { turn_id: 'turn-2', name: 'Read' }),
    ];
    const { turns: views, loose } = buildTranscript(turns, events);
    expect(views[0]).toMatchObject({
      at: 1_001,
      text: 'first',
      usage: { input_tokens: 10 },
      end: { state: 'completed', error: null },
    });
    expect(views[1]).toMatchObject({
      at: 1_005,
      text: '',
      end: { state: 'failed', error: 'adapter refused' },
    });
    expect(views[1]!.items).toEqual([
      { kind: 'tool', id: '', name: 'Read', input: undefined, started_at: 1_009 },
    ]);
    expect(loose.text).toBe('stray');
    expect(loose.items).toEqual([{ kind: 'text', text: 'stray' }]);
  });

  it("takes a turn's key point from what the newest recap of that turn says happened", () => {
    const recapped = (sequence: number, extra: object) =>
      event(sequence, 'agent.session.recapped', 'session-main', {
        headline: 'Login fixed',
        happened: `happened ${sequence}`,
        at: 0,
        ...extra,
      });
    const { turns: views, loose } = buildTranscript(
      [turn('turn-1'), turn('turn-2')],
      [
        recapped(1, { turn_id: 'turn-1' }),
        recapped(2, { turn_id: 'turn-1' }),
        recapped(3, {}),
        event(4, 'agent.turn.summarized', 'session-main', { turn_id: 'turn-2', summary: 'old' }),
      ],
    );
    expect(views.map((view) => view.summary)).toEqual(['happened 2', undefined]);
    expect([...views[0]!.items, ...loose.items]).not.toContainEqual(
      expect.objectContaining({ kind: 'event' }),
    );
  });

  it('keeps the runtime quota out of the thread, with or without a turn', () => {
    const quota = (sequence: number, extra: object = {}) =>
      event(sequence, 'agent.quota.updated', 'session-main', {
        windows: [{ kind: 'five_hour', used_percent: 40 }],
        ...extra,
      });
    const { turns: views, loose } = buildTranscript(
      [turn('turn-1')],
      [quota(1), delta(2, 'turn-1', 'done'), quota(3), quota(4, { turn_id: 'turn-1' })],
    );
    expect(loose.items).toEqual([]);
    expect(views[0]!.items).toEqual([{ kind: 'text', text: 'done' }]);
  });

  it('ends a steer whose delivery failed with the failure reason', () => {
    const turns = [
      turn('turn-main', { state: 'running' }),
      turn('turn-steer', {
        kind: 'steer',
        delivery: 'failed',
        delivery_reason: 'steer unsupported',
        state: 'failed',
      }),
    ];
    const view = buildTranscript(turns, [
      event(1, 'turn.queued', 'turn-steer'),
      event(2, 'session.turn.delivery', 'turn-steer', {
        delivery: 'failed',
        reason: 'steer unsupported',
      }),
    ]);
    expect(view.turns[1]).toMatchObject({
      end: { state: 'failed', error: 'steer unsupported' },
      ended_at: 1_002,
    });
    expect(view.turns[0]!.end).toBeNull();
  });

  const started = (sequence: number, turn_id: string, id: string, extra: object = {}) =>
    event(sequence, 'agent.tool.started', 'session-main', {
      turn_id,
      tool_call_id: id,
      name: 'Bash',
      input: { command: `run ${id}` },
      native_type: 'assistant',
      ...extra,
    });
  const completed = (sequence: number, turn_id: string, id: string, extra: object = {}) =>
    event(sequence, 'agent.tool.completed', 'session-main', {
      turn_id,
      tool_call_id: id,
      ok: true,
      output: { content: `out ${id}` },
      ...extra,
    });

  it('keeps text, tool calls and other events of a turn in sequence order', () => {
    const events = [
      delta(1, 'turn-1', 'Let me '),
      delta(2, 'turn-1', 'look.'),
      started(3, 'turn-1', 'call-a'),
      event(4, 'agent.native', 'session-main', { turn_id: 'turn-1', native_type: 'hook_started' }),
      completed(5, 'turn-1', 'call-a'),
      delta(6, 'turn-1', 'Done.'),
      event(7, 'agent.usage.updated', 'session-main', { turn_id: 'turn-1', input_tokens: 1 }),
    ];
    const view = buildTranscript([turn('turn-1')], events).turns[0]!;
    expect(view.text).toBe('Let me look.Done.');
    expect(view.usage).toEqual({ turn_id: 'turn-1', input_tokens: 1 });
    expect(view.items.map((i) => i.kind)).toEqual(['text', 'tool', 'event', 'text']);
    expect(view.items[0]).toEqual({ kind: 'text', text: 'Let me look.' });
    expect(view.items[1]).toEqual({
      kind: 'tool',
      id: 'call-a',
      name: 'Bash',
      input: { command: 'run call-a' },
      output: { content: 'out call-a' },
      ok: true,
      started_at: 1_003,
      completed_at: 1_005,
    });
    expect(view.items[3]).toEqual({ kind: 'text', text: 'Done.' });
  });

  it('pairs completions with their starts by call id, whatever comes between', () => {
    const events = [
      started(1, 'turn-1', 'call-a'),
      started(2, 'turn-1', 'call-b'),
      completed(3, 'turn-1', 'call-b', { ok: false }),
      completed(4, 'turn-1', 'call-a'),
    ];
    const items = buildTranscript([turn('turn-1')], events).turns[0]!.items;
    expect(items.map((i) => (i.kind === 'tool' ? [i.id, i.ok] : i.kind))).toEqual([
      ['call-a', true],
      ['call-b', false],
    ]);
  });

  it('keeps a completion whose start is missing as a tool call of its own', () => {
    const items = buildTranscript([turn('turn-1')], [completed(1, 'turn-1', 'call-x')]).turns[0]!
      .items;
    expect(items).toEqual([
      {
        kind: 'tool',
        id: 'call-x',
        name: '',
        input: undefined,
        output: { content: 'out call-x' },
        ok: true,
        completed_at: 1_001,
      },
    ]);
  });

  it('tells a running call from one that got no result before its turn ended', () => {
    const [item] = buildTranscript([turn('turn-1')], [started(1, 'turn-1', 'call-a')]).turns[0]!
      .items;
    expect(item!.kind).toBe('tool');
    if (item!.kind !== 'tool') return;
    expect(toolState(item!, false)).toBe('running');
    expect(toolState(item!, true)).toBe('none');
    expect(toolState({ ...item!, ok: true }, true)).toBe('ok');
    expect(toolState({ ...item!, ok: false }, false)).toBe('failed');
  });

  it('notes the parent call of a subagent’s calls', () => {
    const events = [
      started(1, 'turn-1', 'call-task', { name: 'Task' }),
      started(2, 'turn-1', 'call-sub', { parent_tool_use_id: 'call-task' }),
      completed(3, 'turn-1', 'call-sub', { parent_tool_use_id: 'call-task' }),
      completed(4, 'turn-1', 'call-task'),
    ];
    const items = buildTranscript([turn('turn-1')], events).turns[0]!.items;
    expect(items.map((i) => (i.kind === 'tool' ? [i.id, i.parent] : i.kind))).toEqual([
      ['call-task', undefined],
      ['call-sub', 'call-task'],
    ]);
  });

  // Types starting with `agent.` are event kinds; the rest are native event types.
  it.each([
    [
      'hides hook, session start and extension events only when calls are collapsed',
      ['hook_started', 'hook_response', 'agent.session.started', 'agent.extensions.applied'],
      ['agent.error', 'agent.permission.requested'],
    ],
    [
      'hides native protocol frames and the auth check outside the trace',
      ['item/completed', 'thread/tokenUsage/updated', 'agent.auth.checked'],
      [],
    ],
    [
      'hides runtime notices the user cannot act on: fast mode availability and a generated title',
      ['agent.fast_mode.changed', 'agent.title.generated'],
      ['agent.context.compacted'],
    ],
    [
      'hides the turn start an ACP agent reports, which the turn header already shows',
      ['agent.turn.started'],
      ['agent.turn.completed'],
    ],
  ])('%s', (_, quiet, shown) => {
    const of = (type: string) =>
      type.startsWith('agent.')
        ? event(1, type, 'session-main')
        : event(1, 'agent.native', 'session-main', { native_type: type });
    for (const type of quiet) expect(isQuietEvent(of(type))).toBe(true);
    for (const type of shown) expect(isQuietEvent(of(type))).toBe(false);
  });

  it('hides MCP server start progress and keeps a failed start', () => {
    const startup = (status: string) =>
      event(1, 'agent.native', 'session-main', {
        native_type: 'mcpServer/startupStatus/updated',
        native: {
          method: 'mcpServer/startupStatus/updated',
          params: { name: 'pantheon', status, error: null },
        },
      });
    expect(isQuietEvent(startup('starting'))).toBe(true);
    expect(isQuietEvent(startup('ready'))).toBe(true);
    expect(isQuietEvent(startup('failed'))).toBe(false);
  });

  it('keeps a failed MCP server start only in the first turn that reports that server', () => {
    const failed = (sequence: number, turn_id: string, name: string) =>
      event(sequence, 'agent.native', 'session-main', {
        turn_id,
        native_type: 'mcpServer/startupStatus/updated',
        native: {
          method: 'mcpServer/startupStatus/updated',
          params: { name, status: 'failed', error: 'no pipe' },
        },
      });
    const view = buildTranscript(
      [turn('turn-1'), turn('turn-2')],
      [
        failed(1, 'turn-1', 'codex_app'),
        failed(2, 'turn-2', 'codex_app'),
        failed(3, 'turn-2', 'files'),
      ],
    );
    expect(view.turns.map((t) => t.items.length)).toEqual([1, 1]);
    expect(view.turns[1]!.items[0]).toMatchObject({ event: { event_id: 'event-3' } });
  });

  it('counts agent events of the session and events of its turns, nothing else', () => {
    const turnIds = new Set(['turn-1']);
    expect(isSessionEvent(delta(1, 'turn-1', 'x'), 'session-main', turnIds)).toBe(true);
    expect(isSessionEvent(event(2, 'turn.running', 'turn-1'), 'session-main', turnIds)).toBe(true);
    expect(isSessionEvent(event(3, 'turn.running', 'turn-9'), 'session-main', turnIds)).toBe(false);
    expect(isSessionEvent(event(4, 'project.gate_set', 'project-1'), 'session-main', turnIds)).toBe(
      false,
    );
  });
});

describe('sending to a session', () => {
  it('allows send and steer on an open session', () => {
    expect(composeState(session('s', 'open'))).toEqual({
      send: { enabled: true, reason: null },
      steer: { enabled: true, reason: null },
    });
  });

  it('allows only steer while a turn runs and says why send is off', () => {
    const state = composeState(session('s', 'running'));
    expect(state.steer.enabled).toBe(true);
    expect(state.send).toEqual({
      enabled: false,
      reason: zh('data.transcript.compose.turnRunning'),
    });
  });

  it.each(['closed', 'reconciling'] as const)('gives a reason for both on a %s session', (s) => {
    const state = composeState(session('s', s));
    for (const a of [state.send, state.steer]) {
      expect(a.enabled).toBe(false);
      expect(a.reason).toBeTruthy();
    }
  });

  it.each([
    ['being merged', { merge: { state: 'running' } }],
    ['being discarded', { stop_requested: { reason: 'user', at: 1, by: 'user' } }],
    ['finishing a rollback', { rollback_pending: { checkpoint: 'c', turn_id: 't' } }],
  ] as [string, Partial<Session>][])('gives a reason for both on a session %s', (_, extra) => {
    for (const s of ['open', 'running'] as const) {
      const state = composeState(session('s', s, extra));
      for (const a of [state.send, state.steer]) {
        expect(a.enabled).toBe(false);
        expect(a.reason).toBeTruthy();
      }
    }
  });
});

describe('session titles', () => {
  const context = {
    projects: [{ id: 'project-a', name: 'Alpha' }],
    session_turns: [
      { session_id: 'mine', input: 'Plan the billing rewrite' },
      { session_id: 'raw', input: '{"goal":"x"}' },
    ],
  };

  it('uses the native title without its project prefix', () => {
    const s = session('s', 'open', { native_title: 'Alpha · Fix flaky tests' });
    expect(sessionTitle(s, context)).toBe('Fix flaky tests');
  });

  it('removes a long project prefix before shortening the native title', () => {
    const name = 'A project whose name runs past the length of a title by itself alone, nearly';
    const s = session('s', 'open', { native_title: `${name} · Fix flaky tests` });
    expect(sessionTitle(s, { projects: [{ id: 'project-a', name }] })).toBe('Fix flaky tests');
  });

  it('uses the saved title before the native title and the first message', () => {
    const s = session('mine', 'open', {
      title: 'Billing rewrite',
      native_title: 'Alpha · Fix flaky tests',
    });
    expect(sessionTitle(s, context)).toBe('Billing rewrite');
  });

  it('names a baseline session in the interface language rather than by its native title', () => {
    const s = session('b', 'open', {
      baseline: { baseline_id: 'baseline-1' },
      native_title: 'Alpha · Baseline assessment',
    });
    expect(sessionTitle(s, context)).toBe('摸底');
  });

  it('falls back to the purpose and short id of a reviewer', () => {
    const reviewer = session('reviewer-session', 'open', { review_id: 'review-1' });
    expect(sessionTitle(reviewer, context)).toBe(
      zh('data.transcript.purposeId')
        .replace('{purpose}', zh('data.transcript.purpose.reviewer'))
        .replace('{id}', 'reviewer'),
    );
  });

  it('uses the first message for a conversation', () => {
    expect(sessionTitle(session('mine', 'open'), context)).toBe(
      zh('data.transcript.purposeGoal')
        .replace('{purpose}', zh('data.transcript.purpose.conversation'))
        .replace('{goal}', 'Plan the billing rewrite'),
    );
  });

  it('never titles a session with serialized input', () => {
    expect(sessionTitle(session('raw', 'open'), context)).toBe(
      zh('data.transcript.sessionId').replace('{id}', 'raw'),
    );
    const s = session('n', 'open', { native_title: '[{"type":"text"}]' });
    expect(sessionTitle(s, {})).not.toContain('{');
  });
});

describe('model identity', () => {
  it('keeps the requested and the reported model apart when they differ', () => {
    expect(modelText({ requested_model: 'opus', reported_model: 'sonnet' })).toBe(
      zh('data.transcript.model.differs')
        .replace('{requested}', 'opus')
        .replace('{reported}', 'sonnet'),
    );
    expect(modelText({ requested_model: 'opus', reported_model: 'opus' })).toBe(
      zh('data.transcript.model.reported').replace('{model}', 'opus'),
    );
    expect(modelText({ requested_model: 'opus' })).toBe(
      zh('data.transcript.model.unreported').replace('{requested}', 'opus'),
    );
    expect(modelText({})).toBe(zh('data.transcript.model.none'));
  });

  it('names a model by its display name, not the id the runtime takes', () => {
    const pro = '["deepseek-account","deepseek-v4-pro"]';
    const models = [
      {
        id: pro,
        label: 'DeepSeek-V4-Pro',
        resolved: 'DeepSeek-V4-Pro',
        permission_modes: [],
        efforts: [],
        default_effort: null,
        default: false,
      },
    ];
    expect(modelText({ requested_model: pro, reported_model: 'DeepSeek-V4-Pro' }, models)).toBe(
      zh('data.transcript.model.reported').replace('{model}', 'DeepSeek-V4-Pro'),
    );
    expect(modelText({ requested_model: pro }, models)).toBe(
      zh('data.transcript.model.unreported').replace('{requested}', 'DeepSeek-V4-Pro'),
    );
    expect(modelText({ requested_model: pro, reported_model: 'fake-flash' }, models)).toBe(
      zh('data.transcript.model.differs')
        .replace('{requested}', 'DeepSeek-V4-Pro')
        .replace('{reported}', 'fake-flash'),
    );
  });
});

describe('review sessions', () => {
  it('keeps a reviewer session read-only even when open', () => {
    const state = composeState(session('s', 'open', { review_id: 'review-1' }));
    expect(state.send.enabled).toBe(false);
    expect(state.steer.enabled).toBe(false);
    expect(state.send.reason).toBeTruthy();
  });

  it.each([
    ['open', 0, true],
    ['open', 3, true],
    ['open', 4, false],
    ['running', 1, false],
    ['closed', 1, false],
  ] as const)(
    'lets an analysis session that is %s after %i turns send: %s, and never steer',
    (state, turn_count, send) => {
      const blocked = { enabled: false, reason: zh('data.transcript.readOnly.runtimeReview') };
      const runtime_review = { from: 0, to: 1, evidence_hash: 'hash', created_at: 0 };
      expect(composeState(session('s', state, { runtime_review, turn_count }))).toEqual({
        send: send ? { enabled: true, reason: null } : blocked,
        steer: blocked,
      });
    },
  );
});
