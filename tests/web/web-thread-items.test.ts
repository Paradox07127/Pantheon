import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const mock = vi.hoisted(() => ({
  board: {
    board: {
      sessions: [
        { id: 'session-main', runtime: 'claude', task: { lead_session_id: 'lead-1', id: 't1' } },
        { id: 'lead-1', runtime: 'codex' },
      ],
    },
    status: { state: 'live' },
    resync: 0,
  } as any,
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector({}), { getState: () => ({}) }),
}));
import type { DaemonEvent } from '@/data/sync';
import {
  buildTranscript,
  elapsedText,
  groupToolCalls,
  toolDuration,
  type SessionTurn,
  type ToolItem,
  type TranscriptItem,
} from '@/data/transcript';
import { durationText } from '@/screens/board/panels-model';
import { Items } from '@/screens/sessions/parts';
import { ThreadTurn } from '@/screens/sessions/SessionsScreen';
import { TraceSection, traceRows } from '@/screens/sessions/trace';
import { zh } from './i18n-setup.js';

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
  created_at = 1_000 + sequence,
): DaemonEvent => ({
  sequence,
  event_id: `event-${sequence}`,
  kind,
  aggregate_id,
  aggregate_revision: 1,
  project_id: 'project-a',
  causation_id: 'cause',
  created_at,
  payload,
});

const call = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id,
  name: 'Bash',
  input: { command: `run ${id}` },
  ...extra,
});
const text = (value: string): TranscriptItem => ({ kind: 'text', text: value });

describe('tool call groups', () => {
  it('folds two or more consecutive calls into one group', () => {
    const blocks = groupToolCalls([call('a'), call('b'), call('c')]);
    expect(blocks).toEqual([{ kind: 'group', calls: [call('a'), call('b'), call('c')] }]);
  });

  it('breaks the run at text between calls and leaves a lone call alone', () => {
    const blocks = groupToolCalls([call('a'), call('b'), text('so'), call('c')]);
    expect(blocks.map((b) => (b.kind === 'group' ? b.calls.map((c) => c.id) : b.kind))).toEqual([
      ['a', 'b'],
      'text',
      'tool',
    ]);
  });

  it('keeps items that are not calls in place', () => {
    expect(groupToolCalls([text('one'), call('a'), text('two')]).map((b) => b.kind)).toEqual([
      'text',
      'tool',
      'text',
    ]);
  });
});

describe('who sent a turn', () => {
  const header = (extra: Partial<SessionTurn>) => {
    const view = buildTranscript([turn('turn-1', extra)], []).turns[0]!;
    return renderToStaticMarkup(
      createElement(ThreadTurn, {
        view: { ...view, at: Date.UTC(2026, 10, 10, 2, 21) },
        folders: [],
        status: { kind: 'ended', tool: null, since: null },
        fresh: new Set<string>(),
        request: () => null,
        listed: null,
      }),
    );
  };

  it.each(['tracker', 'sync', 'baseline', 'continuation'] as const)(
    'shows a %s turn as a note from Pantheon, not a bubble of the user',
    (origin) => {
      const html = header({ origin, input: '[Pantheon] Task t1 reported done.' });
      expect(html).toMatch(/<div class="ss-sys" role="note">/);
      expect(html).toContain('<b>Pantheon</b>');
      expect(html).toContain('Task t1 reported done.');
      expect(html).not.toContain('[Pantheon]');
      expect(html).not.toContain('ss-user');
    },
  );

  it('shows a turn from the lead under the lead with its runtime, not a bubble of the user', () => {
    const html = header({ origin: 'lead', input: '[Lead] Rebase first.' });
    expect(html).toMatch(/<div class="ss-lead" role="note">/);
    expect(html).toContain('<b>lead</b>');
    expect(html).toContain('<title>Codex</title>');
    expect(html).toContain('Rebase first.');
    expect(html).not.toContain('[Lead]');
    expect(html).not.toContain('ss-user');
  });

  it('keeps the bubble for what the user sent', () => {
    const html = header({});
    expect(html).toContain('<div class="ss-user" data-find="input">input of turn-1</div>');
    expect(html).not.toContain('ss-sys');
    expect(html).not.toContain('ss-lead');
  });
});

