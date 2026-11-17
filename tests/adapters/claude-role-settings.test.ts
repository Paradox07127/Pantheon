import { expect, it, vi } from 'vitest';
import type { SDKMessage } from '../../packages/adapters/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts';
import { NATIVE_ENV_ALLOWLIST, type SessionSpec } from '@pantheon/domain';
import { ClaudeAdapter, buildClaudeOptions } from '../../packages/adapters/src/claude.js';
import { workbenchSessionSpec } from '../../packages/control/src/workbench-session.js';
import type { ControlContext } from '../../packages/control/src/context.js';
import { awaitWorkspaceReady } from '../helpers.js';
import { boundTaskSession, workbenchFixture } from '../control/workbench-fixture.js';

const base = { pathToClaudeCodeExecutable: 'fake-claude', env: { PATH: '/test' } };
const spec = (): SessionSpec => ({
  platform_session_id: 'role-settings-session',
  project_id: 'role-settings-project',
  runtime: 'claude',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  extensions: { mode: 'none' },
  budget: { max_turns: 1, wall_time_ms: 10000 },
});

it('disables workflows for lead task sessions while preserving lead and user settings', async () => {
  const f = await workbenchFixture();
  const lead = await f.create();
  const task = await boundTaskSession(f, lead.id, 'implement-export');
  await awaitWorkspaceReady(f.control, lead.workspace_id!);
  await awaitWorkspaceReady(f.control, task.workspace_id!);
  const ctx = (f.control as unknown as { ctx: ControlContext }).ctx;
  const taskOptions = buildClaudeOptions(workbenchSessionSpec(ctx, task), base);
  expect(taskOptions.settings).toMatchObject({ disableWorkflows: true });
  expect(taskOptions.settings).toHaveProperty('permissions.deny');
  for (const session of [lead, await f.create()]) {
    await awaitWorkspaceReady(f.control, session.workspace_id!);
    const options = buildClaudeOptions(workbenchSessionSpec(ctx, session), base);
    expect(options.settings).not.toHaveProperty('disableWorkflows');
    expect(options.settings).not.toHaveProperty('autoMemoryEnabled');
  }
});

it('caps parallel and nested subagent launch requests without blocking other tools', async () => {
  const input = { ...spec(), task_session: true };
  const options = buildClaudeOptions(input, base);
  const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
  const call = (tool_name: string, index: number) =>
    hook(
      {
        hook_event_name: 'PreToolUse',
        session_id: 'native-task',
        transcript_path: '/unused/transcript.jsonl',
        cwd: input.cwd,
        tool_name,
        tool_input: {},
        tool_use_id: `launch-${index}`,
        ...(index % 2 ? { agent_id: 'nested-agent' } : {}),
      },
      `launch-${index}`,
      { signal: new AbortController().signal },
    );
  const allowed = { hookSpecificOutput: { permissionDecision: 'ask' } };
  expect(await call('Read', 0)).toMatchObject(allowed);
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) => call(index % 2 ? 'Task' : 'Agent', index)),
  );
  for (const result of results.slice(0, 4)) expect(result).toMatchObject(allowed);
  for (const result of results.slice(4))
    expect(result).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('subagent'),
      },
    });
  expect(await call('Read', 7)).toMatchObject(allowed);
  const separate = buildClaudeOptions(input, base);
  const user = buildClaudeOptions(spec(), base);
  for (const other of [separate, user])
    expect(
      await other.hooks!.PreToolUse![0]!.hooks[0]!(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'native-other',
          transcript_path: '/unused/transcript.jsonl',
          cwd: input.cwd,
          tool_name: 'Agent',
          tool_input: {},
          tool_use_id: 'other-launch',
        },
        'other-launch',
        { signal: new AbortController().signal },
      ),
    ).toMatchObject(allowed);
});

it('disables reviewer auto memory with isolated or inherited extensions and with or without a sandbox', () => {
  for (const sandbox of [undefined, { writable_roots: [], protected_entries: [] }]) {
    for (const extensions of [
      { mode: 'none' },
      {
        mode: 'inherit',
        overrides: {
          disabled_mcp_servers: [],
          disabled_plugins: [],
          disabled_skills: [],
          disable_apps: false,
          disable_hooks: false,
        },
      },
    ] satisfies SessionSpec['extensions'][]) {
      const options = buildClaudeOptions(
        { ...spec(), role: 'reviewer', extensions, sandbox },
        base,
      );
      expect(options.settings).toMatchObject({ autoMemoryEnabled: false });
      expect(options.settings).not.toHaveProperty('disableWorkflows');
    }
  }
});

it('keeps the task subagent cap when the session reopens its SDK query', async () => {
  const queries: { options: ReturnType<typeof buildClaudeOptions>; end: () => void }[] = [];
  const query = ({ options }: { options: ReturnType<typeof buildClaudeOptions> }) => {
    const ended = Promise.withResolvers<void>();
    queries.push({ options, end: ended.resolve });
    return {
      initializationResult: async () => ({
        account: { apiProvider: 'firstParty', subscriptionType: 'max' },
      }),
      close: ended.resolve,
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
        await ended.promise;
      },
    };
  };
  const adapter = new ClaudeAdapter('fake-claude', 'test', query as never);
  const handle = await adapter.start({ ...spec(), task_session: true }, () => {});
  try {
    await adapter.send(handle, { turn_id: 'first-turn', input: 'Implement the export' });
    const input = {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'native-task',
      transcript_path: '/unused/transcript.jsonl',
      cwd: process.cwd(),
      tool_name: 'Agent',
      tool_input: {},
      tool_use_id: 'launch',
    };
    for (let index = 0; index < 4; index++)
      await queries[0]!.options.hooks!.PreToolUse![0]!.hooks[0]!(input, 'launch', {
        signal: new AbortController().signal,
      });
    queries[0]!.end();
    await vi.waitFor(async () => {
      expect((await adapter.inspect(handle)).state).toBe('idle');
    });
    await adapter.send(handle, { turn_id: 'second-turn', input: 'Continue the export' });
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    expect(
      await queries[1]!.options.hooks!.PreToolUse![0]!.hooks[0]!(input, 'launch', {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  } finally {
    await adapter.close(handle, Date.now() + 1000);
  }
});
