import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { WorkbenchSession } from '@pantheon/protocol';
import { Menu } from '../../apps/web/node_modules/@base-ui/react/menu/index.mjs';
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
import { WindowSnapshots } from '@/screens/sessions/attachments';
import { useQueued } from '@/screens/sessions/parts';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';
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
const session: Session = {
  id: 'session-a',
  revision: 2,
  project_id: 'project-a',
  runtime: 'claude',
  state: 'open',
  turn_count: 1,
};
const shot = { id: 'shot', name: 'Safari.png', mime: 'image/png', size: 3 };

describe('app window snapshots in the composer', () => {
  let listWindowSnapshots: ReturnType<typeof vi.fn>;
  let snapshotWindow: ReturnType<typeof vi.fn>;
  let openPrivacySettings: ReturnType<typeof vi.fn>;
  const mount = async (agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)') => {
    vi.stubGlobal('navigator', { userAgent: agent });
    const h = host(() => SessionCompose({ session, listed, title: 'title of session-a' }));
    await h.flush();
    return h;
  };
  const label = () => zh('sessions.composer.addWindowSnapshot');
  const item = (h: HookHost<any>) =>
    nodes(h.value).find((n) => n.type === Menu.Item && text(n) === label());
  async function openPicker(h: HookHost<any>) {
    item(h)!.props.onClick();
    h.render();
    const sub = host(() => WindowSnapshots(named(h.value, 'WindowSnapshots').props));
    await sub.flush();
    return sub;
  }

  beforeEach(() => {
    useQueued.setState({ queued: {} });
    useFeedback.setState({ items: {} });
    useDrafts.setState({ drafts: {} });
    mock.board = {
      board: { cursor: 1, projects: [{ id: 'project-a', name: 'Project A' }] },
      events: [],
      status: { state: 'live' },
      resync: 0,
      refresh() {},
    };
    listWindowSnapshots = vi.fn(async () => ({
      ok: true,
      value: {
        permission: 'granted',
        windows: [{ id: 'window:200:0', name: 'Safari', thumbnail: 'data:image/png;base64,Ag==' }],
      },
    }));
    snapshotWindow = vi.fn(async () => ({ ok: true, value: shot }));
    openPrivacySettings = vi.fn(async () => ({ ok: true, value: null }));
    vi.stubGlobal('window', {
      pantheon: {
        command: vi.fn(async () => ({ ok: true, value: null })),
        query: vi.fn(async () => ({ ok: true, value: [] })),
        listWindowSnapshots,
        snapshotWindow,
        openPrivacySettings,
      },
      addEventListener() {},
      removeEventListener() {},
    });
  });
  afterEach(() => {
    unmountAll();
    vi.unstubAllGlobals();
  });

  it('offers an app window snapshot in the add menu on macOS only', async () => {
    expect(item(await mount())).toBeDefined();
    expect(item(await mount('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))).toBeUndefined();
  });

  it('attaches the window picked from the thumbnails as an image and closes the picker', async () => {
    const h = await mount();
    const sub = await openPicker(h);
    expect(listWindowSnapshots).toHaveBeenCalledOnce();
    const pick = find(sub.value, (n) => n.type === 'button' && n.props['aria-label'] === 'Safari');
    expect(text(pick)).toContain('Safari');
    pick.props.onClick();
    await h.flush();
    h.render();
    expect(snapshotWindow).toHaveBeenCalledWith('project-a', 'window:200:0');
    expect(useDrafts.getState().drafts[draftKey('project-a', 'session-a')]?.attachments).toEqual([
      shot,
    ]);
    expect(named(h.value, 'AttachmentStrip').props.items).toEqual([shot]);
    expect(named(h.value, 'WindowSnapshots').props.open).toBe(false);
  });

  it('asks for screen recording access and opens its system settings when the system withholds it', async () => {
    listWindowSnapshots.mockResolvedValue({
      ok: true,
      value: { permission: 'denied', windows: [] },
    });
    const h = await mount();
    const sub = await openPicker(h);
    expect(text(sub.value)).toContain(zh('sessions.composer.windowSnapshotDenied'));
    const settings = find(
      sub.value,
      (n) => n.type === 'button' && text(n) === zh('sessions.composer.windowSnapshotSettings'),
    );
    settings.props.onClick();
    expect(openPrivacySettings).toHaveBeenCalledWith('screen');
  });
});
