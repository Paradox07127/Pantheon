import { describe, expect, it } from 'vitest';
import type { BoardModel, BoardSegment, SessionTrace } from '@pantheon/protocol';
import { isLive, runForest, runStats, type RunNode } from '@/screens/runtime/run-tree';

type Span = SessionTrace['spans'][number];
type Task = BoardModel['tasks'][number];
type Lead = NonNullable<BoardModel['leads']>[number];

const span = (id: string, kind: Span['kind'], extra: Partial<Span> = {}): Span => ({
  id,
  parent: 'turn-1',
  turn: 'turn-1',
  kind,
  name: kind === 'llm' ? 'claude-opus' : 'Read',
  start: null,
  end: null,
  status: 'ok',
  timing: 'native',
  ...extra,
});

const segment = (id: string, extra: Partial<BoardSegment> = {}): BoardSegment => ({
  id,
  session_id: id,
  title: `title of ${id}`,
  runtime: 'claude',
  model: 'claude-sonnet',
  status: 'running',
  started_at: null,
  ended_at: null,
  tokens: 999,
  ...extra,
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  goal: '',
  scope: [],
  lane_id: null,
  milestone_id: null,
  status: 'running',
  blockers: [],
  segments: [],
  additions: null,
  deletions: null,
  checks: 'none',
  started_at: null,
  ended_at: null,
  last_progress_at: null,
  blocked_since: null,
  turn_running: false,
  ...extra,
});

const lead = (session_id: string, extra: Partial<Lead> = {}): Lead => ({
  session_id,
  title: `lead ${session_id}`,
  state: 'running',
  inbox: 0,
  updated_at: 0,
  ...extra,
});

const activity = (phase: NonNullable<Task['activity']>['phase']): Task['activity'] => ({
  phase,
  since: 0,
  health: 'fresh',
  attempt: 1,
});

const node = (id: string, extra: Partial<RunNode> = {}): RunNode => ({
  id,
  kind: 'session',
  runtime: null,
  title: id,
  model: null,
  status: 'ok',
  phase: null,
  start: null,
  end: null,
  tokens: 0,
  calls: [],
  children: [],
  taskId: null,
  ...extra,
});

