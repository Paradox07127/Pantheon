import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceIndex } from '@pantheon/control';
import type { Entity, Session, SessionTurn } from '@pantheon/domain';
import type { ProjectTrace } from '@pantheon/protocol';
import { fixture, user } from '../helpers.js';
import { git } from './workbench-fixture.js';
import { runGit } from '../../packages/control/dist/git.js';

// Passes every git command through, so a test can count the ones a query runs.
vi.mock('../../packages/control/dist/git.js', async (original) => {
  const git = await original<typeof import('../../packages/control/dist/git.js')>();
  return { ...git, runGit: vi.fn(git.runGit) };
});

const mainId = 'a3dfdf53-2ff2-4483-b589-5d7eba2b9dab';

const base = Date.parse('2026-01-01T12:00:00Z');
const at = (seconds: number) => base + seconds * 1000;
const iso = (seconds: number) => new Date(at(seconds)).toISOString();

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function traceFixture(withIndex = false) {
  const homes = mkdtempSync(path.join(os.tmpdir(), 'project-trace-'));
  cleanups.push(() => rmSync(homes, { recursive: true, force: true }));
  const claudeHome = path.join(homes, 'claude'),
    codexHome = path.join(homes, 'codex');
  const trace = withIndex
    ? new TraceIndex({
        file: path.join(homes, 'trace-cache.sqlite'),
        claudeHomes: [claudeHome],
        codexHomes: [codexHome],
      })
    : undefined;
  if (trace) cleanups.push(() => trace.close());
  let clock = base;
  const f = await fixture({ now: () => clock, controlOptions: trace ? { trace } : {} });
  cleanups.push(() => f.close());
  const record = (time: number, kind: string, entity: Entity, payload: unknown = {}) => {
    clock = time;
    return f.store.event(kind, entity, f.project.id, payload);
  };
  const session = (id: string, extra: Partial<Session> = {}) =>
    f.store.insert<Session>('sessions', {
      id,
      revision: 1,
      project_id: f.project.id,
      runtime: f.adapter.name,
      title: `Session ${id}`,
      state: 'open',
      turn_count: 0,
      ...extra,
    });
  /** A completed turn running from start to end. */
  const turn = (
    owner: Session,
    id: string,
    start: number,
    end: number,
    extra: Partial<SessionTurn> = {},
  ) => {
    const turn = f.store.insert<SessionTurn>('session_turns', {
      id,
      revision: 1,
      project_id: owner.project_id,
      session_id: owner.id,
      input: 'Check the project',
      kind: 'send',
      delivery: 'delivered',
      state: 'completed',
      ...extra,
    });
    record(start, 'turn.running', turn);
    record(end, 'turn.completed', turn);
    return turn;
  };
  const tool = (
    owner: Session,
    turnId: string,
    id: string,
    start: number,
    end: number,
    ok = true,
  ) => {
    record(start, 'agent.tool.started', owner, {
      kind: 'tool.started',
      key: `${id}:started`,
      provider_sequence: 1,
      turn_id: turnId,
      tool_call_id: id,
      name: 'Bash',
    });
    record(end, 'agent.tool.completed', owner, {
      kind: 'tool.completed',
      key: `${id}:completed`,
      provider_sequence: 2,
      turn_id: turnId,
      tool_call_id: id,
      ok,
    });
  };
  const write = (file: string, content: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  const query = (from?: string, to?: string, bucketMs?: number) =>
    f.control.projectTrace(user, f.project.id, from, to, bucketMs);
  /** Queries until the index has read every transcript. */
  const indexed = async (from?: string, to?: string) => {
    let result = await query(from, to);
    for (
      let round = 0;
      round < 50 && result.indexing!.done_files < result.indexing!.total_files;
      round += 1
    )
      result = await query(from, to);
    return result;
  };
  return {
    ...f,
    trace,
    claudeHome,
    codexHome,
    setClock: (time: number) => (clock = time),
    record,
    session,
    turn,
    tool,
    write,
    query,
    indexed,
  };
}

/** Two sessions of two turns each; the first turn of the first runs a passing and a failing tool. */
async function eventsFixture() {
  const f = await traceFixture();
  const first = f.session('first'),
    second = f.session('second');
  f.turn(first, 'first-turn-1', at(10), at(20), {
    usage: { input_tokens: 100, output_tokens: 20 },
  });
  f.tool(first, 'first-turn-1', 'passing-tool', at(12), at(14));
  f.tool(first, 'first-turn-1', 'failing-tool', at(16), at(18), false);
  f.turn(first, 'first-turn-2', at(30), at(40));
  f.turn(second, 'second-turn-1', at(15), at(25));
  f.turn(second, 'second-turn-2', at(50), at(60));
  f.setClock(at(100));
  return { ...f, first, second };
}

const turnOf = (trace: ProjectTrace, id: string) =>
  trace.lanes.flatMap((lane) => lane.turns).find((turn) => turn.id === id)!;

describe('project trace from the event log', () => {
  it('summarizes recorded tool inputs and preserves reported shell exit codes', async () => {
    const f = await traceFixture();
    const owner = f.session('tools');
    f.turn(owner, 'tools-turn', at(0), at(30));
    const calls = [
      {
        name: 'commandExecution',
        input: { command: 'x'.repeat(250) },
        summary: 'x'.repeat(200),
        output: { exitCode: 7 },
      },
      { name: 'WebSearch', input: { query: 'trace latency' }, summary: 'trace latency' },
      {
        name: 'Agent',
        input: { description: 'Inspect trace data', prompt: 'Long prompt' },
        summary: 'Inspect trace data',
      },
      { name: 'Read', input: { file_path: 'trace.ts' }, summary: 'trace.ts' },
      { name: 'fileChange', input: { changes: [{ path: 'trace.ts' }] }, summary: 'trace.ts' },
      { name: 'Bash', input: { command: 'true' }, summary: 'true', output: { exitCode: 0 } },
    ];
    for (const [index, call] of calls.entries()) {
      f.record(at(index + 1), 'agent.tool.started', owner, {
        tool_call_id: `call-${index}`,
        turn_id: 'tools-turn',
        name: call.name,
        input: call.input,
      });
      f.record(at(index + 2), 'agent.tool.completed', owner, {
        tool_call_id: `call-${index}`,
        turn_id: 'tools-turn',
        ok: true,
        output: call.output,
      });
    }
    const { spans } = await f.control.sessionTrace(user, f.project.id, owner.id);
    for (const [index, call] of calls.entries()) {
      const span = spans.find((span) => span.id === `call-${index}`)!;
      expect(span.input_summary).toBe(call.summary);
      expect(span.exit_code).toBe(call.output?.exitCode);
      expect(span).not.toHaveProperty('tokens');
      expect(span).not.toHaveProperty('retry_count');
      if (!call.summary) expect(span).not.toHaveProperty('input_summary');
      if (!call.output) expect(span).not.toHaveProperty('exit_code');
    }
  });

  it('names every file a recorded tool call gives', async () => {
    const f = await traceFixture();
    const owner = f.session('files');
    f.turn(owner, 'files-turn', at(0), at(30));
    const calls = [
      { name: 'fileChange', input: { changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } },
      { name: 'file_change', input: { changes: { 'c.ts': {}, 'd.ts': {} } } },
      { name: 'Edit', input: { file_path: 'e.ts' } },
      { name: 'Bash', input: { command: 'true' } },
    ];
    for (const [index, call] of calls.entries())
      f.record(at(index + 1), 'agent.tool.started', owner, {
        tool_call_id: `files-${index}`,
        turn_id: 'files-turn',
        name: call.name,
        input: call.input,
      });
    const { spans } = await f.control.sessionTrace(user, f.project.id, owner.id);
    expect(
      calls.map((_, index) => spans.find((span) => span.id === `files-${index}`)?.files),
    ).toEqual([['a.ts', 'b.ts'], ['c.ts', 'd.ts'], ['e.ts'], undefined]);
  });

  it('counts only consecutive identical calls started after a failed result in the same turn', async () => {
    const f = await traceFixture();
    const owner = f.session('retries');
    f.turn(owner, 'retry-turn', at(0), at(30));
    f.turn(owner, 'next-turn', at(31), at(50));
    const call = (
      id: string,
      second: number,
      input: object,
      ok: boolean,
      turn_id = 'retry-turn',
      name = 'Bash',
    ) => {
      f.record(at(second), 'agent.tool.started', owner, { tool_call_id: id, turn_id, name, input });
      f.record(at(second + 1), 'agent.tool.completed', owner, { tool_call_id: id, turn_id, ok });
    };
    call('failed', 1, { command: 'test', cwd: '/repo' }, false);
    call('different-input', 3, { command: 'other' }, true);
    call(
      'different-tool',
      5,
      { command: 'test', cwd: '/repo' },
      true,
      'retry-turn',
      'exec_command',
    );
    call('retry-failed', 7, { cwd: '/repo', command: 'test' }, false);
    call('retry-passed', 9, { command: 'test', cwd: '/repo' }, true);
    call('after-success', 11, { command: 'test', cwd: '/repo' }, true);
    call('next-turn-call', 32, { command: 'test', cwd: '/repo' }, true, 'next-turn');
    f.record(at(15), 'agent.tool.started', owner, {
      tool_call_id: 'parallel-failure',
      turn_id: 'retry-turn',
      name: 'Bash',
      input: { command: 'parallel' },
    });
    f.record(at(15), 'agent.tool.started', owner, {
      tool_call_id: 'parallel-call',
      turn_id: 'retry-turn',
      name: 'Bash',
      input: { command: 'parallel' },
    });
    f.record(at(15), 'agent.tool.completed', owner, {
      tool_call_id: 'parallel-failure',
      turn_id: 'retry-turn',
      ok: false,
    });
    const { spans } = await f.control.sessionTrace(user, f.project.id, owner.id);
    expect(spans.find((span) => span.id === 'retry-failed')).not.toHaveProperty('retry_count');
    expect(spans.find((span) => span.id === 'retry-passed')?.retry_count).toBe(1);
    for (const id of [
      'failed',
      'different-input',
      'different-tool',
      'after-success',
      'next-turn-call',
      'parallel-call',
    ])
      expect(spans.find((span) => span.id === id)).not.toHaveProperty('retry_count');
  });

  it('exposes reported turn cache reads and costs and omits unreported values', async () => {
    const f = await traceFixture();
    const owner = f.session('usage');
    f.turn(owner, 'reported', at(0), at(10), {
      usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 80, cost_usd: 0 },
    });
    f.turn(owner, 'unreported', at(11), at(20), { usage: { input_tokens: 20, output_tokens: 3 } });
    const { spans } = await f.control.sessionTrace(user, f.project.id, owner.id);
    expect(spans.find((span) => span.id === 'reported')).toMatchObject({
      tokens: { input: 100, output: 5, cache_read: 80 },
      cost_usd: 0,
    });
    expect(spans.find((span) => span.id === 'unreported')).not.toHaveProperty('cost_usd');
    expect(spans.find((span) => span.id === 'unreported')?.tokens).not.toHaveProperty('cache_read');
  });

  it('includes reported cost and tokens on project trace turns', async () => {
    const f = await traceFixture();
    const owner = f.session('usage-project');
    f.turn(owner, 'reported-cost', at(0), at(10), {
      usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 80, cost_usd: 0 },
    });
    f.turn(owner, 'missing-cost', at(11), at(20));
    const trace = await f.query(iso(0), iso(30));
    expect(turnOf(trace, 'reported-cost')).toMatchObject({
      cost_usd: 0,
      tokens: { input: 100, output: 5, cache_read: 80 },
    });
    expect(turnOf(trace, 'missing-cost')).not.toHaveProperty('cost_usd');
    expect(turnOf(trace, 'missing-cost')).not.toHaveProperty('tokens');
  });

  it('lists project tool calls newest first and filters the complete command', async () => {
    const f = await traceFixture();
    const owner = f.session('calls');
    f.turn(owner, 'calls-turn', at(0), at(30));
    const calls = [
      { name: 'Bash', input: { command: 'false' }, ok: false, output: { exitCode: 1 } },
      { name: 'Bash', input: { command: 'false' }, ok: true, output: { exitCode: 0 } },
      { name: 'Read', input: { file_path: '/repo/trace.ts' }, ok: true },
      { name: 'commandExecution', input: { command: 'x'.repeat(210) + 'needle' }, ok: true },
    ];
    for (const [index, call] of calls.entries()) {
      f.record(at(index * 2 + 1), 'agent.tool.started', owner, {
        tool_call_id: `listed-${index}`,
        turn_id: 'calls-turn',
        name: call.name,
        input: call.input,
      });
      f.record(at(index * 2 + 2), 'agent.tool.completed', owner, {
        tool_call_id: `listed-${index}`,
        ok: call.ok,
        output: call.output,
      });
    }
    const other = f.store.insert<Session>('sessions', {
      ...owner,
      id: 'foreign',
      project_id: 'other',
    });
    f.store.event('agent.tool.started', other, 'other', { tool_call_id: 'foreign', name: 'Bash' });
    const rows = await f.control.toolCalls(user, f.project.id, undefined, 3);
    expect(rows.map((row) => row.span_id)).toEqual(['listed-3', 'listed-2', 'listed-1']);
    expect(rows[1]).toMatchObject({
      session_id: owner.id,
      session_title: owner.title,
      turn_id: 'calls-turn',
      tool_name: 'Read',
      input_summary: '/repo/trace.ts',
      start: at(5),
      duration_ms: 1000,
      status: 'ok',
    });
    expect(rows[2]).toMatchObject({ exit_code: 0, retry_count: 1 });
    expect(rows[0]!.input_summary).toHaveLength(200);
    expect(
      (await f.control.toolCalls(user, f.project.id, 'needle')).map((row) => row.span_id),
    ).toEqual(['listed-3']);
    expect(
      (await f.control.toolCalls(user, f.project.id, 'Read')).map((row) => row.span_id),
    ).toEqual(['listed-2']);
    expect(await f.control.toolCalls(user, f.project.id, 'absent')).toEqual([]);
    await expect(
      f.control.toolCalls(
        { id: 'foreign', role: 'writer', session_id: 'foreign', project_id: 'other' },
        f.project.id,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('queries native tool commands and paths with consecutive retry counts after indexing', async () => {
    const f = await traceFixture(true);
    const command = 'x'.repeat(210) + 'needle';
    const row = (second: number, extra: object) =>
      JSON.stringify({
        cwd: f.projectRoot,
        sessionId: mainId,
        timestamp: iso(second),
        ...extra,
      });
    const start = (id: string, second: number, name: string, input: object) =>
      row(second, {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id, name, input }] },
      });
    const end = (id: string, second: number, ok: boolean) =>
      row(second, {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok }] },
        toolUseResult: { exitCode: ok ? 0 : 7 },
      });
    f.write(
      path.join(f.claudeHome, 'projects/-repo', `${mainId}.jsonl`),
      [
        row(0, {
          type: 'user',
          message: { content: 'Inspect native tools' },
          turnPosition: { turnIndex: 1 },
        }),
        start('native-failure', 1, 'Bash', { command }),
        end('native-failure', 2, false),
        start('native-retry', 3, 'Bash', { command }),
        end('native-retry', 4, false),
        start('native-read', 5, 'Read', { file_path: '/repo/trace.ts' }),
        end('native-read', 6, true),
        start('native-later', 7, 'Bash', { command }),
        end('native-later', 8, true),
        '',
      ].join('\n'),
    );
    f.setClock(at(20));
    await f.indexed(iso(0), iso(20));
    const native = await f.control.sessionTrace(user, f.project.id, `native:claude:${mainId}`);
    expect(native.spans.find((span) => span.id === 'native-later')).not.toHaveProperty(
      'retry_count',
    );
    const calls = await f.control.toolCalls(user, f.project.id, 'needle');
    expect(calls.map((call) => call.span_id)).toEqual([
      'native-later',
      'native-retry',
      'native-failure',
    ]);
    expect(calls[0]).not.toHaveProperty('retry_count');
    expect(calls[1]).toMatchObject({
      retry_count: 1,
      exit_code: 7,
      status: 'error',
      duration_ms: 1000,
    });
    expect(calls[0]!.input_summary).toHaveLength(200);
    expect(calls[0]!.session_id).toBe(`native:claude:${mainId}`);
    expect((await f.control.toolCalls(user, f.project.id, 'Read'))[0]!.input_summary).toBe(
      '/repo/trace.ts',
    );
  });

  it('returns duration percentiles, reported cache share and failures for a project window', async () => {
    const f = await traceFixture();
    const owner = f.session('diagnosis');
    for (let index = 0; index < 6; index++) {
      const id = `measured-${index}`;
      f.turn(owner, id, at(index * 10), at(index * 10 + index + 1), {
        usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 80 },
      });
      f.tool(owner, id, `measured-tool-${index}`, at(index * 10), at(index * 10 + 1), index !== 2);
    }
    const stats = await f.control.projectTraceStats(user, f.project.id, at(0), at(49));
    expect(stats).toEqual({
      turn_duration_p50_ms: 3000,
      turn_duration_p95_ms: 5000,
      tool_duration_p50_ms: 1000,
      tool_duration_p95_ms: 1000,
      cache_read_share: 0.8,
      failed_tool_calls: 1,
    });
    expect(await f.control.projectTraceStats(user, f.project.id, at(0), at(39))).toEqual({
      cache_read_share: 0.8,
      failed_tool_calls: 1,
    });
    expect(await f.control.projectTraceStats(user, f.project.id, at(60), at(70))).toEqual({
      failed_tool_calls: 0,
    });
  });

  it('reports duration percentiles and cache totals for the requested window', async () => {
    const f = await traceFixture();
    const owner = f.session('statistics');
    f.turn(owner, 'statistics-turn', at(0), at(50), {
      usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 80 },
    });
    for (let index = 0; index < 20; index++) {
      f.record(at(index + 1), 'agent.tool.started', owner, {
        tool_call_id: `timed-${index}`,
        turn_id: 'statistics-turn',
        name: 'Bash',
      });
      f.record(at(index + 2), 'agent.tool.completed', owner, {
        tool_call_id: `timed-${index}`,
        turn_id: 'statistics-turn',
        ok: true,
        duration_ms: (index + 1) * 100,
      });
    }
    f.tool(owner, 'statistics-turn', 'outside-window', at(40), at(49));
    const trace = await f.query(iso(0), iso(30));
    expect(trace.stats).toMatchObject({
      tool_duration_p50_ms: 1050,
      tool_duration_p95_ms: 1900,
      tokens: { cache_read: 80 },
    });
    expect(trace.lanes[0]!.stats).toMatchObject({
      tool_duration_p50_ms: 1050,
      tool_duration_p95_ms: 1900,
    });
    const empty = await f.query(iso(60), iso(70));
    expect(empty.stats).not.toHaveProperty('tool_duration_p50_ms');
    expect(empty.stats).not.toHaveProperty('tool_duration_p95_ms');
    expect(empty.stats.tokens).not.toHaveProperty('cache_read');
  });

  it('breaks down a managed request and a sub-threshold approval with independent work', async () => {
    const f = await traceFixture();
    const owner = f.session('first');
    const turn = f.turn(owner, 'turn', at(3), at(20));
    const second = f.session('second');
    f.turn(second, 'parallel-turn', at(5), at(8));
    f.record(at(0), 'turn.queued', turn);
    f.record(at(1), 'turn.prepare_started', turn);
    f.tool(owner, turn.id, 'gated-tool', at(4), at(10));
    f.tool(second, 'parallel-turn', 'independent-tool', at(5), at(8));
    const approval = { id: 'approval', revision: 1 };
    f.record(at(5), 'approval.requested', approval, {
      session_id: owner.id,
      turn_id: turn.id,
      tool_call_id: 'gated-tool',
    });
    f.record(at(7), 'approval.approved', approval, { decided_by: 'user' });
    f.record(at(8), 'approval.delivered', approval);
    f.record(at(21), 'session.gate_started', owner, { commit: 'commit' });
    f.record(at(23), 'session.gate_checked', owner, { commit: 'commit' });
    f.setClock(at(25));
    const time = (key?: string) => f.control.traceTime(user, f.project.id, key, iso(0), iso(25));
    expect(time(owner.id)).toMatchObject({
      wall_ms: 20_000,
      work_ms: 3_000,
      gate_ms: 2_000,
      turns: 1,
      operations: 1,
      gates: 1,
      wall: expect.arrayContaining([
        expect.objectContaining({ kind: 'approval', ms: 2_000 }),
        expect.objectContaining({ kind: 'delivery', ms: 1_000 }),
        expect.objectContaining({ kind: 'queue', ms: 3_000 }),
      ]),
    });
    expect(time()).toMatchObject({
      wall_ms: 20_000,
      work_ms: 6_000,
      turns: 2,
      wall: expect.arrayContaining([expect.objectContaining({ kind: 'parallel', ms: 3_000 })]),
    });
    expect(time().by_lane).toEqual({
      [owner.id]: time(owner.id),
      [second.id]: time(second.id),
    });
    const clipped = f.control.traceTime(user, f.project.id, owner.id, iso(6), iso(9));
    expect(clipped).toMatchObject({ wall_ms: 3_000, work_ms: 1_000 });
  });
  it('lists each session as a lane with its turns, tool calls, errors and active time', async () => {
    const f = await eventsFixture();
    const trace = await f.query(iso(0), iso(100));
    expect(trace).toMatchObject({ epoch: null, indexing: null, from: iso(0), to: iso(100) });
    expect(trace.lanes.map(({ lane }) => [lane.key, lane.source, lane.title])).toEqual([
      ['first', 'pantheon', 'Session first'],
      ['second', 'pantheon', 'Session second'],
    ]);
    expect(trace.stats).toEqual({
      sessions: 2,
      turns: 4,
      llm: 0,
      tool: 2,
      error: 1,
      tokens: { input: 100, output: 20 },
      // The other three turns ran without reporting usage.
      turns_without_usage: 3,
      tool_duration_p50_ms: 2000,
      tool_duration_p95_ms: 2000,
      // [10, 25] with both first turns, then [30, 40] and [50, 60].
      active_ms: 35_000,
      commits: 0,
    });
    expect(trace.lanes[0]!.stats).toMatchObject({ sessions: 1, turns: 2, tool: 2, error: 1 });
    expect(trace.lanes[0]!.stats.active_ms).toBe(20_000);
    expect(trace.lanes[1]!.stats).toMatchObject({ turns: 2, tool: 0, error: 0, active_ms: 20_000 });
  });

  it('leaves out a steer delivered into the running turn', async () => {
    const f = await eventsFixture();
    const steer = f.store.insert<SessionTurn>('session_turns', {
      id: 'first-steer',
      revision: 1,
      project_id: f.first.project_id,
      session_id: f.first.id,
      input: 'Also check the docs',
      kind: 'steer',
      delivery: 'delivered',
      state: 'completed',
    });
    f.record(at(13), 'turn.queued', steer);
    f.record(at(13), 'session.turn.delivery', steer, { delivery: 'delivered' });
    f.setClock(at(100));
    const trace = await f.query(iso(0), iso(100));
    expect(trace.lanes[0]!.turns.map((turn) => turn.id)).toEqual(['first-turn-1', 'first-turn-2']);
    expect(trace.stats.active_ms).toBe(35_000);
  });

  it('splits a turn into wait, tool and error segments that cover it without overlap', async () => {
    const f = await eventsFixture();
    const turn = turnOf(await f.query(iso(0), iso(100)), 'first-turn-1');
    expect(turn).toMatchObject({ start: at(10), end: at(20), status: 'ok' });
    expect(turn.segments).toEqual([
      { from: at(10), to: at(12), kind: 'wait' },
      { from: at(12), to: at(14), kind: 'tool' },
      { from: at(14), to: at(16), kind: 'wait' },
      { from: at(16), to: at(18), kind: 'error' },
      { from: at(18), to: at(20), kind: 'wait' },
    ]);
    expect(turn.segments[0]!.from).toBe(turn.start);
    expect(turn.segments.at(-1)!.to).toBe(turn.end);
    for (const [index, segment] of turn.segments.entries()) {
      expect(segment.from).toBeLessThan(segment.to);
      if (index > 0) expect(segment.from).toBe(turn.segments[index - 1]!.to);
    }
  });

  it('returns only the lanes and turns that intersect the window', async () => {
    const f = await eventsFixture();
    const trace = await f.query(iso(45), iso(70));
    expect(trace.lanes.map(({ lane }) => lane.key)).toEqual(['second']);
    expect(trace.lanes[0]!.turns.map((turn) => turn.id)).toEqual(['second-turn-2']);
    expect(trace.stats).toMatchObject({ sessions: 1, turns: 1, active_ms: 10_000 });
  });

  it('counts only the spans inside the window of a turn that crosses its start', async () => {
    const f = await eventsFixture();
    const trace = await f.query(iso(15), iso(100), 5000);
    expect(trace.lanes[0]!.turns.map((turn) => turn.id)).toEqual(['first-turn-1', 'first-turn-2']);
    const tools = trace.buckets.reduce((total, bucket) => total + bucket.tool, 0);
    expect(tools).toBe(1);
    expect(trace.stats).toMatchObject({ tool: 1, error: 1 });
    expect(trace.lanes[0]!.stats).toMatchObject({ tool: 1, error: 1 });
  });

  it('keeps the tool calls of a turn that ran for days before the window', async () => {
    const f = await traceFixture();
    const owner = f.session('long');
    const day = 24 * 60 * 60;
    f.turn(owner, 'long-turn', at(0), at(4 * day));
    f.tool(owner, 'long-turn', 'early-tool', at(10), at(12));
    f.setClock(at(5 * day));
    const trace = await f.query(iso(3 * day), iso(5 * day));
    expect(turnOf(trace, 'long-turn').segments).toContainEqual({
      from: at(10),
      to: at(12),
      kind: 'tool',
    });
  });

  it('counts each span once in the bucket of its start and widens buckets past the limit', async () => {
    const f = await eventsFixture();
    const trace = await f.query(iso(0), iso(100), 5000);
    expect(trace.buckets).toHaveLength(20);
    expect(trace.buckets[2]).toEqual({ at: at(10), llm: 0, tool: 1, error: 0 });
    expect(trace.buckets[3]).toEqual({ at: at(15), llm: 0, tool: 1, error: 1 });
    const sum = (buckets: ProjectTrace['buckets'], key: 'tool' | 'error') =>
      buckets.reduce((total, bucket) => total + bucket[key], 0);
    expect([sum(trace.buckets, 'tool'), sum(trace.buckets, 'error')]).toEqual([2, 1]);

    const week = 7 * 24 * 60 * 60;
    const wide = await f.query(iso(0), iso(week), 1000);
    expect(wide.buckets).toHaveLength(2000);
    expect(wide.buckets[1]!.at - wide.buckets[0]!.at).toBe(Math.ceil((week * 1000) / 2000));
    expect([sum(wide.buckets, 'tool'), sum(wide.buckets, 'error')]).toEqual([2, 1]);
  });

  it('returns the spans of one turn and refuses an unknown lane', async () => {
    const f = await eventsFixture();
    const trace = await f.control.sessionTrace(user, f.project.id, 'first', 'first-turn-1');
    expect(trace.lane).toMatchObject({ key: 'first', session_id: 'first', title: 'Session first' });
    expect(trace.spans.map((span) => span.id)).toEqual([
      'first-turn-1',
      'passing-tool',
      'failing-tool',
    ]);
    expect(trace.spans.every((span) => span.turn === 'first-turn-1')).toBe(true);
    expect(trace.spans.find((span) => span.id === 'failing-tool')).toMatchObject({
      parent: 'first-turn-1',
      status: 'error',
      timing: 'daemon',
      start: at(16),
      end: at(18),
    });
    const whole = await f.control.sessionTrace(user, f.project.id, 'first');
    expect(whole.spans).toHaveLength(4);
    await expect(f.control.sessionTrace(user, f.project.id, 'missing')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('gives no tokens to a turn whose runtime reported no token counts', async () => {
    const f = await traceFixture();
    const silent = f.session('silent');
    f.turn(silent, 'silent-turn', at(10), at(20), {
      usage: { input_tokens: 0, output_tokens: 0, context_tokens: 900, tokens_unreported: true },
    });
    f.turn(silent, 'counted-turn', at(30), at(40), {
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    f.setClock(at(100));
    const { spans } = await f.control.sessionTrace(user, f.project.id, 'silent');
    expect(spans.map((span) => [span.id, span.tokens])).toEqual([
      ['silent-turn', undefined],
      ['counted-turn', { input: 0, output: 0 }],
    ]);
  });

  it('counts the turns of the window whose tokens are unknown', async () => {
    const f = await traceFixture();
    const silent = f.session('silent');
    f.turn(silent, 'silent-turn', at(10), at(20), {
      usage: { input_tokens: 0, output_tokens: 0, context_tokens: 900, tokens_unreported: true },
    });
    f.turn(silent, 'counted-turn', at(30), at(40), {
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    f.setClock(at(100));
    const both = await f.query(iso(0), iso(100));
    expect(both.stats.tokens).toEqual({ input: 5, output: 1 });
    expect(both.stats.turns_without_usage).toBe(1);
    expect(both.lanes[0]!.stats.turns_without_usage).toBe(1);
    const counted = await f.query(iso(25), iso(100));
    expect(counted.stats).not.toHaveProperty('turns_without_usage');
  });

  it('gives zero tokens to a turn cancelled before it ran', async () => {
    const f = await traceFixture();
    const silent = f.session('silent');
    const queued = f.store.insert<SessionTurn>('session_turns', {
      id: 'queued-turn',
      revision: 1,
      project_id: silent.project_id,
      session_id: silent.id,
      input: 'Check the project',
      kind: 'send',
      delivery: 'failed',
      state: 'cancelled',
    });
    f.record(at(10), 'turn.queued', queued);
    f.record(at(12), 'turn.cancelled', queued);
    f.setClock(at(100));
    const { spans } = await f.control.sessionTrace(user, f.project.id, 'silent');
    expect(spans.map((span) => [span.id, span.tokens])).toEqual([
      ['queued-turn', { input: 0, output: 0 }],
    ]);
  });
});

describe('project trace merged with native transcripts', () => {
  it('scans once for queries less than two seconds after a complete scan', async () => {
    const f = await traceFixture(true);
    const scan = vi.spyOn(f.trace!, 'scan');
    vi.useFakeTimers({ toFake: ['Date'] });
    cleanups.push(() => vi.useRealTimers());
    const first = await f.query();
    await f.query();
    await f.control.sessionTrace(user, f.project.id, 'missing').catch(() => undefined);
    await f.control.projectHeatmap(user, f.project.id, '7');
    expect(scan).toHaveBeenCalledTimes(1);
    expect((await f.query()).indexing).toEqual(first.indexing);
    vi.setSystemTime(Date.now() + 2001);
    await f.query();
    expect(scan).toHaveBeenCalledTimes(2);
  });
});

describe('project heatmap', () => {
  const local = (hour: number, minute = 0) => new Date(2026, 9, 30, hour, minute).getTime();

  function commitAt(cwd: string, time: number, message: string) {
    const date = `${Math.floor(time / 1000)} +0000`;
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        message,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Trace Fixture',
          GIT_AUTHOR_EMAIL: 'trace@example.invalid',
          GIT_COMMITTER_NAME: 'Trace Fixture',
          GIT_COMMITTER_EMAIL: 'trace@example.invalid',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
        stdio: 'ignore',
      },
    );
    return git(cwd, 'rev-parse', 'HEAD');
  }

  it('attributes commits through a merge and through Bash output, and counts them per day', async () => {
    const f = await traceFixture(true);
    const root = f.projectRoot;
    git(root, 'init', '-q');
    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
    git(root, 'add', 'a.txt');
    const unclaimed = commitAt(root, local(9), 'Add a');
    writeFileSync(path.join(root, 'a.txt'), 'one\nthree\n');
    git(root, 'add', 'a.txt');
    const merged = commitAt(root, local(10), 'Change a');
    writeFileSync(path.join(root, 'b.txt'), 'x\ny\nz\n');
    git(root, 'add', 'b.txt');
    const reported = commitAt(root, local(11), 'Add b');

    const session = f.session('merging');
    f.turn(session, 'merging-turn', local(9, 30), local(10, 30));
    f.record(local(10, 30), 'session.merged', session, {
      from_sha: unclaimed,
      to_sha: merged,
    });
    const nativeId = 'c0ffee00-0000-4000-8000-000000000001';
    const row = (time: number, extra: object) =>
      JSON.stringify({
        sessionId: nativeId,
        cwd: root,
        timestamp: new Date(time).toISOString(),
        ...extra,
      });
    f.write(
      path.join(f.claudeHome, 'projects/-repo', `${nativeId}.jsonl`),
      [
        row(local(11, 0), { type: 'user', message: { role: 'user', content: 'Commit b' } }),
        row(local(11, 1), {
          type: 'assistant',
          message: {
            model: 'claude-test',
            content: [
              { type: 'tool_use', id: 'toolu_commit', name: 'Bash', input: { command: 'git' } },
            ],
          },
        }),
        row(local(11, 2), {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_commit',
                content: `[main ${reported.slice(0, 7)}] Add b\n 1 file changed, 3 insertions(+)`,
              },
            ],
          },
        }),
        '',
      ].join('\n'),
    );
    f.setClock(new Date(2026, 9, 31, 12).getTime());
    await f.indexed(new Date(local(0)).toISOString());

    const heatmap = await f.control.projectHeatmap(user, f.project.id, '7');
    expect(heatmap.days).toEqual([
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
    ]);
    const external = `native:claude:${nativeId}`;
    expect(heatmap.commits).toEqual([
      {
        sha: unclaimed,
        at: local(9),
        day: '2026-10-30',
        lane_key: null,
        via: null,
        added: 2,
        removed: 0,
        subject: 'Add a',
      },
      {
        sha: merged,
        at: local(10),
        day: '2026-10-30',
        lane_key: 'merging',
        via: 'merge',
        added: 1,
        removed: 1,
        subject: 'Change a',
      },
      {
        sha: reported,
        at: local(11),
        day: '2026-10-30',
        lane_key: external,
        via: 'bash_output',
        added: 3,
        removed: 0,
        subject: 'Add b',
      },
    ]);
    const commitsOf = (key: string) =>
      heatmap.lanes.find((lane) => lane.key === key)!.cells.map((cell) => cell.commits);
    expect(heatmap.lanes.map((lane) => lane.key).sort()).toEqual([external, 'merging'].sort());
    expect(commitsOf('merging')).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(commitsOf(external)).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(heatmap.lanes.find((lane) => lane.key === external)!.cells[5]).toMatchObject({
      tool: 1,
      error: 0,
    });
  });

  it('lists each recorded merge of the days at its merge time, several of one session apart', async () => {
    const f = await traceFixture();
    const lead = f.session('lead'),
      worker = f.session('worker');
    const first = f.record(local(9), 'session.merged', lead, {
        direct: true,
        task_id: 'docs',
        to_sha: 'a',
      }),
      second = f.record(local(15), 'session.merged', lead, {
        direct: true,
        task_id: 'tests',
        to_sha: 'b',
      }),
      third = f.record(new Date(2026, 9, 31, 8).getTime(), 'session.merged', worker, {
        from_sha: 'b',
        to_sha: 'c',
      });
    f.record(new Date(2026, 9, 20, 8).getTime(), 'session.merged', worker, { to_sha: 'd' });
    f.setClock(new Date(2026, 9, 31, 12).getTime());
    const heatmap = await f.control.projectHeatmap(user, f.project.id, '7');
    expect(heatmap.merges).toEqual([
      { id: first.event_id, session_id: 'lead', at: local(9), day: '2026-10-30' },
      { id: second.event_id, session_id: 'lead', at: local(15), day: '2026-10-30' },
      {
        id: third.event_id,
        session_id: 'worker',
        at: new Date(2026, 9, 31, 8).getTime(),
        day: '2026-10-31',
      },
    ]);
  });

  it('reads the commit history again only once the refs change', async () => {
    const f = await traceFixture();
    const root = f.projectRoot;
    git(root, 'init', '-q');
    writeFileSync(path.join(root, 'a.txt'), 'one\n');
    git(root, 'add', 'a.txt');
    const first = commitAt(root, local(9), 'Add a');
    f.setClock(new Date(2026, 9, 31, 12).getTime());
    const logs = () => vi.mocked(runGit).mock.calls.filter(([, args]) => args[0] === 'log').length;
    const before = logs();
    await f.control.projectHeatmap(user, f.project.id, '7');
    const heatmap = await f.control.projectHeatmap(user, f.project.id, '7');
    expect(heatmap.commits.map((commit) => commit.sha)).toEqual([first]);
    expect(logs() - before).toBe(1);

    writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
    git(root, 'add', 'a.txt');
    const second = commitAt(root, local(10), 'Change a');
    const changed = await f.control.projectHeatmap(user, f.project.id, '7');
    expect(changed.commits.map((commit) => commit.sha)).toEqual([first, second]);
    expect(logs() - before).toBe(2);

    // A session worktree is detached, so its commits move no ref.
    const worktree = mkdtempSync(path.join(os.tmpdir(), 'heatmap-worktree-'));
    cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
    git(root, 'worktree', 'add', '-q', '--detach', worktree);
    writeFileSync(path.join(worktree, 'b.txt'), 'x\n');
    git(worktree, 'add', 'b.txt');
    const detached = commitAt(worktree, local(11), 'Add b');
    const moved = await f.control.projectHeatmap(user, f.project.id, '7');
    expect(moved.commits.map((commit) => commit.sha)).toEqual([first, second, detached]);
  });

  it('leaves Pantheon checkpoint commits out of the whole history', async () => {
    const f = await traceFixture();
    const root = f.projectRoot;
    git(root, 'init', '-q');
    writeFileSync(path.join(root, 'a.txt'), 'one\n');
    git(root, 'add', 'a.txt');
    const project = commitAt(root, local(9), 'Add a');
    const checkpoint = execFileSync(
      'git',
      ['commit-tree', `${project}^{tree}`, '-m', 'Pantheon checkpoint before turn'],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'Pantheon',
          GIT_AUTHOR_EMAIL: 'pantheon@localhost',
          GIT_COMMITTER_NAME: 'Pantheon',
          GIT_COMMITTER_EMAIL: 'pantheon@localhost',
          GIT_AUTHOR_DATE: '946684800 +0000',
          GIT_COMMITTER_DATE: '946684800 +0000',
        },
        encoding: 'utf8',
      },
    ).trim();
    git(root, 'update-ref', 'refs/pantheon/checkpoints/session/turn', checkpoint);
    f.setClock(new Date(2026, 9, 31, 12).getTime());

    const heatmap = await f.control.projectHeatmap(user, f.project.id, 'all');
    expect(heatmap.days).toEqual(['2026-10-30', '2026-10-31']);
    expect(heatmap.commits.map((commit) => commit.sha)).toEqual([project]);
  });

  it('counts the project calls and errors per local hour of each day', async () => {
    const f = await traceFixture();
    const morning = f.session('morning'),
      afternoon = f.session('afternoon');
    f.turn(morning, 'morning-turn', local(9, 10), local(9, 50));
    f.tool(morning, 'morning-turn', 'morning-passing', local(9, 20), local(9, 25));
    f.tool(morning, 'morning-turn', 'morning-failing', local(9, 30), local(9, 35), false);
    f.turn(afternoon, 'afternoon-turn', local(14), local(14, 30));
    f.tool(afternoon, 'afternoon-turn', 'afternoon-passing', local(14, 10), local(14, 15));
    f.setClock(new Date(2026, 9, 31, 12).getTime());

    const heatmap = await f.control.projectHeatmap(user, f.project.id, '7');
    expect(heatmap.hours.map((entry) => entry.day)).toEqual(heatmap.days);
    const hoursOf = (counts: number[]) =>
      Object.fromEntries(counts.flatMap((count, hour) => (count ? [[hour, count]] : [])));
    const october30 = heatmap.hours[heatmap.days.indexOf('2026-10-30')]!;
    expect(october30.calls).toHaveLength(24);
    expect(october30.errors).toHaveLength(24);
    expect(hoursOf(october30.calls)).toEqual({ 9: 2, 14: 1 });
    expect(hoursOf(october30.errors)).toEqual({ 9: 1 });
    for (const [index, entry] of heatmap.hours.entries()) {
      const cells = heatmap.lanes.map((lane) => lane.cells[index]!);
      const sum = (counts: number[]) => counts.reduce((total, count) => total + count, 0);
      expect(sum(entry.calls)).toBe(sum(cells.map((cell) => cell.llm + cell.tool)));
      expect(sum(entry.errors)).toBe(sum(cells.map((cell) => cell.error)));
    }
  });
});
