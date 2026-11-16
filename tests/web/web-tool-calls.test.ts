import { describe, expect, it } from 'vitest';
import {
  isTruncated,
  orchestrationDetail,
  orchestrationResult,
  toolGroupLabel,
  toolLabel,
  toolOutcome,
  toolFiles,
  toolOutputText,
} from '@/data/tool-calls';
import { zh } from './i18n-setup.js';

const tc = (key: string) => zh(`data.toolCalls.${key}`);

const bases = ['/repo/app'];

describe('tool call labels from Claude', () => {
  it.each([
    [
      'Bash',
      { command: 'git status\n  --short', description: 'Show status' },
      'Bash',
      'git status --short',
    ],
    ['Read', { file_path: '/repo/app/src/main.ts', offset: 10 }, 'Read', 'src/main.ts'],
    [
      'Edit',
      { file_path: '/elsewhere/x.ts', old_string: 'a', new_string: 'b' },
      'Edit',
      '/elsewhere/x.ts',
    ],
    ['Write', { file_path: '/repo/app/notes.md', content: 'hello' }, 'Write', 'notes.md'],
    ['Glob', { pattern: '**/*.ts', path: '/repo/app/src' }, 'Glob', '**/*.ts, src'],
    ['Grep', { pattern: 'TODO', path: '/repo/app', glob: '*.ts' }, 'Grep', 'TODO, ., *.ts'],
    ['WebFetch', { url: 'https://example.com/a' }, 'WebFetch', 'https://example.com/a'],
    ['WebSearch', { query: 'vitest each' }, 'WebSearch', 'vitest each'],
    [
      'Task',
      { description: 'Find callers', prompt: 'long prompt', subagent_type: 'Explore' },
      'Task, Explore',
      'Find callers',
    ],
    ['Agent', { description: 'Review diff', prompt: 'p' }, 'Agent', 'Review diff'],
  ])('labels %s', (name, input, title, detail) => {
    expect(toolLabel(name, input, bases)).toEqual({ title, detail });
  });

  it('shows a todo list as the done count of the total and the step in progress', () => {
    const todos = [
      { content: 'Read the spec', status: 'completed' },
      { content: 'Write tests', status: 'in_progress' },
      { content: 'Ship', status: 'in_progress' },
      { content: 'Review', status: 'pending' },
    ];
    expect(toolLabel('TodoWrite', { todos })).toEqual({
      title: tc('todos'),
      detail: '1/4 Write tests',
    });
    expect(toolLabel('TodoWrite', { todos: todos.slice(0, 1) })).toEqual({
      title: tc('todos'),
      detail: '1/1',
    });
  });

  it('splits an MCP name into server and tool and shows its first short scalar arguments', () => {
    expect(
      toolLabel(
        'mcp__pantheon__project_read',
        { project_id: 'p-1', include: { deep: true }, verbose: true, limit: 5 },
        bases,
      ),
    ).toEqual({ title: 'pantheon, project_read', detail: 'project_id=p-1, verbose=true' });
  });

  it('falls back to the first short string field of an unknown tool', () => {
    expect(toolLabel('Mystery', { count: 3, long: 'x'.repeat(500), note: 'hi' })).toEqual({
      title: 'Mystery',
      detail: 'hi',
    });
    expect(toolLabel('', undefined)).toEqual({ title: tc('unknownTool'), detail: '' });
  });
});

describe('tool call labels from Codex', () => {
  it.each([
    [
      'commandExecution',
      { command: 'pnpm test', cwd: '/repo/app' },
      tc('title.commandExecution'),
      'pnpm test',
    ],
    [
      'local_shell_call',
      { type: 'exec', command: ['bash', '-lc', 'ls -la'] },
      tc('title.localShellCall'),
      'ls -la',
    ],
    [
      'fileChange',
      { changes: [{ path: '/repo/app/a.ts', kind: 'update' }, { path: '/tmp/b.ts' }] },
      tc('title.fileChange'),
      'a.ts, /tmp/b.ts',
    ],
    ['webSearch', { query: 'zod strictObject' }, tc('title.webSearch'), 'zod strictObject'],
    ['imageView', { path: '/repo/app/shot.png' }, tc('title.imageView'), 'shot.png'],
    [
      'pantheon.project_read',
      { server: 'pantheon', tool: 'project_read', arguments: { project_id: 'p-1' } },
      'pantheon, project_read',
      'project_id=p-1',
    ],
    [
      'dynamicToolCall',
      { namespace: 'board', tool: 'lookup', arguments: { id: 'n-2' } },
      'board, lookup',
      'id=n-2',
    ],
    [
      'collabAgentToolCall',
      { tool: 'spawn', senderThreadId: 't', prompt: 'Check the\nlogs' },
      tc('title.collabAgentToolCall'),
      'spawn, Check the logs',
    ],
    ['functions.exec_command', { cmd: 'git diff' }, 'functions, exec_command', 'cmd=git diff'],
    ['shell', { command: ['bash', '-lc', 'cat README.md'] }, 'shell', 'cat README.md'],
  ])('labels %s', (name, input, title, detail) => {
    expect(toolLabel(name, input, bases)).toEqual({ title, detail });
  });
});