describe('durations', () => {
  it('shows tenths of a second under a minute, then minutes and hours', () => {
    expect(elapsedText(0)).toBe('0.0 秒');
    expect(elapsedText(3_420)).toBe('3.4 秒');
    expect(elapsedText(59_940)).toBe('59.9 秒');
    expect(elapsedText(59_960)).toBe('1 分 00 秒');
    expect(elapsedText(125_000)).toBe('2 分 05 秒');
    expect(elapsedText(3_780_000)).toBe('1 时 03 分');
  });

  it.each([
    [0, '0.0 秒'],
    [187, '0.2 秒'],
    [29_000, '29.0 秒'],
    [59_940, '59.9 秒'],
    [59_960, '1 分'],
    [64_000, '1 分'],
    [3_780_000, '1 时 3 分'],
  ])('rounds %d ms to the coarse duration %s, in seconds under a minute', (ms, shown) => {
    expect(durationText(ms)).toBe(shown);
  });

  it('times a call from its start to its completion event', () => {
    const events = [
      event(1, 'agent.tool.started', 'session-main', {
        turn_id: 'turn-1',
        tool_call_id: 'call-a',
        name: 'Bash',
        input: { command: 'pnpm test' },
      }),
      event(
        2,
        'agent.tool.completed',
        'session-main',
        { turn_id: 'turn-1', tool_call_id: 'call-a', ok: true },
        4_400,
      ),
      event(3, 'agent.tool.started', 'session-main', {
        turn_id: 'turn-1',
        tool_call_id: 'call-b',
        name: 'Read',
      }),
    ];
    const [done, running] = buildTranscript([turn('turn-1')], events).turns[0]!.items as ToolItem[];
    expect(toolDuration(done!)).toBe(3_399);
    expect(toolDuration(running!)).toBeNull();
  });

  it('shows the duration and the summed duration of a group', () => {
    const items = [
      call('a', { started_at: 1_000, completed_at: 2_500, ok: true }),
      call('b', { started_at: 3_000, completed_at: 3_100, ok: true }),
    ];
    const html = renderToStaticMarkup(
      createElement(Items, {
        items,
        verbose: false,
        ended: true,
        folders: [],
        sessionId: 'session-main',
      }),
    );
    expect(html).toContain('运行 2 条命令');
    expect(html).toContain('1.6 秒');
    expect(html).not.toContain('run a');
  });
});

