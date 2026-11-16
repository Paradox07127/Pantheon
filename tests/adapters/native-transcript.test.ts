import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeReducer, createCodexReducer, probeMeta } from '@pantheon/adapters';
import type { TraceSpan } from '@pantheon/domain';

const mainLane = { native_id: 'a3dfdf53-2ff2-4483-b589-5d7eba2b9dab' };
const codexLane = { native_id: '01a19da1-4c93-7b13-96b4-2afba9c24ed0' };

const codexLine = (timestamp: string, payload: Record<string, unknown>, type = 'event_msg') =>
  JSON.stringify({ timestamp, type, payload });
const codexPrompt = (timestamp: string, ...texts: string[]) =>
  codexLine(
    timestamp,
    { type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) },
    'response_item',
  );
const codexAt = (second: number) => `2026-11-02T10:00:${String(second).padStart(2, '0')}.000Z`;
const agentsText = '# AGENTS.md instructions for /repo\n\nKeep tests green.';
const environmentText = '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>';
const codexAborted = [
  codexLine(codexAt(0), { type: 'task_started', turn_id: 'first' }),
  codexPrompt(
    codexAt(1),
    agentsText,
    environmentText,
    '\n  Rename the board check  \nand keep tests',
  ),
  codexLine(codexAt(2), { type: 'turn_aborted', turn_id: 'first', reason: 'interrupted' }),
  codexLine(codexAt(3), { type: 'task_started', turn_id: 'second' }),
  codexPrompt(codexAt(4), 'Second prompt'),
  codexLine(codexAt(5), { type: 'task_complete', turn_id: 'second' }),
  codexLine(codexAt(6), { type: 'token_count', info: null }),
];

const claudeUser = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-10-30T06:00:00.000Z',
    message: { role: 'user', content },
    ...extra,
  });
const customTitle = (title: string) =>
  JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 'session' });
