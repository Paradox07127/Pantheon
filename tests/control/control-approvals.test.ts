import { expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Control } from '@pantheon/control';
import { FixtureAdapter } from '@pantheon/adapters';
import { Store } from '@pantheon/store';
import {
  hash,
  type AgentEvent,
  type AgentEventSink,
  type Approval,
  type BoardPlan,
  type Principal,
  type Project,
  type Session,
  type SessionHandle,
  type SessionTurn,
} from '@pantheon/domain';
import { command } from '@pantheon/protocol';
import { awaitWorkspaceReady, eventually, fixture, user } from '../helpers.js';
import { createVirtualClock } from '../acceptance/lib/clock.mjs';
import { FakeAgentAdapter } from '../acceptance/fixtures/fake-agent-adapter.mjs';
import { git } from './workbench-fixture.js';

/** Worktree sessions branch from a commit of the project root. */
function commitProjectRoot(root: string) {
  git(root, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'Initial files');
}

async function approvalFixture() {
  const clock = createVirtualClock(1700000000000),
    adapter = new FixtureAdapter(),
    sinks = new Map<SessionHandle, AgentEventSink>(),
    resume = adapter.resume.bind(adapter);
  vi.spyOn(adapter, 'resume').mockImplementation(async (spec, nativeId, sink) => {
    const handle = await resume(spec, nativeId, sink);
    sinks.set(handle, sink);
    return handle;
  });
  vi.spyOn(adapter, 'send').mockImplementation(async (_handle, turn) => ({
    turn_id: turn.turn_id,
    status: 'delivered',
  }));
  let failpoint: string | undefined;
  const f = await fixture({
    adapter,
    now: clock.now,
    failpoint: (name) => {
      if (name === failpoint) throw new Error('Approval transaction interrupted');
    },
    managedWorkspaces: true,
  });
  commitProjectRoot(f.projectRoot);
  const answer = vi.spyOn(adapter, 'answerPermission').mockImplementation(async () => {
    f.store.transaction(() => {});
    return { ok: true };
  });
  const session = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: adapter.name,
    input: 'Request permission',
  });
  const principal: Principal = {
    id: 'approval-planner',
    role: 'planner',
    project_id: f.project.id,
  };
  const turn = f.store.list<SessionTurn>('session_turns')[0]!;
  await awaitWorkspaceReady(f.control, session.workspace_id!);
  await eventually(
    () => f.control.handles.has(turn.id),
    () => f.control.tick(),
  );
  const handle = f.control.handles.get(turn.id)!;
  let sequence = 10;
  const emit = (event: AgentEvent, target = handle) => sinks.get(target)!(event);
  const request = (
    input: Partial<Extract<AgentEvent, { kind: 'permission.requested' }>> = {},
    target = handle,
  ) => {
    const event: AgentEvent = {
      key: String(++sequence),
      provider_sequence: sequence,
      turn_id: turn.id,
      kind: 'permission.requested',
      request_id: 'native-permission',
      tool: 'tool.read',
      detail: { path: 'report.txt' },
      ...input,
    };
    emit(event, target);
    return f.store.list<Approval>('approvals').at(-1)!;
  };
  return {
    ...f,
    principal,
    session,
    turn,
    handle,
    clock,
    answer,
    emit,
    request,
    failAt: (name?: string) => {
      failpoint = name;
    },
    respond: (
      approval: Approval,
      decision: 'approve' | 'approve_session' | 'reject' = 'approve',
      actor = user,
      extra: { reason?: string; answers?: Record<string, string> } = {},
    ) =>
      f.call<Approval>(
        'approval.respond',
        { approval_id: approval.id, decision, ...extra },
        approval.revision,
        actor,
      ),
  };
}

it('stores a Claude tool input summary and exposes it in needs-you without changing events', async () => {
  const f = await approvalFixture();
  try {
    const detail = {
        input: { query: 'select:mcp__pantheon__report', max_results: 5 },
        tool_call_id: 't1',
      },
      approval = f.request({ tool: 'ToolSearch', detail }),
      summary = 'query=select:mcp__pantheon__report, max_results=5';
    expect(approval.input_summary).toBe(summary);
    expect(approval.input_hash).toBe(hash({ tool: 'ToolSearch', detail }));
    expect(
      f.control.needsYou(user).items.find((item) => item.source.id === approval.id)?.binding
        ?.input_summary,
    ).toBe(summary);
    f.respond(approval);
    for (const event of f.store.events().filter((event) => event.aggregate_id === approval.id))
      expect(event.payload).not.toHaveProperty('input_summary');
  } finally {
    await f.close();
  }
});

it('carries the rule an allow for the session would add in needs-you', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request({ tool: 'Bash', detail: { input: { command: 'pnpm test' } } });
    expect(approval.rule).toBeTruthy();
    expect(
      f.control.needsYou(user).items.find((item) => item.source.id === approval.id)?.binding?.rule,
    ).toBe(approval.rule);
  } finally {
    await f.close();
  }
});

it('includes the command text from a Codex command approval input', async () => {
  const f = await approvalFixture();
  try {
    const detail = {
        input: {
          threadId: 'sandbox-thread',
          turnId: 'native-turn',
          startedAtMs: 1,
          command: 'echo hello',
          cwd: '/workspace',
          itemId: 'command-item',
        },
        tool_call_id: 'command-item',
      },
      approval = f.request({ tool: 'commandExecution', detail });
    expect(approval.input_summary).toBe('echo hello');
    expect(approval.input_hash).toBe(hash({ tool: 'commandExecution', detail }));
  } finally {
    await f.close();
  }
});