describe('tool group labels', () => {
  const c = (name: string, input: unknown = {}) => ({ name, input });

  it('names the two highest kinds and counts the other calls', () => {
    expect(
      toolGroupLabel([
        c('Read', { file_path: '/repo/x.ts' }),
        c('Edit', { file_path: '/repo/a.ts' }),
        c('Bash', { command: 'ls' }),
        c('Edit', { file_path: '/repo/a.ts' }),
        c('commandExecution', { command: 'pnpm test' }),
        c('Write', { file_path: '/repo/b.ts' }),
        c('local_shell_call', { command: ['ls'] }),
        c('fileChange', { changes: [{ path: '/repo/c.ts' }, { path: '/repo/a.ts' }] }),
        c('shell', { command: ['ls'] }),
        c('WebFetch', { url: 'https://example.com' }),
      ]),
    ).toBe('运行 4 条命令，改了 3 个文件，另 2 项');
  });

  it('orders kinds by priority rather than by first call', () => {
    expect(
      toolGroupLabel([
        c('Read', { file_path: '/repo/x.ts' }),
        c('Read', { file_path: '/repo/x.ts' }),
        c('Bash', { command: 'ls' }),
      ]),
    ).toBe('运行 1 条命令，读了 1 个文件');
  });

  it('counts subagents, web lookups, MCP servers and reads', () => {
    expect(
      toolGroupLabel([
        c('WebSearch'),
        c('Task'),
        c('Agent'),
        c('collabAgentToolCall'),
        c('webSearch'),
        c('Glob'),
        c('Grep'),
      ]),
    ).toBe('派了 3 个子代理，查了 2 次网页，另 2 项');
    expect(
      toolGroupLabel([c('mcp__pantheon__a'), c('mcp__github__b'), c('mcp__pantheon__c')]),
    ).toBe('用了 pantheon 2 次，用了 github 1 次');
    expect(
      toolGroupLabel([
        c('Read', { file_path: '/repo/a.ts' }),
        c('Read', { file_path: '/repo/b.ts' }),
        c('Glob'),
        c('Grep'),
      ]),
    ).toBe('读了 4 个文件');
    expect(toolGroupLabel([c('TodoWrite'), c('Mystery')])).toBe('2 个工具调用');
    expect(toolGroupLabel([c('Read', { file_path: '/repo/a.ts' }), c('Mystery')])).toBe(
      '读了 1 个文件，另 1 项',
    );
  });

  it("counts dsh's lowercase tool names by kind", () => {
    expect(
      toolGroupLabel([
        c('bash', { command: 'ls' }),
        c('edit', { file_path: '/repo/a.ts' }),
        c('write', { file_path: '/repo/a.ts' }),
      ]),
    ).toBe('运行 1 条命令，改了 1 个文件');
    expect(
      toolGroupLabel([c('subagent'), c('subagent_fork'), c('web_fetch'), c('web_search')]),
    ).toBe('派了 2 个子代理，查了 2 次网页');
    expect(
      toolGroupLabel([
        c('read', { file_path: '/repo/a.ts' }),
        c('read', { file_path: '/repo/a.ts' }),
        c('glob'),
        c('grep'),
      ]),
    ).toBe('读了 3 个文件');
  });
});

