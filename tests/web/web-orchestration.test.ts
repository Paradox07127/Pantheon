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
import { RuntimeGlyph } from '@/components/RuntimeGlyph';
import { orchestrationLabel, pantheonTool, toolGroupLabel } from '@/data/tool-calls';
import { groupToolCalls, type ToolItem } from '@/data/transcript';
import { OrchestrationRow, TaskChip } from '@/screens/sessions/orchestration';
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
    expect(pantheonTool('mcp__pantheon__update_board')).toBe('update_board');
    expect(pantheonTool('pantheon.start_task')).toBe('start_task');
    expect(pantheonTool('report')).toBe('report');
  });

  it('is null for any other tool', () => {
    expect(pantheonTool('mcp__github__update_board')).toBeNull();
    expect(pantheonTool('github.start_task')).toBeNull();
    expect(pantheonTool('mcp__pantheon__a')).toBeNull();
    expect(pantheonTool('pantheon.unknown')).toBeNull();
    expect(pantheonTool('Read')).toBeNull();
    expect(pantheonTool('')).toBeNull();
  });

  it('counts project and note reads in any spelling as reading the project', () => {
    const c = (name: string) => ({ name, input: {} });
    expect(
      toolGroupLabel([
        c('mcp__pantheon__project_read'),
        c('pantheon.read_note'),
        c('project_read'),
      ]),
    ).toBe('读了项目 3 次');
    expect(toolGroupLabel([c('Bash'), c('pantheon.project_read'), c('mcp__pantheon__a')])).toBe(
      '运行 1 条命令，读了项目 1 次，另 1 项',
    );
  });
});

describe('orchestration labels', () => {
  it.each([
    ['mcp__pantheon__start_task', { task_ids: ['t1', 't2'] }, action('dispatch'), '', ['t1', 't2']],
    [
      'pantheon.message_task',
      { task_id: 't1', text: '\nCheck the tests\nthen push' },
      action('message'),
      'Check the tests',
      ['t1'],
    ],
    ['accept_task', { task_id: 't1', evidence: 'ok' }, action('accept'), '', ['t1']],
    [
      'mcp__pantheon__stop_task',
      { task_id: 't2', reason: 'Wrong scope' },
      action('stop'),
      'Wrong scope',
      ['t2'],
    ],
    ['update_board', { tasks: [{}, {}, {}] }, action('updatePlan'), '3 个任务', []],
    ['pantheon.milestone_accept', { milestone_id: 'm1' }, action('acceptMilestone'), 'm1', []],
    [
      'mcp__pantheon__report',
      { kind: 'done', text: 'All green\nDetails' },
      action('report'),
      'All green',
      [],
    ],
    [
      'mcp__pantheon__edit_board',
      {
        base_version: 3,
        ops: [
          { type: 'set_task', task_id: 't2', patch: { model: 'm' } },
          { type: 'add_task', task: { id: 't9', title: 'New' } },
          { type: 'set_dependencies', task_id: 't2', depends_on: [] },
        ],
      },
      action('editPlan'),
      '3 处修改',
      ['t2', 't9'],
    ],
    ['pantheon.interrupt_task', { task_id: 't2' }, action('interrupt'), '', ['t2']],
    ['mcp__pantheon__sync_board', {}, action('syncBoard'), '', []],
    ['rerun_baseline', {}, action('rerunBaseline'), '', []],
    [
      'request_review',
      { session_id: 's-3', runtimes: ['codex'] },
      action('requestReview'),
      'codex',
      [],
    ],
  ])('labels %s', (name, input, title, detail, tasks) => {
    expect(orchestrationLabel(name, input)).toEqual({ title, detail, tasks });
  });

  it('chips the task a review receipt names', () => {
    const output = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ receipt: { requester: { task_id: 't3' }, state: 'running' } }),
        },
      ],
    };
    expect(
      orchestrationLabel('request_review', { session_id: 's-3', runtimes: ['codex'] }, output)
        ?.tasks,
    ).toEqual(['t3']);
  });

  it('reads the arguments Codex wraps in its MCP call input', () => {
    expect(
      orchestrationLabel('pantheon.message_task', {
        server: 'pantheon',
        tool: 'message_task',
        arguments: { task_id: 't1', text: 'Rebase first' },
      }),
    ).toEqual({ title: action('message'), detail: 'Rebase first', tasks: ['t1'] });
  });

  it('leaves reads and other tools to the tool rows', () => {
    expect(orchestrationLabel('mcp__pantheon__project_read', {})).toBeNull();
    expect(orchestrationLabel('pantheon.read_note', { note_id: 'n' })).toBeNull();
    expect(orchestrationLabel('Read', { file_path: '/a' })).toBeNull();
  });
});