it('limits a long approval input summary to 300 characters including the ellipsis', async () => {
  const f = await approvalFixture();
  try {
    const detail = { input: 'x'.repeat(2000) },
      approval = f.request({ detail });
    expect(approval.input_summary).toBe(`${'x'.repeat(299)}…`);
    expect(approval.input_summary).toHaveLength(300);
    expect(approval.input_hash).toBe(hash({ tool: 'tool.read', detail }));
  } finally {
    await f.close();
  }
});

it.each([
  {
    name: 'multiline string input',
    detail: { input: '  read\n\t the\r\n report  ' },
    summary: 'read the report',
  },
  {
    name: 'nested object and array values',
    detail: {
      input: { enabled: false, options: { limit: 5 }, paths: ['report.txt', 'notes.txt'] },
    },
    summary: 'enabled=false, options={"limit":5}, paths=["report.txt","notes.txt"]',
  },
  {
    name: 'unwrapped detail',
    detail: { path: 'report.txt', recursive: true, limit: 0 },
    summary: 'path=report.txt, recursive=true, limit=0',
  },
  {
    name: 'a shell command beside its description and timeout as the command alone',
    tool: 'Bash',
    detail: {
      input: {
        command: 'pnpm migrate --table webhook_secrets',
        description: 'Migrate the secrets table',
        timeout: 60000,
      },
    },
    summary: 'pnpm migrate --table webhook_secrets',
  },
  {
    name: 'a command field of a tool that is not a shell with its other arguments',
    tool: 'mcp__ops__deploy',
    detail: { input: { command: 'delete', target: 'prod' } },
    summary: 'command=delete, target=prod',
  },
  {
    name: 'exactly 300 characters',
    detail: { input: 'x'.repeat(300) },
    summary: 'x'.repeat(300),
  },
])('summarizes $name', async ({ tool, detail, summary }) => {
  const f = await approvalFixture();
  try {
    const approval = f.request(tool ? { tool, detail } : { detail });
    expect(approval.input_summary).toBe(summary);
  } finally {
    await f.close();
  }
});

it.each([
  { name: 'no detail', detail: undefined },
  { name: 'null detail', detail: null },
  { name: 'empty detail', detail: {} },
  { name: 'undefined input', detail: { input: undefined, tool_call_id: 'empty-call' } },
  { name: 'null input', detail: { input: null, tool_call_id: 'empty-call' } },
  { name: 'empty object input', detail: { input: {} } },
  { name: 'empty string input', detail: { input: '' } },
  { name: 'whitespace input', detail: { input: ' \n\t ' } },
])('omits the stored summary for $name and preserves the input hash', async ({ detail }) => {
  const f = await approvalFixture();
  try {
    const approval = f.request({ detail });
    expect(approval).not.toHaveProperty('input_summary');
    expect(approval.input_hash).toBe(hash({ tool: 'tool.read', detail }));
  } finally {
    await f.close();
  }
});

