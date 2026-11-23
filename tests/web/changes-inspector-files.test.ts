import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, nodes, text, unmountAll } from './web-hook-host.js';

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
  resolveTheme: () => 'light',
}));
import { ChangedFiles, diffCells } from '@/screens/changes/ChangedFiles';
import { zh, zhf } from './i18n-setup.js';

let files: unknown[];
let query: ReturnType<typeof vi.fn>;

beforeEach(() => {
  files = [];
  query = vi.fn(async (method: string, params: { session_id: string }) =>
    method === 'session.diff'
      ? {
          ok: true,
          value: {
            session_id: params.session_id,
            base_sha: 'a',
            head_sha: 'b',
            files,
            patch: null,
            truncated: false,
          },
        }
      : { ok: false, error: { code: 'not_found', message: method } },
  );
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, pantheon: { query } });
  mock.board = {
    board: { cursor: 1, projects: [], sessions: [], workspaces: [], session_turns: [] },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  mock.shell = { openSession: vi.fn() };
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

async function changed(sessionId: string) {
  const h = mount(() => ChangedFiles({ sessionId }) as ReactElement);
  await h.flush();
  return h;
}

describe('changed files of a change', () => {
  it('reads the diff of the session and lists one row per file, each bar named by its counts', async () => {
    files = [
      { path: 'tests/acceptance/verify/run.mjs', additions: 148, deletions: 31, untracked: false },
      { path: 'drivers/window.mjs', additions: 64, deletions: 9, untracked: false },
    ];
    const h = await changed('refund-list');
    expect(query).toHaveBeenCalledWith('session.diff', { session_id: 'refund-list' });
    const list = nodes(h.value).find(
      (n) => n.type === 'ul' && n.props['aria-label'] === zh('changes.files.title'),
    )!;
    const items = nodes(list).filter((n) => n.type === 'li');
    expect(items).toHaveLength(2);
    expect(text(items[0]!)).toContain('+148 −31');
    expect(text(items[1]!)).toContain('+64 −9');
    const bars = nodes(list).filter((n) => n.props.role === 'img');
    expect(bars.map((n) => n.props['aria-label'])).toEqual([
      zhf('changes.files.file', {
        path: 'tests/acceptance/verify/run.mjs',
        additions: 148,
        deletions: 31,
      }),
      zhf('changes.files.file', { path: 'drivers/window.mjs', additions: 64, deletions: 9 }),
    ]);
  });

  it('opens the diff of the session from a file row', async () => {
    files = [{ path: 'src/refunds/list.tsx', additions: 3, deletions: 1, untracked: false }];
    const h = await changed('refund-list');
    const open = nodes(h.value).find(
      (n) =>
        n.type === 'button' &&
        n.props['aria-label'] === zhf('changes.files.open', { path: 'src/refunds/list.tsx' }),
    )!;
    open.props.onClick();
    expect(mock.shell.openSession).toHaveBeenCalledWith('refund-list', 'diff');
  });

  it('names the total of added and removed lines in five cells', () => {
    const cells = diffCells(212, 40)!;
    expect(cells.props.role).toBe('img');
    expect(cells.props['aria-label']).toBe(
      zhf('changes.files.total', { additions: 212, deletions: 40 }),
    );
    expect(nodes(cells).filter((n) => n.type === 'i')).toHaveLength(5);
    expect(diffCells(0, 0)).toBeNull();
  });
});