const claudePrompts = [
  claudeUser('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
  claudeUser('Meta prompt', { isMeta: true }),
  claudeUser('Sidechain prompt', { isSidechain: true }),
  claudeUser([{ type: 'text', text: '<command-name>/clear</command-name>' }]),
  claudeUser([{ type: 'tool_result', tool_use_id: 'call', content: 'output' }]),
  claudeUser([{ type: 'image' }, { type: 'text', text: '\n  Fix the board check\nwith details' }]),
  claudeUser('Later prompt'),
];
const claudeTitled = [customTitle('First name'), ...claudePrompts, customTitle('Second name')];

const ofKind = (spans: TraceSpan[], ...kinds: TraceSpan['kind'][]): TraceSpan[] =>
  spans.filter((span) => kinds.includes(span.kind));

describe('Claude transcript reducer', () => {
  it('records the commit a Bash call printed', () => {
    const reducer = createClaudeReducer({ native_id: 'session' });
    const at = '2026-10-30T06:11:11.874Z';
    reducer.push(
      JSON.stringify({
        type: 'user',
        timestamp: at,
        turnPosition: { turnIndex: 1 },
        message: { content: 'commit it' },
      }),
    );
    reducer.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: at,
        message: {
          content: [
            { type: 'tool_use', id: 'bash-call', name: 'Bash', input: {} },
            { type: 'tool_use', id: 'read-call', name: 'Read', input: { file_path: 'a.ts' } },
          ],
        },
      }),
    );
    reducer.push(
      JSON.stringify({
        type: 'user',
        timestamp: at,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'bash-call',
              content: [{ type: 'text', text: 'hint\n[main (root-commit) 1a2b3c4] add a\n' }],
            },
            { type: 'tool_result', tool_use_id: 'read-call', content: '[main 1a2b3c4] a' },
          ],
        },
      }),
    );
    const spans = reducer.spans();
    expect(spans.find((span) => span.id === 'bash-call')?.commit).toEqual({
      sha: '1a2b3c4',
      via: 'bash_output',
    });
    const read = spans.find((span) => span.id === 'read-call');
    expect(read?.commit).toBeUndefined();
    expect(read?.files).toEqual(['a.ts']);
  });

  it('ends a turn at its own work, not at replayed history, queued prompts or compaction', () => {
    const reducer = createClaudeReducer({ native_id: 'session' });
    const row = (uuid: string, at: string, extra: Record<string, unknown>) =>
      JSON.stringify({ uuid, timestamp: `2026-11-01T${at}.000Z`, ...extra });
    const prompt = (uuid: string, at: string, turnIndex: number, extra = {}) =>
      row(uuid, at, {
        type: 'user',
        turnPosition: { turnIndex },
        message: { content: `prompt ${turnIndex}` },
        ...extra,
      });
    const reply = (uuid: string, at: string) =>
      row(uuid, at, { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    for (const line of [
      prompt('p1', '10:00:00', 1),
      reply('a1', '10:01:00'),
      row('compact', '11:00:00', { type: 'system', subtype: 'compact_boundary' }),
      prompt('summary', '11:00:00', 1, { isCompactSummary: true }),
      row('queued', '15:00:00', { type: 'queue-operation' }),
      prompt('p2', '15:00:01', 2),
      reply('a2', '15:02:00'),
      // History replayed after a resume keeps the rows' own uuids and times.
      prompt('p1', '10:00:00', 1),
      reply('a1', '10:01:00'),
      prompt('p2', '15:00:01', 2),
      reply('a3', '15:03:00'),
    ])
      reducer.push(line);
    const turns = ofKind(reducer.spans(), 'turn').map(({ id, start, end }) => ({ id, start, end }));
    expect(turns).toEqual([
      {
        id: 'session:turn:1',
        start: Date.parse('2026-11-01T10:00:00.000Z'),
        end: Date.parse('2026-11-01T10:01:00.000Z'),
      },
      {
        id: 'session:turn:2',
        start: Date.parse('2026-11-01T15:00:01.000Z'),
        end: Date.parse('2026-11-01T15:03:00.000Z'),
      },
    ]);
  });

  it('counts cache reads and cache writes in a model call input', () => {
    const reducer = createClaudeReducer({ native_id: 'session' });
    const at = '2026-10-30T06:11:11.874Z';
    reducer.push(JSON.stringify({ type: 'api-request', id: 'request', timestamp: at }));
    reducer.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: at,
        requestRef: 'request',
        message: {
          model: 'claude-model',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 10,
            output_tokens: 7,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
      }),
    );
    expect(reducer.spans().find((span) => span.id === 'request')?.tokens).toEqual({
      input: 160,
      output: 7,
      cache_read: 100,
    });
  });

  it('titles a session with its latest custom title', () => {
    const reducer = createClaudeReducer({ native_id: 'session' });
    for (const line of claudeTitled) reducer.push(line);
    expect(reducer.title()).toBe('Second name');
  });

  it('titles a session without a custom title with its first typed prompt', () => {
    const reducer = createClaudeReducer({ native_id: 'session' });
    for (const line of claudePrompts) reducer.push(line);
    expect(reducer.title()).toBe('Fix the board check');
  });

  it('titles a session with a typed first prompt that starts with a tag', () => {
    const reducer = createClaudeReducer({ native_id: 'session' });
    reducer.push(claudeUser('<system-reminder>Context</system-reminder>'));
    reducer.push(claudeUser('<local-command-stdout>done</local-command-stdout>'));
    reducer.push(claudeUser([{ type: 'text', text: '<html>\n<body>Fix this</body>' }]));
    reducer.push(claudeUser('Later prompt'));
    expect(reducer.title()).toBe('<html>');
  });
});

