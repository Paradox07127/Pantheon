// A scripted Agent Client Protocol agent on stdio. The first prompt text picks the turn's script;
// FAKE_ACP_LOG records every received frame, FAKE_ACP_FAIL fails a handshake step,
// FAKE_ACP_NO_MODEL_OPTION leaves the model out of the config options, FAKE_ACP_NO_THOUGHT_OPTION
// the thought level, FAKE_ACP_REJECT_EFFORT refuses to set the thought level, FAKE_ACP_GROUPED_MODELS
// offers grouped models and advertises session/close, FAKE_ACP_ARGV_LOG names a file that gets
// the agent's own arguments, FAKE_ACP_RESUMED_COST is the session cost a resume replays,
// FAKE_ACP_STARTUP_CONFIG_UPDATE announces the options ahead of the session/new response and
// FAKE_ACP_REFUSE_MODEL names a model value the agent refuses to set. The last
// text block of a prompt picks the script. A replies file (first
// argument) instead scripts prompts by substring: one text chunk, then either a hold until cancel or
// an edit permission request that, once allowed, writes the file `write` captures from the prompt.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const log = process.env.FAKE_ACP_LOG;
const fail = process.env.FAKE_ACP_FAIL;
const initDelay = Number(process.env.FAKE_ACP_INIT_DELAY ?? 0);
const slowPromptDelay = Number(process.env.FAKE_ACP_SLOW_PROMPT_DELAY ?? 400);
const replies =
  process.argv[2] && !process.argv[2].startsWith('--')
    ? JSON.parse(readFileSync(process.argv[2], 'utf8'))
    : [];
if (process.env.FAKE_ACP_ARGV_LOG)
  writeFileSync(process.env.FAKE_ACP_ARGV_LOG, JSON.stringify(process.argv.slice(2)));
const patchAt = process.argv.indexOf('--patch');
if (process.env.FAKE_ACP_PATCH_LOG && patchAt > 0)
  writeFileSync(
    process.env.FAKE_ACP_PATCH_LOG,
    JSON.stringify({
      path: process.argv[patchAt + 1],
      content: readFileSync(process.argv[patchAt + 1], 'utf8'),
    }),
  );
const write = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const configOptions = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'fake-model',
    options: [
      { value: 'fake-model', name: 'Fake model' },
      { value: 'other-model', name: 'Other model' },
    ],
  },
  {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
];
// Models in provider groups whose values are JSON strings, an off thought level, and session/close.
const grouped = Boolean(process.env.FAKE_ACP_GROUPED_MODELS);
if (grouped) {
  configOptions[0].currentValue = '["fake-provider","fake-flash"]';
  configOptions[0].options = [
    {
      group: 'fake-provider',
      name: 'Fake provider',
      options: [
        { value: '["fake-provider","fake-flash"]', name: 'fake-flash' },
        {
          value: '["fake-provider","fake-pro"]',
          name: 'Fake-Pro',
          description: 'Stronger reasoning',
        },
      ],
    },
    {
      group: 'fake-account',
      name: 'Fake account',
      options: [{ value: '["fake-account","fake-pro"]', name: 'Fake-Pro' }],
    },
  ];
  configOptions[1].currentValue = 'high';
  configOptions[1].options = ['off', 'low', 'high', 'max', 'turbo'].map((value) => ({
    value,
    name: value,
  }));
}
if (process.env.FAKE_ACP_NO_MODEL_OPTION) configOptions.shift();
if (process.env.FAKE_ACP_NO_THOUGHT_OPTION) configOptions.pop();
// The ACP stdio MCP server shape: env is a list of name/value pairs, not a map.
const validMcpServers = (servers) =>
  Array.isArray(servers) &&
  servers.every(
    (server) =>
      typeof server.name === 'string' &&
      typeof server.command === 'string' &&
      Array.isArray(server.args) &&
      server.args.every((arg) => typeof arg === 'string') &&
      Array.isArray(server.env) &&
      server.env.every((pair) => typeof pair.name === 'string' && typeof pair.value === 'string'),
  );
let sessionId = 'fake-session-1';
let prompt;
let cancelRequested = false;
// What the agent does instead of stopping when the prompt is cancelled.
let onCancel;
let sessionCost = 0;
let nextRequest = 0;
const waiting = new Map();
const update = (value) => write({ method: 'session/update', params: { sessionId, update: value } });
const stop = (stopReason, usage) => {
  if (!prompt) return;
  write({ id: prompt.id, result: { stopReason, ...(usage && { usage }) } });
  prompt = undefined;
};
const ask = (method, params, then) => {
  const id = `agent-${++nextRequest}`;
  waiting.set(id, then);
  write({ id, method, params });
};
const permission = (
  kind,
  onAllow,
  optionKinds = ['allow_once', 'allow_always', 'reject_once'],
  toolCall = { toolCallId: 'call-edit', title: 'Edit notes.md', kind, rawInput: { path: 'x' } },
) =>
  ask(
    'session/request_permission',
    {
      sessionId,
      toolCall,
      options: [
        { optionId: 'opt-allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'opt-allow-always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'opt-reject-once', name: 'Deny', kind: 'reject_once' },
      ].filter((option) => optionKinds.includes(option.kind)),
    },
    (response) => {
      const outcome = response.result?.outcome;
      if (outcome?.optionId?.startsWith('opt-allow')) onAllow?.();
      stop(cancelRequested || outcome?.outcome === 'cancelled' ? 'cancelled' : 'end_turn');
    },
  );