it('creates one bound approval for duplicate permission deliveries', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request({ key: 'duplicate-permission' }),
      cursor = f.store.cursor();
    f.request({ key: 'duplicate-permission' });
    expect(f.store.cursor()).toBe(cursor);
    f.request();
    expect(f.store.list('approvals')).toEqual([approval]);
    expect(approval).toMatchObject({
      project_id: f.project.id,
      kind: 'permission',
      session_id: f.session.id,
      request_id: 'native-permission',
      tool: 'tool.read',
      input_hash: hash({ tool: 'tool.read', detail: { path: 'report.txt' } }),
      decider: 'user',
      state: 'pending',
      created_at: f.clock.now(),
    });
    expect(f.store.list('timers')).toEqual([]);
    expect(f.store.events().filter((e) => e.kind === 'approval.requested')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('rolls back a permission event together with its approval and deduplication receipt', async () => {
  const f = await approvalFixture();
  try {
    const event = f.store.event.bind(f.store),
      cursor = f.store.cursor(),
      spy = vi.spyOn(f.store, 'event').mockImplementation((...args) => {
        if (args[0] === 'approval.requested') throw new Error('Event persistence failed');
        return event(...args);
      });
    expect(() => f.request({ key: 'atomic-permission' })).toThrow('Event persistence failed');
    expect(f.store.list('approvals')).toEqual([]);
    expect(f.store.cursor()).toBe(cursor);
    spy.mockRestore();
    f.request({ key: 'atomic-permission' });
    expect(f.store.list('approvals')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('voids replaced input and prevents an old decision from answering its replacement', async () => {
  const f = await approvalFixture();
  try {
    const old = f.request(),
      replacement = f.request({ detail: { path: 'changed.txt' } });
    expect(f.store.must<Approval>('approvals', old.id)).toMatchObject({
      state: 'void',
      reason: 'input_replaced',
      revision: old.revision + 1,
    });
    expect(replacement.input_hash).not.toBe(old.input_hash);
    expect(() => f.respond(old)).toThrow(expect.objectContaining({ code: 'approval_not_pending' }));
    f.respond(replacement);
    const latest = f.request({ detail: { path: 'latest.txt' } });
    await f.control.tick();
    expect(f.answer).not.toHaveBeenCalled();
    expect(f.store.must<Approval>('approvals', latest.id).state).toBe('pending');
    expect(f.control.needsYou(user).items.map((item) => item.source.id)).toEqual([latest.id]);
  } finally {
    await f.close();
  }
});

it('opens a new approval when a decided request is asked again with the same input', async () => {
  const f = await approvalFixture();
  try {
    const first = f.request();
    f.respond(first, 'reject');
    const again = f.request();
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ state: 'pending', input_hash: first.input_hash });
    expect(f.store.must<Approval>('approvals', first.id).state).toBe('rejected');
  } finally {
    await f.close();
  }
});

it('keeps a permission request pending past an hour and delivers the late answer', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    expect(f.store.list('timers')).toEqual([]);
    f.clock.advance(3600000 + 60000);
    await f.control.tick();
    expect(f.store.must<Approval>('approvals', approval.id)).toEqual(approval);
    expect(f.answer).not.toHaveBeenCalled();
    const item = f.control.needsYou(user).items.find((i) => i.source.id === approval.id)!;
    expect(item.actions).toEqual([{ command: 'approval.respond', allowed: true }]);
    expect(item.session_id).toBe(approval.session_id);
    f.respond(approval);
    await f.control.tick();
    expect(f.answer).toHaveBeenCalledExactlyOnceWith(f.handle, approval.request_id, 'allow');
  } finally {
    await f.close();
  }
});

it('records a session-wide approval as an allowed rule and delivers it as allow_session', async () => {
  const f = await approvalFixture();
  try {
    const shell = f.request({
      request_id: 'shell-request',
      tool: 'Bash',
      detail: { input: { command: '  pnpm test --filter web' }, tool_call_id: 'shell' },
    });
    expect(f.respond(shell, 'approve_session')).toMatchObject({ state: 'approved' });
    expect(f.store.must<Session>('sessions', f.session.id).allowed_rules).toEqual([
      'Bash(pnpm test)',
    ]);
    expect(f.store.events().filter((e) => e.kind === 'session.rule_allowed')).toEqual([
      expect.objectContaining({ aggregate_id: f.session.id, payload: { rule: 'Bash(pnpm test)' } }),
    ]);
    await f.control.tick();
    expect(f.answer).toHaveBeenCalledExactlyOnceWith(f.handle, 'shell-request', 'allow_session');
    const again = f.request({
      request_id: 'second-shell-request',
      tool: 'Bash',
      detail: { input: { command: 'pnpm test' }, tool_call_id: 'test' },
    });
    f.respond(again, 'approve_session');
    const fetch = f.request({
      request_id: 'fetch-request',
      tool: 'WebFetch',
      detail: { input: { url: 'https://example.invalid' }, tool_call_id: 'fetch' },
    });
    f.respond(fetch, 'approve_session');
    expect(f.store.must<Session>('sessions', f.session.id).allowed_rules).toEqual([
      'Bash(pnpm test)',
      'WebFetch',
    ]);
  } finally {
    await f.close();
  }
});

it('takes the session-wide rule from the request and never from a truncated input', async () => {
  const f = await approvalFixture();
  try {
    const truncated = f.request({
      request_id: 'truncated-request',
      tool: 'Bash',
      detail: { input: { command: `git ${'a'.repeat(4092)}`, truncated: true } },
    });
    expect(truncated.rule).toBeUndefined();
    expect(() => f.respond(truncated, 'approve_session')).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    const ruled = f.request({
      request_id: 'ruled-request',
      tool: 'Bash',
      rule: 'Bash(git status && git push)',
      detail: { input: { command: 'git status', truncated: true } },
    });
    expect(ruled.rule).toBe('Bash(git status && git push)');
  } finally {
    await f.close();
  }
});

it('leaves plan mode for ask when the user approves ExitPlanMode', async () => {
  const f = await approvalFixture();
  try {
    const setPermissionMode = vi.fn(async () => ({ ok: true }));
    Object.assign(f.adapter, { setPermissionMode });
    f.call(
      'session.setPermissionMode',
      { session_id: f.session.id, permission_mode: 'plan' },
      f.store.must<Session>('sessions', f.session.id).revision,
    );
    const approval = f.request({
      request_id: 'exit-plan',
      tool: 'ExitPlanMode',
      detail: { input: { plan: 'Edit the file' } },
    });
    f.respond(approval);
    expect(f.store.must<Session>('sessions', f.session.id).permission_mode).toBe('ask');
    expect(
      f.store
        .events()
        .filter((e) => e.kind === 'session.permission_mode_changed')
        .map((e) => e.payload),
    ).toEqual([{ permission_mode: 'plan' }, { permission_mode: 'ask' }]);
    await f.control.tick();
    expect(f.answer).toHaveBeenCalledExactlyOnceWith(f.handle, 'exit-plan', 'allow');
    expect(setPermissionMode).toHaveBeenLastCalledWith(f.handle, 'ask');
  } finally {
    await f.close();
  }
});

it('stores a rejection reason and sends it with the denial', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    expect(f.respond(approval, 'reject', user, { reason: 'Use the cached report' })).toMatchObject({
      state: 'rejected',
      decision_reason: 'Use the cached report',
    });
    await f.control.tick();
    expect(f.answer).toHaveBeenCalledExactlyOnceWith(
      f.handle,
      approval.request_id,
      'deny',
      undefined,
      'Use the cached report',
    );
  } finally {
    await f.close();
  }
});

it('keeps the questions of an AskUserQuestion request and sends the answers back', async () => {
  const f = await approvalFixture();
  try {
    const questions = [
        {
          question: 'Which package manager?',
          header: 'Tooling',
          options: [
            { label: 'pnpm', description: 'Workspace default' },
            { label: 'npm', description: 'Bundled with node' },
          ],
          multiSelect: false,
        },
      ],
      approval = f.request({
        tool: 'AskUserQuestion',
        detail: { input: { questions }, tool_call_id: 'ask', questions },
      });
    expect(approval.questions).toEqual(questions);
    expect(f.store.events().find((e) => e.kind === 'approval.requested')?.payload).toMatchObject({
      questions,
    });
    expect(() => f.respond(approval)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => f.respond(approval, 'approve_session', user, { answers: {} })).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    const answers = { 'Which package manager?': 'pnpm' };
    expect(f.respond(approval, 'approve', user, { answers })).toMatchObject({
      state: 'approved',
      answers,
    });
    await f.control.tick();
    expect(f.answer).toHaveBeenCalledExactlyOnceWith(
      f.handle,
      approval.request_id,
      'allow',
      answers,
    );
  } finally {
    await f.close();
  }
});