describe('Codex rollout reducer', () => {
  it('puts an execution step under the call that was running when the step started', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    const call = (second: number, call_id: string) =>
      codexLine(codexAt(second), { type: 'function_call', call_id, name: 'exec' }, 'response_item');
    for (const line of [
      codexLine(codexAt(0), { type: 'task_started', turn_id: 'parallel' }),
      call(1, 'earlier-call'),
      call(2, 'later-call'),
      codexLine(codexAt(3), {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'command-step',
          status: 'completed',
          duration: { secs: 2, nanos: 0 },
        },
      }),
    ])
      reducer.push(line);
    expect(reducer.spans().find((span) => span.id === 'command-step')).toMatchObject({
      start: Date.parse(codexAt(1)),
      parent: 'earlier-call',
    });
  });

  it('merges an execution step that carries its call id into that call', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    for (const line of [
      codexLine(codexAt(0), { type: 'task_started', turn_id: 'paginated' }),
      codexLine(
        codexAt(1),
        { type: 'function_call', call_id: 'shared', name: 'shell', arguments: '{"cmd":"sleep 1"}' },
        'response_item',
      ),
      codexLine(codexAt(3), {
        type: 'item_completed',
        item: {
          type: 'CommandExecution',
          id: 'shared',
          status: 'completed',
          exit_code: 2,
          duration: { secs: 1, nanos: 0 },
        },
      }),
    ])
      reducer.push(line);
    const shared = reducer.spans().filter((span) => span.id === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      parent: 'rollout:turn:1',
      name: 'shell',
      input_summary: 'sleep 1',
      start: Date.parse(codexAt(1)),
      end: Date.parse(codexAt(3)),
      status: 'error',
      exit_code: 2,
    });
  });

  it('reads a local shell call with its action as input', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    for (const line of [
      codexLine(codexAt(0), { type: 'task_started', turn_id: 'local' }),
      codexLine(
        codexAt(1),
        {
          type: 'local_shell_call',
          call_id: 'local',
          status: 'completed',
          action: { type: 'exec', command: ['ls', '-la'] },
        },
        'response_item',
      ),
      codexLine(
        codexAt(2),
        { type: 'function_call_output', call_id: 'local', output: 'listing' },
        'response_item',
      ),
    ])
      reducer.push(line);
    expect(reducer.spans().find((span) => span.id === 'local')).toMatchObject({
      name: 'local_shell_call',
      input_summary: 'ls -la',
      end: Date.parse(codexAt(2)),
    });
  });

  it('fails a shell call whose text output reports a nonzero exit and counts its retry', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    const call = (second: number, id: string) =>
      codexLine(
        codexAt(second),
        { type: 'function_call', call_id: id, name: 'shell', arguments: '{"command":["false"]}' },
        'response_item',
      );
    const output = (second: number, id: string, text: unknown) =>
      codexLine(
        codexAt(second),
        { type: 'function_call_output', call_id: id, output: text },
        'response_item',
      );
    for (const line of [
      codexLine(codexAt(0), { type: 'task_started', turn_id: 'retry' }),
      call(1, 'first'),
      output(2, 'first', 'Process exited with code 1\nOutput:\nExit code: 0\n'),
      call(3, 'second'),
      output(4, 'second', [{ type: 'input_text', text: 'Exit code: 0\nOutput:\n' }]),
      call(5, 'silent'),
      output(6, 'silent', 'listing'),
    ])
      reducer.push(line);
    const spans = reducer.spans();
    expect(spans.find((span) => span.id === 'first')?.status).toBe('error');
    expect(spans.find((span) => span.id === 'second')).toMatchObject({
      status: 'ok',
      retry_count: 1,
    });
    expect(spans.find((span) => span.id === 'silent')?.status).toBe('unknown');
  });

  it('names a namespaced call with its namespace', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    for (const line of [
      codexLine(codexAt(0), { type: 'task_started', turn_id: 'namespaced' }),
      codexLine(
        codexAt(3),
        {
          type: 'function_call',
          call_id: 'namespaced',
          namespace: 'files',
          name: 'read',
          arguments: '{"path":"a.ts"}',
        },
        'response_item',
      ),
    ])
      reducer.push(line);
    expect(reducer.spans().find((span) => span.id === 'namespaced')?.name).toBe('files.read');
  });

  it('times an execution step by the start and end Codex recorded for it', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    const ms = (second: number) => Date.parse(codexAt(second));
    for (const line of [
      codexLine(codexAt(0), { type: 'task_started', turn_id: 'timed' }),
      codexLine(
        codexAt(1),
        { type: 'function_call', call_id: 'call', name: 'exec' },
        'response_item',
      ),
      codexLine(codexAt(5), {
        type: 'item_completed',
        item: { type: 'FileChange', id: 'patch-step', status: 'completed', changes: {} },
        started_at_ms: ms(2),
        completed_at_ms: ms(3),
      }),
      codexLine(codexAt(40), {
        type: 'item_completed',
        item: {
          type: 'McpToolCall',
          id: 'mcp-step',
          server: 'docs',
          tool: 'search',
          status: 'completed',
          duration: { secs: 0, nanos: 0 },
        },
        started_at_ms: ms(2),
        completed_at_ms: ms(39),
      }),
    ])
      reducer.push(line);
    const spans = reducer.spans();
    expect(spans.find((span) => span.id === 'patch-step')).toMatchObject({
      start: ms(2),
      end: ms(3),
      parent: 'call',
    });
    expect(spans.find((span) => span.id === 'mcp-step')).toMatchObject({
      start: ms(2),
      end: ms(39),
    });
  });

  it('ends an interrupted turn where it was aborted', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    for (const line of codexAborted) reducer.push(line);
    expect(
      ofKind(reducer.spans(), 'turn').map(({ start, end, status }) => ({ start, end, status })),
    ).toEqual([
      { start: Date.parse(codexAt(0)), end: Date.parse(codexAt(2)), status: 'ok' },
      { start: Date.parse(codexAt(3)), end: Date.parse(codexAt(5)), status: 'ok' },
    ]);
    expect(reducer.unknown()).toEqual({});
  });

  it('ends a turn that never completed at the last line read', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    reducer.push(codexLine(codexAt(0), { type: 'task_started', turn_id: 'left' }));
    reducer.push(
      codexLine(
        codexAt(1),
        { type: 'function_call', call_id: 'call', name: 'exec' },
        'response_item',
      ),
    );
    reducer.push(
      codexLine(codexAt(2), {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } },
      }),
    );
    const [turn] = ofKind(reducer.spans(), 'turn');
    expect(turn).toMatchObject({ end: Date.parse(codexAt(2)), status: 'unknown' });
  });

  it('titles a session with the first line of its prompt after the injected context', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    for (const line of codexAborted) reducer.push(line);
    expect(reducer.title()).toBe('Rename the board check');
    const long = createCodexReducer({ native_id: 'rollout' });
    long.push(codexPrompt(codexAt(0), agentsText, environmentText));
    long.push(codexPrompt(codexAt(1), 'abcdefghij'.repeat(10)));
    expect(long.title()).toBe(`${'abcdefghij'.repeat(8).slice(0, 79)}…`);
    expect(long.title()).toHaveLength(80);
  });

  it('titles a session with a typed first prompt that starts with a tag', () => {
    const reducer = createCodexReducer({ native_id: 'rollout' });
    reducer.push(
      codexPrompt(
        codexAt(0),
        agentsText,
        environmentText,
        '<user_instructions>\nBe brief\n</user_instructions>',
      ),
    );
    reducer.push(codexPrompt(codexAt(1), '<div class="header">Fix this</div>'));
    reducer.push(codexPrompt(codexAt(2), 'Later prompt'));
    expect(reducer.title()).toBe('<div class="header">Fix this</div>');
  });
});