const scripts = {
  text() {
    for (const text of ['Hel', 'lo', ' world'])
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    update({
      sessionUpdate: 'usage_update',
      used: 1200,
      size: 200000,
      cost: { amount: 0.25, currency: 'USD' },
    });
    update({
      sessionUpdate: 'usage_update',
      used: 1300,
      size: 200000,
      cost: { amount: 1, currency: 'EUR' },
    });
    update({ sessionUpdate: 'session_info_update', title: 'Greeting' });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [] });
    stop('end_turn');
  },
  // The unstable PromptResponse.usage: input excludes the cache, thought is part of output.
  usage() {
    update({
      sessionUpdate: 'usage_update',
      used: 1800,
      size: 200000,
      cost: { amount: 0.5, currency: 'USD' },
    });
    stop('end_turn', {
      totalTokens: 1900,
      inputTokens: 300,
      outputTokens: 400,
      thoughtTokens: 150,
      cachedReadTokens: 1000,
      cachedWriteTokens: 200,
    });
  },
  slow() {
    setTimeout(() => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } });
      stop('end_turn');
    }, slowPromptDelay);
  },
  tools() {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-read',
      title: 'Read notes.md',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'notes.md' },
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-read', status: 'in_progress' });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-read',
      status: 'completed',
      rawOutput: { content: 'notes' },
    });
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-run',
      title: 'Run tests',
      kind: 'execute',
      status: 'pending',
    });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-run',
      status: 'failed',
      rawOutput: { exitCode: 1 },
    });
    stop('end_turn');
  },
  // A tool done in its first frame, and one whose input and output come before a status-only end.
  'tools-merged'() {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-done',
      title: 'Read a.md',
      kind: 'read',
      status: 'completed',
      rawInput: { path: 'a.md' },
      rawOutput: { content: 'a' },
    });
    update({ sessionUpdate: 'tool_call', toolCallId: 'call-part', title: 'Read b.md' });
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-part',
      status: 'in_progress',
      rawInput: { path: 'b.md' },
      content: [{ type: 'content', content: { type: 'text', text: 'b' } }],
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call-part', status: 'completed' });
    stop('end_turn');
  },
  // The agent falls back to another model mid-turn.
  'model-fallback'() {
    configOptions[0].currentValue = 'other-model';
    update({ sessionUpdate: 'config_option_update', configOptions });
    stop('end_turn');
  },
  vendor() {
    ask('vendor/question', { sessionId, question: 'Continue?' }, (response) => {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: JSON.stringify(response) },
      });
      stop('end_turn');
    });
  },
  // FAKE_ACP_ELICITATION holds the elicitation/create params besides the session id.
  elicit() {
    ask('elicitation/create', { sessionId, ...JSON.parse(process.env.FAKE_ACP_ELICITATION) }, () =>
      stop('end_turn'),
    );
  },
  permission() {
    permission('edit');
  },
  'permission-read'() {
    permission('read');
  },
  'permission-no-allow-once'() {
    permission('edit', undefined, ['allow_always', 'reject_once']);
  },
  // dsh's shape: the request names only the call, whose tool name and input came before with kind other.
  'permission-call-id-only'() {
    update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-bash',
      title: 'bash',
      kind: 'other',
      status: 'pending',
      rawInput: { command: 'rm -rf build' },
    });
    permission(undefined, undefined, undefined, { toolCallId: 'call-bash' });
  },
  'permission-mode-env'() {
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: process.env.DSH_PERMISSION_MODE ?? 'unset' },
    });
    stop('end_turn');
  },
  hold() {},
  // Titles the session from the start of the first text block, as grok does.
  titled() {
    update({
      sessionUpdate: 'session_info_update',
      title: prompt.params.prompt[0].text.slice(0, 20),
    });
    stop('end_turn');
  },
  // Each turn adds 1 USD to the cumulative session cost a usage_update carries.
  cost() {
    sessionCost += 1;
    update({
      sessionUpdate: 'usage_update',
      used: 100,
      size: 200000,
      cost: { amount: sessionCost, currency: 'USD' },
    });
    stop('end_turn');
  },
  // Answers a cancel late, with output and usage first.
  'slow-cancel'() {
    onCancel = () =>
      setTimeout(() => {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } });
        update({
          sessionUpdate: 'usage_update',
          used: 900,
          size: 200000,
          cost: { amount: 7, currency: 'USD' },
        });
        stop('cancelled', { totalTokens: 30, inputTokens: 10, outputTokens: 20 });
      }, 200);
  },
  // A permission request that crosses the cancel.
  'permission-on-cancel'() {
    onCancel = () => permission('edit');
  },
  // An elicitation that crosses the cancel.
  'elicit-on-cancel'() {
    onCancel = () =>
      ask(
        'elicitation/create',
        {
          sessionId,
          mode: 'form',
          message: 'Pantheon needs a value',
          requestedSchema: { type: 'object', properties: { field: { type: 'string' } } },
        },
        () => stop('cancelled'),
      );
  },
  refusal() {
    stop('refusal');
  },
  'rpc-error'() {
    write({ id: prompt.id, error: { code: -32603, message: 'Internal error' } });
    prompt = undefined;
  },
  // grok's shape for a provider error: the detail is in data.message.
  'billing-error'() {
    write({
      id: prompt.id,
      error: {
        code: -32603,
        message: 'Internal error',
        data: {
          message: 'API error (status 402 Payment Required): usage balance exhausted',
          http_status: 402,
        },
      },
    });
    prompt = undefined;
  },
  exit() {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'bye' } });
    setTimeout(() => process.exit(3), 20);
  },
};
const replied = (reply, text) => {
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply.text } });
  if (reply.hold) return;
  if (!reply.write) return stop('end_turn');
  const file = text.match(new RegExp(reply.write))[1];
  permission('edit', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, reply.text);
  });
};

