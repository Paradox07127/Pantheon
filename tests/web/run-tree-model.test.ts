import { describe, expect, it } from 'vitest';
import type { SessionTrace } from '@pantheon/protocol';
import {
  isLive,
  runForest,
  runStats,
  type RunNode,
  type RunSession,
} from '@/screens/runtime/run-tree';

type Span = SessionTrace['spans'][number];

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

const listed = (id: string, extra: Partial<RunSession> = {}): RunSession => ({
  id,
  title: `title of ${id}`,
  runtime: 'claude',
  model: null,
  state: 'running',
  ...extra,
});

const NO_PARENTS: ReadonlyMap<string, string> = new Map();

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
  ...extra,
});

describe('runForest', () => {
  it('nests session, started session, subagent and nested subagent with calls on their own node', () => {
    const forest = runForest(
      [listed('lead-1'), listed('worker-1', { model: 'claude-sonnet' })],
      new Map([['worker-1', 'lead-1']]),
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
    expect(forest.trees.map((n) => n.id)).toEqual(['lead-1']);
    const root = forest.trees[0]!;
    expect(root).toMatchObject({
      id: 'lead-1',
      kind: 'session',
      runtime: 'claude',
      title: 'title of lead-1',
      model: null,
      status: 'running',
      start: 10,
      end: null,
      tokens: 12,
    });
    expect(root.calls.map((c) => c.id)).toEqual(['lead-llm']);
    const worker = root.children[0]!;
    expect(worker).toMatchObject({
      id: 'worker-1',
      kind: 'session',
      runtime: 'claude',
      model: 'claude-sonnet',
      start: 110,
      tokens: 3,
    });
    expect(worker.calls.map((c) => c.id)).toEqual(['worker-llm']);
    const spawn = worker.children[0]!;
    expect(spawn).toMatchObject({
      id: 'spawn',
      kind: 'subagent',
      title: 'explorer',
      runtime: null,
      model: null,
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
      [listed('lead-1', { runtime: 'codex' })],
      NO_PARENTS,
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

  it('reads a session status from its state and what it is doing now', () => {
    const run = (phase: NonNullable<RunSession['run']>['phase']) => ({ phase, since: 0 });
    const forest = runForest(
      [
        listed('starting', { state: 'starting' }),
        listed('running', { state: 'running', run: run('thinking') }),
        listed('waiting', { state: 'waiting' }),
        listed('idle', { state: 'idle', run: run('idle') }),
        listed('ready', { state: 'ready' }),
        listed('merging', { state: 'merging' }),
        listed('gate', { state: 'ready', run: run('gate') }),
        listed('approval', { state: 'idle', run: run('waiting_approval') }),
        listed('failed', { state: 'failed', run: run('thinking') }),
        listed('merged', { state: 'merged' }),
        listed('discarded', { state: 'discarded' }),
        listed('done', { state: 'done' }),
      ],
      NO_PARENTS,
      new Map(),
    );
    expect(forest.trees.map((n) => [n.id, n.status, n.phase])).toEqual([
      ['starting', 'running', null],
      ['running', 'running', 'thinking'],
      ['waiting', 'waiting', null],
      ['idle', 'idle', 'idle'],
      ['ready', 'ready', null],
      ['merging', 'running', null],
      ['gate', 'running', 'gate'],
      ['approval', 'waiting', 'waiting_approval'],
      ['failed', 'error', 'thinking'],
      ['merged', 'ok', null],
      ['discarded', 'idle', null],
      ['done', 'ok', null],
    ]);
    expect(runStats(forest.trees, 0).running).toBe(4);
  });

  it('keeps the runtime of a session and the sessions it started beyond Claude and Codex', () => {
    const forest = runForest(
      [listed('lead-1', { runtime: 'agy' }), listed('s-grok', { runtime: 'grok' })],
      new Map([['s-grok', 'lead-1']]),
      new Map(),
    );
    const root = forest.trees[0]!;
    expect(root.runtime).toBe('agy');
    expect(root.children.map((c) => c.runtime)).toEqual(['grok']);
  });

  it('names a baseline session without a title by its start', () => {
    const forest = runForest(
      [listed('baseline', { title: '', baseline_started_at: 0 })],
      NO_PARENTS,
      new Map(),
    );
    expect(forest.trees[0]!.title).not.toBe('');
  });

  it('puts a session whose starter is not listed on top', () => {
    const forest = runForest(
      [listed('lead'), listed('orphan')],
      new Map([['orphan', 'gone']]),
      new Map(),
    );
    expect(forest.trees.map((n) => [n.id, n.children.length])).toEqual([
      ['lead', 0],
      ['orphan', 0],
    ]);
  });

  it('puts session subagents after the sessions it started', () => {
    const forest = runForest(
      [listed('lead-1'), listed('worker')],
      new Map([['worker', 'lead-1']]),
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

  it('orders trees by newest activity with idle sessions last', () => {
    const forest = runForest(
      [
        listed('quiet'),
        listed('old'),
        listed('new'),
        listed('also-quiet'),
        listed('new-worker', { state: 'idle' }),
      ],
      new Map([['new-worker', 'new']]),
      new Map([
        ['old', [span('old-llm', 'llm', { start: 100, end: 500 })]],
        ['new-worker', [span('new-read', 'tool', { start: 10, end: 900 })]],
      ]),
    );
    expect(forest.trees.map((t) => t.id)).toEqual(['new', 'old', 'quiet', 'also-quiet']);
  });

  it('keeps a running session open between its calls', () => {
    const forest = runForest(
      [listed('lead-1')],
      NO_PARENTS,
      new Map([['lead-1', [span('done-read', 'tool', { start: 10, end: 20 })]]]),
    );
    const root = forest.trees[0]!;
    expect(root).toMatchObject({ status: 'running', start: 10, end: null });
    expect(runStats([root], 1000).duration_ms).toBe(990);
  });

  it('counts the turn tokens its model calls do not carry and times a session by its turns', () => {
    const forest = runForest(
      [listed('codex-lead', { state: 'idle', runtime: 'codex' })],
      NO_PARENTS,
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
      [listed('acp-lead', { state: 'idle', runtime: 'grok' })],
      NO_PARENTS,
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

  it('times a tool-free session by its turns alone', () => {
    const forest = runForest(
      [listed('quiet-lead', { state: 'idle' })],
      NO_PARENTS,
      new Map([['quiet-lead', [span('turn-1', 'turn', { parent: null, start: 100, end: 400 })]]]),
    );
    expect(forest.trees[0]).toMatchObject({ start: 100, end: 400, tokens: 0 });
  });

  it('ends an open session that is not running at its last call or turn', () => {
    const spans = [
      span('turn-1', 'turn', { parent: null, start: 100, end: 300 }),
      span('worked', 'tool', { start: 120, end: 280 }),
      span('pending', 'tool', { start: 320, status: 'running' }),
    ];
    const forest = runForest(
      [
        listed('waiting-session', {
          state: 'waiting',
          run: { phase: 'waiting_approval', since: 320 },
        }),
        listed('running-session'),
      ],
      NO_PARENTS,
      new Map([
        ['waiting-session', spans],
        ['running-session', spans],
      ]),
    );
    const [waiting, running] = forest.trees;
    expect(waiting).toMatchObject({ status: 'waiting', start: 100, end: 320 });
    expect(runStats([waiting!], 1000).duration_ms).toBe(220);
    expect(running).toMatchObject({ status: 'running', start: 100, end: null });
  });

  it('does not hang on a cycle in parent links', () => {
    const forest = runForest(
      [listed('lead-1')],
      NO_PARENTS,
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

  it('times a session with a very long history of calls and subagents', () => {
    const count = 300_000;
    const spans = Array.from({ length: count }, (_, i) =>
      span(`call-${i}`, i % 2 === 0 ? 'tool' : 'subagent', { start: i, end: i + 1 }),
    );
    const forest = runForest(
      [listed('lead-1', { state: 'idle' })],
      NO_PARENTS,
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
