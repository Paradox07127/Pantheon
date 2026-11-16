import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, WorkbenchSession } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  target: null as { repo_root: string; cdp_port: number | null } | null,
}));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
    subscribe: () => () => {},
  }),
}));
vi.mock('@/data/app-errors', async (actual) => ({
  ...(await actual<object>()),
  debugTarget: async () => mock.target,
}));
vi.mock('@/components/Toast', () => ({ toast: vi.fn(() => 'toast') }));
import { appErrors, recordAppError } from '@/data/app-errors';
import { askDebugAgent } from '@/data/ask-debug';
import { runCommand } from '@/data/commands';
import { toast } from '@/components/Toast';

const REPO = '/work/pantheon';

const debugListed = (id: string, extra: Partial<WorkbenchSession>) =>
  ({ id, created_at: '2026-11-16T08:00:00.000Z', app_debug: {}, ...extra }) as WorkbenchSession;

let listed: WorkbenchSession[];
let bridge: {
  command: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  appInfo: ReturnType<typeof vi.fn>;
  logsDir: ReturnType<typeof vi.fn>;
};
const sent = () => bridge.command.mock.calls.map(([c]) => c as Command);

beforeEach(() => {
  listed = [];
  bridge = {
    command: vi.fn(async () => ({ ok: true, value: { id: 'session-new' } })),
    query: vi.fn(async () => ({ ok: true, value: listed })),
    appInfo: vi.fn(async () => ({ version: '1.2.3' })),
    logsDir: vi.fn(async () => '/data/logs'),
  };
  vi.stubGlobal('window', { pantheon: bridge });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
  mock.target = { repo_root: REPO, cdp_port: 41235 };
  mock.board = {
    board: {
      projects: [{ id: 'pantheon', roots: [REPO] }],
      sessions: [
        { id: 'debug-live', state: 'open', revision: 4 },
        { id: 'debug-other-port', state: 'open', revision: 2 },
        { id: 'debug-archived', state: 'open', revision: 2 },
      ],
    },
    refresh: vi.fn(),
  };
  vi.mocked(toast).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('asking the debug agent', () => {
  it.each([
    {
      name: 'copies the report without a debug target',
      target: null,
      sessions: [],
      expected: { copied: true, command: null, kind: 'result' },
    },
    {
      name: 'copies the report when no project holds the repository',
      target: { repo_root: '/elsewhere', cdp_port: 41235 },
      sessions: [],
      expected: { copied: true, command: null, kind: 'failure' },
    },
    {
      name: 'sends to the live debug session on the same port',
      target: { repo_root: REPO, cdp_port: 41235 },
      sessions: [
        debugListed('debug-other-port', { app_debug: { cdp_port: 9333 } }),
        debugListed('debug-live', { app_debug: { cdp_port: 41235 } }),
      ],
      expected: {
        copied: false,
        command: { type: 'session.send', input: { session_id: 'debug-live' } },
        kind: 'result',
      },
    },
    {
      name: 'opens a debug session when the others have another port or are archived',
      target: { repo_root: REPO, cdp_port: 41235 },
      sessions: [
        debugListed('debug-other-port', { app_debug: { cdp_port: 9333 } }),
        debugListed('debug-archived', {
          app_debug: { cdp_port: 41235 },
          archived_at: '2026-11-16T09:00:00.000Z',
        }),
      ],
      expected: {
        copied: false,
        command: {
          type: 'session.create',
          input: { project_id: 'pantheon', purpose: 'app_debug', cdp_port: 41235 },
        },
        kind: 'result',
      },
    },
  ])('$name', async ({ target, sessions, expected }) => {
    mock.target = target;
    listed = sessions;
    recordAppError({ source: 'console', message: 'render loop warning' });
    await askDebugAgent({ title: 'Push failed', detail: 'at PushButton (push.tsx:9)' });
    const writeText = vi.mocked(navigator.clipboard.writeText);
    expect(writeText.mock.calls.length > 0).toBe(expected.copied);
    const commands = sent();
    expect(commands.map((c) => ({ type: c.type, input: c.input }))).toEqual(
      expected.command
        ? [{ type: expected.command.type, input: expect.objectContaining(expected.command.input) }]
        : [],
    );
    const prompt = expected.copied ? writeText.mock.calls[0]![0] : String(commands[0]!.input.input);
    expect(prompt).toContain('Push failed');
    expect(prompt).toContain('at PushButton (push.tsx:9)');
    expect(prompt).toContain('render loop warning');
    expect(vi.mocked(toast).mock.calls.at(-1)![0].kind ?? 'result').toBe(expected.kind);
  });

  it('shows a failed send without offering to ask again', async () => {
    bridge.command.mockResolvedValueOnce({ ok: false, error: { code: 'busy', message: 'Busy' } });
    await askDebugAgent({ title: 'Push failed' });
    expect(vi.mocked(toast).mock.calls.at(-1)![0]).toMatchObject({
      kind: 'failure',
      askAgent: false,
    });
  });

  it('opens the session it sent to from the toast', async () => {
    listed = [debugListed('debug-live', { app_debug: { cdp_port: 41235 } })];
    await askDebugAgent({ title: 'Push failed' });
    const shown = vi.mocked(toast).mock.calls.at(-1)![0];
    expect(shown.title).toBe(zh('data.askDebug.sent'));
    expect(shown.action?.label).toBe(zh('data.askDebug.open'));
  });
});

describe('recorded app errors', () => {
  it('records a failed command with its long strings cut to 500 characters', async () => {
    bridge.command.mockResolvedValueOnce({ ok: false, error: { code: 'busy', message: 'Busy' } });
    await runCommand('session.send', { session_id: 's', input: 'x'.repeat(600) }, null);
    const entry = appErrors().at(-1)!;
    expect(entry).toMatchObject({
      source: 'command',
      command: 'session.send',
      code: 'busy',
      message: 'Busy',
    });
    expect((entry.input as { input: string }).input).toHaveLength(500);
  });

  it('keeps only the newest 50', () => {
    for (let i = 0; i < 60; i++) recordAppError({ source: 'error', message: `error ${i}` });
    expect(appErrors()).toHaveLength(50);
    expect(appErrors()[0]!.message).toBe('error 10');
    expect(appErrors().at(-1)!.message).toBe('error 59');
  });
});