it('refuses question answers that leave a question unanswered', async () => {
  const f = await approvalFixture();
  try {
    const question = (text: string) => ({
        question: text,
        header: 'Tooling',
        options: [
          { label: 'pnpm', description: 'Workspace default' },
          { label: 'npm', description: 'Bundled with node' },
        ],
        multiSelect: false,
      }),
      questions = [question('Which package manager?'), question('Which test runner?')],
      approval = f.request({
        tool: 'AskUserQuestion',
        detail: { input: { questions }, tool_call_id: 'ask', questions },
      });
    expect(approval.questions).toEqual(questions);
    const invalid: Record<string, string>[] = [
      {},
      { 'Which package manager?': 'pnpm' },
      { 'Which package manager?': 'pnpm', 'Which test runner?': ' ' },
      { 'Another question?': 'pnpm', 'Which test runner?': 'vitest' },
    ];
    for (const answers of invalid)
      expect(() => f.respond(approval, 'approve', user, { answers })).toThrow(
        expect.objectContaining({ code: 'invalid_input' }),
      );
    expect(f.store.must<Approval>('approvals', approval.id)).toEqual(approval);
    const answers = { 'Which package manager?': 'pnpm', 'Which test runner?': 'vitest' };
    expect(f.respond(approval, 'approve', user, { answers })).toMatchObject({
      state: 'approved',
    });
  } finally {
    await f.close();
  }
});

const exportQuestions = [
  {
    question: 'Which export format?',
    header: 'Format',
    options: [
      { label: 'CSV', description: 'Opens in spreadsheets' },
      { label: 'JSON', description: 'Keeps nested fields' },
    ],
    multiSelect: false,
  },
];

/** Gives the fixture session a lead whose plan has its task, when it is a task session. */
async function leadOf(
  f: Awaited<ReturnType<typeof approvalFixture>>,
  taskSession: boolean,
): Promise<string> {
  const lead = await f.call<Session>('session.create', {
    project_id: f.project.id,
    runtime: f.session.runtime,
    input: 'Plan the export feature',
  });
  f.store.insert<BoardPlan>('board_plans', {
    id: lead.id,
    revision: 1,
    project_id: f.project.id,
    headline: 'Export files',
    lanes: [{ id: 'core', title: 'Core' }],
    tasks: [
      {
        id: 'format',
        title: 'Format',
        goal: 'Export files',
        lane: 'core',
        depends_on: [],
        source: ['Plan the export feature'],
        scope: ['src/format'],
        acceptance: ['pnpm test'],
      },
    ],
    plan_version: 1,
    pending_edits: [],
    risks: [],
    assumptions: [],
    inbox: [],
    notified: {},
    updated_at: f.store.now(),
  });
  if (taskSession) {
    const session = f.store.must<Session>('sessions', f.session.id);
    f.store.update<Session>(
      'sessions',
      { ...session, task: { lead_session_id: lead.id, id: 'format', generation: 1 } },
      session.revision,
    );
  }
  return lead.id;
}

const askExport = (f: Awaited<ReturnType<typeof approvalFixture>>) =>
  f.request({
    tool: 'AskUserQuestion',
    detail: {
      input: { questions: exportQuestions },
      tool_call_id: 'ask',
      questions: exportQuestions,
    },
  });

const boardQuestions = (f: Awaited<ReturnType<typeof approvalFixture>>, leadId: string) =>
  f.store.must<BoardPlan>('board_plans', leadId).questions ?? [];

it.each([
  ['a task session', true, 1],
  ['a session without a task', false, 0],
] as const)(
  'puts the question of %s on its lead board as it asks',
  async (_name, taskSession, cards) => {
    const f = await approvalFixture();
    try {
      const leadId = await leadOf(f, taskSession),
        approval = askExport(f),
        questions = boardQuestions(f, leadId);
      expect(questions).toHaveLength(cards);
      if (cards)
        expect(questions[0]).toMatchObject({
          question: 'Which export format?',
          options: ['CSV', 'JSON'],
          blocks: ['format'],
          source: { session_id: f.session.id, approval_id: approval.id },
          questions: exportQuestions,
        });
      const items = f.control
        .needsYou(user, f.project.id)
        .items.filter(
          (item) => item.source.id === approval.id || String(item.kind) === 'lead.question',
        );
      expect(items.map((item) => item.kind)).toEqual(cards ? ['lead.question'] : ['permission']);
    } finally {
      await f.close();
    }
  },
);

it.each([
  ['answers', { answers: { 'Which export format?': 'JSON, with a header row' } }],
  ['an answer only', {}],
] as const)('sends a board answer with %s back to the task session', async (_name, extra) => {
  const f = await approvalFixture();
  try {
    const leadId = await leadOf(f, true),
      approval = askExport(f),
      [card] = boardQuestions(f, leadId);
    f.call('lead.question.answer', {
      project_id: f.project.id,
      lead_session_id: leadId,
      question_id: card!.id,
      answer: 'JSON',
      ...extra,
    });
    const answers = 'answers' in extra ? extra.answers : { 'Which export format?': 'JSON' };
    expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
      state: 'approved',
      answers,
    });
    expect(boardQuestions(f, leadId)[0]!.answer).toMatchObject({ text: 'JSON' });
    await f.control.tick();
    expect(f.answer).toHaveBeenCalledExactlyOnceWith(
      f.handle,
      approval.request_id,
      'allow',
      answers,
    );
  } finally {
    await f.close();
  }
});