describe('orchestration rows in the thread', () => {
  it('breaks a run of tool calls like text does', () => {
    const start = call('b', 'mcp__pantheon__start_task', { task_ids: ['t1'] });
    expect(groupToolCalls([call('a'), start, call('c'), call('d')])).toEqual([
      call('a'),
      start,
      { kind: 'group', calls: [call('c'), call('d')] },
    ]);
    const read = call('b', 'pantheon.project_read');
    expect(groupToolCalls([call('a'), read])).toEqual([
      { kind: 'group', calls: [call('a'), read] },
    ]);
  });

  it('draws an orchestration call with its own row for the rendering session', () => {
    const start = call('b', 'start_task', { task_ids: ['t1'] }, { ok: true });
    const shown = Items({
      items: [call('a'), start],
      verbose: false,
      ended: true,
      folders: [],
      sessionId: 'lead-1',
    });
    const row = find(shown, (n) => n.type === OrchestrationRow);
    expect(row.props).toMatchObject({ item: start, sessionId: 'lead-1', state: 'ok' });
    expect(nodes(shown).filter((n) => (n.type as any)?.name === 'ToolCall')).toHaveLength(1);
  });

  it('names the action, chips each task and folds out the input and output', () => {
    const h = mount(() =>
      OrchestrationRow({
        item: call(
          'b',
          'mcp__pantheon__stop_task',
          { task_id: 't2', reason: 'Wrong scope' },
          { ok: true, output: 'stopped', started_at: 1_000, completed_at: 3_500 },
        ),
        state: 'ok',
        depth: 0,
        open: false,
        enter: '',
        sessionId: 'lead-1',
      }),
    );
    const trigger = find(h.value, (n) => typeof n.props['aria-label'] === 'string');
    expect(trigger.props['aria-label']).toBe('停止，Wrong scope，stopped，2.5 秒');
    expect(text(find(h.value, (n) => n.props.className === 'ss-tn'))).toBe(action('stop'));
    const chips = nodes(h.value).filter((n) => n.type === TaskChip);
    expect(chips.map((n) => n.props)).toEqual([{ leadSessionId: 'lead-1', taskId: 't2' }]);
    expect(text(find(h.value, (n) => n.props.className === 'ss-ta'))).toBe('Wrong scope');
    expect(nodes(h.value).some((n) => (n.type as any)?.name === 'StateMark')).toBe(true);
    expect(find(h.value, (n) => n.props.label === zh('sessions.parts.input')).props.text).toContain(
      'Wrong scope',
    );
    expect(find(h.value, (n) => n.props.label === zh('sessions.parts.output')).props.text).toBe(
      'stopped',
    );
  });

  it('sums up the receipt and folds out the edits instead of the input and output', () => {
    const h = mount(() =>
      OrchestrationRow({
        item: call(
          'b',
          'mcp__pantheon__edit_board',
          {
            base_version: 14,
            ops: [{ type: 'set_task', task_id: 't2', patch: { model: 'claude-opus-5-5' } }],
          },
          {
            ok: true,
            output: {
              content: [{ type: 'text', text: '{"receipt":{"plan_version":15,"tasks":[]}}' }],
            },
          },
        ),
        state: 'ok',
        depth: 0,
        open: true,
        enter: '',
        sessionId: 'lead-1',
      }),
    );
    expect(text(find(h.value, (n) => n.props.className === 'ss-ts'))).toBe(
      zhf('data.toolCalls.savedVersion', { version: 15 }),
    );
    expect(
      nodes(h.value).some((n) =>
        [zh('sessions.parts.input'), zh('sessions.parts.output')].includes(n.props.label),
      ),
    ).toBe(false);
    const panel = find(h.value, (n) => n.props.className === 'ss-olist');
    expect(text(panel)).toContain('model=claude-opus-5-5');
    expect(text(panel)).not.toMatch(/[{"]/);
    expect(
      nodes(panel)
        .filter((n) => n.type === TaskChip)
        .map((n) => n.props.taskId),
    ).toEqual(['t2']);
  });

  it('shows the first sentence of a refusal on the row', () => {
    const h = mount(() =>
      OrchestrationRow({
        item: call(
          'b',
          'interrupt_task',
          { task_id: 't1' },
          {
            ok: false,
            output: {
              content: [
                {
                  type: 'text',
                  text: 'Refused task.interrupt: resource_busy — Task t1 has no running turn to interrupt',
                },
              ],
            },
          },
        ),
        state: 'failed',
        depth: 0,
        open: false,
        enter: '',
        sessionId: 'lead-1',
      }),
    );
    expect(text(find(h.value, (n) => n.props.className === 'ss-ts'))).toBe(
      zhf('data.toolCalls.refused', { reason: 'Task t1 has no running turn to interrupt' }),
    );
  });

  it('shows a task the board does not name by its raw id in mono, not as a link', () => {
    const chip = mount(() => TaskChip({ leadSessionId: 'lead-1', taskId: 't9' })).value;
    expect(chip.type).toBe('span');
    expect(chip.props.className).toBe('tchip mono');
    expect(text(chip)).toBe('t9');
    expect(nodes(chip).some((n) => n.type === 'button')).toBe(false);
  });

  it('names a task by its newest session, with its runtime, and opens that session', () => {
    const task = (id: string, title: string, runtime: string, taskId = 't1') => ({
      id,
      title,
      runtime,
      task: { lead_session_id: 'lead-1', id: taskId },
    });
    mock.board.board.sessions = [
      task('s-old', 'Add a.txt', 'claude'),
      task('s-other', 'Other', 'claude', 't2'),
      task('s-new', 'Add a.txt again', 'codex'),
    ];
    mock.opened = [];
    const chip = mount(() => TaskChip({ leadSessionId: 'lead-1', taskId: 't1' })).value;
    expect(chip.type).toBe('button');
    expect(text(chip)).toBe('Add a.txt again');
    expect(find(chip, (n) => n.type === RuntimeGlyph).props.runtime).toBe('codex');
    chip.props.onClick();
    expect(mock.opened).toEqual(['s-new']);
  });

  it('names a task by its id while its session has a blank title', () => {
    mock.board.board.sessions = [
      { id: 's1', title: ' ', runtime: 'claude', task: { lead_session_id: 'lead-1', id: 't1' } },
    ];
    const chip = mount(() => TaskChip({ leadSessionId: 'lead-1', taskId: 't1' })).value;
    expect(chip.type).toBe('button');
    expect(text(chip)).toBe('t1');
  });
});
