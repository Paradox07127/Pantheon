import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { find, HookHost, named, nodes, text, mount as host, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
import { draftKey, useDrafts } from '@/data/drafts';
import { useFeedback } from '@/data/feedback';
import { CompletionPopup, useQueued } from '@/screens/sessions/parts';
import { NewSession, SessionCompose } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const listed: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-01-01T00:00:00.000Z',
  title: 'title of session-a',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-01-01T00:00:00.000Z',
  changes: null,
  merge: null,
};
const open: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-compact',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};
const status = (runtime: string, capabilities: Record<string, 'supported' | 'unsupported'>) => ({
  runtime,
  enabled: true,
  installed: true,
  auth: { state: 'logged_in' },
  capabilities: Object.fromEntries(
    Object.entries(capabilities).map(([name, s]) => [name, { status: s }]),
  ),
});
const bothSupported = [
  status('claude', { manual_compaction: 'supported', compaction_instructions: 'supported' }),
  status('codex', { manual_compaction: 'supported', compaction_instructions: 'unsupported' }),
];

describe('the compact command in the composer', () => {
  let session: Session;
  let row: WorkbenchSession;
  let statuses: unknown;
  let command: ReturnType<typeof vi.fn>;
  const mount = async () => {
    const h = host(() => SessionCompose({ session, listed: row, title: 'title of session-a' }));
    await h.flush();
    return h;
  };
  const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
  const popup = (h: HookHost<any>) => named(h.value, 'CompletionPopup').props;
  const labels = (h: HookHost<any>) => popup(h).items.map((i: { label: string }) => i.label);
  const press = (h: HookHost<any>, key: string) => {
    box(h).props.onKeyDown({
      key,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    });
    h.render();
  };
  const type = (h: HookHost<any>, value: string) => {
    box(h).props.onChange({ target: { value } });
    h.render();
  };
  const sent = () => command.mock.calls.map(([c]) => [c.type, c.input]);
  const alert = (h: HookHost<any>) =>
    nodes(h.value).find((n) => n.props.role === 'alert' && n.props.className === 'tr-err');

  beforeEach(() => {
    vi.useFakeTimers();
    session = open;
    row = listed;
    statuses = bothSupported;
    useQueued.setState({ queued: {} });
    useFeedback.setState({ items: {} });
    useDrafts.setState({ drafts: {} });
    mock.board = {
      board: { cursor: 1, projects: [{ id: 'project-compact', name: 'Project' }] },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    command = vi.fn(async () => ({ ok: true, value: { id: 'turn-compact' } }));
    const query = vi.fn(async (method: string, params: Record<string, string>) =>
      method === 'runtime.status'
        ? statuses === null
          ? new Promise(() => {})
          : { ok: true, value: statuses }
        : method === 'extensions.inventory'
          ? {
              ok: true,
              value: {
                runtime: params.runtime,
                mcp_servers: [],
                plugins: [],
                skills: [{ id: 'lint', name: 'lint', enabled: true }],
                apps: false,
                connectors: [],
                hooks: [],
              },
            }
          : { ok: true, value: [] },
    );
    vi.stubGlobal('window', {
      pantheon: { command, query },
      addEventListener() {},
      removeEventListener() {},
    });
  });
  afterEach(() => {
    unmountAll();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists /compact first with what it does, and /review with what it does, when the runtime compacts on request', async () => {
    const h = await mount();
    type(h, '/');
    expect(labels(h)).toEqual(['/compact', '/review', '/lint']);
    const menu = CompletionPopup(popup(h))!;
    const options = nodes(menu).filter((n) => n.props.role === 'option');
    expect(
      options.map((o) =>
        nodes(o)
          .filter((n) => n.props.className === 'cp-cmh')
          .map(text),
      ),
    ).toEqual([
      [zh('sessions.completion.compactHint')],
      [zh('sessions.completion.reviewHint')],
      [],
    ]);
  });

  it.each([
    [
      'leaves /compact out when the runtime cannot compact on request',
      [status('claude', { manual_compaction: 'unsupported' })],
    ],
    ['leaves /compact out while the runtime status is still being read', null],
  ])('%s', async (_name, given) => {
    statuses = given;
    const h = await mount();
    type(h, '/');
    expect(labels(h)).toEqual(['/review', '/lint']);
  });

  it('leaves /compact out of the new-session composer', async () => {
    const h = host(() =>
      NewSession({
        projectId: 'project-compact',
        defaults: undefined,
        focus: 0,
        onCreated() {},
        recent: [],
        onOpen() {},
        onClose() {},
      }),
    );
    await h.flush();
    type(h, '/');
    expect(labels(h)).not.toContain('/compact');
  });

  it('inserts /compact when picked, running nothing', async () => {
    const h = await mount();
    type(h, '/comp');
    press(h, 'Enter');
    await h.flush();
    expect(box(h).props.value).toBe('/compact ');
    expect(command).not.toHaveBeenCalled();
  });

  it('compacts on sending /compact, without instructions, at the session revision', async () => {
    const h = await mount();
    type(h, '  /compact  ');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([['session.compact', { session_id: 'session-a' }]]);
    expect(command.mock.calls[0]![0].expected_revision).toBe(2);
    expect(box(h).props.value).toBe('');
  });

  it('sends what follows /compact as one line of instructions', async () => {
    const h = await mount();
    type(h, '/compact keep\nthe   plan ');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([
      ['session.compact', { session_id: 'session-a', instructions: 'keep the plan' }],
    ]);
  });

  it('says the runtime takes no instructions and keeps the draft, running nothing', async () => {
    session = { ...open, runtime: 'codex' };
    row = { ...listed, runtime: 'codex' };
    const h = await mount();
    type(h, '/compact keep the plan');
    press(h, 'Enter');
    await h.flush();
    expect(command).not.toHaveBeenCalled();
    expect(text(alert(h)!)).toBe('Codex 压缩时不收指示');
    expect(box(h).props.value).toBe('/compact keep the plan');
  });

  it('shows why the compaction was refused and keeps the draft', async () => {
    command.mockImplementation(async () => ({
      ok: false,
      error: { code: 'resource_busy', message: 'the session has a turn running' },
    }));
    const h = await mount();
    type(h, '/compact ');
    press(h, 'Enter');
    await h.flush();
    expect(text(alert(h)!)).toContain('the session has a turn running');
    expect(box(h).props.value).toBe('/compact ');
  });

  it('sends /compact as a message when it carries an attachment', async () => {
    useDrafts.getState().update(draftKey('project-compact', 'session-a'), () => ({
      attachments: [{ id: 'attachment-a', name: 'notes.txt', mime: 'text/plain' }],
    }));
    const h = await mount();
    type(h, '/compact ');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([
      [
        'session.send',
        { session_id: 'session-a', input: '/compact ', attachments: ['attachment-a'] },
      ],
    ]);
  });

  it('sends /compact as a message when the runtime cannot compact on request', async () => {
    statuses = [status('claude', { manual_compaction: 'unsupported' })];
    const h = await mount();
    type(h, '/compact');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([['session.send', { session_id: 'session-a', input: '/compact' }]]);
  });
});
