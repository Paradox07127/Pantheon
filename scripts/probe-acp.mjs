import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { AcpAdapter, acpProfiles, JsonRpcProcess } from '@pantheon/adapters';
import { NATIVE_ENV_ALLOWLIST } from '@pantheon/domain';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    out: { type: 'string' },
    runtime: { type: 'string', multiple: true },
    binary: { type: 'string' },
    args: { type: 'string', multiple: true },
  },
});
const runtimes = values.runtime ?? Object.keys(acpProfiles);
for (const runtime of runtimes)
  if (!Object.hasOwn(acpProfiles, runtime)) throw new Error(`Unknown runtime ${runtime}`);
const output = path.resolve(values.out ?? `.notes/evidence/acp-probe-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const probeRoot = await mkdtemp(path.join(os.tmpdir(), 'pantheon-acp-probe-'));

const TURN_WALL_TIME_MS = 300000;
const REQUEST_TIMEOUT_MS = 60000;
const CANCEL_DEADLINE_MS = 10000;
const README = `# Invoice

\`total(items, discountPercent, taxRate)\` in \`src/invoice.js\` returns the amount due: it first
applies the discount to the subtotal, then charges tax on the discounted amount, rounded to cents.

Each item is \`{ price, quantity }\`. \`discountPercent\` runs from 0 to 100; \`taxRate\` is a
fraction, so 0.1 means 10%.

Example input: items \`[{ price: 50, quantity: 2 }, { price: 25, quantity: 4 }]\`, discountPercent
\`20\`, taxRate \`0.1\`.
`;
const BUG = '  const tax = base * taxRate;';
const INVOICE = `// Invoice totals for the order screen.

export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

export function total(items, discountPercent, taxRate) {
  const base = subtotal(items);
${BUG}
  const discounted = base * (1 - discountPercent / 100);
  return Math.round((discounted + tax) * 100) / 100;
}
`;
const BUG_LINE = INVOICE.split('\n').indexOf(BUG) + 1;
// The README example total, discount first and tax second.
const EXPECTED_TOTAL = Math.round((50 * 2 + 25 * 4) * (1 - 20 / 100) * (1 + 0.1) * 100) / 100;
const number = (value) => new RegExp(`(?<![\\d.])${value}(?:\\.0+)?(?!\\.?\\d)`);
const PROMPTS = {
  text: '读 README.md 和 src/invoice.js。total() 和 README 描述的顺序一致吗？指出不一致的那一行（行号）和原因，不超过三句。不要改任何文件。',
  resume: '给出一个能抓住这个 bug 的测试用例：输入和期望输出。用 README.md 里的示例输入。',
  permission: '把这个测试写进 test/invoice.test.js。',
  cancel: '逐个审查 src/ 下每个函数的边界情况，写详细报告。',
  outside: (marker) => `把一句话总结写进 ../outside-${marker}.md。`,
};
const INITIALIZE = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: 'pantheon', title: 'Pantheon', version: '0.1.0' },
};

const report = {
  started_at: new Date().toISOString(),
  live: !!values.live,
  scope:
    'ACP handshake and, when live, text, resume, permission, cancel and outside-write turns on a fixture bug; not writer acceptance',
  fixture: { bug_line: BUG_LINE, expected_total: EXPECTED_TOTAL },
  limits: {
    sessions_per_runtime: 1,
    cancel_sessions_per_runtime: 1,
    turns_per_runtime: 5,
    wall_time_ms_per_turn: TURN_WALL_TIME_MS,
    api_fallback: false,
  },
  backends: [],
};
// Agent payloads are kept verbatim except for anything shaped like an account email.
const serialize = (value) =>
  JSON.stringify(value, null, 2).replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>') + '\n';
const saveReport = () =>
  writeFile(path.join(output, 'report.json'), serialize(report), { mode: 0o600 });

async function fixture(dir) {
  const project = path.join(dir, 'project');
  await mkdir(path.join(project, 'src'), { recursive: true });
  await writeFile(path.join(project, 'README.md'), README);
  await writeFile(path.join(project, 'src', 'invoice.js'), INVOICE);
  await writeFile(path.join(project, 'package.json'), '{ "type": "module" }\n');
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Pantheon probe',
    '-c',
    'user.email=probe@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'Invoice fixture',
  );
  return project;
}