describe('runForest', () => {
  it('nests lead, task session, subagent and nested subagent with calls on their own node', () => {
    const forest = runForest(
      {
        leads: [lead('lead-1')],
        tasks: [
          task('lead-1:build', {
            owner_session_id: 'lead-1',
            segments: [segment('worker-1', { started_at: 100 })],
          }),
        ],
      },
      [
        { id: 'lead-1', runtime: 'claude' },
        { id: 'worker-1', runtime: 'claude' },
      ],
      new Map([
        [
          'lead-1',
          [
            span('turn-1', 'turn', { parent: null }),
            span('lead-llm', 'llm', { start: 10, end: 20, tokens: { input: 5, output: 7 } }),
          ],
        ],
        [
          'worker-1',
          [
            span('worker-llm', 'llm', { start: 110, end: 120, tokens: { input: 1, output: 2 } }),
            span('spawn', 'subagent', { name: 'explorer', start: 130, end: 200 }),
            span('inner-read', 'tool', { parent: 'spawn', start: 140, end: 150 }),
            span('inner-spawn', 'subagent', { parent: 'spawn', name: 'grep agent', start: 160 }),
            span('deep-llm', 'llm', {
              parent: 'inner-spawn',
              start: 170,
              status: 'running',
              tokens: { input: 3, output: 4 },
            }),
          ],
        ],
      ]),
    );
    expect(forest.adhoc).toEqual([]);
    const root = forest.trees[0]!;
    expect(root).toMatchObject({
      id: 'lead-1',
      kind: 'lead',
      runtime: 'claude',
      title: 'lead lead-1',
      model: 'claude-opus',
      status: 'running',
      start: 10,
      end: null,
      tokens: 12,
      taskId: null,
    });
    expect(root.calls.map((c) => c.id)).toEqual(['lead-llm']);
    const worker = root.children[0]!;
    expect(worker).toMatchObject({
      id: 'worker-1',
      kind: 'session',
      runtime: 'claude',
      model: 'claude-sonnet',
      start: 100,
      tokens: 3,
      taskId: 'lead-1:build',
    });
    expect(worker.calls.map((c) => c.id)).toEqual(['worker-llm']);
    const spawn = worker.children[0]!;
    expect(spawn).toMatchObject({
      id: 'spawn',
      kind: 'subagent',
      title: 'explorer',
      runtime: null,
      model: null,
      taskId: null,
      start: 130,
      end: 200,
    });
    expect(spawn.calls.map((c) => c.id)).toEqual(['inner-read']);
    expect(spawn.children.map((c) => c.id)).toEqual(['inner-spawn']);
    expect(spawn.children[0]!.calls).toEqual([
      {
        id: 'deep-llm',
        kind: 'llm',
        name: 'claude-opus',
        status: 'running',
        start: 170,
        end: null,
        tokens: 7,
      },
    ]);
    expect(spawn.children[0]!.tokens).toBe(7);
  });

  it('turns a Task tool span recorded by the daemon into a subagent', () => {
    const forest = runForest(
      { leads: [lead('lead-1')], tasks: [] },
      [{ id: 'lead-1', runtime: 'codex' }],
      new Map([
        [
          'lead-1',
          [
            span('task-call', 'tool', {
              name: 'Task',
              start: 5,
              status: 'running',
              timing: 'daemon',
            }),
            span('agent-call', 'tool', { name: 'Agent', start: 6 }),
            span('child-read', 'tool', { parent: 'task-call', start: 7 }),
          ],
        ],
      ]),
    );
    const root = forest.trees[0]!;
    expect(root.runtime).toBe('codex');
    expect(root.calls).toEqual([]);
    expect(root.children.map((c) => [c.id, c.kind, c.status])).toEqual([
      ['task-call', 'subagent', 'running'],
      ['agent-call', 'subagent', 'ok'],
    ]);
    expect(root.children[0]!.calls.map((c) => c.id)).toEqual(['child-read']);
    expect(root.end).toBeNull();
  });

  it('maps segment statuses and orders segments by start with the phase on the newest only', () => {
    const forest = runForest(
      {
        leads: [lead('lead-1', { state: 'closed' })],
        tasks: [
          task('lead-1:retry', {
            owner_session_id: 'lead-1',
            activity: activity('thinking'),
            segments: [
              segment('s-open', { status: 'running', started_at: null, runtime: 'gemini' }),
              segment('s-discarded', { status: 'discarded', started_at: 30 }),
              segment('s-failed', { status: 'failed', started_at: 10, ended_at: 20 }),
              segment('s-none', { session_id: null, status: 'done', started_at: 5 }),
            ],
          }),
          task('lead-1:other', {
            owner_session_id: 'lead-1',
            segments: [
              segment('s-ready', { status: 'ready', started_at: 1 }),
              segment('s-done', { status: 'done', started_at: 2 }),
              segment('s-waiting', { status: 'waiting', started_at: 3 }),
              segment('s-todo', { status: 'todo', started_at: 4 }),
              segment('s-idle', { status: 'idle', started_at: 5 }),
            ],
          }),
        ],
      },
      [],
      new Map(),
    );
    const root = forest.trees[0]!;
    expect(root.status).toBe('idle');
    expect(root.runtime).toBeNull();
    expect(root.model).toBeNull();
    expect(root.children.map((c) => [c.id, c.status, c.phase, c.runtime])).toEqual([
      ['s-failed', 'error', null, 'claude'],
      ['s-discarded', 'idle', null, 'claude'],
      ['s-open', 'running', 'thinking', 'gemini'],
      ['s-ready', 'ready', null, 'claude'],
      ['s-done', 'ok', null, 'claude'],
      ['s-waiting', 'waiting', null, 'claude'],
      ['s-todo', 'idle', null, 'claude'],
      ['s-idle', 'idle', null, 'claude'],
    ]);
    expect(root.children[0]).toMatchObject({ start: 10, end: 20, tokens: 0 });
  });

  it('keeps the runtime of a lead and its sessions beyond Claude and Codex', () => {
    const forest = runForest(
      {
        leads: [lead('lead-1')],
        tasks: [
          task('lead-1:a', {
            owner_session_id: 'lead-1',
            segments: [segment('s-grok', { runtime: 'grok' })],
          }),
        ],
      },
      [{ id: 'lead-1', runtime: 'agy' }],
      new Map(),
    );
    const root = forest.trees[0]!;
    expect(root.runtime).toBe('agy');
    expect(root.children.map((c) => c.runtime)).toEqual(['grok']);
  });

  it('gives a queued task without a session one node keyed by the task id', () => {
    const forest = runForest(
      {
        leads: [lead('lead-1', { state: 'waiting' })],
        tasks: [
          task('lead-1:queued', {
            owner_session_id: 'lead-1',
            status: 'todo',
            activity: activity('queued'),
            segments: [segment('never', { session_id: null })],
          }),
        ],
      },
      [],
      new Map(),
    );
    expect(forest.trees[0]!.status).toBe('waiting');
    expect(forest.trees[0]!.children).toEqual([
      node('lead-1:queued', {
        title: 'task lead-1:queued',
        status: 'idle',
        phase: 'queued',
        taskId: 'lead-1:queued',
      }),
    ]);
  });

  it('puts tasks without a lead in adhoc', () => {
    const forest = runForest(
      {
        tasks: [
          task('solo', { segments: [segment('solo', { status: 'failed' })] }),
          task('fresh', { status: 'waiting' }),
        ],
      },
      [{ id: 'solo', runtime: 'claude' }],
      new Map([['solo', [span('solo-read', 'tool', { status: 'error' })]]]),
    );
    expect(forest.trees).toEqual([]);
    expect(forest.adhoc.map((n) => [n.id, n.status, n.taskId, n.calls.length])).toEqual([
      ['solo', 'error', 'solo', 1],
      ['fresh', 'waiting', 'fresh', 0],
    ]);
  });

  it('puts tasks whose lead is not listed in adhoc', () => {
    const forest = runForest(
      { tasks: [task('orphan', { owner_session_id: 'gone' })], leads: [lead('lead')] },
      [],
      new Map(),
    );
    expect(forest.trees.map((n) => n.children.length)).toEqual([0]);
    expect(forest.adhoc.map((n) => n.id)).toEqual(['orphan']);
  });

  it('puts session subagents after the task children', () => {
    const forest = runForest(
      {
        leads: [lead('lead-1')],
        tasks: [
          task('lead-1:a', {
            owner_session_id: 'lead-1',
            segments: [segment('worker', { started_at: 50 })],
          }),
        ],
      },
      [],
      new Map([
        [
          'lead-1',
          [
            span('late', 'subagent', { start: 40 }),
            span('early', 'tool', { name: 'Task', start: 1 }),
          ],
        ],
      ]),
    );
    expect(forest.trees[0]!.children.map((c) => c.id)).toEqual(['worker', 'early', 'late']);
  });

  it('orders trees by newest activity with idle leads last', () => {
    const forest = runForest(
      {
        leads: [lead('quiet'), lead('old'), lead('new'), lead('also-quiet')],
        tasks: [
          task('new:a', {
            owner_session_id: 'new',
            segments: [segment('new-worker', { started_at: 10, ended_at: 900 })],
          }),
        ],
      },
      [],
      new Map([['old', [span('old-llm', 'llm', { start: 100, end: 500 })]]]),
    );
    expect(forest.trees.map((t) => t.id)).toEqual(['new', 'old', 'quiet', 'also-quiet']);
  });

  it('keeps a running lead open between its calls', () => {
    const forest = runForest(
      { leads: [lead('lead-1')], tasks: [] },
      [],
      new Map([['lead-1', [span('done-read', 'tool', { start: 10, end: 20 })]]]),
    );
    const root = forest.trees[0]!;
    expect(root).toMatchObject({ status: 'running', start: 10, end: null });
    expect(runStats([root], 1000).duration_ms).toBe(990);
  });

  it('counts the turn tokens its model calls do not carry and times a lead by its turns', () => {
    const forest = runForest(
      { leads: [lead('codex-lead', { state: 'idle' })], tasks: [] },
      [{ id: 'codex-lead', runtime: 'codex' }],
      new Map([
        [
          'codex-lead',
          [
            span('turn-1', 'turn', {
              parent: null,
              start: 100,
              end: 400,
              tokens: { input: 1000, output: 200 },
            }),
            span('turn-2', 'turn', {
              parent: null,
              turn: 'turn-2',
              start: 500,
              end: 900,
              tokens: { input: 40, output: 10 },
            }),
            span('turn-2-llm', 'llm', {
              parent: 'turn-2',
              turn: 'turn-2',
              start: 510,
              end: 520,
              tokens: { input: 30, output: 5 },
            }),
            span('turn-3', 'turn', { parent: null, turn: 'turn-3', start: 950, end: 990 }),
            span('turn-3-llm', 'llm', {
              parent: 'turn-3',
              turn: 'turn-3',
              start: 960,
              end: 970,
              tokens: { input: 5, output: 2 },
            }),
          ],
        ],
      ]),
    );
    const root = forest.trees[0]!;
    expect(root).toMatchObject({ tokens: 1257, start: 100, end: 990 });
    expect(root.calls.map((c) => c.id)).toEqual(['turn-2-llm', 'turn-3-llm']);
    expect(runStats([root], 5000)).toMatchObject({ tokens: 1257, duration_ms: 890 });
  });

  it('counts the ended turns that reported no tokens on the node that ran them', () => {
    const forest = runForest(
      { leads: [lead('acp-lead', { state: 'idle' })], tasks: [] },
      [{ id: 'acp-lead', runtime: 'grok' }],
      new Map([
        [
          'acp-lead',
          [
            span('turn-1', 'turn', {
              parent: null,
              start: 100,
              end: 400,
              tokens: { input: 40, output: 5 },
            }),
            span('turn-2', 'turn', { parent: null, turn: 'turn-2', start: 500, end: 900 }),
            span('turn-3', 'turn', { parent: null, turn: 'turn-3', start: 950, end: 990 }),
            span('turn-3-llm', 'llm', {
              parent: 'turn-3',
              turn: 'turn-3',
              start: 960,
              end: 970,
              tokens: { input: 5, output: 2 },
            }),
            span('turn-4', 'turn', {
              parent: null,
              turn: 'turn-4',
              start: 1000,
              status: 'running',
            }),
          ],
        ],
      ]),
    );
    const root = forest.trees[0]!;
    expect(root).toMatchObject({ tokens: 52, unreported: 1 });
    expect(runStats([root], 2000)).toMatchObject({ tokens: 52, unreported: 1 });
  });

  it('times a tool-free lead by its turns alone', () => {
    const forest = runForest(
      { leads: [lead('quiet-lead', { state: 'idle' })], tasks: [] },
      [],
      new Map([['quiet-lead', [span('turn-1', 'turn', { parent: null, start: 100, end: 400 })]]]),
    );
    expect(forest.trees[0]).toMatchObject({ start: 100, end: 400, tokens: 0 });
  });

  it('reads a session status with what it is doing now', () => {
    const forest = runForest(
      {
        tasks: [
          task('idle-session', {
            status: 'idle',
            activity: activity('idle'),
            segments: [segment('idle-session', { status: 'idle' })],
          }),
          task('merging-session', {
            status: 'ready',
            activity: activity('merging'),
            segments: [segment('merging-session', { status: 'ready' })],
          }),
          task('gate-session', {
            status: 'ready',
            activity: activity('gate'),
            segments: [segment('gate-session', { status: 'ready' })],
          }),
          task('ready-session', {
            status: 'ready',
            activity: activity('idle'),
            segments: [segment('ready-session', { status: 'ready' })],
          }),
          task('approval-session', {
            status: 'waiting',
            activity: activity('waiting_approval'),
            segments: [segment('approval-session', { status: 'waiting' })],
          }),
          task('failed-session', {
            status: 'failed',
            activity: activity('idle'),
            segments: [segment('failed-session', { status: 'failed' })],
          }),
        ],
      },
      [],
      new Map(),
    );
    expect(forest.adhoc.map((n) => [n.id, n.status])).toEqual([
      ['idle-session', 'idle'],
      ['merging-session', 'running'],
      ['gate-session', 'running'],
      ['ready-session', 'ready'],
      ['approval-session', 'waiting'],
      ['failed-session', 'error'],
    ]);
    expect(runStats(forest.adhoc, 0).running).toBe(2);
  });

  it('ends an open session that is not running at its last call or turn', () => {
    const spans = [
      span('turn-1', 'turn', { parent: null, start: 100, end: 300 }),
      span('worked', 'tool', { start: 120, end: 280 }),
      span('pending', 'tool', { start: 320, status: 'running' }),
    ];
    const forest = runForest(
      {
        tasks: [
          task('waiting-task', {
            status: 'waiting',
            activity: activity('waiting_approval'),
            segments: [segment('waiting-session', { status: 'waiting', started_at: 100 })],
          }),
          task('running-task', {
            segments: [segment('running-session', { status: 'running', started_at: 100 })],
          }),
        ],
      },
      [],
      new Map([
        ['waiting-session', spans],
        ['running-session', spans],
      ]),
    );
    const [waiting, running] = forest.adhoc;
    expect(waiting).toMatchObject({ status: 'waiting', start: 100, end: 320 });
    expect(runStats([waiting!], 1000).duration_ms).toBe(220);
    expect(running).toMatchObject({ status: 'running', start: 100, end: null });
  });

  it('does not hang on a cycle in parent links', () => {
    const forest = runForest(
      { leads: [lead('lead-1')], tasks: [] },
      [],
      new Map([
        [
          'lead-1',
          [
            span('loop-a', 'tool', { parent: 'loop-b' }),
            span('loop-b', 'tool', { parent: 'loop-a' }),
            span('sub-a', 'subagent', { parent: 'sub-b' }),
            span('sub-b', 'subagent', { parent: 'sub-a' }),
            span('in-sub', 'llm', { parent: 'sub-a' }),
          ],
        ],
      ]),
    );
    const root = forest.trees[0]!;
    const ids = (n: RunNode): string[] => [
      n.id,
      ...n.calls.map((c) => c.id),
      ...n.children.flatMap(ids),
    ];
    expect(ids(root).sort()).toEqual(
      ['lead-1', 'loop-a', 'loop-b', 'sub-a', 'sub-b', 'in-sub'].sort(),
    );
  });

  it('times a lead with a very long history of calls and subagents', () => {
    const count = 300_000;
    const spans = Array.from({ length: count }, (_, i) =>
      span(`call-${i}`, i % 2 === 0 ? 'tool' : 'subagent', { start: i, end: i + 1 }),
    );
    const forest = runForest(
      { leads: [lead('lead-1', { state: 'idle' })], tasks: [] },
      [],
      new Map([['lead-1', spans]]),
    );
    expect(forest.trees[0]).toMatchObject({ start: 0, end: count - 1 });
    expect(forest.trees[0]!.children).toHaveLength(count / 2);
  });
});

