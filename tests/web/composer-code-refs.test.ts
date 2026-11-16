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
import { useDrafts } from '@/data/drafts';
import { useFeedback } from '@/data/feedback';
import { GithubRefMenu } from '@/screens/sessions/attachments';
import { AttachmentStrip, CompletionPopup, useQueued } from '@/screens/sessions/parts';
import { SessionCompose } from '@/screens/sessions/SessionsScreen';
import { useSettingsView } from '@/screens/settings/view';
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
const pull = {
  number: 7,
  title: 'Fix the parser',
  url: 'https://example.test/pull/7',
  state: 'open',
  updated_at: '2026-01-01T00:00:00.000Z',
  checks: 'failing',
};

describe('code symbols and pull requests in the composer', () => {
  let command: ReturnType<typeof vi.fn>;
  let query: ReturnType<typeof vi.fn>;
  let items: () => unknown;
  const mount = async () => {
    const h = host(() => SessionCompose({ session, listed, title: 'title of session-a' }));
    await h.flush();
    return h;
  };
  const box = (h: HookHost<any>) => find(h.value, (n) => n.type === 'textarea');
  const popup = (h: HookHost<any>) => named(h.value, 'CompletionPopup').props;
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
  async function openItems(h: HookHost<any>, kind: 'pr' | 'issue') {
    const menu = find(
      h.value,
      (n) =>
        typeof n.type === 'function' && n.type.name === 'GithubRefMenu' && n.props.kind === kind,
    );
    const sub = host(() => GithubRefMenu(menu.props));
    find(sub.value, (n) => n.type === Menu.SubmenuRoot).props.onOpenChange(true);
    await sub.flush();
    return sub;
  }
  const sent = () => command.mock.calls.map(([c]) => c.input);

  beforeEach(() => {
    vi.useFakeTimers();
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
    items = () => ({ ok: true, value: { repo: 'owner/repo', items: [pull] } });
    command = vi.fn(async () => ({ ok: true, value: null }));
    query = vi.fn(async (method: string) =>
      method === 'files.search'
        ? { ok: true, value: ['apps/a.ts'] }
        : method === 'symbols.search'
          ? {
              ok: true,
              value: {
                symbols: [
                  { name: 'applyPatch', kind: 'function', path: 'apps/patch.ts', line: 12 },
                ],
              },
            }
          : method === 'github.items'
            ? items()
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

  it('lists the symbols under the files after @ and refers to a picked one by path and line', async () => {
    const h = await mount();
    type(h, '看 @ap');
    vi.advanceTimersByTime(150);
    await h.flush();
    expect(query).toHaveBeenCalledWith('symbols.search', {
      project_id: 'project-a',
      session_id: 'session-a',
      q: 'ap',
    });
    expect(popup(h).items.map((i: { label: string }) => i.label)).toEqual([
      'apps/a.ts',
      'applyPatch',
    ]);
    const menu = CompletionPopup(popup(h))!;
    const group = find(menu, (n) => n.props.role === 'group');
    expect(text(find(group, (n) => n.props.className === 'cp-cap'))).toBe(
      zh('sessions.completion.symbols'),
    );
    expect(text(find(group, (n) => n.props.role === 'option'))).toContain('apps/patch.ts:12');
    press(h, 'ArrowDown');
    press(h, 'Enter');
    await h.flush();
    const strip = AttachmentStrip(named(h.value, 'AttachmentStrip').props)!;
    expect(text(find(strip, (n) => n.props.className === 'chip mono cp-ref'))).toContain(
      'apps/patch.ts:12',
    );
    type(h, '看这里');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([{ session_id: 'session-a', input: '看这里\n\n@apps/patch.ts:12' }]);
  });

  it('lists the open pull requests with their checks, puts a picked one on the box and sends it as a ref', async () => {
    const h = await mount();
    const sub = await openItems(h, 'pr');
    expect(query).toHaveBeenCalledWith('github.items', { project_id: 'project-a', kind: 'pr' });
    const rows = nodes(sub.value).filter((n) => n.type === Menu.Item);
    expect(rows.map(text)).toEqual(['#7Fix the parser']);
    expect(
      nodes(rows[0]).some(
        (n) => n.props['aria-label'] === zh('sessions.composeRefs.checksFailing'),
      ),
    ).toBe(true);
    rows[0]!.props.onClick();
    h.render();
    const strip = AttachmentStrip(named(h.value, 'AttachmentStrip').props);
    const card = find(strip, (n) => n.props.role === 'group');
    expect(card.props.className).toBe('cr-card cr-ref');
    expect(text(card)).toContain('Fix the parser');
    type(h, 'look at this');
    press(h, 'Enter');
    await h.flush();
    expect(sent()).toEqual([
      { session_id: 'session-a', input: 'look at this', refs: [{ kind: 'pr', number: 7 }] },
    ]);
  });

  it('says why the items could not be listed and offers to connect', async () => {
    items = () => ({
      ok: false,
      error: { code: 'gh_unavailable', message: 'gh is not installed' },
    });
    const h = await mount();
    const sub = await openItems(h, 'issue');
    expect(text(find(sub.value, (n) => n.props.role === 'alert'))).toContain('gh is not installed');
    const connect = find(
      sub.value,
      (n) => n.type === Menu.Item && text(n) === zh('sessions.composeRefs.connect'),
    );
    useSettingsView.setState({ open: false, page: 'general' });
    connect.props.onClick();
    expect(useSettingsView.getState()).toMatchObject({ open: true, page: 'connections' });
  });
});
