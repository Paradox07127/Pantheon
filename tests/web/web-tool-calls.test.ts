import { describe, expect, it } from 'vitest';
import {
  isTruncated,
  orchestrationDetail,
  orchestrationLabel,
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

describe('orchestration results', () => {
  it.each([
    ['request_review', { review_id: 'r-1', state: 'running' }, tc('review.running')],
    ['mcp__pantheon__request_review', { review_id: 'r-1', state: 'failed' }, tc('review.failed')],
  ])('sums up the receipt of %s', (name, value, expected) => {
    expect(orchestrationResult(name, receipt(value), true)).toBe(expected);
  });

  it('sums up the receipts of the conductor tools', () => {
    expect(
      orchestrationResult(
        'request_review',
        receipt({ review_id: 'r-1', runtimes: ['codex'] }),
        true,
      ),
    ).toBe(tc('review.running'));
    expect(orchestrationResult('spawn_session', receipt({ session_id: 's-9' }), true)).toBe(
      '已开 s-9',
    );
    expect(
      orchestrationResult(
        'report_ready',
        receipt({ session_id: 's-9', next: 'The gate runs now' }),
        true,
      ),
    ).toBe(tc('ready.gating'));
    expect(
      orchestrationResult('report_ready', receipt({ next: 'The gate and landing start' }), true),
    ).toBe(tc('ready.afterTurn'));
    expect(
      orchestrationResult('read_state', receipt({ changes: [{}, {}], todo: [{}] }), true),
    ).toBe('2 项改动，1 项等你处理');
  });

  it('reads a receipt from the text of a Codex MCP result', () => {
    const output = {
      result: { content: [{ type: 'text', text: '{"receipt":{"state":"completed"}}' }] },
    };
    expect(orchestrationResult('pantheon.request_review', output, true)).toBe(
      tc('review.completed'),
    );
  });

  it('shows the first sentence of a refusal or an error', () => {
    const said = (text: string) => ({ content: [{ type: 'text', text }] });
    expect(
      orchestrationResult(
        'request_review',
        said('Refused conductor.review: resource_busy — A review is already running. Wait.'),
        false,
      ),
    ).toBe('已拒绝：A review is already running.');
    expect(
      orchestrationResult(
        'request_review',
        said('Refused conductor.review: permission_denied'),
        false,
      ),
    ).toBe('已拒绝：permission_denied');
    expect(orchestrationResult('request_review', { error: 'server gone. Retry.' }, false)).toBe(
      'server gone.',
    );
    expect(orchestrationResult('request_review', undefined, false)).toBe(tc('failed'));
  });

  it('keeps the one-line outcome of a call whose output is no receipt', () => {
    expect(orchestrationResult('request_review', 'queued', true)).toBe('queued');
  });
});

describe('orchestration details', () => {
  it('lists the reviewers', () => {
    expect(
      orchestrationDetail('request_review', { session_id: 's-3', runtimes: ['codex', 'claude'] }),
    ).toEqual([
      { name: tc('reviewEntry'), code: 'codex, claude' },
      { name: tc('sessionEntry'), code: 's-3' },
    ]);
    expect(orchestrationDetail('request_review', { runtimes: ['codex'] })).toEqual([
      { name: tc('reviewEntry'), code: 'codex' },
    ]);
  });

  it('gives the conductor tools their own rows', () => {
    expect(orchestrationLabel('spawn_session', { runtime: 'codex', input: 'Fix it' })).toEqual({
      title: tc('action.spawnSession'),
      detail: 'codex',
    });
    expect(orchestrationLabel('report_ready', { session_id: 's-9' })).toEqual({
      title: tc('action.reportReady'),
      detail: 's-9',
    });
    expect(orchestrationLabel('read_state', {})).toEqual({
      title: tc('action.readState'),
      detail: '',
    });
  });

  it('folds out what each conductor tool was given or returned', () => {
    expect(
      orchestrationDetail('spawn_session', { runtime: 'codex', input: 'Fix the importer' }),
    ).toEqual([
      { name: tc('runtimeEntry'), code: 'codex' },
      { name: tc('inputEntry'), code: 'Fix the importer', prose: true },
    ]);
    expect(orchestrationDetail('report_ready', { session_id: 's-9' })).toEqual([
      { name: tc('sessionEntry'), code: 's-9' },
    ]);
    expect(
      orchestrationDetail('read_state', {}, receipt({ changes: [{}, {}], todo: [{}] })),
    ).toEqual([
      { name: tc('changesEntry'), code: '2' },
      { name: tc('todoEntry'), code: '1' },
    ]);
  });

  it('has nothing to fold out without arguments or a receipt to show', () => {
    expect(orchestrationDetail('report_ready', {})).toEqual([]);
    expect(orchestrationDetail('read_state', {})).toEqual([]);
    expect(orchestrationDetail('spawn_session', {})).toEqual([]);
  });

  it('has no structure for other calls', () => {
    expect(orchestrationDetail('accept_task', { task_id: 't1', evidence: 'ok' })).toBeNull();
    expect(orchestrationDetail('start_task', { task_ids: ['t1'] })).toBeNull();
    expect(orchestrationDetail('Read', { file_path: '/a' })).toBeNull();
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