describe('runStats', () => {
  it('sums the subtree and counts a running node end as now', () => {
    const tree = node('lead', {
      status: 'running',
      start: 100,
      tokens: 10,
      calls: [
        { id: 'l1', kind: 'llm', name: 'm', status: 'ok', start: 100, end: 110, tokens: 10 },
        { id: 't1', kind: 'tool', name: 'Read', status: 'error', start: 120, end: 130, tokens: 0 },
      ],
      children: [
        node('sub', {
          kind: 'subagent',
          status: 'error',
          start: 150,
          end: 400,
          tokens: 5,
          calls: [
            { id: 'l2', kind: 'llm', name: 'm', status: 'ok', start: 160, end: 170, tokens: 5 },
            {
              id: 'c1',
              kind: 'compact',
              name: 'compact',
              status: 'ok',
              start: 180,
              end: 190,
              tokens: 0,
            },
          ],
        }),
      ],
    });
    expect(runStats([tree], 1000)).toEqual({
      duration_ms: 900,
      tokens: 15,
      unreported: 0,
      llm: 2,
      tool: 2,
      errors: 2,
      running: 1,
    });
  });

  it('adds up the turns of the subtree that reported no tokens', () => {
    const tree = node('lead', { unreported: 1, children: [node('worker', { unreported: 2 })] });
    expect(runStats([tree], 1000).unreported).toBe(3);
  });

  it('is zero without starts', () => {
    expect(runStats([node('a')], 1000).duration_ms).toBe(0);
  });
});

describe('isLive', () => {
  it('is live by phase alone', () => {
    const idle = node('n', { status: 'idle' });
    expect(isLive({ trees: [], adhoc: [idle] })).toBe(false);
    expect(isLive({ trees: [], adhoc: [{ ...idle, phase: 'gate' }] })).toBe(true);
    expect(
      isLive({ trees: [node('l', { children: [{ ...idle, phase: 'tool' }] })], adhoc: [] }),
    ).toBe(true);
    expect(isLive({ trees: [], adhoc: [{ ...idle, phase: 'waiting_input' }] })).toBe(false);
    expect(isLive({ trees: [], adhoc: [{ ...idle, status: 'running' }] })).toBe(true);
  });
});