it.each(['approve', 'reject'] as const)(
  'closes the board card of a question the user answers with %s in the task session',
  async (decision) => {
    const f = await approvalFixture();
    try {
      const leadId = await leadOf(f, true),
        approval = askExport(f);
      f.respond(
        approval,
        decision,
        user,
        decision === 'approve' ? { answers: { 'Which export format?': 'CSV' } } : {},
      );
      expect(boardQuestions(f, leadId)[0]!.answer).toMatchObject({
        text: decision === 'approve' ? 'CSV' : 'rejected',
      });
      expect(
        f.control
          .needsYou(user, f.project.id)
          .items.filter((item) => String(item.kind) === 'lead.question'),
      ).toEqual([]);
      const [card] = boardQuestions(f, leadId);
      expect(() =>
        f.call('lead.question.answer', {
          project_id: f.project.id,
          lead_session_id: leadId,
          question_id: card!.id,
          answer: 'JSON',
        }),
      ).toThrow(expect.objectContaining({ code: 'invalid_state' }));
    } finally {
      await f.close();
    }
  },
);

it('refuses answers on a request that is not AskUserQuestion', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    expect(() => f.respond(approval, 'approve', user, { answers: { question: 'yes' } })).toThrow(
      expect.objectContaining({ code: 'invalid_input' }),
    );
    expect(f.store.must<Approval>('approvals', approval.id)).toEqual(approval);
  } finally {
    await f.close();
  }
});

it.each(['approve', 'reject'] as const)(
  'delivers a user %s through the outbox once despite duplicate commands',
  async (decision) => {
    const f = await approvalFixture();
    try {
      const approval = f.request(),
        sent = command(
          user.id,
          'approval.respond',
          { approval_id: approval.id, decision },
          approval.revision,
        ),
        result = f.control.execute(user, sent),
        cursor = f.store.cursor();
      expect(result).toMatchObject({
        state: decision === 'approve' ? 'approved' : 'rejected',
        decided_by: user.id,
      });
      expect(f.control.execute(user, sent)).toEqual(result);
      expect(f.control.execute(user, { ...sent, command_id: 'another-response' })).toEqual(result);
      expect(f.control.execute(user, { ...sent, idempotency_key: 'another-key' })).toEqual(result);
      expect(f.store.cursor()).toBe(cursor);
      expect(f.store.pending().filter((out) => out.kind === 'permission.answer')).toHaveLength(1);
      expect(f.answer).not.toHaveBeenCalled();
      expect(() => f.respond(approval)).toThrow(
        expect.objectContaining({ code: 'approval_not_pending' }),
      );
      await f.control.tick();
      await f.control.tick();
      expect(f.answer).toHaveBeenCalledExactlyOnceWith(
        f.handle,
        approval.request_id,
        decision === 'approve' ? 'allow' : 'deny',
      );
      const eventKind = decision === 'approve' ? 'approval.approved' : 'approval.rejected';
      expect(f.store.events().filter((e) => e.kind === eventKind)).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
);

it('returns the stored receipt when a session retries a command after its credential was extended', async () => {
  const f = await approvalFixture();
  try {
    const lead: Principal = {
        id: `session:${f.session.id}`,
        role: 'lead',
        project_id: f.project.id,
        session_id: f.session.id,
        expires_at: f.clock.now() + 60000,
      },
      sent = command(lead.id, 'board.plan.update', {
        project_id: f.project.id,
        base_version: 0,
        headline: 'Export ships this week',
        lanes: [{ id: 'core', title: 'Core' }],
        tasks: [],
        milestones: [],
        risks: [],
        assumptions: [],
      }),
      result = f.control.execute(lead, sent),
      cursor = f.store.cursor();
    const extended = { ...lead, expires_at: lead.expires_at! + 5 };
    expect(f.control.execute(extended, sent)).toEqual(result);
    expect(f.control.execute(extended, { ...sent, command_id: 'retried-plan' })).toEqual(result);
    expect(f.store.cursor()).toBe(cursor);
  } finally {
    await f.close();
  }
});

it('rolls back a failed response transaction and retains a committed response after delivery interruption', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request(),
      sent = command(
        user.id,
        'approval.respond',
        { approval_id: approval.id, decision: 'approve' },
        approval.revision,
      ),
      cursor = f.store.cursor();
    f.failAt('before_transaction_commit');
    expect(() => f.control.execute(user, sent)).toThrow('Approval transaction interrupted');
    expect(f.store.must<Approval>('approvals', approval.id)).toEqual(approval);
    expect(f.store.pending()).toEqual([]);
    expect(f.store.cursor()).toBe(cursor);
    f.failAt('after_commit_before_send');
    expect(() => f.control.execute(user, sent)).toThrow('Approval transaction interrupted');
    expect(f.store.must<Approval>('approvals', approval.id).state).toBe('approved');
    expect(f.answer).not.toHaveBeenCalled();
    f.failAt();
    expect(f.control.execute(user, sent)).toMatchObject({ state: 'approved' });
    await f.control.tick();
    expect(f.answer).toHaveBeenCalledTimes(1);
  } finally {
    f.failAt();
    await f.close();
  }
});

it('reserves a permission request for the user', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    expect(() => f.respond(approval, 'approve', f.principal)).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    expect(f.store.must<Approval>('approvals', approval.id)).toEqual(approval);
    expect(f.control.needsYou(f.principal).items).toEqual([]);
    expect(f.control.needsYou(user).items.map((item) => item.source.id)).toEqual([approval.id]);
  } finally {
    await f.close();
  }
});

it('denies an approval response from an expired user principal', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    expect(() =>
      f.respond(approval, 'approve', { ...user, expires_at: f.clock.now() - 1 }),
    ).toThrow(expect.objectContaining({ code: 'permission_denied' }));
    expect(f.store.must<Approval>('approvals', approval.id)).toEqual(approval);
  } finally {
    await f.close();
  }
});