describe('tool results', () => {
  it('reads Claude content as a string or as text parts', () => {
    expect(toolOutputText({ content: 'one\ntwo' })).toBe('one\ntwo');
    expect(
      toolOutputText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a\nb');
  });

  it('summarises a single line, a line count and an exit code', () => {
    expect(toolOutcome({ content: 'Found 3 files' }, true)).toBe('Found 3 files');
    expect(toolOutcome({ content: '1\n2\n3\n' }, true)).toBe('3 行');
    expect(toolOutcome({ text: 'ok\n', exitCode: 0, status: 'completed' }, true)).toBe(
      '退出码 0，ok',
    );
    expect(toolOutcome({ text: '' }, true)).toBe('');
  });

  it('shows nothing for the receipt a Pantheon command returns, and keeps JSON a command printed', () => {
    expect(toolOutcome(receipt({ visual_id: 'cb265e12-d285', revision: 1 }), true)).toBe('');
    expect(toolOutcome({ content: '{"count":3}' }, true)).toBe('{"count":3}');
  });

  it('marks a failure with its exit code and first line', () => {
    expect(toolOutcome({ text: '\nfatal: not a repo\nmore', exitCode: 128 }, false)).toBe(
      '失败，退出码 128，fatal: not a repo',
    );
    expect(toolOutcome({ result: null, error: 'server gone' }, false)).toBe('失败，server gone');
    expect(toolOutcome(undefined, false)).toBe(tc('failed'));
  });

  it('tells a truncated payload from a whole one', () => {
    expect(isTruncated({ content: 'x'.repeat(4096), truncated: true })).toBe(true);
    expect(isTruncated({ content: 'x' })).toBe(false);
    expect(isTruncated(undefined)).toBe(false);
    // A truncated flag is not an argument.
    expect(toolLabel('mcp__s__t', { a: 'x', truncated: true }).detail).toBe('a=x');
  });
});

const receipt = (value: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify({ receipt: value }) }],
});
const BRIEF = [
  'Sync the board with the project as it is now.',
  'Your plan: Refunds',
  '- t1 "Refund idempotency": done; sessions: s-1 closed/merged',
  '- t2 "Webhook signature": active; sessions: s-2 running',
  '- t3 "Refund list": todo; sessions: none',
  'Recent commits in /repo:',
  '- a3f9c21 2026-11-09 Add refund keys',
].join('\n');

describe('orchestration results', () => {
  it.each([
    ['mcp__pantheon__edit_board', {}, { plan_version: 15, tasks: [] }, '已写入 v15'],
    ['update_board', {}, { plan_version: 14, tasks: [] }, '已写入 v14'],
    [
      'start_task',
      { task_ids: ['t1', 't2', 't3'] },
      { requested: ['t0', 't1', 't2', 't3'] },
      '3 个已排队',
    ],
    ['start_task', { task_ids: ['t4'] }, { claimed: 't4', generation: 1 }, tc('claimed')],
    ['interrupt_task', { task_id: 't2' }, { task_id: 't2', session_id: 's-2' }, tc('interrupted')],
    [
      'stop_task',
      { task_id: 't2', reason: 'Wrong scope' },
      { task_id: 't2', dequeued: false, sessions: [{ session_id: 's-2', step: 'stopping' }] },
      tc('stopping'),
    ],
    [
      'stop_task',
      { task_id: 't2', reason: 'Wrong scope' },
      { task_id: 't2', dequeued: true, sessions: [{ session_id: 's-2', step: 'discarded' }] },
      tc('stopped'),
    ],
    ['propose_improvement', {}, { id: 'i-1', status: 'candidate' }, tc('improvement.candidate')],
    ['propose_improvement', {}, { id: 'i-1', status: 'trial' }, tc('improvement.trial')],
    ['pantheon.sync_board', {}, { brief: BRIEF }, tc('read')],
    [
      'rerun_baseline',
      {},
      { id: 'b-1', state: 'running', session_id: 's-9' },
      tc('baseline.running'),
    ],
    ['rerun_baseline', {}, { id: 'b-1', state: 'empty' }, tc('baseline.empty')],
    [
      'request_review',
      { session_id: 's-3', runtimes: ['codex'] },
      { review_id: 'r-1', state: 'running' },
      tc('review.running'),
    ],
  ])('sums up the receipt of %s', (name, input, value, expected) => {
    expect(orchestrationResult(name, input, receipt(value), true)).toBe(expected);
  });

  it('reads a receipt from the text of a Codex MCP result', () => {
    const output = {
      result: { content: [{ type: 'text', text: '{"receipt":{"plan_version":3}}' }] },
    };
    expect(orchestrationResult('pantheon.edit_board', {}, output, true)).toBe('已写入 v3');
  });

  it('shows the first sentence of a refusal or an error', () => {
    const said = (text: string) => ({ content: [{ type: 'text', text }] });
    expect(
      orchestrationResult(
        'interrupt_task',
        { task_id: 't1' },
        said(
          'Refused task.interrupt: resource_busy — Task t1 has no running turn to interrupt. Wait.',
        ),
        false,
      ),
    ).toBe('已拒绝：Task t1 has no running turn to interrupt.');
    expect(
      orchestrationResult('sync_board', {}, said('Refused board.sync: permission_denied'), false),
    ).toBe('已拒绝：permission_denied');
    expect(orchestrationResult('request_review', {}, { error: 'server gone. Retry.' }, false)).toBe(
      'server gone.',
    );
    expect(orchestrationResult('edit_board', {}, undefined, false)).toBe(tc('failed'));
  });

  it('keeps the one-line outcome of a call whose output is no receipt', () => {
    expect(orchestrationResult('stop_task', {}, 'stopped', true)).toBe('stopped');
  });
});

