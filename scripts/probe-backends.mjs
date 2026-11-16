import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import {
  ClaudeAdapter,
  CodexAdapter,
  JsonRpcProcess,
  nativeEnvironment,
  versionOf,
} from '@pantheon/adapters';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, out: { type: 'string' } } });
const output = path.resolve(values.out ?? `.notes/evidence/backend-probe-${Date.now()}`);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output, { mode: 0o700 });
const fixture = await mkdtemp(path.join(os.tmpdir(), 'pantheon-native-probe-'));
const adapters = [new ClaudeAdapter('claude'), new CodexAdapter('codex')];
const report = {
  started_at: new Date().toISOString(),
  live: !!values.live,
  scope:
    'Version/handshake and optional text-only native session/resume; not isolation or writer acceptance',
  limits: {
    sessions_per_provider: 1,
    turns_per_session: 2,
    wall_time_ms_per_session: 300000,
    api_fallback: false,
  },
  backends: [],
};
try {
  for (const adapter of adapters) {
    const item = {
      runtime: adapter.name,
      version: versionOf(adapter.binary),
      authentication: 'unknown',
      handshake: 'not_run',
      turns: [],
      status: 'not_run',
    };
    report.backends.push(item);
    try {
      if (adapter.name === 'claude') {
        const status = JSON.parse(
          execFileSync(adapter.binary, ['auth', 'status', '--json'], {
            encoding: 'utf8',
            timeout: 10000,
            env: nativeEnvironment(),
          }),
        );
        item.authentication = {
          loggedIn: status.loggedIn,
          authMethod: status.authMethod,
          subscriptionType: status.subscriptionType,
        };
        if (values.live && !(status.loggedIn && ['claude.ai', 'oauth'].includes(status.authMethod)))
          throw new Error('Existing subscription login not confirmed; refusing API fallback');
      } else {
        const rpc = new JsonRpcProcess(adapter.binary, ['app-server'], fixture);
        try {
          await rpc.initialize();
          item.handshake = 'passed';
          const result = await rpc.request('account/read', { refreshToken: false });
          item.authentication = {
            type: result.account?.type,
            requiresOpenaiAuth: result.requiresOpenaiAuth,
          };
          if (values.live && result.account?.type !== 'chatgpt')
            throw new Error('Existing ChatGPT login not confirmed; refusing API fallback');
        } finally {
          await rpc.close();
        }
      }
      if (values.live) {
        const { NATIVE_ENV_ALLOWLIST } = await import('@pantheon/domain');
        let nativeId;
        const deadline = Date.now() + 300000,
          sessionId = randomUUID();
        for (let round = 0; round < 2; round++) {
          const events = [],
            marker = round === 0 ? 'PANTHEON_PROBE_ONE' : 'PANTHEON_PROBE_TWO',
            turnId = randomUUID();
          let resolveDone;
          const done = new Promise((resolve) => {
            resolveDone = resolve;
          });
          const spec = {
            platform_session_id: sessionId,
            project_id: 'authorized-native-probe',
            runtime: adapter.name,
            role: 'planner',
            device_id: 'local',
            cwd: fixture,
            env_allowlist: NATIVE_ENV_ALLOWLIST,
            skills: [],
            mcp_servers: [],
            budget: { max_turns: 2, wall_time_ms: Math.max(1, deadline - Date.now()) },
          };
          const sink = (event) => {
            events.push(event);
            if (event.kind === 'turn.completed' && event.turn_id === turnId) resolveDone(event);
          };
          const handle =
            round === 0
              ? await adapter.start(spec, sink)
              : await adapter.resume(spec, nativeId, sink);
          try {
            const receipt = await adapter.send(handle, {
              turn_id: turnId,
              input: `Reply with exactly ${marker}. Do not use tools or access any files.`,
            });
            if (receipt.status !== 'delivered')
              throw new Error(receipt.reason ?? 'Turn not delivered');
            const completed = await done;
            if (completed.status === 'failed') throw new Error(completed.error);
          } finally {
            await adapter.close(handle, Date.now() + 10000);
          }
          const text = events
            .filter((e) => e.kind === 'message.delta')
            .map((e) => e.text ?? '')
            .join('');
          const current =
            events.find((e) => e.kind === 'session.started')?.native_session_id ??
            handle.native_session_id;
          const eventFile = path.join(output, `${adapter.name}-turn-${round + 1}.json`);
          await writeFile(eventFile, JSON.stringify(events, null, 2) + '\n', { mode: 0o600 });
          const row = {
            round: round + 1,
            native_session_id: current,
            text_matches: text.trim() === marker,
            resumed_same_session: round === 0 ? null : current === nativeId,
            event_file: path.basename(eventFile),
            sha256: createHash('sha256')
              .update(await readFile(eventFile))
              .digest('hex'),
          };
          item.turns.push(row);
          if (!row.text_matches || !current || (round > 0 && !row.resumed_same_session))
            throw new Error('Native text/resume assertion failed');
          nativeId = current;
        }
        item.status = 'passed_text_and_resume';
      } else item.status = 'passed_offline_probe';
    } catch (error) {
      item.status = 'failed';
      item.error = String(error);
      process.exitCode = 1;
    }
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        runtime: item.runtime,
        version: item.version,
        status: item.status,
        error: item.error,
      }),
    );
  }
} finally {
  report.finished_at = new Date().toISOString();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  await rm(fixture, { recursive: true, force: true });
}
console.log('Report: ' + path.join(output, 'report.json'));