it.each(['planner', 'writer', 'reviewer', 'lead', 'worker'] as const)(
  'denies approval responses from a %s principal without changing pending state',
  async (role) => {
    const f = await approvalFixture();
    try {
      const approval = f.request();
      expect(() => f.respond(approval, 'approve', { ...f.principal, role })).toThrow(
        expect.objectContaining({ code: 'permission_denied' }),
      );
      expect(f.store.must<Approval>('approvals', approval.id)).toEqual(approval);
      expect(f.answer).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it('rejects a stale approval revision', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request(),
      stale = { ...approval, revision: approval.revision - 1 };
    expect(() => f.respond(stale, 'approve')).toThrow(
      expect.objectContaining({ code: 'revision_conflict' }),
    );
    expect(f.store.must<Approval>('approvals', approval.id)).toEqual(approval);
    expect(f.answer).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(['session.exited', 'turn.completed', 'shutdown'] as const)(
  'voids pending approvals when the session ends through %s',
  async (kind) => {
    const f = await approvalFixture();
    try {
      const approval = f.request();
      if (kind === 'shutdown') await f.control.shutdown();
      else
        f.emit({
          key: 'session-ended',
          provider_sequence: 100,
          turn_id: f.turn.id,
          ...(kind === 'session.exited' ? { kind, code: 0 } : { kind, status: 'completed' }),
        });
      expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
        state: 'void',
        reason: 'session_lost',
      });
      expect(f.answer).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it.each([0, 3600000])('keeps recovered approvals terminal %i ms after the request', async (ms) => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.clock.advance(ms);
    const recoveredStore = new Store(f.store.file, f.clock.now);
    try {
      const restarted = new Control(recoveredStore, f.files, [f.adapter]);
      await restarted.recover();
      const terminal = recoveredStore.must<Approval>('approvals', approval.id);
      expect(terminal).toMatchObject({ state: 'void', reason: 'session_lost' });
      await restarted.tick();
      await restarted.recover();
      await restarted.tick();
      expect(recoveredStore.must<Approval>('approvals', approval.id)).toEqual(terminal);
      expect(
        restarted.needsYou(user).items.filter((i) => i.source.table === 'approvals'),
      ).toMatchObject([
        {
          source: { id: approval.id },
          session_id: f.session.id,
          turn_id: f.turn.id,
          request_id: approval.request_id,
          status: 'void',
          reason: 'permission_voided',
          actions: [],
        },
      ]);
      expect(() =>
        restarted.execute(
          user,
          command(
            user.id,
            'approval.respond',
            { approval_id: approval.id, decision: 'approve' },
            terminal.revision,
          ),
        ),
      ).toThrow(expect.objectContaining({ code: 'approval_not_pending' }));
      expect(f.answer).not.toHaveBeenCalled();
      await restarted.shutdown();
    } finally {
      recoveredStore.close();
    }
  } finally {
    await f.close();
  }
});

it('projects pending approvals with project isolation', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.store.insert<Project>('projects', { ...f.project, id: 'another-project' });
    const cursor = f.store.cursor(),
      items = f.control.needsYou(user, f.project.id).items;
    expect(items.map((item) => item.source.table)).toEqual(['approvals']);
    expect(items.find((item) => item.source.id === approval.id)).toMatchObject({
      created_at: approval.created_at,
      binding: {
        action: approval.tool,
        input_hash: approval.input_hash,
      },
    });
    expect(f.control.needsYou(user).items).toHaveLength(1);
    expect(f.control.needsYou(user, 'another-project').items).toEqual([]);
    expect(f.control.needsYou(f.principal).items).toEqual([]);
    expect(() => f.control.needsYou(f.principal, 'another-project')).toThrow(
      expect.objectContaining({ code: 'permission_denied' }),
    );
    expect(f.store.cursor()).toBe(cursor);
  } finally {
    await f.close();
  }
});

it('delivers a queued permission decision to the fake agent and records its native resolution', async () => {
  const clock = createVirtualClock(1700000000000),
    f = await fixture({ now: clock.now, managedWorkspaces: true }),
    adapter = new FakeAgentAdapter({
      dir: path.join(f.root, 'agent'),
      script: {
        turns: [
          {
            steps: [{ permission: { request_id: 'native-read', tool: 'tool.read', detail: {} } }],
          },
        ],
      },
    }),
    control = new Control(f.store, f.files, [adapter], undefined, f.controlOptions);
  try {
    commitProjectRoot(f.projectRoot);
    const requested = new Promise<void>((resolve) => {
      const listener = () => {
        if (f.store.list<Approval>('approvals').length) {
          control.off('events', listener);
          resolve();
        }
      };
      control.on('events', listener);
    });
    const session = (await control.execute(
      user,
      command(user.id, 'session.create', {
        project_id: f.project.id,
        runtime: adapter.name,
        input: 'Read with permission',
      }),
    )) as Session;
    await awaitWorkspaceReady(control, session.workspace_id!);
    await control.tick();
    await requested;
    const approval = f.store.list<Approval>('approvals')[0]!,
      handle = [...control.handles.values()][0]!;
    control.execute(
      user,
      command(
        user.id,
        'approval.respond',
        { approval_id: approval.id, decision: 'approve' },
        approval.revision,
      ),
    );
    expect(
      (await adapter.ledger(handle.native_session_id)).filter(
        (entry: { type: string }) => entry.type === 'permission_answer',
      ),
    ).toEqual([]);
    const resolved = new Promise<void>((resolve) => {
      const listener = () => {
        if (f.store.events().some((event) => event.kind === 'agent.permission.resolved')) {
          control.off('events', listener);
          resolve();
        }
      };
      control.on('events', listener);
    });
    await control.tick();
    await resolved;
    expect(
      (await adapter.ledger(handle.native_session_id)).filter(
        (entry: { type: string }) => entry.type === 'permission_answer',
      ),
    ).toEqual([expect.objectContaining({ request_id: 'native-read', decision: 'allow' })]);
  } finally {
    await control.shutdown();
    await f.close();
  }
});

it('reconciles native permission resolutions without waiting for turn completion', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.emit({
      key: 'resolved',
      provider_sequence: 100,
      turn_id: f.turn.id,
      kind: 'permission.resolved',
      request_id: approval.request_id!,
      decision: 'deny',
    });
    expect(f.store.must<Approval>('approvals', approval.id).state).toBe('rejected');
    expect(f.control.needsYou(user).items).toEqual([]);
  } finally {
    await f.close();
  }
});

