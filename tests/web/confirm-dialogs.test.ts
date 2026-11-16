import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { WorkbenchSession } from '@pantheon/protocol';
import { AlertDialog } from '../../apps/web/node_modules/@base-ui/react/alert-dialog/index.mjs';
import { find, named, text, mount, unmountAll } from './web-hook-host.js';
const mock = vi.hoisted(() => ({ board: {} as any, shell: {} as any }));
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('@/data/board', () => ({
  useBoard: Object.assign((selector: any) => selector(mock.board), {
    getState: () => mock.board,
  }),
}));
vi.mock('@/store', () => ({
  useShell: Object.assign((selector: any) => selector(mock.shell), {
    getState: () => mock.shell,
  }),
}));
import { DiscardDialog } from '@/screens/sessions/parts';
import { SessionListRow } from '@/screens/sessions/SessionsScreen';
import { zh } from './i18n-setup.js';

const session: WorkbenchSession = {
  id: 'session-a',
  created_at: '2026-11-03T00:00:00.000Z',
  title: 'Release notes',
  runtime: 'claude',
  model: null,
  effort: null,
  permission_mode: 'ask',
  workspace_id: 'workspace-a',
  workspace_kind: 'linked_worktree',
  state: 'ready',
  waiting: 0,
  reconciling: false,
  stopping: false,
  last_activity_at: '2026-11-03T00:00:00.000Z',
  changes: null,
  merge: null,
};

beforeEach(() => {
  mock.board = {
    board: {
      sessions: [{ id: 'session-a', revision: 5 }],
      session_turns: [],
      projects: [],
      workspaces: [{ id: 'workspace-a', path: '/work/a', base_sha: 'abc1234' }],
      cursor: 1,
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
    refresh() {},
  };
  mock.shell = { sessionId: 'session-a', followFirstSession: vi.fn(), openSession: vi.fn() };
  vi.stubGlobal('window', {
    pantheon: { command: vi.fn(), query: vi.fn(async () => ({ ok: false, error: {} })) },
    addEventListener() {},
    removeEventListener() {},
  });
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

/** The alert dialog's question, its body and its two buttons' labels. */
function confirmation(tree: ReactElement<any>) {
  expect(tree.type).toBe(AlertDialog.Root);
  const title = find(tree, (n) => n.type === AlertDialog.Title);
  const body = find(tree, (n) => n.type === AlertDialog.Description);
  const cancel = find(tree, (n) => n.type === AlertDialog.Close);
  const danger = find(tree, (n) => n.props.className === 'btn dng');
  return { title: text(title), body: text(body), cancel: text(cancel), danger: text(danger) };
}

describe('confirmations of what cannot be undone', () => {
  it('asks before deleting a session in an alert dialog', () => {
    const row = mount(() => SessionListRow({ session, on: true, now: 0, onSelect() {} }));
    const dialog = named(row.value, 'DeleteDialog');
    const render = dialog.type as (props: object) => ReactElement<any>;
    const h = mount(() => render({ ...dialog.props, open: true }));
    expect(confirmation(h.value)).toEqual({
      title: '删除「Release notes」？',
      body: zh('sessions.screen.deleteBody'),
      cancel: zh('sessions.parts.cancel'),
      danger: zh('sessions.screen.delete'),
    });
  });

  it('asks before discarding a worktree in an alert dialog', () => {
    const h = mount(() =>
      DiscardDialog({
        open: true,
        title: 'Release notes',
        sessionId: 'session-a',
        revision: 5,
        onClose() {},
      }),
    );
    expect(confirmation(h.value)).toEqual({
      title: '丢弃「Release notes」？',
      body: zh('sessions.parts.discardBody'),
      cancel: zh('sessions.parts.cancel'),
      danger: zh('sessions.parts.discard'),
    });
  });

  it('names the branch, its unmerged commits and the changed lines a discard deletes', () => {
    const h = mount(() =>
      DiscardDialog({
        open: true,
        title: 'Release notes',
        sessionId: 'session-a',
        revision: 5,
        listed: {
          ...session,
          branch: 'pt/release-notes',
          ahead: 7,
          changes: { files: 9, additions: 402, deletions: 37 },
        },
        onClose() {},
      }),
    );
    expect(confirmation(h.value).body).toBe(
      '分支 pt/release-notes 上 7 个没合并的提交会被删除，不能恢复。',
    );
    const stat = find(h.value, (n) => n.props.className === 'pj-rm-stat mono');
    expect(named(stat, 'DiffCounts').props).toEqual({ additions: 402, deletions: 37 });
    expect(text(stat)).toBe('+402 −37' + '9 个文件');
  });
});