async function handshake(binary, args, cwd) {
  const rpc = new JsonRpcProcess(binary, args, cwd, NATIVE_ENV_ALLOWLIST, {}, { jsonrpc: true });
  try {
    const result = await rpc.initialize(INITIALIZE, null, REQUEST_TIMEOUT_MS);
    return {
      status: 'passed',
      protocol_version: result?.protocolVersion,
      agent: result?.agentInfo
        ? { name: result.agentInfo.name, version: result.agentInfo.version }
        : undefined,
      agent_capabilities: result?.agentCapabilities,
      auth_methods: (result?.authMethods ?? []).map((method) => method.id),
    };
  } finally {
    await rpc.close();
  }
}

async function probeRuntime(item, adapter, dir) {
  const cwd = await fixture(dir);
  const spec = (platform_session_id) => ({
    platform_session_id,
    project_id: 'acp-probe',
    runtime: adapter.name,
    role: 'planner',
    device_id: 'local',
    cwd,
    env_allowlist: NATIVE_ENV_ALLOWLIST,
    skills: [],
    mcp_servers: [],
    budget: { max_turns: 5, wall_time_ms: TURN_WALL_TIME_MS },
  });
  const open = async (id, native_session_id) => {
    const session = { events: [], onEvent: undefined };
    const sink = (event) => {
      session.events.push(event);
      session.onEvent?.(event);
    };
    session.handle =
      native_session_id === undefined
        ? await adapter.start(spec(id), sink)
        : await adapter.resume(spec(id), native_session_id, sink);
    return session;
  };
  // Every permission request gets the step's decision; deny unless the step says otherwise.
  const turn = async (session, input, { decision = 'deny', onEvent } = {}) => {
    const turn_id = randomUUID();
    const done = new Promise((resolve) => {
      session.onEvent = (event) => {
        if (event.kind === 'permission.requested')
          void adapter.answerPermission(session.handle, event.request_id, decision);
        onEvent?.(event);
        if (event.kind === 'turn.completed' && event.turn_id === turn_id) resolve(event);
      };
    });
    const receipt = await adapter.send(session.handle, { turn_id, input });
    if (receipt.status !== 'delivered') throw new Error(receipt.reason ?? 'Turn not delivered');
    const completed = await done;
    const events = session.events.filter((event) => event.turn_id === turn_id);
    return {
      completed,
      text: events
        .filter((event) => event.kind === 'message.delta')
        .map((event) => event.text ?? '')
        .join(''),
      permissions: events.filter((event) => event.kind === 'permission.requested').length,
    };
  };
  const step = async (name, session, run) => {
    const from = session ? session.events.length : 0;
    let result;
    try {
      result = await run();
    } finally {
      const target = result?.session ?? session;
      const eventFile = path.join(output, `${adapter.name}-${name}.json`);
      await writeFile(eventFile, serialize(target ? target.events.slice(from) : []), {
        mode: 0o600,
      });
      item.steps.push({
        step: name,
        passed: result?.passed ?? false,
        detail: result?.detail ?? { error: 'Step threw' },
        event_file: path.basename(eventFile),
        sha256: createHash('sha256')
          .update(await readFile(eventFile))
          .digest('hex'),
      });
    }
  };
  const platformId = randomUUID();
  let main;
  try {
    let nativeId;
    await step('text', undefined, async () => {
      const first = await open(platformId);
      try {
        const { completed, text } = await turn(first, PROMPTS.text);
        nativeId = first.handle.native_session_id;
        const checks = {
          mentions_bug_line: number(BUG_LINE).test(text),
          mentions_tax: /tax|税/i.test(text),
          mentions_discount: /discount|折扣|打折|折后/i.test(text),
        };
        return {
          session: first,
          passed: completed.status === 'completed' && Object.values(checks).every(Boolean),
          detail: {
            status: completed.status,
            error: completed.error,
            native_session_id: nativeId,
            ...checks,
            answer: text,
          },
        };
      } finally {
        await adapter.close(first.handle, Date.now() + CANCEL_DEADLINE_MS);
      }
    });
    await step('resume', undefined, async () => {
      main = await open(platformId, nativeId);
      const started = main.events.find((event) => event.kind === 'session.started');
      const { completed, text } = await turn(main, PROMPTS.resume);
      const checks = {
        resumed_same_session: !!nativeId && started?.native_session_id === nativeId,
        mentions_expected_total: number(EXPECTED_TOTAL).test(text),
      };
      return {
        session: main,
        passed: completed.status === 'completed' && Object.values(checks).every(Boolean),
        detail: {
          status: completed.status,
          error: completed.error,
          expected_total: EXPECTED_TOTAL,
          ...checks,
          answer: text,
        },
      };
    });
    await step('permission', main, async () => {
      const { completed, permissions } = await turn(main, PROMPTS.permission);
      const file_exists = existsSync(path.join(cwd, 'test', 'invoice.test.js'));
      return {
        passed: permissions > 0 && !file_exists,
        detail: {
          status: completed.status,
          error: completed.error,
          permission_requests: permissions,
          decision: 'deny',
          file_exists,
        },
      };
    });
    await step('cancel', undefined, async () => {
      const other = await open(randomUUID());
      let deadline, cancelled;
      const { completed } = await turn(other, PROMPTS.cancel, {
        onEvent: (event) => {
          if (event.kind !== 'message.delta' || cancelled) return;
          deadline = Date.now() + CANCEL_DEADLINE_MS;
          cancelled = adapter.cancel(other.handle, deadline);
        },
      });
      const finishedAt = Date.now();
      const receipt = cancelled
        ? await cancelled
        : await adapter.close(other.handle, Date.now() + CANCEL_DEADLINE_MS);
      const in_time = deadline !== undefined && finishedAt <= deadline;
      return {
        session: other,
        passed: !!cancelled && completed.status === 'interrupted' && in_time,
        detail: {
          status: completed.status,
          error: completed.error,
          cancelled_after_first_delta: !!cancelled,
          terminal_within_deadline: in_time,
          process_stopped: receipt.stopped,
          stop_method: receipt.evidence?.method,
        },
      };
    });
    await step('outside_write', main, async () => {
      const marker = randomUUID().slice(0, 8);
      const outside = path.join(dir, `outside-${marker}.md`);
      const { completed, permissions } = await turn(main, PROMPTS.outside(marker), {
        decision: 'allow',
      });
      return {
        passed: completed.status === 'completed',
        detail: {
          status: completed.status,
          error: completed.error,
          permission_requests: permissions,
          decision: 'allow',
          outside_file: path.basename(outside),
          outside_file_written: existsSync(outside),
        },
      };
    });
  } finally {
    if (main) await adapter.close(main.handle, Date.now() + CANCEL_DEADLINE_MS);
  }
}

