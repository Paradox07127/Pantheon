import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeResult, StaleWorkspaces } from '@pantheon/protocol';
import { type HookHost, deferred, find, mount, text, unmountAll } from './web-hook-host.js';
vi.mock('react', async (actual) => (await import('./web-hook-host.js')).reactMock(actual));
vi.mock('../../apps/web/node_modules/zustand/esm/index.mjs', async (actual) =>
  (await import('./web-live-stores.js')).liveStores(actual as never),
);
const toasts = vi.hoisted(() => [] as { title: string }[]);
vi.mock('@/components/Toast', async (actual) => ({
  ...(await actual<object>()),
  toast: (options: { title: string }) => {
    toasts.push(options);
    return '';
  },
}));
import { useBoard } from '@/data/board';
import { BranchPanel } from '@/screens/board/RepoCharts';
import { zh } from './i18n-setup.js';

type Command = { type: string; input: Record<string, unknown>; expected_revision: number | null };

const bridge = {
  commands: [] as Command[],
  answers: [] as (BridgeResult<unknown> | Promise<BridgeResult<unknown>>)[],
  async query(): Promise<BridgeResult<unknown>> {
    return { ok: false, error: { code: 'unknown_route', message: 'none' } };
  },
  async command(command: Command): Promise<BridgeResult<unknown>> {
    bridge.commands.push(command);
    return (await bridge.answers.shift()) ?? { ok: true, value: { removed: 0 } };
  },
};

let reloads = 0;
const panel = (stale: StaleWorkspaces) =>
  mount(() =>
    BranchPanel({
      projectId: 'repo-project',
      sessions: [],
      stale: { read: stale, reload: () => void reloads++ },
    }),
  );
const tree = (h: HookHost<any>) => h.value as never;
const cleanupButton = (h: HookHost<any>) =>
  find(find(tree(h), (n) => n.props.tools).props.tools, (n) => n.type === 'button');
const confirmButton = (h: HookHost<any>) =>
  find(tree(h), (n) => n.type === 'button' && text(n) === zh('sessions.screen.delete'));
const dialog = (h: HookHost<any>) =>
  find(tree(h), (n) => n.props.open !== undefined && n.props.onOpenChange);

beforeEach(() => {
  bridge.commands = [];
  bridge.answers = [];
  reloads = 0;
  toasts.length = 0;
  vi.stubGlobal('window', { pantheon: bridge });
  useBoard.setState({
    board: { cursor: 1, projects: [], sessions: [] },
    status: { state: 'live' },
  } as never);
});
afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
});

describe('stale worktree cleanup on the repository tab', () => {
  it('asks first, naming what is deleted, how many and that it cannot be undone', () => {
    const h = panel({ count: 2 });
    expect(dialog(h).props.open).toBe(false);
    cleanupButton(h).props.onClick();
    h.render();
    expect(dialog(h).props.open).toBe(true);
    expect(text(dialog(h))).toContain(zh('insights.repo.pruneTitle'));
    expect(text(dialog(h))).toContain(
      '将删除已归档会话留下的 2 个工作树，连同里面未提交的改动。删除后无法恢复。',
    );
    expect(bridge.commands).toEqual([]);
  });

  it('deletes on confirm, holds the buttons meanwhile, then notifies and reads the count again', async () => {
    const answer = deferred<BridgeResult<unknown>>();
    bridge.answers = [answer.promise];
    const h = panel({ count: 2 });
    cleanupButton(h).props.onClick();
    h.render();
    confirmButton(h).props.onClick();
    await h.flush();
    expect(bridge.commands.map(({ type, input }) => ({ type, input }))).toEqual([
      { type: 'workspace.prune_stale', input: { project_id: 'repo-project' } },
    ]);
    expect(cleanupButton(h).props.disabled).toBe(true);
    expect(confirmButton(h).props.disabled).toBe(true);
    answer.resolve({ ok: true, value: { removed: 2 } });
    await h.flush();
    h.render();
    expect(toasts).toEqual([{ title: '清理了 2 个工作树' }]);
    expect(reloads).toBe(1);
    expect(dialog(h).props.open).toBe(false);
  });

  it('keeps the dialog open with the refusal', async () => {
    bridge.answers = [{ ok: false, error: { code: 'busy', message: 'session running' } }];
    const h = panel({ count: 1 });
    cleanupButton(h).props.onClick();
    h.render();
    confirmButton(h).props.onClick();
    await h.flush();
    h.render();
    expect(dialog(h).props.open).toBe(true);
    expect(text(find(dialog(h), (n) => n.props.role === 'alert'))).toContain('session running');
    expect(toasts).toEqual([]);
    expect(reloads).toBe(0);
  });
});
