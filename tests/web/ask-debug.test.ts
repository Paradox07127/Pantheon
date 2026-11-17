import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, WorkbenchSession } from '@pantheon/protocol';
import { zh } from './i18n-setup.js';
const mock = vi.hoisted(() => ({
  board: {} as any,
  target: null as { repo_root: string } | null,
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
import { appErrors, captureAppErrors, recordAppError } from '@/data/app-errors';
import { askDebugAgent } from '@/data/ask-debug';
import { runCommand } from '@/data/commands';
import { useCurrentProject } from '@/data/current-project';
import { toast } from '@/components/Toast';

const REPO = '/work/pantheon';

const debugListed = (id: string, extra: Partial<WorkbenchSession>) =>
  ({ id, created_at: '2026-11-16T08:00:00.000Z', app_debug: true, ...extra }) as WorkbenchSession;

let listed: WorkbenchSession[];
let globalDefaults: unknown;
let bridge: {
  command: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  appInfo: ReturnType<typeof vi.fn>;
  logsDir: ReturnType<typeof vi.fn>;
  attachFile: ReturnType<typeof vi.fn>;
};
const sent = () => bridge.command.mock.calls.map(([c]) => c as Command);

beforeEach(() => {
  listed = [];
  globalDefaults = { runtime: 'claude', model: 'opus', permission_mode: 'auto_edit' };
  bridge = {
    command: vi.fn(async () => ({ ok: true, value: { id: 'session-new' } })),
    query: vi.fn(async (method: string) =>
      method === 'project.defaults'
        ? { ok: true, value: { settings: [{ key: 'session_defaults', global: globalDefaults }] } }
        : { ok: true, value: listed },
    ),
    appInfo: vi.fn(async () => ({ version: '1.2.3' })),
    logsDir: vi.fn(async () => '/data/logs'),
    attachFile: vi.fn(async (_project: string, name: string) => ({
      ok: true,
      value: { id: `attachment-${name}` },
    })),
  };
  vi.stubGlobal('window', { pantheon: bridge });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
  mock.target = { repo_root: REPO };
  mock.board = {
    board: {
      projects: [
        {
          id: 'pantheon',
          roots: [REPO],
          session_defaults: {
            runtime: 'codex',
            model: 'gpt-5.5',
            effort: 'high',
            permission_mode: 'auto',
          },
        },
        { id: 'shop', roots: ['/work/shop'], session_defaults: { runtime: 'claude' } },
      ],
      sessions: [
        { id: 'debug-live', state: 'open', revision: 4 },
        { id: 'debug-archived', state: 'open', revision: 2 },
        { id: 'shop-diagnosis', state: 'open', revision: 3 },
      ],
    },
    refresh: vi.fn(),
  };
  useCurrentProject.setState({ projectId: null });
  vi.mocked(toast).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('asking the debug agent', () => {
  it.each([
    {
      name: 'copies the report without a debug target or a current project',
      target: null,
      current: null,
      sessions: [],
      expected: { copied: true, command: null, kind: 'result' },
    },
    {
      name: 'copies the report when no project holds the repository and none is current',
      target: { repo_root: '/elsewhere' },
      current: null,
      sessions: [],
      expected: { copied: true, command: null, kind: 'failure' },
    },
    {
      name: 'opens a read-only debug session in the current project when no project holds the repository',
      target: { repo_root: '/elsewhere' },
      current: 'shop',
      sessions: [],
      expected: {
        copied: false,
        command: {
          type: 'session.create',
          input: {
            project_id: 'shop',
            purpose: 'app_debug',
            workspace: 'in_place',
            runtime: 'claude',
          },
        },
        kind: 'result',
      },
    },
    {
      name: "sends to the current project's live debug session when no project holds the repository",
      target: { repo_root: '/elsewhere' },
      current: 'shop',
      sessions: [debugListed('shop-diagnosis', {})],
      expected: {
        copied: false,
        command: { type: 'session.send', input: { session_id: 'shop-diagnosis' } },
        kind: 'result',
      },
    },
    {
      name: 'opens a read-only debug session in the current project of a packaged app',
      target: null,
      current: 'shop',
      sessions: [],
      expected: {
        copied: false,
        command: {
          type: 'session.create',
          input: { project_id: 'shop', purpose: 'app_debug', workspace: 'in_place' },
        },
        kind: 'result',
      },
    },
    {
      name: 'sends to the live debug session whatever port the app had when it opened',
      target: { repo_root: REPO },
      current: 'shop',
      sessions: [debugListed('debug-live', {})],
      expected: {
        copied: false,
        command: { type: 'session.send', input: { session_id: 'debug-live' } },
        kind: 'result',
      },
    },
    {
      name: 'opens a debug session when the only one is archived',
      target: { repo_root: REPO },
      current: 'shop',
      sessions: [debugListed('debug-archived', { archived_at: '2026-11-16T09:00:00.000Z' })],
      expected: {
        copied: false,
        command: {
          type: 'session.create',
          input: {
            project_id: 'pantheon',
            purpose: 'app_debug',
            runtime: 'codex',
            model: 'gpt-5.5',
            effort: 'high',
            permission_mode: 'auto',
          },
        },
        kind: 'result',
      },
    },
  ])('$name', async ({ target, current, sessions, expected }) => {
    mock.target = target;
    useCurrentProject.setState({ projectId: current });
    listed = sessions;
    recordAppError({ source: 'console', message: 'render loop warning' });
    const delivered = await askDebugAgent({
      title: 'Push failed',
      detail: 'at PushButton (push.tsx:9)',
    });
    expect(delivered).toBe(expected.copied || expected.kind !== 'failure');
    const writeText = vi.mocked(navigator.clipboard.writeText);
    expect(writeText.mock.calls.length > 0).toBe(expected.copied);
    const commands = sent();
    expect(commands.map((c) => ({ type: c.type, input: c.input }))).toEqual(
      expected.command
        ? [{ type: expected.command.type, input: expect.objectContaining(expected.command.input) }]
        : [],
    );
    // The daemon holds a session in the user's own folder in plan mode.
    if (commands[0]?.input.workspace === 'in_place')
      expect(commands[0].input).not.toHaveProperty('permission_mode');
    const prompt = expected.copied ? writeText.mock.calls[0]![0] : String(commands[0]!.input.input);
    expect(prompt).toContain('Push failed');
    expect(prompt).toContain('at PushButton (push.tsx:9)');
    expect(prompt).toContain('render loop warning');
    // The debug view sends picks through here too, so the prompt does not call the report an error.
    expect(prompt).not.toMatch(/this error|the error/);
    expect(vi.mocked(toast).mock.calls.at(-1)![0].kind ?? 'result').toBe(expected.kind);
  });

  it.each([
    {
      name: 'attaches the images to the message for the live debug session',
      target: { repo_root: REPO },
      sessions: [debugListed('debug-live', {})],
      expected: {
        uploads: ['debug-1.png', 'debug-2.png'],
        command: 'session.send',
        attachments: ['attachment-debug-1.png', 'attachment-debug-2.png'],
      },
    },
    {
      name: 'attaches the images to a new debug session',
      target: { repo_root: REPO },
      sessions: [],
      expected: {
        uploads: ['debug-1.png', 'debug-2.png'],
        command: 'session.create',
        attachments: ['attachment-debug-1.png', 'attachment-debug-2.png'],
      },
    },
    {
      name: 'drops the images when it copies the report',
      target: null,
      sessions: [],
      expected: { uploads: [], command: null, attachments: null },
    },
  ])('$name', async ({ target, sessions, expected }) => {
    mock.target = target;
    listed = sessions;
    await askDebugAgent({
      title: 'Debug view: 2 items',
      images: ['data:image/png;base64,AQID', 'data:image/png;base64,BAU='],
    });
    expect(bridge.attachFile.mock.calls.map(([, name]) => name)).toEqual(expected.uploads);
    if (expected.uploads.length)
      expect([...bridge.attachFile.mock.calls[0]![3]]).toEqual([1, 2, 3]);
    const commands = sent();
    expect(commands.map((c) => c.type)).toEqual(expected.command ? [expected.command] : []);
    if (expected.attachments) expect(commands[0]!.input.attachments).toEqual(expected.attachments);
  });

  it('stops with a failure when an image cannot be uploaded', async () => {
    bridge.attachFile.mockResolvedValueOnce({
      ok: false,
      error: { code: 'too_large', message: 'Too large' },
    });
    expect(
      await askDebugAgent({ title: 'Debug view: 1 item', images: ['data:image/png;base64,AQID'] }),
    ).toBe(false);
    expect(sent()).toEqual([]);
    expect(vi.mocked(toast).mock.calls.at(-1)![0]).toMatchObject({
      kind: 'failure',
      askAgent: false,
    });
  });

  it('sends no attachments without images', async () => {
    listed = [debugListed('debug-live', {})];
    await askDebugAgent({ title: 'Push failed' });
    expect(sent()[0]!.input).not.toHaveProperty('attachments');
  });

  it('opens the debug session on the global defaults when the project has none', async () => {
    delete mock.board.board.projects[0].session_defaults;
    await askDebugAgent({ title: 'Push failed' });
    expect(sent()[0]!.input).toMatchObject({
      runtime: 'claude',
      model: 'opus',
      permission_mode: 'auto_edit',
    });
    // The daemon reads the app's current port for each turn.
    expect(sent()[0]!.input).not.toHaveProperty('cdp_port');
  });

  it('opens the debug session on a runtime that can run when nothing names one', async () => {
    delete mock.board.board.projects[0].session_defaults;
    globalDefaults = {};
    const statuses = [
      { runtime: 'claude', enabled: true, installed: false, auth: { state: 'unknown' } },
      { runtime: 'codex', enabled: true, installed: true, auth: { state: 'logged_in' } },
    ];
    const answer = bridge.query.getMockImplementation() as (method: string) => Promise<unknown>;
    bridge.query.mockImplementation(async (method: string) =>
      method === 'runtime.status' ? { ok: true, value: statuses } : answer(method),
    );
    await askDebugAgent({ title: 'Push failed' });
    expect(sent()[0]!.input).toMatchObject({ runtime: 'codex' });
  });

  it('shows a failed send without offering to ask again', async () => {
    bridge.command.mockResolvedValueOnce({ ok: false, error: { code: 'busy', message: 'Busy' } });
    expect(await askDebugAgent({ title: 'Push failed' })).toBe(false);
    expect(vi.mocked(toast).mock.calls.at(-1)![0]).toMatchObject({
      kind: 'failure',
      askAgent: false,
    });
  });

  it('sets the error it is about apart, with its stack, before the recent problems', async () => {
    mock.target = null;
    recordAppError({ source: 'console', message: 'render loop warning' });
    const error = recordAppError({
      source: 'command',
      command: 'session.archive',
      code: 'invalid_request',
      message: 'Cannot read properties of undefined',
      status: 400,
      stack:
        'TypeError: Cannot read properties of undefined\n    at archive (packages/control/src/session.ts:40:7)',
    });
    await askDebugAgent({ title: 'Archive failed', error });
    const prompt = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
    const section = `The error:\n\n\`\`\`json\n${JSON.stringify(error, null, 2)}\n\`\`\``;
    expect(prompt).toContain(`Archive failed\n\n${section}`);
    expect(section).toContain('packages/control/src/session.ts:40:7');
    const recent = prompt.slice(prompt.indexOf('Recent problems'));
    expect(prompt.indexOf(section)).toBeLessThan(prompt.indexOf('Recent problems'));
    expect(recent).toContain('render loop warning');
    expect(recent).not.toContain(`"id":${error.id},`);
  });

  it('opens the session it sent to from the toast', async () => {
    listed = [debugListed('debug-live', {})];
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

  it('records the status, details and stack of a failed command', async () => {
    const stack = 'TypeError: x is undefined\n' + '    at handler (control.ts:1:1)\n'.repeat(200);
    bridge.command.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'x is undefined',
        status: 400,
        details: { field: 'title' },
        stack,
      },
    });
    await runCommand('session.send', { session_id: 's', input: 'hi' }, null);
    expect(appErrors().at(-1)).toMatchObject({
      code: 'invalid_request',
      status: 400,
      details: { field: 'title' },
      stack: stack.slice(0, 4000),
    });
  });

  it('records uncaught errors, rejections and console errors with their stacks', () => {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
    });
    const original = console.error;
    console.error = () => {};
    try {
      captureAppErrors();
      const thrown = new TypeError('bad render');
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      listeners.get('error')!({ error: thrown, message: 'bad render' });
      listeners.get('error')!({
        error: null,
        message: 'Script error.',
        filename: 'app.js',
        lineno: 3,
        colno: 9,
      });
      listeners.get('unhandledrejection')!({ reason: thrown });
      console.error('Render failed:', thrown);
      console.error('State', { tab: 'files', open: true });
      console.error('State', cyclic);
      expect(
        appErrors()
          .slice(-6)
          .map(({ source, message, stack }) => ({ source, message, stack })),
      ).toEqual([
        { source: 'error', message: 'TypeError: bad render', stack: thrown.stack },
        { source: 'error', message: 'Script error.', stack: 'app.js:3:9' },
        { source: 'rejection', message: 'TypeError: bad render', stack: thrown.stack },
        { source: 'console', message: 'Render failed: TypeError: bad render', stack: thrown.stack },
        { source: 'console', message: 'State {"tab":"files","open":true}', stack: undefined },
        { source: 'console', message: 'State [object Object]', stack: undefined },
      ]);
    } finally {
      console.error = original;
    }
  });

  it('keeps only the newest 50', () => {
    for (let i = 0; i < 60; i++) recordAppError({ source: 'error', message: `error ${i}` });
    expect(appErrors()).toHaveLength(50);
    expect(appErrors()[0]!.message).toBe('error 10');
    expect(appErrors().at(-1)!.message).toBe('error 59');
  });
});
