import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { BackendSummary, RuntimeModel, WorkbenchSession } from '@pantheon/protocol';
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
import { zh } from './i18n-setup.js';
import { find, type HookHost, mount, named, nodes, text, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector?: any) => (selector ? selector(mock.shell) : mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { draftKey, useDrafts } from '@/data/drafts';
import { useFeedback } from '@/data/feedback';
import { runShortcut } from '@/lib/shortcuts';
import { ModelMenu, useQueued } from '@/screens/sessions/parts';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';

const model = (id: string): RuntimeModel => ({
  id,
  label: `label of ${id}`,
  permission_modes: ['plan', 'ask', 'auto_edit'],
  efforts: ['low', 'medium', 'high'],
  default_effort: 'medium',
  default: false,
});
const row = (id: string, extra: Partial<WorkbenchSession> = {}): WorkbenchSession => ({
  id,
  created_at: '2026-11-03T00:00:00.000Z',
  title: `title of ${id}`,
  runtime: 'claude',
  model: 'claude-a',
  effort: 'medium',
  permission_mode: 'ask',
  workspace_id: `workspace-${id}`,
  workspace_kind: 'linked_worktree',
  state: 'idle',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
  ...extra,
});
const router: BackendSummary = {
  id: 'router',
  protocol: 'anthropic',
  base_url: 'https://router.example.com',
  models: [],
  runtimes: ['claude'],
  key: { env: 'ROUTER_KEY' },
  key_present: true,
};
const inventory = (runtime: string) => ({
  runtime,
  mcp_servers: [],
  plugins: [],
  skills:
    runtime === 'codex'
      ? [{ id: 'codex-lint', name: 'lint', enabled: true, path: '/codex/skills/lint' }]
      : [
          { id: 'claude-tidy', name: 'tidy', enabled: true },
          { id: 'claude-trace', name: 'trace', enabled: true },
        ],
  apps: false,
  connectors: [],
  hooks: [],
});

let command: ReturnType<typeof vi.fn>;
let project = 0;
let session: Session;
let listed: WorkbenchSession;

beforeEach(() => {
  useDrafts.setState({ drafts: {}, answers: {} });
  useQueued.setState({ queued: {}, failures: {} });
  useFeedback.setState({ items: {} });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], session_turns: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.shell = { openSession: vi.fn(), openSettings() {} };
  command = vi.fn(async () => ({ ok: true, value: {} }));
  const answers: Record<string, unknown> = {
    'runtime.status': ['claude', 'codex'].map((runtime) => ({
      runtime,
      enabled: true,
      installed: true,
      auth: { state: 'logged_in' },
    })),
    'backend.list': [],
  };
  vi.stubGlobal('window', {
    pantheon: {
      command,
      chooseFiles: vi.fn(async () => ({ ok: true, value: [] })),
      query: vi.fn(async (method: string, params: { runtime?: string }) =>
        method === 'runtime.models'
          ? { ok: true, value: [model(`${params.runtime}-a`), model(`${params.runtime}-b`)] }
          : method === 'extensions.inventory'
            ? { ok: true, value: inventory(params.runtime!) }
            : method in answers
              ? { ok: true, value: answers[method] }
              : { ok: false, error: { code: 'unknown_route', message: method } },
      ),
    },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  // Each test reads the runtime models and skills of a project of its own.
  const projectId = `project-offers-${++project}`;
  session = {
    id: 'session-a',
    revision: 3,
    project_id: projectId,
    runtime: 'claude',
    state: 'open',
    turn_count: 1,
  };
  listed = row('session-a');
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

const compose = async (sessions: readonly WorkbenchSession[] = []) => {
  const h = mount(() => SessionCompose({ session, listed, title: 'Offers', sessions }));
  await h.flush();
  return h;
};
const key = () => draftKey(session.project_id, session.id);
const menuOf = (h: HookHost<any>) => mount(() => ModelMenu(named(h.value, 'ModelMenu').props));
const radio = (h: HookHost<any>, value: string) =>
  find(h.value, (n) => n.type === Menu.RadioItem && n.props.value === value);
const alerts = (h: HookHost<any>) =>
  nodes(h.value)
    .filter((n) => n.props.role === 'alert')
    .map((n) => text(n));

describe('an archived session', () => {
  it('says it is archived above a disabled box, and restore sends unarchive', async () => {
    session = { ...session, archived_at: '2026-11-03T00:00:00.000Z' };
    listed = row('session-a', { archived_at: '2026-11-03T00:00:00.000Z' });
    const h = await compose();
    expect(find(h.value, (n) => n.type === 'textarea').props).toMatchObject({
      disabled: true,
      placeholder: zh('data.transcript.busy.archived'),
    });
    expect(text(h.value)).toContain(zh('sessions.compose.archived'));
    find(
      h.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.compose.unarchive'),
    ).props.onClick();
    await h.flush();
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.unarchive',
        input: { session_id: 'session-a' },
        expected_revision: 3,
      }),
    );
  });

  it('shows no archived bar on a session that is not archived', async () => {
    const h = await compose();
    expect(
      nodes(h.value).some(
        (n) => n.type === 'button' && text(n) === zh('sessions.compose.unarchive'),
      ),
    ).toBe(false);
  });
});

describe('the session rows of the add menu', () => {
  it('are off once the pull requests, issues and sessions referred to reach the limit', async () => {
    useDrafts.getState().update(key(), () => ({
      refs: [row('session-b')],
      github: Array.from({ length: 7 }, (_, i) => ({
        kind: 'issue' as const,
        number: i + 1,
        title: `issue ${i + 1}`,
      })),
    }));
    const h = await compose([row('session-b'), row('session-c')]);
    const other = find(h.value, (n) => n.type === Menu.Item && n.key === 'session-c');
    expect(other.props.disabled).toBe(true);
  });
});

describe('the model menu of a session that cannot switch', () => {
  it('turns off the other runtimes and backends of a session in the user folder', async () => {
    listed = row('session-a', { workspace_kind: 'in_place', backend_id: 'router' });
    const h = await compose();
    const menu = mount(() =>
      ModelMenu({ ...named(h.value, 'ModelMenu').props, backends: [router] }),
    );
    expect(radio(menu, 'codex').props.disabled).toBe(true);
    expect(radio(menu, '').props.disabled).toBe(true);
    expect(radio(menu, 'claude').props.disabled).toBe(false);
  });

  it('offers no handoff while the first turn of a new session runs, and offers it once a turn completed', async () => {
    session = { ...session, state: 'running' };
    listed = row('session-a', { state: 'running' });
    const h = await compose();
    expect(radio(menuOf(h), 'codex').props.disabled).toBe(true);
    mock.board.board.session_turns = [
      { id: 'turn-a', session_id: 'session-a', kind: 'send', state: 'completed' },
      { id: 'turn-b', session_id: 'session-a', kind: 'send', state: 'running' },
    ];
    h.render();
    expect(radio(menuOf(h), 'codex').props.disabled).toBe(false);
  });
});

describe('the skills of a handoff', () => {
  it("completes and counts the target runtime's skills while a handoff is chosen", async () => {
    const h = await compose();
    named(h.value, 'ModelMenu').props.onChange({
      runtime: 'codex',
      backend: null,
      model: 'codex-a',
      effort: null,
    });
    await h.flush();
    const box = find(h.value, (n) => n.type === 'textarea');
    box.props.onChange({ target: { value: '/', selectionStart: 1 } });
    await h.flush();
    const labels = named(h.value, 'CompletionPopup').props.items.map(
      (i: { label: string }) => i.label,
    );
    expect(labels.filter((l: string) => !['/compact', '/review'].includes(l))).toEqual(['$lint']);
    const count = find(h.value, (n) => n.props.className === 'cp-ct');
    expect(text(count)).toBe('1');
  });
});

describe('the add menu key', () => {
  it('opens the add menu of a session composer', async () => {
    const h = await compose();
    const root = () =>
      find(
        h.value,
        (n) =>
          n.type === Menu.Root &&
          nodes(n.props.children).some((c) => c.props.className === 'cp-add'),
      );
    runShortcut('attach');
    h.render();
    expect(root().props.open).toBe(true);
  });
});

describe('the error under the composer', () => {
  it('shows the failure of a send made after a backend change failed', async () => {
    command.mockImplementation(async (c: { type: string }) =>
      c.type === 'session.setModel'
        ? { ok: false, error: { code: 'invalid_state', message: 'model refused' } }
        : c.type === 'session.send'
          ? { ok: false, error: { code: 'invalid_state', message: 'send refused' } }
          : { ok: true, value: {} },
    );
    const h = await compose();
    const shown = named(h.value, 'ModelMenu').props;
    shown.onChange({ ...shown.value, model: 'claude-b' });
    await h.flush();
    expect(alerts(h).join(' ')).toContain('model refused');
    const box = find(h.value, (n) => n.type === 'textarea');
    box.props.onChange({ target: { value: 'try again', selectionStart: 9 } });
    h.render();
    named(h.value, 'SendButton').props.onPress();
    await h.flush();
    expect(alerts(h).join(' ')).toContain('send refused');
    expect(alerts(h).join(' ')).not.toContain('model refused');
  });

  it('takes the backend error down when a file is picked', async () => {
    command.mockImplementation(async (c: { type: string }) =>
      c.type === 'session.setModel'
        ? { ok: false, error: { code: 'invalid_state', message: 'model refused' } }
        : { ok: true, value: {} },
    );
    const h = await compose();
    const shown = named(h.value, 'ModelMenu').props;
    shown.onChange({ ...shown.value, model: 'claude-b' });
    await h.flush();
    expect(alerts(h).join(' ')).toContain('model refused');
    const pick = find(
      h.value,
      (n) => n.type === Menu.Item && text(n) === zh('sessions.composer.addFile'),
    );
    pick.props.onClick();
    await h.flush();
    expect(alerts(h)).toEqual([]);
  });
});