describe('orchestration details', () => {
  it('lists each edit of the plan by its task and fields', () => {
    expect(
      orchestrationDetail(
        'edit_board',
        {
          base_version: 14,
          ops: [
            {
              type: 'set_task',
              task_id: 't2',
              patch: { model: 'claude-opus-5-5', runtime: 'claude' },
            },
            { type: 'add_task', task: { id: 't9', title: 'Refund report' } },
            { type: 'remove_task', task_id: 't4' },
            { type: 'set_dependencies', task_id: 't3', depends_on: ['t1', 't2'] },
            { type: 'resolve_edit', edit_id: 'e-1', decision: 'reject', reason: 'Out of scope' },
          ],
        },
        receipt({ plan_version: 15 }),
      ),
    ).toEqual([
      { task: 't2', name: tc('edit.set'), code: 'model=claude-opus-5-5, runtime=claude' },
      { task: 't9', name: tc('edit.add'), text: 'Refund report' },
      { task: 't4', name: tc('edit.remove') },
      { task: 't3', name: tc('edit.dependsOn'), code: 't1, t2' },
      { name: tc('edit.reject'), code: 'e-1', text: 'Out of scope' },
    ]);
  });

  it('lists each task of a board sync with its state and sessions', () => {
    expect(orchestrationDetail('sync_board', {}, receipt({ brief: BRIEF }))).toEqual([
      { task: 't1', name: tc('taskState.done'), code: 's-1 closed/merged' },
      { task: 't2', name: tc('taskState.active'), code: 's-2 running' },
      { task: 't3', name: tc('taskState.todo') },
    ]);
  });

  it('lists the started tasks, the stopped sessions, the proposal and the reviewers', () => {
    expect(
      orchestrationDetail('start_task', { task_ids: ['t1', 't2'] }, receipt({ requested: ['t1'] })),
    ).toEqual([{ task: 't1', name: tc('queued') }, { task: 't2' }]);
    expect(
      orchestrationDetail(
        'stop_task',
        { task_id: 't2', reason: 'Wrong scope' },
        receipt({ sessions: [{ session_id: 's-2', step: 'discarded' }] }),
      ),
    ).toEqual([{ name: tc('discarded'), code: 's-2' }]);
    expect(
      orchestrationDetail(
        'propose_improvement',
        {
          retrospective_ids: ['r1', 'r2'],
          change: { type: 'policy_change', param: 'max_parallel', to: 3 },
        },
        receipt({ status: 'candidate' }),
      ),
    ).toEqual([{ name: 'max_parallel', code: '3' }]);
    expect(
      orchestrationDetail(
        'propose_improvement',
        {
          retrospective_ids: ['r1', 'r2'],
          change: { type: 'experience', procedure: 'Run the tests first', runtime: 'codex' },
        },
        undefined,
      ),
    ).toEqual([{ name: tc('procedure'), text: 'Run the tests first', code: 'codex' }]);
    expect(
      orchestrationDetail(
        'request_review',
        { session_id: 's-3', runtimes: ['codex', 'claude'] },
        undefined,
      ),
    ).toEqual([{ name: tc('reviewEntry'), code: 'codex, claude' }]);
  });

  it('has no structure for other calls', () => {
    expect(
      orchestrationDetail('accept_task', { task_id: 't1', evidence: 'ok' }, undefined),
    ).toBeNull();
    expect(orchestrationDetail('interrupt_task', { task_id: 't1' }, undefined)).toBeNull();
    expect(
      orchestrationDetail('sync_board', {}, receipt({ brief: 'You have no plan yet.' })),
    ).toBeNull();
  });
});

describe('the files a call touched', () => {
  it('names the files an indexed Codex file_change changed', () => {
    const changes = [{ path: '/repo/src/a.ts' }, { path: '/repo/src/b.ts' }];
    expect(toolFiles('file_change', { changes }, undefined, ['/repo'])).toEqual(
      toolFiles('fileChange', { changes }, undefined, ['/repo']),
    );
    expect(toolFiles('file_change', { changes }, undefined, ['/repo'])).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });
});
