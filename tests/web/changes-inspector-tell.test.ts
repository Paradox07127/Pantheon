import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@pantheon/domain';
import type { ChangeRow, WorkbenchSession } from '@pantheon/protocol';
import { mount, nodes, unmountAll } from './web-hook-host.js';

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
vi.mock('@/data/commands', () => ({
  runCommand: vi.fn(async () => ({ ok: true, value: null })),
}));
import { runCommand } from '@/data/commands';
import { draftKey, useDrafts } from '@/data/drafts';
import { TellBox } from '@/screens/changes/TellBox';
import { tellDraft, tellState } from '@/screens/changes/tell-model';
import { zh, zhf } from './i18n-setup.js';

const session = (id: string, state: Session['state'], extra: Partial<Session> = {}): Session =>
  ({
    id,
    revision: 4,
    project_id: 'alpha',
    runtime: 'fixture',
    state,
    turn_count: 1,
    ...extra,
  }) as Session;

const listed = (id: string, extra: Partial<WorkbenchSession> = {}) =>
  ({ id, title: id, state: 'idle', ...extra }) as WorkbenchSession;

const change: ChangeRow = {
  id: 'session:worker',
  kind: 'session',
  title: 'Refund list page',
  branch: 'pt/refund-list',
  status: 'running',
  gate: { state: 'none' },
  updated_at: '2026-11-20T10:00:00.000Z',
};

beforeEach(() => {
  mock.board = {
    board: {
      cursor: 1,
      projects: [],
      sessions: [session('worker', 'running', { revision: 7 }), session('main', 'open')],
      workspaces: [],
      session_turns: [],
    },
    events: [],
    status: { state: 'live' },
    resync: 0,
  };
  useDrafts.setState({ drafts: {}, answers: {} });
  vi.mocked(runCommand).mockClear();
});
afterEach(() => unmountAll());

describe('telling the agent of a change', () => {
  it('sends to an open session and steers a running one', () => {
    expect(tellState(session('s', 'open'))).toEqual({
      type: 'session.send',
      enabled: true,
      reason: null,
    });
    expect(tellState(session('s', 'running'))).toEqual({
      type: 'session.steer',
      enabled: true,
      reason: null,
    });
  });

  it('is off for a closed session, one whose stop is pending, and a missing one', () => {
    expect(tellState(session('s', 'closed'))).toEqual({
      type: 'session.send',
      enabled: false,
      reason: zh('data.transcript.compose.closedSend'),
    });
    expect(tellState(session('s', 'open', { stop_pending: true }))).toEqual({
      type: 'session.send',
      enabled: false,
      reason: zh('data.transcript.busy.stopPending'),
    });
    const missing = tellState(undefined);
    expect(missing.enabled).toBe(false);
    expect(missing.reason).toBe(zh('changes.tell.gone'));
  });

  it('drafts a line naming the change by its title and branch', () => {
    expect(tellDraft(change)).toBe(
      zhf('changes.tell.draftBranch', { title: 'Refund list page', branch: 'pt/refund-list' }),
    );
    expect(tellDraft({ ...change, branch: null })).toBe(
      zhf('changes.tell.draft', { title: 'Refund list page' }),
    );
  });

  const box = (main: WorkbenchSession | null) =>
    mount(
      () =>
        TellBox({
          row: change,
          session: listed('worker', main ? { spawned_by: { session_id: main.id } } : {}),
          main,
        }) as ReactElement,
    );
  const textarea = (tree: unknown) =>
    nodes(tree as ReactElement).find(
      (n) => n.type === 'textarea' && n.props['aria-label'] === zh('changes.tell.message'),
    )!;
  const send = (tree: unknown) =>
    nodes(tree as ReactElement).find(
      (n) => n.type === 'button' && n.props['aria-label'] === zh('changes.tell.send'),
    )!;

  it('prefills the reference to the change and steers the running session of the row', async () => {
    const h = box(null);
    expect(textarea(h.value).props.value).toBe(tellDraft(change));
    expect(nodes(h.value).some((n) => n.props['aria-label'] === zh('changes.tell.recipient'))).toBe(
      false,
    );
    textarea(h.value).props.onChange({ target: { value: `${tellDraft(change)}use the cursor` } });
    h.render();
    expect(useDrafts.getState().drafts[draftKey('alpha', 'worker', change.id)]?.text).toBe(
      `${tellDraft(change)}use the cursor`,
    );
    send(h.value).props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'session.steer',
      { session_id: 'worker', input: `${tellDraft(change)}use the cursor` },
      7,
    );
  });

  it('sends to the main agent that started the session once it is chosen', async () => {
    const h = box(listed('main', { conductor: true }));
    const choice = nodes(h.value).find(
      (n) => n.props['aria-label'] === zh('changes.tell.recipient'),
    )!;
    expect(choice.props.value).toBe('session');
    choice.props.onValueChange('main');
    h.render();
    expect(textarea(h.value).props.value).toBe(tellDraft(change));
    send(h.value).props.onClick();
    await h.flush();
    expect(runCommand).toHaveBeenCalledWith(
      'session.send',
      { session_id: 'main', input: tellDraft(change).trim() },
      4,
    );
  });

  it('keeps the send off when the session is gone from the board', async () => {
    mock.board.board.sessions = [];
    const h = box(null);
    expect(send(h.value).props['aria-disabled']).toBe(true);
    send(h.value).props.onClick();
    await h.flush();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
