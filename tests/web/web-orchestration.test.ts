import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { find, nodes, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, opened: [] as string[] }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: { getState: () => ({ openSession: (id: string) => mock.opened.push(id) }) },
}));
import { orchestrationLabel, pantheonTool, toolGroupLabel, toolLabel } from '@/data/tool-calls';
import { groupToolCalls, type ToolItem } from '@/data/transcript';
import { OrchestrationRow } from '@/screens/sessions/orchestration';
import { Items } from '@/screens/sessions/parts';
import { zh, zhf } from './i18n-setup.js';

beforeEach(() => {
  mock.board = {
    board: { cursor: 1, sessions: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
});
afterEach(() => {
  unmountAll();
});

const action = (name: string) => zh(`data.toolCalls.action.${name}`);

const call = (id: string, name = 'Bash', input: unknown = {}, extra: Partial<ToolItem> = {}) =>
  ({ kind: 'tool', id, name, input, ...extra }) as ToolItem;

describe('Pantheon tool names', () => {
  it('reads the tool from the Claude, Codex and fixture spellings', () => {
    expect(pantheonTool('mcp__pantheon__spawn_session')).toBe('spawn_session');
    expect(pantheonTool('pantheon.read_state')).toBe('read_state');
    expect(pantheonTool('report_ready')).toBe('report_ready');
  });

  it('is null for any other tool', () => {
    expect(pantheonTool('mcp__github__spawn_session')).toBeNull();
    expect(pantheonTool('github.read_state')).toBeNull();
    expect(pantheonTool('mcp__pantheon__a')).toBeNull();
    expect(pantheonTool('pantheon.unknown')).toBeNull();
    expect(pantheonTool('Read')).toBeNull();
    expect(pantheonTool('')).toBeNull();
  });

  it('counts project reads in any spelling as reading the project', () => {
    const c = (name: string) => ({ name, input: {} });
    expect(toolGroupLabel([c('mcp__pantheon__project_read'), c('project_read')])).toBe(
      '读了项目 2 次',
    );
    expect(toolGroupLabel([c('Bash'), c('pantheon.project_read'), c('mcp__pantheon__a')])).toBe(
      '运行 1 条命令，读了项目 1 次，另 1 项',
    );
  });
});

describe('orchestration labels', () => {
  it('labels a review request with its runtimes', () => {
    expect(
      orchestrationLabel('request_review', { session_id: 's-3', runtimes: ['codex'] }),
    ).toEqual({ title: action('requestReview'), detail: 'codex' });
  });

  it('reads the arguments Codex wraps in its MCP call input', () => {
    expect(
      orchestrationLabel('pantheon.request_review', {
        server: 'pantheon',
        tool: 'request_review',
        arguments: { session_id: 's-3', runtimes: ['claude'] },
      }),
    ).toEqual({ title: action('requestReview'), detail: 'claude' });
  });

  it.each([
    ['mcp__pantheon__project_read', {}],
    ['pantheon.read_note', { note_id: 'n' }],
    ['Read', { file_path: '/a' }],
    ['mcp__pantheon__start_task', { task_ids: ['t1', 't2'] }],
    ['pantheon.message_task', { task_id: 't1', text: 'Check the tests' }],
    ['accept_task', { task_id: 't1', evidence: 'ok' }],
    ['mcp__pantheon__stop_task', { task_id: 't2', reason: 'Wrong scope' }],
    ['update_board', { tasks: [{}, {}, {}] }],
    ['mcp__pantheon__edit_board', { base_version: 3, ops: [] }],
    ['mcp__pantheon__report', { kind: 'done', text: 'All green' }],
    ['pantheon.interrupt_task', { task_id: 't2' }],
    ['mcp__pantheon__sync_board', {}],
    ['rerun_baseline', {}],
    ['ask_user', { question: 'Ship it?' }],
    ['propose_board', { tasks: [] }],
  ])('leaves %s to the tool rows', (name, input) => {
    expect(orchestrationLabel(name, input)).toBeNull();
  });
});

describe('orchestration rows in the thread', () => {
  it('breaks a run of tool calls like text does', () => {
    const review = call('b', 'mcp__pantheon__request_review', { runtimes: ['codex'] });
    expect(groupToolCalls([call('a'), review, call('c'), call('d')])).toEqual([
      call('a'),
      review,
      { kind: 'group', calls: [call('c'), call('d')] },
    ]);
    const read = call('b', 'pantheon.project_read');
    expect(groupToolCalls([call('a'), read])).toEqual([
      { kind: 'group', calls: [call('a'), read] },
    ]);
  });

  it('draws an orchestration call with its own row', () => {
    const review = call('b', 'request_review', { runtimes: ['codex'] }, { ok: true });
    const shown = Items({
      items: [call('a'), review],
      verbose: false,
      ended: true,
      folders: [],
      sessionId: 's-1',
    });
    const row = find(shown, (n) => n.type === OrchestrationRow);
    expect(row.props).toMatchObject({ item: review, state: 'ok' });
    expect(nodes(shown).filter((n) => (n.type as any)?.name === 'ToolCall')).toHaveLength(1);
  });

  it('draws an old lead call as a plain tool call with its name and arguments', () => {
    const start = call(
      'b',
      'mcp__pantheon__start_task',
      { task_ids: ['t1'], note: 'go' },
      {
        ok: true,
        output: { content: [{ type: 'text', text: '{"receipt":{"requested":["t1"]}}' }] },
      },
    );
    const ls = call('a', 'Bash', { command: 'ls' });
    expect(groupToolCalls([ls, start])).toEqual([{ kind: 'group', calls: [ls, start] }]);
    const shown = Items({
      items: [start],
      verbose: false,
      ended: true,
      folders: [],
      sessionId: 's-1',
    });
    expect(nodes(shown).some((n) => n.type === OrchestrationRow)).toBe(false);
    const tool = find(shown, (n) => (n.type as any)?.name === 'ToolCall');
    expect(tool.props.item).toBe(start);
    expect(toolLabel(start.name, start.input)).toEqual({
      title: 'pantheon, start_task',
      detail: 'note=go',
    });
  });

  it('names the action and its reviewers, and folds out the reviewers', () => {
    const h = mount(() =>
      OrchestrationRow({
        item: call(
          'b',
          'mcp__pantheon__request_review',
          { session_id: 's-3', runtimes: ['codex'] },
          { ok: true, output: 'queued', started_at: 1_000, completed_at: 3_500 },
        ),
        state: 'ok',
        depth: 0,
        open: false,
        enter: '',
      }),
    );
    const trigger = find(h.value, (n) => typeof n.props['aria-label'] === 'string');
    expect(trigger.props['aria-label']).toBe(`${action('requestReview')}，codex，queued，2.5 秒`);
    expect(text(find(h.value, (n) => n.props.className === 'ss-tn'))).toBe(action('requestReview'));
    expect(text(find(h.value, (n) => n.props.className === 'ss-ta'))).toBe('codex');
    expect(nodes(h.value).some((n) => (n.type as any)?.name === 'StateMark')).toBe(true);
    const panel = find(h.value, (n) => n.props.className === 'ss-olist');
    expect(text(panel)).toBe(
      `${zh('data.toolCalls.reviewEntry')}codex${zh('data.toolCalls.sessionEntry')}s-3`,
    );
  });

  it('shows the first sentence of a refusal on the row', () => {
    const h = mount(() =>
      OrchestrationRow({
        item: call(
          'b',
          'request_review',
          { runtimes: ['codex'] },
          {
            ok: false,
            output: {
              content: [
                {
                  type: 'text',
                  text: 'Refused conductor.review: resource_busy — A review is already running',
                },
              ],
            },
          },
        ),
        state: 'failed',
        depth: 0,
        open: false,
        enter: '',
      }),
    );
    expect(text(find(h.value, (n) => n.props.className === 'ss-ts'))).toBe(
      zhf('data.toolCalls.refused', { reason: 'A review is already running' }),
    );
  });

  it('draws no fold-out for a call with nothing to show', () => {
    const h = mount(() =>
      OrchestrationRow({
        item: call('c', 'mcp__pantheon__report_ready', {}, { ok: true, output: 'queued' }),
        state: 'ok',
        depth: 0,
        open: false,
        enter: '',
      }),
    );
    // The title sits in a box that keeps the chevron's place, so it lines up with folding rows.
    const title = find(h.value, (n) => n.props.className === 'ss-otb');
    expect(text(find(title, (n) => n.props.className === 'ss-tn'))).toBe(action('reportReady'));
    expect(nodes(h.value).some((n) => n.props.className === 'ss-otg')).toBe(false);
    expect(nodes(h.value).some((n) => n.props.className === 'ss-olist')).toBe(false);
  });

  it('cuts the input of a spawned session through Clip', () => {
    const prompt = 'Fix the importer and add a test for empty rows';
    const h = mount(() =>
      OrchestrationRow({
        item: call('d', 'spawn_session', { runtime: 'codex', input: prompt }),
        state: 'running',
        depth: 0,
        open: true,
        enter: '',
      }),
    );
    const clip = find(h.value, (n) => (n.type as any)?.name === 'Clip');
    expect(clip.props.text).toBe(prompt);
    expect(clip.props.lines).toBeGreaterThan(1);
    const codes = nodes(h.value).filter((n) => n.props.className === 'ss-ox mono');
    expect(codes.map((n) => text(n))).toEqual(['codex']);
    // Only the prose line aligns its name with the first line of the text.
    const lines = nodes(find(h.value, (n) => n.props.className === 'ss-olist')).filter(
      (n) => n.type === 'li',
    );
    expect(lines.map((n) => n.props['data-prose'])).toEqual([undefined, true]);
  });
});