try {
  for (const runtime of runtimes) {
    const binary = values.binary ?? acpProfiles[runtime].binary;
    const args = values.binary ? (values.args ?? []) : acpProfiles[runtime].args;
    const item = {
      runtime,
      binary,
      args,
      version: 'unknown',
      handshake: { status: 'not_run' },
      steps: [],
      status: 'not_run',
    };
    report.backends.push(item);
    const dir = path.join(probeRoot, runtime);
    await mkdir(dir);
    try {
      const adapter = new AcpAdapter({
        name: runtime,
        binary,
        profile: { ...acpProfiles[runtime], args },
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
      });
      item.version = (await adapter.probe()).version;
      try {
        item.handshake = await handshake(binary, args, dir);
      } catch (error) {
        item.handshake = { status: 'failed', error: String(error) };
        throw error;
      }
      if (values.live) {
        await probeRuntime(item, adapter, dir);
        item.status = 'probed';
      } else item.status = 'handshake_only';
    } catch (error) {
      item.status = 'failed';
      item.error = String(error);
      process.exitCode = 1;
    }
    await saveReport();
    console.log(
      JSON.stringify({
        runtime: item.runtime,
        version: item.version,
        handshake: item.handshake.status,
        protocol_version: item.handshake.protocol_version,
        status: item.status,
        steps: Object.fromEntries(item.steps.map(({ step, passed }) => [step, passed])),
        error: item.error,
      }),
    );
  }
} finally {
  report.finished_at = new Date().toISOString();
  await saveReport();
  await rm(probeRoot, { recursive: true, force: true });
}
console.log('Report: ' + path.join(output, 'report.json'));
