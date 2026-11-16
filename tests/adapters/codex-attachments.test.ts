import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAdapter } from '../../packages/adapters/src/codex.js';
import { JsonRpcProcess } from '../../packages/adapters/src/process.js';
import {
  NATIVE_ENV_ALLOWLIST,
  type SessionSpec,
  type TurnAttachment,
  type TurnSkill,
} from '@pantheon/domain';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const spec: SessionSpec = {
  platform_session_id: 'attachment-session',
  project_id: 'attachment-project',
  runtime: 'codex',
  device_id: 'local',
  role: 'writer',
  cwd: process.cwd(),
  env_allowlist: NATIVE_ENV_ALLOWLIST,
  skills: [],
  mcp_servers: [],
  budget: { max_turns: 1, wall_time_ms: 10000 },
};

type Request = { id: number; method: string; params: Record<string, unknown> };

/** A fake app-server whose turns keep running until the adapter closes it. */
function fakeAppServer() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);
  const requests: Request[] = [];
  const write = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', (data) => {
    for (const line of String(data).split('\n').filter(Boolean)) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      if (request.method === 'initialize') write({ id: request.id, result: {} });
      if (request.method === 'account/read')
        write({ id: request.id, result: { account: { type: 'chatgpt', planType: 'plus' } } });
      if (request.method === 'config/read')
        write({ id: request.id, result: { config: { model_provider: 'openai' } } });
      if (request.method === 'thread/name/set') write({ id: request.id, result: {} });
      if (request.method === 'thread/start')
        write({ id: request.id, result: { thread: { id: 'attachment-thread' } } });
      if (request.method === 'turn/start')
        write({ id: request.id, result: { turn: { id: 'native-turn' } } });
      if (request.method === 'turn/steer') write({ id: request.id, result: {} });
    }
  });
  // The fake child has no pid, so the transport closing stands in for the process exit.
  const originalClose = JsonRpcProcess.prototype.close;
  vi.spyOn(JsonRpcProcess.prototype, 'close').mockImplementation(function (
    this: JsonRpcProcess,
    deadline?: number,
  ) {
    child.emit('close', 0, null);
    return originalClose.call(this, deadline);
  });
  const inputs = (method: string) =>
    requests.filter((request) => request.method === method).map((r) => r.params.input);
  return { inputs };
}

const attachments: TurnAttachment[] = [
  { id: 'image-attachment', name: 'shot.png', mime: 'image/png', path: '/session/shot.png' },
  { id: 'file-attachment', name: 'notes.txt', mime: 'text/plain', path: '/session/notes.txt' },
];
const skills: TurnSkill[] = [{ name: 'review', path: '/skills/review/SKILL.md' }];
const input = (text: string) => [
  { type: 'text', text: `${text}\n\nAttached files:\n- /session/notes.txt` },
  { type: 'localImage', path: '/session/shot.png' },
  { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
];

describe('Codex attachments and skills', () => {
  it('sends only the text when the turn has no attachments or skills', async () => {
    const server = fakeAppServer();
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(spec, () => {});
    try {
      await adapter.send(handle, { turn_id: 'plain-turn', input: 'Work' });
      expect(server.inputs('turn/start')).toEqual([[{ type: 'text', text: 'Work' }]]);
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });

  it('sends the file list, local images and skills on turn/start and turn/steer', async () => {
    const server = fakeAppServer();
    const adapter = new CodexAdapter('fake-codex');
    const handle = await adapter.start(spec, () => {});
    try {
      await adapter.send(handle, { turn_id: 'attached-turn', input: 'Look', attachments, skills });
      expect(server.inputs('turn/start')).toEqual([input('Look')]);
      expect(
        await adapter.steer(handle, { turn_id: 'steer-turn', input: 'Also', attachments, skills }),
      ).toMatchObject({ status: 'delivered' });
      expect(server.inputs('turn/steer')).toEqual([input('Also')]);
    } finally {
      await adapter.close(handle, Date.now() + 1000);
    }
  });
});
