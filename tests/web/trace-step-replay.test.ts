import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionStepDiff, SessionTrace, WorkbenchSession } from '@pantheon/protocol';
import { find, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { parsePatch } from '@/data/patch';
import { replayClock, replaySteps, stepDiffFiles, stepMoment } from '@/data/step-replay';
import { StepReplay } from '@/screens/trace/StepReplay';
import { zh } from './i18n-setup.js';

type Span = SessionTrace['spans'][number];

const span = (id: string, extra: Partial<Span>): Span => ({
  id,
  parent: null,
  turn: 'turn-1',
  kind: 'tool',
  name: '',
  start: null,
  end: null,
  status: 'ok',
  timing: 'daemon',
  ...extra,
});

const SPANS: Span[] = [
  span('turn-1', {
    kind: 'turn',
    start: 1_000,
    end: 200_000,
    tokens: { input: 100, output: 20 },
  }),
  span('turn-2', { kind: 'turn', turn: 'turn-2', start: 210_000, status: 'running' }),
  span('edit-2', {
    turn: 'turn-2',
    name: 'Edit',
    start: 225_000,
    end: 230_000,
    input_summary: 'src/refund/service.ts',
    gate_state: 'passed',
  }),
  span('read-1', {
    name: 'Read',
    start: 5_000,
    end: 6_000,
    input_summary: 'src/refund/state.ts',
    context_tokens: 1_000,
    context_window: 10_000,
    gate_state: 'none',
  }),
  span('grep-1', { name: 'Grep', start: 10_000, end: 11_000, input_summary: 'idempotency' }),
  span('edit-1', {
    name: 'Edit',
    start: 32_000,
    end: 33_000,
    input_summary: 'src/refund/service.ts',
    gate_state: 'none',
  }),
  span('llm-2', {
    kind: 'llm',
    turn: 'turn-2',
    start: 215_000,
    end: 216_000,
    tokens: { input: 30, output: 5 },
  }),
  span('bash-1', {
    turn: 'turn-2',
    name: 'Bash',
    start: 220_000,
    end: 221_000,
    status: 'error',
    input_summary: 'pnpm test refund',
    context_tokens: 50_000,
    context_window: 100_000,
    gate_state: 'failed',
  }),
  span('unstarted', { name: 'Read', input_summary: 'never.ts' }),
];

const EDIT_PATCH =
  'diff --git a/src/refund/service.ts b/src/refund/service.ts\n--- a/src/refund/service.ts\n+++ b/src/refund/service.ts\n@@ -1,1 +1,2 @@\n-a\n+b\n+c\n';

const listed = (): WorkbenchSession => ({
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Refund idempotency',
  runtime: 'codex',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'running',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
});

describe('the steps of one session', () => {
  it('lists the timed tool calls by start with what each acted on, timed from the first record', () => {
    const { steps, total } = replaySteps(SPANS);
    expect(steps.map((s) => [s.span.id, s.kind, s.subject, s.at])).toEqual([
      ['read-1', 'read', 'src/refund/state.ts', 4_000],
      ['grep-1', 'search', 'idempotency', 9_000],
      ['edit-1', 'edit', 'src/refund/service.ts', 31_000],
      ['bash-1', 'run', 'pnpm test refund', 219_000],
      ['edit-2', 'edit', 'src/refund/service.ts', 224_000],
    ]);
    expect(total).toBe(229_000);
    expect([replayClock(31_000), replayClock(229_000), replayClock(3_725_000)]).toEqual([
      '0:31',
      '3:49',
      '1:02:05',
    ]);
  });

  it('reads the context, tokens, edited files and checks as they stood when a step started', () => {
    const { steps } = replaySteps(SPANS);
    expect(stepMoment(SPANS, steps, 0)).toEqual({
      context: { used_tokens: 1_000, window_tokens: 10_000 },
      tokens: 0,
      files: 0,
      tests: 'none',
    });
    expect(stepMoment(SPANS, steps, 3)).toEqual({
      context: { used_tokens: 50_000, window_tokens: 100_000 },
      tokens: 155,
      files: 1,
      tests: 'failed',
    });
    expect(stepMoment(SPANS, steps, 1).context).toBeNull();
  });

  it("reads an indexed Codex session's commands and file changes as runs and edits", () => {
    const codex = [
      span('turn-1', { kind: 'turn', start: 1_000, status: 'running' }),
      span('cmd-1', { name: 'command', start: 2_000, end: 3_000, input_summary: 'ls' }),
      span('exec-1', { name: 'exec_command', start: 4_000, end: 5_000, input_summary: 'pwd' }),
      span('change-1', { name: 'file_change', start: 6_000, end: 7_000, files: ['a.ts', 'b.ts'] }),
      span('patch-1', { name: 'apply_patch', start: 8_000, end: 9_000, files: ['c.ts'] }),
    ];
    const { steps } = replaySteps(codex);
    expect(steps.map((s) => s.kind)).toEqual(['run', 'run', 'edit', 'edit']);
    expect(stepMoment(codex, steps, 3).files).toBe(3);
  });

  it('counts a model call of an open turn only once it has ended, not while it overlaps the step', () => {
    const overlapping = [
      span('turn-1', { kind: 'turn', start: 1_000, status: 'running' }),
      span('llm-1', {
        kind: 'llm',
        start: 1_000,
        end: 2_000,
        tokens: { input: 10, output: 1 },
      }),
      span('llm-background', {
        kind: 'llm',
        start: 1_500,
        end: 9_000,
        tokens: { input: 300, output: 70 },
      }),
      span('read-1', { name: 'Read', start: 3_000, end: 3_500 }),
      span('read-2', { name: 'Read', start: 9_500, end: 9_800 }),
    ];
    const { steps } = replaySteps(overlapping);
    expect(stepMoment(overlapping, steps, 0).tokens).toBe(11);
    expect(stepMoment(overlapping, steps, 1).tokens).toBe(381);
  });

  it('lists the steps of a session with more spans than a call can take as arguments', () => {
    const many = Array.from({ length: 150_000 }, (_, i) =>
      span(`read-${i}`, { name: 'Read', start: 1_000 + i, end: 2_000 + i }),
    );
    const { steps, total } = replaySteps(many);
    expect([steps.length, total]).toEqual([150_000, 150_999]);
  });

  it('reads the moment of a step in a long session without scanning every span per turn', () => {
    const long = Array.from({ length: 10_000 }, (_, i) => {
      const turn = `turn-${i}`;
      const start = i * 10;
      return [
        span(turn, { kind: 'turn', turn, start, end: start + 9 }),
        span(`llm-${i}`, {
          kind: 'llm',
          turn,
          start,
          end: start + 1,
          tokens: { input: 1, output: 1 },
        }),
        span(`tool-${i}`, { name: 'Bash', turn, start: start + 2, end: start + 3 }),
      ];
    }).flat();
    const { steps } = replaySteps(long);
    const began = performance.now();
    const moment = stepMoment(long, steps, 9_999);
    expect(moment.tokens).toBe(20_000);
    expect(performance.now() - began).toBeLessThan(100);
  });

  it('counts each recorded patch and marks a written file as new', () => {
    const diff: SessionStepDiff = {
      session_id: 'session-a',
      turn_id: 'turn-1',
      span_id: 'edit-1',
      files: [
        { path: 'src/refund/service.ts', patch: EDIT_PATCH, truncated: false },
        {
          path: 'src/new.ts',
          patch:
            'diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+x\n',
          truncated: false,
        },
      ],
    };
    const read = stepDiffFiles(diff);
    expect(read.files).toEqual([
      { path: 'src/refund/service.ts', additions: 2, deletions: 1, untracked: false },
      { path: 'src/new.ts', additions: 1, deletions: 0, untracked: true },
    ]);
    expect(parsePatch(read.patch!).map((file) => file.path)).toEqual([
      'src/refund/service.ts',
      'src/new.ts',
    ]);
    expect(read.truncated).toBe(false);
    expect(read.patch).toContain('diff --git a/src/refund/service.ts b/src/refund/service.ts\n');
    expect(
      stepDiffFiles({
        ...diff,
        files: [{ path: 'big.ts', patch: null, truncated: true }],
      }).truncated,
    ).toBe(true);
  });
});

describe('the step replay', () => {
  let queries: { method: string; params: Record<string, string> }[];
  let traceFails: boolean;
  const stepReplay = (sessionId = 'session-a') =>
    mount(() => StepReplay({ sessionId, projectId: 'project-a' }));
  const list = (tree: unknown) => find(tree as any, (n) => n.props.role === 'listbox');
  const options = (tree: unknown) => nodes(tree as any).filter((n) => n.props.role === 'option');
  const selected = (tree: unknown) =>
    options(tree).findIndex((n) => n.props['aria-selected'] === true);
  const labelled = (tree: unknown, label: string) =>
    find(tree as any, (n) => n.props['aria-label'] === label);
  const key = (tree: unknown, name: string) => {
    const preventDefault = vi.fn();
    list(tree).props.onKeyDown({ key: name, preventDefault });
    return preventDefault;
  };
  const stepReads = () =>
    queries.filter((q) => q.method === 'session.step_diff').map((q) => q.params.span_id);

  beforeEach(() => {
    queries = [];
    traceFails = false;
    mock.board = {
      board: { cursor: 1, sessions: [], session_turns: [], projects: [], workspaces: [] },
      events: [],
      status: { state: 'live' },
      resync: 0,
      trace_revision: 0,
      refresh() {},
    };
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async () => ({ ok: true, value: {} })),
        query: vi.fn(async (method: string, params: Record<string, string>) => {
          queries.push({ method, params });
          if (method === 'session.list') return { ok: true, value: [listed()] };
          if (method === 'session.trace')
            return traceFails
              ? { ok: false, error: { code: 'internal', message: 'trace read failed' } }
              : {
                  ok: true,
                  value: {
                    lane: {
                      key: 'session-a',
                      source: 'pantheon',
                      runtime: 'codex',
                      session_id: 'session-a',
                      native_id: 'native-a',
                      title: 'Refund idempotency',
                      cwd: '/repo',
                    },
                    spans: SPANS,
                  },
                };
          if (method === 'session.step_diff')
            return params.span_id === 'grep-1'
              ? { ok: false, error: { code: 'internal', message: 'step read failed' } }
              : {
                  ok: true,
                  value: {
                    ...params,
                    files:
                      params.span_id === 'edit-1'
                        ? [{ path: 'src/refund/service.ts', patch: EDIT_PATCH, truncated: false }]
                        : [],
                  },
                };
          return { ok: false, error: { code: 'not_found', message: method } };
        }),
      },
      addEventListener() {},
      removeEventListener() {},
      innerWidth: 1440,
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('names the session with its state and title', async () => {
    const h = stepReplay();
    await h.flush();
    const chip = find(h.value, (n) => n.props.className === 'chip srp-chip');
    expect(named(chip, 'SessionStateIcon').props.session.id).toBe('session-a');
    expect(text(chip)).toContain('Refund idempotency');
  });

  it('opens on the first step, lists every step with its kind and time, and reads that step only', async () => {
    const h = stepReplay();
    await h.flush();
    expect(queries.find((q) => q.method === 'session.trace')?.params).toEqual({
      project_id: 'project-a',
      lane_key: 'session-a',
    });
    expect(options(h.value).map((o) => text(o))).toEqual([
      '读取src/refund/state.ts0:04',
      '搜索idempotency0:09',
      '编辑src/refund/service.ts0:31',
      '运行pnpm test refund3:39',
      '编辑src/refund/service.ts3:44',
    ]);
    expect(selected(h.value)).toBe(0);
    expect(list(h.value).props['aria-activedescendant']).toBe(options(h.value)[0]!.props.id);
    expect(stepReads()).toEqual(['read-1']);
    expect(text(h.value)).toContain('第 1 步，共 5 步');
    expect(text(find(h.value, (n) => n.props.className === 'srp-at'))).toBe('0:04');
    expect(text(find(h.value, (n) => n.props.className === 'srp-total'))).toBe('3:49');
  });

  it('moves a step with the arrow keys on the list and back with the previous button', async () => {
    const h = stepReplay();
    await h.flush();
    expect(labelled(h.value, zh('trace.stepReplay.previous')).props.disabled).toBe(true);
    expect(key(h.value, 'ArrowLeft')).toHaveBeenCalled();
    h.render();
    expect(selected(h.value)).toBe(0);
    key(h.value, 'ArrowRight');
    h.render();
    key(h.value, 'ArrowRight');
    h.render();
    await h.flush();
    expect(selected(h.value)).toBe(2);
    expect(stepReads()).toEqual(['read-1', 'grep-1', 'edit-1']);
    const diff = named(h.value, 'DiffFiles').props.diff;
    expect(diff.data.files).toEqual([
      { path: 'src/refund/service.ts', additions: 2, deletions: 1, untracked: false },
    ]);
    labelled(h.value, zh('trace.stepReplay.previous')).props.onClick();
    h.render();
    expect(selected(h.value)).toBe(1);
    expect(key(h.value, 'Tab')).not.toHaveBeenCalled();
  });

  it('jumps to a step picked in the list or on the position slider', async () => {
    const h = stepReplay();
    await h.flush();
    options(h.value)[3]!.props.onClick();
    h.render();
    expect(selected(h.value)).toBe(3);
    const slider = labelled(h.value, zh('trace.stepReplay.slider'));
    expect(slider.props.value).toBe(219_000);
    expect(slider.props.max).toBe(229_000);
    slider.props.onChange({ target: { value: '30000' } });
    h.render();
    expect(selected(h.value)).toBe(1);
  });

  it('shows the moment of the current step beside its diff', async () => {
    const h = stepReplay();
    await h.flush();
    options(h.value)[3]!.props.onClick();
    h.render();
    await h.flush();
    const moment = find(h.value, (n) => n.props.className === 'panel srp-cells');
    expect(named(moment, 'ContextRing').props.context).toEqual({
      used_tokens: 50_000,
      window_tokens: 100_000,
    });
    expect(text(moment)).toBe('上下文50%已用 tokens155改过的文件1测试未通过');
    expect(text(h.value)).toContain(zh('trace.stepReplay.noChanges'));
  });

  it('shows a failed read in the cell it belongs to, with a way to read again', async () => {
    const h = stepReplay();
    await h.flush();
    options(h.value)[1]!.props.onClick();
    h.render();
    await h.flush();
    expect(named(h.value, 'DiffFiles').props.diff.error).toContain('step read failed');

    traceFails = true;
    const failed = stepReplay('session-b');
    await failed.flush();
    const cell = find(failed.value, (n) => n.props['aria-label'] === zh('trace.stepReplay.steps'));
    expect(text(find(cell, (n) => n.props.role === 'alert'))).toContain('trace read failed');
    const before = queries.filter((q) => q.method === 'session.trace').length;
    find(cell, (n) => n.type === 'button').props.onClick();
    failed.render();
    await failed.flush();
    expect(queries.filter((q) => q.method === 'session.trace').length).toBe(before + 1);
  });
});