it.each(['negative receipt', 'exception'])(
  'retries permission delivery after a %s',
  async (failure) => {
    const f = await approvalFixture();
    try {
      const approval = f.request();
      f.respond(approval);
      if (failure === 'exception')
        f.answer.mockRejectedValueOnce(new Error('transport unavailable'));
      else f.answer.mockResolvedValueOnce({ ok: false, reason: 'transport unavailable' });
      await expect(f.control.tick()).resolves.toBeUndefined();
      expect(f.store.pending().filter((out) => out.kind === 'permission.answer')).toHaveLength(1);
      await f.control.tick();
      expect(f.answer).toHaveBeenCalledTimes(2);
      expect(f.store.pending().filter((out) => out.kind === 'permission.answer')).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);

it.each(['negative receipt', 'exception'])(
  'lists an answer whose delivery keeps failing with a %s in needs-you until it arrives',
  async (failure) => {
    const f = await approvalFixture();
    try {
      const approval = f.request();
      f.respond(approval);
      if (failure === 'exception') f.answer.mockRejectedValue(new Error('transport unavailable'));
      else f.answer.mockResolvedValue({ ok: false, reason: 'transport unavailable' });
      await f.control.tick();
      await f.control.tick();
      expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
        state: 'approved',
        delivery_error: 'transport unavailable',
      });
      expect(f.control.needsYou(user).items).toMatchObject([
        {
          source: { table: 'approvals', id: approval.id },
          turn_id: f.turn.id,
          request_id: approval.request_id,
          status: 'approved',
          reason: 'answer_undelivered',
        },
      ]);
      f.answer.mockResolvedValue({ ok: true });
      await f.control.tick();
      expect(f.store.must<Approval>('approvals', approval.id)).not.toHaveProperty('delivery_error');
      expect(f.control.needsYou(user).items).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it('keeps an approval pending when the runtime refuses its decision and refuses that decision again with the reason', async () => {
  const f = await approvalFixture();
  try {
    const reason = 'The agent offers no allow-once option for this request';
    const approval = f.request();
    f.respond(approval);
    f.answer.mockResolvedValueOnce({ ok: false, reason, refused: true });
    await f.control.tick();
    const reopened = f.store.must<Approval>('approvals', approval.id);
    expect(reopened.state).toBe('pending');
    expect(f.store.pending().filter((out) => out.kind === 'permission.answer')).toHaveLength(0);
    expect(() => f.respond(reopened)).toThrow(reason);
    f.respond(f.store.must<Approval>('approvals', approval.id), 'reject');
    await f.control.tick();
    expect(f.answer).toHaveBeenLastCalledWith(f.handle, approval.request_id, 'deny');
    expect(f.store.must<Approval>('approvals', approval.id)).not.toHaveProperty('refused');
  } finally {
    await f.close();
  }
});

it('records a request the adapter withdrew at the turn deadline as lost, not rejected', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.emit({
      key: 'withdrawn',
      provider_sequence: 100,
      turn_id: f.turn.id,
      kind: 'permission.resolved',
      request_id: approval.request_id!,
      decision: 'deny',
      cancelled: true,
    });
    f.emit({
      key: 'deadline',
      provider_sequence: 101,
      turn_id: f.turn.id,
      kind: 'turn.completed',
      status: 'failed',
      error: 'Claude turn deadline exceeded',
    });
    const terminal = f.store.must<Approval>('approvals', approval.id);
    expect(terminal.state).not.toBe('rejected');
    expect(terminal).toMatchObject({ state: 'void', reason: 'session_lost' });
    await f.control.tick();
    expect(f.answer).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(['approve', 'reject'] as const)(
  'records a request withdrawn before the answer %s arrived as lost and lists it in needs-you until its project is removed',
  async (decision) => {
    const f = await approvalFixture();
    try {
      const approval = f.request();
      f.respond(approval, decision);
      f.emit({
        key: 'withdrawn',
        provider_sequence: 100,
        turn_id: f.turn.id,
        kind: 'permission.resolved',
        request_id: approval.request_id!,
        decision: 'deny',
        cancelled: true,
      });
      expect(f.store.must<Approval>('approvals', approval.id)).toMatchObject({
        state: 'void',
        reason: 'session_lost',
      });
      expect(f.control.needsYou(user).items).toMatchObject([
        { source: { table: 'approvals', id: approval.id }, reason: 'permission_voided' },
      ]);
      await f.control.tick();
      expect(f.answer).not.toHaveBeenCalled();
      const project = f.store.must<Project>('projects', approval.project_id);
      f.store.update<Project>('projects', { ...project, removed_at: 1 }, project.revision);
      expect(f.control.needsYou(user).items).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it('keeps an answer pending with its delivery error while the session has no process', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.respond(approval);
    f.control.handles.delete(f.turn.id);
    await f.control.tick();
    // Shutdown waits for the turn of the handle.
    f.control.handles.set(f.turn.id, f.handle);
    expect(f.answer).not.toHaveBeenCalled();
    expect(f.store.pending().filter((out) => out.kind === 'permission.answer')).toHaveLength(1);
    expect(f.store.must<Approval>('approvals', approval.id).delivery_error).toContain(
      'session process',
    );
    expect(f.control.needsYou(user).items).toMatchObject([
      { source: { table: 'approvals', id: approval.id }, reason: 'answer_undelivered' },
    ]);
  } finally {
    await f.close();
  }
});

it('delivers an answer held while the session had no process once the process is back', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.respond(approval);
    f.control.handles.delete(f.turn.id);
    await f.control.tick();
    expect(f.store.pending().filter((out) => out.kind === 'permission.answer')).toHaveLength(1);
    f.control.handles.set(f.turn.id, f.handle);
    await f.control.tick();
    expect(f.answer).toHaveBeenCalledTimes(1);
    expect(f.store.pending().filter((out) => out.kind === 'permission.answer')).toHaveLength(0);
    expect(f.store.must<Approval>('approvals', approval.id).delivery_error).toBeUndefined();
  } finally {
    await f.close();
  }
});

it('stops retrying an answer the running process has no pending request for', async () => {
  const f = await approvalFixture();
  try {
    f.answer.mockImplementation(async () => ({
      ok: false,
      reason: 'No pending permission request with this id',
      unknown_request: true,
    }));
    const approval = f.request();
    f.respond(approval);
    for (let i = 0; i < 4; i++) await f.control.tick();
    expect(f.answer).toHaveBeenCalledTimes(1);
    expect(
      f.store.db.prepare("SELECT state FROM outbox WHERE kind='permission.answer'").all(),
    ).toEqual([{ state: 'done' }]);
    expect(
      f.store
        .kindEvents(f.project.id, ['approval.delivery_failed'])
        .filter((event) => event.aggregate_id === approval.id),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('stops retrying an answer once its session has ended', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.respond(approval);
    f.control.handles.delete(f.turn.id);
    const session = f.store.must<Session>('sessions', approval.session_id!);
    f.store.update('sessions', { ...session, state: 'closed' as const }, session.revision);
    await f.control.tick();
    f.control.handles.set(f.turn.id, f.handle);
    expect(f.store.pending().filter((out) => out.kind === 'permission.answer')).toHaveLength(0);
    expect(f.control.needsYou(user).items.map((item) => item.reason)).not.toContain(
      'answer_undelivered',
    );
  } finally {
    await f.close();
  }
});

it('lists a lost request in needs-you until the session starts a new turn', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.emit({
      key: 'turn-ended',
      provider_sequence: 100,
      turn_id: f.turn.id,
      kind: 'turn.completed',
      status: 'completed',
    });
    expect(f.control.needsYou(user).items).toMatchObject([
      {
        source: { table: 'approvals', id: approval.id },
        turn_id: f.turn.id,
        request_id: approval.request_id,
        status: 'void',
        reason: 'permission_voided',
      },
    ]);
    await eventually(
      () => f.store.must<Session>('sessions', f.session.id).state === 'open',
      () => f.control.tick(),
    );
    f.call(
      'session.send',
      { session_id: f.session.id, input: 'Try again' },
      f.store.must<Session>('sessions', f.session.id).revision,
    );
    expect(f.control.needsYou(user).items.map((item) => item.source.id)).toEqual([approval.id]);
    await eventually(
      () =>
        f.store
          .list<SessionTurn>('session_turns')
          .some((turn) => turn.id !== f.turn.id && turn.state === 'running'),
      () => f.control.tick(),
    );
    expect(f.control.needsYou(user).items).toEqual([]);
  } finally {
    await f.close();
  }
});

it('keeps a lost request listed after a steer delivered into the turn that raised it', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.emit({
      key: 'turn-ended',
      provider_sequence: 100,
      turn_id: f.turn.id,
      kind: 'turn.completed',
      status: 'completed',
    });
    f.store.insert<SessionTurn>('session_turns', {
      ...f.store.must<SessionTurn>('session_turns', f.turn.id),
      id: 'steer-into-raising-turn',
      revision: 1,
      input: 'Use the staging database',
      kind: 'steer',
      delivery: 'delivered',
      state: 'completed',
    });
    expect(f.control.needsYou(user).items.map((item) => [item.source.id, item.reason])).toEqual([
      [approval.id, 'permission_voided'],
    ]);
  } finally {
    await f.close();
  }
});

it('requeues interrupted sent permission answers on recovery', async () => {
  const f = await approvalFixture();
  try {
    const approval = f.request();
    f.respond(approval);
    const out = f.store.pending().find((out) => out.kind === 'permission.answer')!;
    f.store.mark(out.id, 'sent');
    const restarted = new Control(f.store, f.files, [f.adapter]);
    await restarted.recover();
    expect(f.store.pending().some((entry) => entry.id === out.id)).toBe(true);
  } finally {
    await f.close();
  }
});

it.each(['closed', 'reconciling'] as const)(
  'denies a repeated pending permission request after its session becomes %s',
  async (state) => {
    const f = await approvalFixture();
    try {
      const approval = f.request();
      const session = f.store.must<Session>('sessions', f.session.id);
      f.store.update('sessions', { ...session, state }, session.revision);
      f.request();
      expect(f.store.must<Approval>('approvals', approval.id).state).toBe('void');
      await f.control.tick();
      expect(f.answer).toHaveBeenCalledExactlyOnceWith(f.handle, approval.request_id, 'deny');
    } finally {
      await f.close();
    }
  },
);