const handle = (frame) => {
  if (frame.method === undefined) {
    const then = waiting.get(frame.id);
    waiting.delete(frame.id);
    then?.(frame);
    return;
  }
  const reply = (result) => write({ id: frame.id, result });
  const error = (message) => write({ id: frame.id, error: { code: -32603, message } });
  switch (frame.method) {
    case 'initialize':
      if (fail === 'initialize') return error('Initialization refused');
      return setTimeout(
        () =>
          reply({
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: process.env.FAKE_ACP_IMAGES === 'true' },
              ...(grouped ? { sessionCapabilities: { close: {} } } : {}),
            },
            authMethods: [],
          }),
        initDelay,
      );
    case 'session/new':
      if (fail === 'session') return error('Session refused');
      if (!validMcpServers(frame.params.mcpServers)) return error('Invalid mcpServers');
      if (process.env.FAKE_ACP_STARTUP_CONFIG_UPDATE)
        update({ sessionUpdate: 'config_option_update', configOptions });
      return reply({ sessionId, configOptions });
    case 'session/load':
    case 'session/resume':
      if (
        process.env.FAKE_ACP_RESUME_METHOD &&
        frame.method !== `session/${process.env.FAKE_ACP_RESUME_METHOD}`
      )
        return error('Wrong resume method');
      if (!validMcpServers(frame.params.mcpServers)) return error('Invalid mcpServers');
      if (frame.params.sessionId === 'missing-session')
        return error('Failed to read session missing-session');
      sessionId = frame.params.sessionId;
      if (process.env.FAKE_ACP_RESUMED_COST) {
        sessionCost = Number(process.env.FAKE_ACP_RESUMED_COST);
        update({
          sessionUpdate: 'usage_update',
          used: 100,
          size: 200000,
          cost: { amount: sessionCost, currency: 'USD' },
        });
      }
      return reply({ configOptions });
    case 'session/set_config_option': {
      const option = configOptions.find((candidate) => candidate.id === frame.params.configId);
      if (!option) return error('Unknown config option');
      if (process.env.FAKE_ACP_REJECT_EFFORT && option.category === 'thought_level')
        return error('Effort rejected');
      if (option.category === 'model' && frame.params.value === process.env.FAKE_ACP_REFUSE_MODEL)
        return error('Model refused');
      option.currentValue = frame.params.value;
      return reply({ configOptions });
    }
    case 'session/prompt': {
      prompt = frame;
      cancelRequested = false;
      onCancel = undefined;
      const text = frame.params.prompt.filter((block) => block.type === 'text').at(-1).text;
      const reply = replies.find((candidate) => text.includes(candidate.match));
      return reply ? replied(reply, text) : scripts[text]();
    }
    case 'session/close':
      if (grouped) return reply({});
      return write({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
    case 'session/cancel':
      cancelRequested = true;
      if (onCancel) {
        const run = onCancel;
        onCancel = undefined;
        return run();
      }
      if (waiting.size === 0) stop('cancelled');
      return;
    default:
      if (frame.id !== undefined)
        write({ id: frame.id, error: { code: -32601, message: 'Method not found' } });
  }
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (log) appendFileSync(log, JSON.stringify(frame) + '\n');
  handle(frame);
});