describe('reducer state', () => {
  const inline = [
    ['Claude titled', () => createClaudeReducer({ native_id: 'session' }), claudeTitled],
    ['Claude untitled', () => createClaudeReducer({ native_id: 'session' }), claudePrompts],
    ['Codex aborted', () => createCodexReducer({ native_id: 'rollout' }), codexAborted],
  ] as const;
  for (const [label, create, lines] of inline)
    it(`resumes the ${label} lines at every line with the same title and turns`, () => {
      const whole = create();
      for (const line of lines) whole.push(line);
      for (let cut = 1; cut < lines.length; cut += 1) {
        const first = create();
        for (const line of lines.slice(0, cut)) first.push(line);
        const second = create();
        second.restore(JSON.parse(JSON.stringify(first.state())));
        for (const line of lines.slice(cut)) second.push(line);
        expect(second.spans()).toEqual(whole.spans());
        expect(second.title()).toEqual(whole.title());
      }
    });

  it('counts lines it cannot read instead of throwing', () => {
    for (const reducer of [createClaudeReducer(mainLane), createCodexReducer(codexLane)]) {
      expect(() => {
        reducer.push('not json');
        reducer.push('{"type":"brand_new_type"}');
      }).not.toThrow();
      expect(reducer.unknown()).toEqual({ invalid_json: 1, brand_new_type: 1 });
      expect(reducer.spans()).toEqual([]);
    }
  });
});

describe('probeMeta', () => {
  it('waits on a file that holds only half a line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-transcript-'));
    const file = join(dir, 'half.jsonl');
    await writeFile(file, '{"type":"session_meta","payload":{"id":"01a1');
    expect(await probeMeta(file)).toBe('pending');
    await rm(dir, { recursive: true });
  });

  it('reads a metadata record larger than the first read window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-transcript-'));
    const file = join(dir, 'large.jsonl');
    const meta = { id: 'large-session', cwd: '/repo', instructions: 'x'.repeat(600 * 1024) };
    await writeFile(
      file,
      `${codexLine(codexAt(0), meta, 'session_meta')}\n${codexLine(codexAt(1), { type: 'task_started', turn_id: 'first' })}\n`,
    );
    expect(await probeMeta(file)).toMatchObject({
      runtime: 'codex',
      native_id: 'large-session',
      cwd: '/repo',
    });
    await rm(dir, { recursive: true });
  });

  it('stops looking for a metadata record past the probe limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'native-transcript-'));
    const file = join(dir, 'no-meta.jsonl');
    const filler = codexLine(codexAt(0), { type: 'agent_message', message: 'x'.repeat(9 << 20) });
    const meta = codexLine(codexAt(1), { id: 'late-session', cwd: '/repo' }, 'session_meta');
    await writeFile(file, `${filler}\n${meta}\n`);
    expect(await probeMeta(file)).toBe('pending');
    await rm(dir, { recursive: true });
  });
});