describe('answered requests', () => {
  const requested = (sequence: number, request_id: string, tool: string, detail: object) =>
    event(sequence, 'agent.permission.requested', 'session-main', {
      turn_id: 'turn-1',
      request_id,
      tool,
      detail,
    });
  const approval = (sequence: number, kind: string, request_id: string, extra: object) =>
    event(sequence, kind, `approval-${request_id}`, {
      session_id: 'session-main',
      kind: 'permission',
      request_id,
      ...extra,
    });

  const render = (events: DaemonEvent[]) => {
    const view = buildTranscript([turn('turn-1')], events).turns[0]!;
    return renderToStaticMarkup(
      createElement(Items, {
        items: view.items,
        verbose: false,
        ended: true,
        folders: [],
        sessionId: 'session-main',
      }),
    );
  };

  it('leaves a row with the tool, its argument and a denial with its reason', () => {
    const html = render([
      approval(1, 'approval.requested', 'req-1', { tool: 'WebFetch', state: 'pending' }),
      requested(2, 'req-1', 'WebFetch', { input: { url: 'https://docs.example.com/oauth' } }),
      approval(3, 'approval.rejected', 'req-1', {
        tool: 'WebFetch',
        state: 'rejected',
        decision_reason: '不要联网',
      }),
    ]);
    expect(html).toContain('WebFetch');
    expect(html).toContain('https://docs.example.com/oauth');
    expect(html).toContain('拒绝：不要联网');
    expect(html).not.toContain('permission.requested');
  });

  it('tells allowing once from allowing for the session', () => {
    const once = render([
      requested(1, 'req-1', 'Bash', { input: { command: 'pnpm build' } }),
      approval(2, 'approval.approved', 'req-1', { tool: 'Bash', state: 'approved' }),
    ]);
    expect(once).toContain(zh('data.transcript.outcome.approve'));
    const session = render([
      requested(1, 'req-1', 'Bash', { input: { command: 'pnpm build' } }),
      approval(2, 'approval.approved', 'req-1', {
        tool: 'Bash',
        state: 'approved',
        session_wide: true,
      }),
    ]);
    expect(session).toContain(zh('data.transcript.outcome.approveSession'));
  });

  it('leaves the question and its answer', () => {
    const question = '用哪种存储？';
    const html = render([
      requested(1, 'req-1', 'AskUserQuestion', {
        input: {},
        questions: [{ question, header: '', options: [], multiSelect: false }],
      }),
      approval(2, 'approval.approved', 'req-1', {
        tool: 'AskUserQuestion',
        state: 'approved',
        answers: { [question]: 'SQLite' },
      }),
    ]);
    expect(html).toContain(question);
    expect(html).toContain('SQLite');
  });

  it('leaves no row while the request waits', () => {
    const html = render([
      requested(1, 'req-1', 'Bash', { input: { command: 'rm -rf build' } }),
      approval(2, 'approval.requested', 'req-1', { tool: 'Bash', state: 'pending' }),
    ]);
    expect(html).not.toContain('rm -rf build');
  });
});

describe('trace and usage', () => {
  it('has one row per turn with its time, calls and tokens, and a total', () => {
    const turns = [
      turn('turn-1', { usage: { input_tokens: 1_200, output_tokens: 300 } }),
      turn('turn-2', { state: 'running', usage: { input_tokens: 800, output_tokens: 50 } }),
    ];
    const events = [
      event(1, 'turn.queued', 'turn-1', {}, 10_000),
      event(2, 'turn.running', 'turn-1', {}, 11_000),
      event(3, 'agent.tool.started', 'session-main', { turn_id: 'turn-1', tool_call_id: 'a' }),
      event(4, 'agent.tool.started', 'session-main', { turn_id: 'turn-1', tool_call_id: 'b' }),
      event(5, 'turn.completed', 'turn-1', {}, 16_000),
      event(6, 'turn.queued', 'turn-2', {}, 20_000),
      event(7, 'agent.tool.started', 'session-main', { turn_id: 'turn-2', tool_call_id: 'c' }),
    ];
    const { rows, total } = traceRows(buildTranscript(turns, events).turns);
    expect(rows).toEqual([
      { id: 'turn-1', started: 11_000, duration: 5_000, tools: 2, input: 1_200, output: 300 },
      { id: 'turn-2', started: 20_000, duration: null, tools: 1, input: 800, output: 50 },
    ]);
    expect(total).toEqual({ duration: 5_000, tools: 3, input: 2_000, output: 350 });
  });

  it('shows the waterfall with the table behind a toggle', () => {
    const view = buildTranscript([turn('turn-1')], []).turns;
    const html = renderToStaticMarkup(createElement(TraceSection, { turns: view, now: 0 }));
    expect(html).toMatch(/aria-label="Trace 瀑布/);
    expect(html).toContain('aria-label="表格视图"');
    expect(html).not.toContain('ss-trt');
  });

  it('names the trace for assistive tech without repeating the panel title on screen', () => {
    const view = buildTranscript([turn('turn-1')], []).turns;
    const html = renderToStaticMarkup(createElement(TraceSection, { turns: view, now: 0 }));
    expect(html).toMatch(new RegExp(`^<section[^>]* aria-label="${zh('sessions.parts.trace')}"`));
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/\bTrace\b/);
  });
});