it('keeps reported sub-millisecond command durations and Codex compaction items', () => {
  const reducer = createCodexReducer({ native_id: 'local-history' });
  reducer.push(codexLine(codexAt(0), { type: 'task_started', turn_id: 'turn' }));
  const at = Date.parse(codexAt(1));
  reducer.push(
    codexLine(codexAt(1), {
      type: 'item_completed',
      started_at_ms: at,
      completed_at_ms: at,
      item: {
        type: 'CommandExecution',
        id: 'shell',
        status: 'completed',
        exit_code: 1,
        duration: { secs: 0, nanos: 5_000 },
      },
    }),
  );
  reducer.push(
    codexLine(codexAt(2), {
      type: 'item_completed',
      item: { type: 'ContextCompaction', id: 'compaction' },
    }),
  );
  expect(reducer.spans().find((span) => span.id === 'shell')).toMatchObject({
    start: at,
    end: at,
    status: 'error',
    duration_ms: 0.005,
  });
  expect(reducer.spans().find((span) => span.id === 'compaction')).toMatchObject({
    kind: 'compact',
  });
});

it('reads only explicitly reported native tool usage and shell exit codes', () => {
  const claude = createClaudeReducer({ native_id: 'reported-tools' });
  claude.push(
    JSON.stringify({
      type: 'assistant',
      timestamp: codexAt(0),
      message: {
        usage: { input_tokens: 999, output_tokens: 999 },
        content: [
          { type: 'tool_use', id: 'agent', name: 'Agent', input: { description: 'Inspect data' } },
          { type: 'tool_use', id: 'shell', name: 'Bash', input: { command: 'false' } },
          { type: 'tool_use', id: 'silent', name: 'Read', input: {} },
        ],
      },
    }),
  );
  claude.push(
    JSON.stringify({
      type: 'user',
      timestamp: codexAt(1),
      toolUseResult: {
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4 },
      },
      message: { content: [{ type: 'tool_result', tool_use_id: 'agent', content: 'done' }] },
    }),
  );
  claude.push(
    JSON.stringify({
      type: 'user',
      timestamp: codexAt(2),
      toolUseResult: { exitCode: 1 },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'shell', is_error: true, content: 'failed' }],
      },
    }),
  );
  const agent = claude.spans().find((span) => span.id === 'agent')!;
  expect(agent.tokens).toEqual({ input: 14, output: 2, cache_read: 4 });
  expect(agent.input_summary).toBe('Inspect data');
  expect(claude.spans().find((span) => span.id === 'shell')).toMatchObject({
    exit_code: 1,
    input_summary: 'false',
  });
  for (const id of ['shell', 'silent'])
    expect(claude.spans().find((span) => span.id === id)).not.toHaveProperty('tokens');
  const codex = createCodexReducer({ native_id: 'reported-tools' });
  codex.push(codexLine(codexAt(0), { type: 'task_started' }));
  codex.push(
    codexLine(codexAt(1), {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        id: 'command',
        exit_code: 0,
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
  );
  codex.push(
    codexLine(codexAt(2), {
      type: 'item_completed',
      item: {
        type: 'McpToolCall',
        id: 'silent',
        server: 'docs',
        tool: 'search',
        status: 'completed',
      },
    }),
  );
  expect(codex.spans().find((span) => span.id === 'command')).toMatchObject({
    tokens: { input: 5, output: 1 },
    exit_code: 0,
  });
  expect(codex.spans().find((span) => span.id === 'silent')).not.toHaveProperty('tokens');
  expect(codex.spans().find((span) => span.id === 'silent')).not.toHaveProperty('exit_code');
});

it('preserves native input summaries and retries across saved reducer state', () => {
  const reducer = createClaudeReducer({ native_id: 'retry-tools' });
  const start = (id: string, second: number) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: codexAt(second),
      message: {
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'test' } }],
      },
    });
  reducer.push(start('failed', 0));
  reducer.push(
    JSON.stringify({
      type: 'user',
      timestamp: codexAt(1),
      message: { content: [{ type: 'tool_result', tool_use_id: 'failed', is_error: true }] },
    }),
  );
  const resumed = createClaudeReducer({ native_id: 'retry-tools' });
  resumed.restore(JSON.parse(JSON.stringify(reducer.state())));
  resumed.push(start('retried', 2));
  expect(resumed.spans().find((span) => span.id === 'retried')).toMatchObject({
    retry_count: 1,
    input_summary: 'test',
  });
  expect(resumed.spans().find((span) => span.id === 'failed')).not.toHaveProperty('retry_count');
});
